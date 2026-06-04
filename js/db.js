/* ============================================================
   Savart — DB module
   IndexedDB wrapper: audio blob cache + metadata + app state
   ============================================================
   Stores:
   - blobs      : { id (fileId), blob, mimeType, size, savedAt, lastUsed }
   - metadata   : { id (fileId), name, displayName, artist, album, duration,
                    coverUrl, coverBlob, playCount, starred, folderId }
   - state      : { key, value }  — playback state, last folder, etc.
   - playlists  : { id, name, songIds[], createdAt, updatedAt }
   - recents    : { id (fileId), name, type ('song'|'folder'), folderId, accessedAt }
   - history    : { id (fileId), name, displayName, artist, thumbnailUrl, folderId, playedAt }
   ============================================================ */

const DB = (() => {

  let _db = null;

  /* ── Open / migrate ─────────────────────────────────────── */

  /**
   * Initialize IndexedDB. Must be called before any other DB method.
   * Returns a Promise that resolves when the DB is ready.
   */
  function open() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // blobs store
        if (!db.objectStoreNames.contains('blobs')) {
          const blobStore = db.createObjectStore('blobs', { keyPath: 'id' });
          blobStore.createIndex('lastUsed', 'lastUsed', { unique: false });
          blobStore.createIndex('savedAt',  'savedAt',  { unique: false });
        }

        // metadata store
        if (!db.objectStoreNames.contains('metadata')) {
          const metaStore = db.createObjectStore('metadata', { keyPath: 'id' });
          metaStore.createIndex('folderId',  'folderId',  { unique: false });
          metaStore.createIndex('starred',   'starred',   { unique: false });
          metaStore.createIndex('playCount', 'playCount', { unique: false });
        } else {
          // Migration: add missing indexes to an existing metadata store.
          // Indexes were only created when the store was first built, so older
          // DB instances that predate these indexes never received them.
          const metaStore = event.target.transaction.objectStore('metadata');
          if (!metaStore.indexNames.contains('folderId')) {
            metaStore.createIndex('folderId',  'folderId',  { unique: false });
          }
          if (!metaStore.indexNames.contains('starred')) {
            metaStore.createIndex('starred',   'starred',   { unique: false });
          }
          if (!metaStore.indexNames.contains('playCount')) {
            metaStore.createIndex('playCount', 'playCount', { unique: false });
          }
        }

        // state store (key-value)
        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state', { keyPath: 'key' });
        }

        // playlists store
        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: 'id' });
        }

        // recents store
        if (!db.objectStoreNames.contains('recents')) {
          const recentsStore = db.createObjectStore('recents', { keyPath: 'id' });
          recentsStore.createIndex('accessedAt', 'accessedAt', { unique: false });
        }

        // history store (v2+)
        if (oldVersion < 2 && !db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id' });
          historyStore.createIndex('playedAt', 'playedAt', { unique: false });
        }

        // collections store (v5+) — { id (=folderId), name, coverUrl, updatedAt }
        if (!db.objectStoreNames.contains('collections')) {
          db.createObjectStore('collections', { keyPath: 'id' });
        }

        console.log(`[DB] Upgraded from v${oldVersion} to v${CONFIG.DB_VERSION}`);
      };

      req.onsuccess = (event) => {
        _db = event.target.result;
        _db.onerror = (e) => console.error('[DB] Unhandled error:', e.target.error);
        console.log('[DB] Opened:', CONFIG.DB_NAME);
        resolve(_db);
      };

      req.onerror = (event) => {
        console.error('[DB] Failed to open:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /* ── Internal helpers ───────────────────────────────────── */

  function _tx(storeName, mode = 'readonly') {
    if (!_db) throw new Error('[DB] Database not open. Call DB.open() first.');
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  function _promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror  = () => reject(request.error);
    });
  }

  /* ── Blob cache ─────────────────────────────────────────── */

  /**
   * Get a cached blob for a fileId.
   * Also updates lastUsed for LRU tracking.
   * @param {string} fileId
   * @returns {Promise<Blob|null>}
   */
  async function getCachedBlob(fileId) {
    const store = _tx('blobs', 'readwrite');
    const entry = await _promisify(store.get(fileId));
    if (!entry) return null;

    // Touch lastUsed
    entry.lastUsed = Date.now();
    store.put(entry);

    return entry.blob;
  }

  /**
   * Store a blob in the cache.
   * Triggers LRU eviction if cache limit is exceeded.
   * @param {string} fileId
   * @param {Blob} blob
   * @param {string} mimeType
   */
  async function setCachedBlob(fileId, blob, mimeType) {
    const now = Date.now();
    const store = _tx('blobs', 'readwrite');
    await _promisify(store.put({
      id:       fileId,
      blob,
      mimeType: mimeType || blob.type || 'audio/mpeg',
      size:     blob.size,
      savedAt:  now,
      lastUsed: now,
    }));

    // Async eviction — don't await so playback isn't blocked
    _evictIfNeeded().catch(e => console.warn('[DB] Eviction error:', e));
  }

  /**
   * Remove a specific blob from the cache.
   * @param {string} fileId
   */
  async function removeCachedBlob(fileId) {
    const store = _tx('blobs', 'readwrite');
    return _promisify(store.delete(fileId));
  }

  /**
   * Check if a file is cached.
   * @param {string} fileId
   * @returns {Promise<boolean>}
   */
  async function isCached(fileId) {
    const store = _tx('blobs');
    const entry = await _promisify(store.get(fileId));
    return !!entry;
  }

  /**
   * Get total bytes used by the blob cache.
   * @returns {Promise<number>}
   */
  async function getCacheSize() {
    const store = _tx('blobs');
    const entries = await _promisify(store.getAll());
    return entries.reduce((sum, e) => sum + (e.size || 0), 0);
  }

  /**
   * Clear the entire blob cache.
   * @returns {Promise<void>}
   */
  async function clearCache() {
    const store = _tx('blobs', 'readwrite');
    return _promisify(store.clear());
  }

  /**
   * LRU eviction: remove least recently used blobs until we're under the limit.
   */
  async function _evictIfNeeded() {
    const limitKey   = await getState('cacheLimit');
    const limitBytes = limitKey ?? CONFIG.CACHE_LIMIT_DEFAULT;

    const store   = _tx('blobs', 'readwrite');
    const entries = await _promisify(store.getAll());
    const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);

    if (totalBytes <= limitBytes) return;

    // Sort by lastUsed ascending (oldest first)
    entries.sort((a, b) => a.lastUsed - b.lastUsed);

    let freed = 0;
    const toDelete = [];
    for (const entry of entries) {
      if (totalBytes - freed <= limitBytes) break;
      toDelete.push(entry.id);
      freed += entry.size || 0;
    }

    for (const id of toDelete) {
      await _promisify(store.delete(id));
    }

    if (toDelete.length > 0) {
      console.log(`[DB] Evicted ${toDelete.length} blobs (freed ~${Math.round(freed / 1024 / 1024)} MB)`);
    }
  }

  /* ── Metadata ───────────────────────────────────────────── */

  /**
   * Get metadata for a file.
   * @param {string} fileId
   * @returns {Promise<Object|null>}
   */
  async function getMeta(fileId) {
    const store = _tx('metadata');
    return _promisify(store.get(fileId));
  }

  /**
   * Get all metadata records (used for Artists / Albums aggregation in Library).
   * @returns {Promise<Object[]>}
   */
  async function getAllMeta() {
    const store = _tx('metadata');
    return _promisify(store.getAll());
  }

  /**
   * Remove normalGain and normalGainDb from every metadata record.
   * Used to force re-analysis after changing the normalizer algorithm/targets.
   * Writes directly to the store (bypasses setMeta's null-stripping logic).
   * @returns {Promise<number>} number of records cleared
   */
  async function clearNormGains() {
    const store = _tx('metadata', 'readwrite');
    const all   = await _promisify(store.getAll());
    if (!all?.length) return 0;
    let count = 0;
    for (const record of all) {
      if ('normalGain' in record || 'normalGainDb' in record) {
        const { normalGain, normalGainDb, ...rest } = record; // eslint-disable-line no-unused-vars
        await _promisify(store.put(rest));
        count++;
      }
    }
    return count;
  }

  /**
   * Like getAllMeta() but strips coverBlob from every record to avoid loading
   * megabytes of image binary data during library listing.
   * Records that had a coverBlob get a lightweight `hasCoverBlob: true` flag
   * so callers can still detect which files have a persisted blob cover.
   * @returns {Promise<Object[]>}
   */
  async function getAllMetaLight() {
    const store = _tx('metadata');
    const all   = await _promisify(store.getAll());
    return (all || []).map(m => {
      if (!m.coverBlob) return m;
      // eslint-disable-next-line no-unused-vars
      const { coverBlob, ...rest } = m;
      return { ...rest, hasCoverBlob: true };
    });
  }

  /**
   * Save or update metadata for a file.
   * Merges with existing metadata if present.
   * @param {string} fileId
   * @param {Object} meta
   */
  async function setMeta(fileId, meta) {
    const store   = _tx('metadata', 'readwrite');
    const existing = await _promisify(store.get(fileId)) || { id: fileId, playCount: 0, starred: false };
    // Strip null/undefined values so we never overwrite valid existing data with empty values.
    // Callers often pass optional fields that may be absent — merging them as-is would clear
    // previously persisted thumbnailUrls, display names, etc.
    const cleanMeta = Object.fromEntries(
      Object.entries(meta).filter(([, v]) => v !== undefined && v !== null)
    );
    return _promisify(store.put({ ...existing, ...cleanMeta, id: fileId }));
  }

  /**
   * Increment play count for a file.
   * @param {string} fileId
   */
  async function incrementPlayCount(fileId) {
    const meta = await getMeta(fileId) || { id: fileId, playCount: 0, starred: false };
    meta.playCount = (meta.playCount || 0) + 1;
    meta.playedAt  = Date.now(); // stamp time of play — used by clearedAt merge to decide if this record survives
    // Re-surface the song if it was previously hidden from top-played
    delete meta.hiddenFromTopPlayed;
    return setMeta(fileId, meta);
  }

  /**
   * Toggle starred status for a file.
   * @param {string} fileId
   * @returns {Promise<boolean>} new starred value
   */
  async function toggleStar(fileId) {
    const meta = await getMeta(fileId) || { id: fileId, playCount: 0, starred: false };
    meta.starred = !meta.starred;
    if (meta.starred) meta.starredAt = Date.now(); // LWW: record exact moment of starring
    else              delete meta.starredAt;
    await setMeta(fileId, meta);
    return meta.starred;
  }

  /**
   * Get all starred songs.
   * @returns {Promise<Object[]>}
   */
  async function getStarred() {
    try {
      const store = _tx('metadata');
      const index = store.index('starred');
      const result = await _promisify(index.getAll(IDBKeyRange.only(true)));
      return result || [];
    } catch (_e) {
      // Fallback: full scan (index may be missing in older DB instances)
      console.warn('[DB] starred index unavailable, falling back to full scan');
      const store = _tx('metadata');
      const all = await _promisify(store.getAll());
      return (all || []).filter(m => m && m.starred === true);
    }
  }

  /**
   * Get top played songs.
   * @param {number} limit
   * @returns {Promise<Object[]>}
   */
  async function getTopPlayed(limit = CONFIG.TOP_PLAYED_MAX) {
    const store   = _tx('metadata');
    const entries = await _promisify(store.getAll());
    return entries
      .filter(e => e.playCount > 0 && !e.hiddenFromTopPlayed)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, limit);
  }

  /**
   * Same as getTopPlayed but includes songs hidden from the top-played list.
   * Used by the sync playcounts merge so hidden items are treated as known local
   * records — preventing the remote value from being re-upserted as if it were new.
   */
  async function getAllPlaycounts() {
    const store   = _tx('metadata');
    const entries = await _promisify(store.getAll());
    return entries.filter(e => e.playCount > 0 || e.hiddenFromTopPlayed);
  }

  /* ── State (key-value) ──────────────────────────────────── */

  /**
   * Get a value from the state store.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async function getState(key) {
    const store = _tx('state');
    const entry = await _promisify(store.get(key));
    return entry ? entry.value : undefined;
  }

  /**
   * Set a value in the state store.
   * @param {string} key
   * @param {any} value
   */
  async function setState(key, value) {
    const store = _tx('state', 'readwrite');
    return _promisify(store.put({ key, value }));
  }

  /* ── Recents ─────────────────────────────────────────────── */

  /**
   * Add an item to the recents list.
   * Replaces existing entry for the same id.
   * @param {{ id, name, type, folderId, mimeType, thumbnailUrl }} item
   */
  async function addRecent(item) {
    const store = _tx('recents', 'readwrite');
    // Preserve the item's own accessedAt if it was set (e.g. synced from another device).
    // Fall back to Date.now() for regular use where no timestamp is provided.
    await _promisify(store.put({ ...item, accessedAt: item.accessedAt ?? Date.now() }));
    await _trimRecents();
  }

  /**
   * Bulk-write recents in a SINGLE IndexedDB transaction.
   * All puts are queued synchronously before any await, so the transaction
   * never auto-commits mid-batch (avoids the IDB async-deadlock issue).
   * Used by Sync to apply remote data without per-item overhead.
   * @param {Object[]} items
   */
  async function bulkPutRecents(items) {
    if (!_db) return;
    // Live items are capped at RECENTS_MAX; tombstones are exempt from the cap
    // so they survive next to a full list and _trimRecents() can apply them later.
    const all        = (items || []).filter(r => r && r.id);
    const live       = all.filter(r => !r.removedAt).slice(0, CONFIG.RECENTS_MAX);
    const tombstones = all.filter(r =>  r.removedAt);
    const valid      = [...live, ...tombstones];
    if (!valid.length) return;
    await new Promise((resolve, reject) => {
      const tx    = _db.transaction('recents', 'readwrite');
      const store = tx.objectStore('recents');
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
      // Fire all get()s synchronously so the transaction stays open,
      // then merge+put inside each onsuccess — preserves thumbnailUrl when remote sends null
      for (const item of valid) {
        const clean = Object.fromEntries(
          Object.entries(item).filter(([, v]) => v !== undefined && v !== null)
        );
        const req = store.get(item.id);
        req.onsuccess = () => {
          const existing = req.result || {};
          store.put({ ...existing, ...clean, id: item.id, accessedAt: clean.accessedAt ?? existing.accessedAt ?? Date.now() });
        };
      }
    });
    await _trimRecents();
  }

  /**
   * Bulk-write metadata rows in a SINGLE IndexedDB transaction.
   * Used by Sync to apply remote playcounts without per-item overhead.
   * Unlike setMeta, this does a direct put (no get+merge) so it's safe
   * inside a single readwrite transaction opened without any prior await.
   * @param {Object[]} items  — each must have an `id` field
   */
  async function bulkPutMeta(items) {
    if (!_db) return;
    const valid = (items || []).filter(r => r && r.id);
    if (!valid.length) return;
    await new Promise((resolve, reject) => {
      const tx    = _db.transaction('metadata', 'readwrite');
      const store = tx.objectStore('metadata');
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
      // Fire all get()s synchronously so the transaction stays open,
      // then merge+put inside each onsuccess — preserves coverBlob, thumbnailUrl, etc.
      for (const item of valid) {
        const clean = Object.fromEntries(
          Object.entries(item).filter(([, v]) => v !== undefined && v !== null)
        );
        const req = store.get(item.id);
        req.onsuccess = () => {
          const existing = req.result || { playCount: 0, starred: false };
          // thumbnailUrl — fill-only: synced records carry thumbnailUrl for convenience
          // on new devices only — never overwrite an existing cover or blob.
          const safeClean = { ...clean };
          if ('thumbnailUrl' in safeClean) {
            const hasExisting = (existing.thumbnailUrl && existing.thumbnailUrl !== 'id3')
                             || existing.coverBlob;
            if (hasExisting) delete safeClean.thumbnailUrl;
          }
          const merged   = { ...existing, ...safeClean, id: item.id };
          // Never restore playCount while the user has explicitly hidden the song
          if (existing.hiddenFromTopPlayed && 'playCount' in safeClean) merged.playCount = 0;
          store.put(merged);
        };
      }
    });
  }

  /**
   * Apply remote play-count records using MAX(local, remote) per song.
   * Runs in a single IndexedDB transaction so there's no per-song round-trip.
   * Prevents a lower remote count from overwriting a higher local count when
   * two devices have played the same song a different number of times.
   * @param {Object[]} items — each must have { id, playCount }
   */
  async function bulkApplyPlaycounts(items) {
    if (!_db) return;
    const valid = (items || []).filter(r => r && r.id);
    if (!valid.length) return;
    await new Promise((resolve, reject) => {
      const tx    = _db.transaction('metadata', 'readwrite');
      const store = tx.objectStore('metadata');
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
      for (const item of valid) {
        const clean = Object.fromEntries(
          Object.entries(item).filter(([, v]) => v !== undefined && v !== null)
        );
        const req = store.get(item.id);
        req.onsuccess = () => {
          const existing  = req.result || { playCount: 0 };
          // "hide" wins on either side: local OR remote hiddenFromTopPlayed → playCount stays 0
          const hidden   = existing.hiddenFromTopPlayed || item.hiddenFromTopPlayed || false;
          const maxCount = hidden ? 0 : Math.max(existing.playCount || 0, item.playCount || 0);
          // thumbnailUrl — fill-only: never overwrite an existing cover URL or blob.
          // Synced playcounts carry thumbnailUrl only for display convenience on new devices.
          const safeClean = { ...clean };
          if ('thumbnailUrl' in safeClean) {
            const hasExisting = (existing.thumbnailUrl && existing.thumbnailUrl !== 'id3')
                             || existing.coverBlob;
            if (hasExisting) delete safeClean.thumbnailUrl;
          }
          store.put({ ...existing, ...safeClean, id: item.id, playCount: maxCount,
                      ...(hidden ? { hiddenFromTopPlayed: true } : {}) });
        };
      }
    });
  }

  /**
   * Write pre-merged complete records in a single transaction.
   * Unlike bulkPutMeta, this does NOT strip nulls or add defaults — the caller
   * is responsible for providing fully-formed records (typically: spread of existing
   * record + applied patch). Used by the sync metadata merge for performance.
   * @param {Object[]} records — complete records, each must have an `id` field
   */
  async function bulkWriteMeta(records) {
    if (!_db || !records?.length) return;
    await new Promise((resolve, reject) => {
      const tx    = _db.transaction('metadata', 'readwrite');
      const store = tx.objectStore('metadata');
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
      for (const rec of records) {
        if (rec?.id) store.put(rec);
      }
    });
  }

  /**
   * Get recent items, most recent first.
   * @param {number} limit
   * @returns {Promise<Object[]>}
   */
  async function getRecents(limit = CONFIG.RECENTS_MAX) {
    const store   = _tx('recents');
    const entries = await _promisify(store.getAll());
    return entries
      .filter(e => !e.removedAt)          // hide tombstones from callers
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, limit);
  }

  /** Returns ALL recents store records, including tombstones. Used by sync push. */
  async function getRecentsAll() {
    const store = _tx('recents');
    return _promisify(store.getAll());
  }

  async function _trimRecents() {
    const store   = _tx('recents', 'readwrite');
    const entries = await _promisify(store.getAll());
    // Purge tombstones older than 7 days — they've had enough time to propagate
    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const e of entries) {
      if (e.removedAt && e.removedAt < week) await _promisify(store.delete(e.id));
    }
    // Trim live items beyond RECENTS_MAX
    const live = entries.filter(e => !e.removedAt);
    if (live.length <= CONFIG.RECENTS_MAX) return;
    live.sort((a, b) => a.accessedAt - b.accessedAt);
    const toDelete = live.slice(0, live.length - CONFIG.RECENTS_MAX);
    for (const e of toDelete) await _promisify(store.delete(e.id));
  }

  /* ── Playlists ───────────────────────────────────────────── */

  function _uuid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `pl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Create a new playlist.
   * @param {string} name
   * @returns {Promise<Object>} the new playlist
   */
  async function createPlaylist(name) {
    const pl = {
      id:        _uuid(),
      name,
      songIds:   [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const store = _tx('playlists', 'readwrite');
    await _promisify(store.put(pl));
    return pl;
  }

  /**
   * Write a playlist directly (used by Sync to apply remote data).
   * Unlike createPlaylist(), this preserves the existing id.
   * @param {Object} pl — full playlist object with id
   */
  async function putPlaylist(pl) {
    const store = _tx('playlists', 'readwrite');
    return _promisify(store.put(pl));
  }

  /**
   * Get all playlists.
   * @returns {Promise<Object[]>}
   */
  async function getPlaylists() {
    const store = _tx('playlists');
    const pls   = await _promisify(store.getAll());
    // Sort by most recent activity: lastPlayedAt takes priority over updatedAt
    return pls.sort((a, b) => {
      const ta = Math.max(a.lastPlayedAt || 0, a.updatedAt || 0);
      const tb = Math.max(b.lastPlayedAt || 0, b.updatedAt || 0);
      return tb - ta;
    });
  }

  /**
   * Get a single playlist by id.
   * @param {string} id
   */
  async function getPlaylist(id) {
    const store = _tx('playlists');
    return _promisify(store.get(id));
  }

  /**
   * Update playlist fields (partial update).
   * @param {string} id
   * @param {Object} changes
   */
  async function updatePlaylist(id, changes) {
    const store    = _tx('playlists', 'readwrite');
    const existing = await _promisify(store.get(id));
    if (!existing) throw new Error(`Playlist ${id} not found`);
    return _promisify(store.put({ ...existing, ...changes, id, updatedAt: Date.now() }));
  }

  /**
   * Delete a playlist.
   * @param {string} id
   */
  async function deletePlaylist(id) {
    const store = _tx('playlists', 'readwrite');
    return _promisify(store.delete(id));
  }

  /**
   * Add a song to a playlist (avoids duplicates).
   * @param {string} playlistId
   * @param {string} fileId
   */
  async function addToPlaylist(playlistId, fileId) {
    const pl = await getPlaylist(playlistId);
    if (!pl) return;
    if (!pl.songIds.includes(fileId)) {
      pl.songIds.push(fileId);
      await updatePlaylist(playlistId, { songIds: pl.songIds });
    }
  }

  /**
   * Remove a song from a playlist.
   * @param {string} playlistId
   * @param {string} fileId
   */
  async function removeFromPlaylist(playlistId, fileId) {
    const pl = await getPlaylist(playlistId);
    if (!pl) return;
    await updatePlaylist(playlistId, {
      songIds: pl.songIds.filter(id => id !== fileId),
    });
  }

  /* ── Pinned folders ─────────────────────────────────────── */

  /**
   * Get pinned folder IDs (stored in state).
   * @returns {Promise<string[]>}
   */
  async function getPinned() {
    return (await getState('pinned')) || [];
  }

  /**
   * Pin or unpin any item (folder or song) to the Fijadas section.
   * Stores enough display fields so the pinned card renders correctly.
   * @param {{ id, name, displayName?, type?, thumbnailUrl?, isFolder? }} item
   * @returns {Promise<boolean>} true if now pinned, false if unpinned
   */
  async function togglePin(item) {
    const pinned = await getPinned();
    const stored = await getState('pinnedMeta') || {};
    const idx    = pinned.indexOf(item.id);
    if (idx === -1) {
      pinned.push(item.id);
      stored[item.id] = {
        id:           item.id,
        name:         item.name,
        displayName:  item.displayName  || item.name,
        type:         item.type         || (item.isFolder ? 'folder' : 'song'),
        thumbnailUrl: item.thumbnailUrl || item.thumbnailLink || null,
        artist:       item.artist       || null,
        folderId:     item.folderId     || item.parents?.[0]  || null,
        folderType:   item.folderType   || null,
        pinnedAt:     Date.now(),
        // Preserve Soundrop identity so the SD chip and replay work correctly.
        ...(item.isSoundrop || (item.id || '').startsWith('sd_')
          ? { isSoundrop: true, videoId: item.videoId || item.id.slice(3) }
          : {}),
      };
      await setState('pinned', pinned);
      await setState('pinnedMeta', stored);
      return true;
    } else {
      pinned.splice(idx, 1);
      delete stored[item.id];
      await setState('pinned', pinned);
      await setState('pinnedMeta', stored);
      return false;
    }
  }

  /**
   * Remove a single item from the recents list.
   * Writes a tombstone { id, removedAt } instead of a hard delete so that
   * other devices learn about the removal via sync (getRecents filters these out).
   * @param {string} id
   */
  async function removeRecent(id) {
    const store = _tx('recents', 'readwrite');
    // Keep display fields so the tombstone is self-describing, but stamp removedAt.
    const existing = await _promisify(store.get(id));
    await _promisify(store.put({ ...(existing || {}), id, removedAt: Date.now() }));
  }

  /**
   * Clear all recents (used by LWW sync to replace with remote data).
   */
  async function clearRecents() {
    const store = _tx('recents', 'readwrite');
    return _promisify(store.clear());
  }

  /**
   * Clear all playlists (used by LWW sync to replace with remote data).
   */
  async function clearPlaylists() {
    const store = _tx('playlists', 'readwrite');
    return _promisify(store.clear());
  }

  /**
   * Get full pinned folder objects.
   * @returns {Promise<Object[]>}
   */
  async function getPinnedFolders() {
    let meta = await getState('pinnedMeta') || {};

    // ── Auto-repair for the 3.5.1 sync bug ───────────────────────────────────
    // That version's init() passed the whole { meta: {...}, order: [...] } wrapper
    // object directly to _mergePinned instead of unwrapping .meta first, so the
    // corrupted wrapper got written to IndexedDB as `pinnedMeta`.
    //
    // Detection: the object has BOTH a 'meta' key that is a non-array plain object
    // AND an 'order' key that is an array — no legitimate pinned-item record would
    // have those exact key names simultaneously.
    if (meta && typeof meta.meta === 'object' && !Array.isArray(meta.meta)
        && Array.isArray(meta.order)) {
      console.warn('[DB] pinnedMeta corruption detected — auto-repairing (3.5.1 format bug)…');
      const repaired = meta.meta || {};
      const repairedOrder = meta.order.filter(id => repaired[id]); // drop 'meta'/'order' entries
      await setState('pinnedMeta', repaired);
      await setState('pinned', repairedOrder);
      meta = repaired;
    }

    // ── Ghost-pin cleanup ─────────────────────────────────────────────────────
    // Remove entries that have no name and no displayName — these are orphaned
    // references left over from sync bugs or interrupted pin operations. They show
    // as blank cards with only a music-note icon on the home screen.
    const ghostIds = Object.keys(meta).filter(id => {
      const item = meta[id];
      return !item || (!item.name && !item.displayName);
    });
    if (ghostIds.length > 0) {
      console.warn(`[DB] Removing ${ghostIds.length} ghost pin(s) with no name reference…`);
      for (const id of ghostIds) delete meta[id];
      const order = await getState('pinned') || [];
      const cleanOrder = order.filter(id => meta[id]);
      await setState('pinnedMeta', meta);
      await setState('pinned', cleanOrder);
    }

    return Object.values(meta);
  }

  /* ── History ────────────────────────────────────────────── */

  /**
   * Add (or update) a song in the playback history.
   * Each song appears at most once; replaying bumps its playedAt to now.
   * Trims to HISTORY_MAX items and drops entries older than HISTORY_MAX_DAYS.
   * @param {{ id, name, displayName, artist, thumbnailUrl, folderId }} item
   */
  async function addToHistory(item) {
    if (!item || !item.id) return;
    const store = _tx('history', 'readwrite');
    const safeThumb = (item.thumbnailUrl && !item.thumbnailUrl.startsWith('blob:') && item.thumbnailUrl !== 'id3')
      ? item.thumbnailUrl : (item.thumbnailLink || null); // thumbnailLink = stable Drive CDN fallback
    await _promisify(store.put({
      id:           item.id,
      name:         item.name        || '',
      displayName:  item.displayName || item.name || '',
      artist:       item.artist      || '',
      thumbnailUrl: safeThumb,
      folderId:     item.parents?.[0] || item.folderId || null,
      isSoundrop:   item.isSoundrop  || false,
      videoId:      item.videoId     || null,
      playedAt:     Date.now(),
    }));
    await _trimHistory();
  }

  /**
   * Get history items, most recently played first.
   * Automatically drops entries older than HISTORY_MAX_DAYS.
   * @param {number} limit
   * @returns {Promise<Object[]>}
   */
  async function getHistory(limit = CONFIG.HISTORY_MAX) {
    const store   = _tx('history');
    const entries = await _promisify(store.getAll());
    const cutoff  = Date.now() - CONFIG.HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
    return entries
      .filter(e => !e.removedAt && (e.playedAt || 0) >= cutoff)  // hide tombstones
      .sort((a, b) => b.playedAt - a.playedAt)
      .slice(0, limit);
  }

  /**
   * Bulk-write history rows in a single IndexedDB transaction.
   * Used by Sync to apply remote history without per-item overhead.
   * @param {Object[]} items
   */
  async function bulkPutHistory(items) {
    if (!_db) return;
    const valid = (items || []).filter(r => r && r.id).slice(0, CONFIG.HISTORY_MAX);
    if (!valid.length) return;
    await new Promise((resolve, reject) => {
      const tx    = _db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
      for (const item of valid) {
        store.put({ ...item, playedAt: item.playedAt ?? Date.now() });
      }
    });
    await _trimHistory();
  }

  /**
   * Remove a single item from the history.
   * @param {string} id
   */
  async function removeFromHistory(id) {
    // Tombstone — same pattern as removeRecent — so sync LWW doesn't restore the item on next login.
    const store    = _tx('history', 'readwrite');
    const existing = await _promisify(store.get(id));
    await _promisify(store.put({ ...(existing || {}), id, removedAt: Date.now() }));
  }

  /** Returns ALL history store records, including tombstones. Used by sync push. */
  async function getHistoryAll() {
    const store = _tx('history');
    return _promisify(store.getAll());
  }

  /**
   * Clear all history (used by LWW sync to replace with remote data).
   */
  async function clearHistory() {
    const store = _tx('history', 'readwrite');
    return _promisify(store.clear());
  }

  /** Clear all pinned items (ids list + metadata object in state store). */
  async function clearPinned() {
    await setState('pinned',     []);
    await setState('pinnedMeta', {});
  }

  /** Reset playCount to 0 on every metadata record (also removes hiddenFromTopPlayed). */
  async function clearPlaycounts() {
    // Step 1: read all records (first transaction — auto-commits after getAll)
    const readStore = _tx('metadata', 'readwrite');
    const records   = await _promisify(readStore.getAll());
    if (!records.length) return;
    // Step 2: write all records in a SINGLE transaction (all puts issued
    // synchronously so the transaction stays open until they all complete)
    const writeStore = _tx('metadata', 'readwrite');
    await Promise.all(records.map(r => {
      r.playCount = 0;
      delete r.hiddenFromTopPlayed;
      return _promisify(writeStore.put(r));
    }));
  }

  /** Set starred = false on every metadata record (also removes starredAt). */
  async function clearStarred() {
    // Step 1: read all records (first transaction — auto-commits after getAll)
    const readStore = _tx('metadata', 'readwrite');
    const records   = await _promisify(readStore.getAll());
    if (!records.length) return;
    // Step 2: write all records in a SINGLE transaction (all puts issued
    // synchronously so the transaction stays open until they all complete)
    const writeStore = _tx('metadata', 'readwrite');
    await Promise.all(records.map(r => {
      r.starred = false;
      delete r.starredAt;
      return _promisify(writeStore.put(r));
    }));
  }

  /** Trim history: remove oldest entries beyond HISTORY_MAX and older than HISTORY_MAX_DAYS. */
  async function _trimHistory() {
    const store   = _tx('history', 'readwrite');
    const entries = await _promisify(store.getAll());
    const cutoff  = Date.now() - CONFIG.HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
    const week    = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Purge tombstones older than 7 days (they've propagated to all devices by then)
    // Drop stale live entries by age
    for (const e of entries) {
      if (e.removedAt && e.removedAt < week)  { await _promisify(store.delete(e.id)); continue; }
      if (!e.removedAt && (e.playedAt || 0) < cutoff) await _promisify(store.delete(e.id));
    }

    // Trim live entries to hard limit (keep most recent); tombstones don't count toward limit
    const remaining = entries.filter(e => !e.removedAt && (e.playedAt || 0) >= cutoff);
    if (remaining.length <= CONFIG.HISTORY_MAX) return;
    remaining.sort((a, b) => a.playedAt - b.playedAt);
    const toDelete = remaining.slice(0, remaining.length - CONFIG.HISTORY_MAX);
    for (const e of toDelete) await _promisify(store.delete(e.id));
  }

  /**
   * Clear enrichment fields so a song can be fully re-enriched from scratch.
   * Preserves user data (starred, playCount, starredAt) and basic file info
   * (id, name, displayName, folderId, coverBlob).
   * Called by the Rescan action before re-running the enrichment pipeline.
   * @param {string} fileId
   */
  async function clearEnrichment(fileId) {
    const store    = _tx('metadata', 'readwrite');
    const existing = await _promisify(store.get(fileId));
    if (!existing) return;
    // Only clear enrichment flags and cover data — preserve artist/album/year/track
    // so that MusicBrainz can use them as context for a more accurate re-lookup.
    // MB will overwrite them if it finds a better match; without this context, MB
    // searches by title alone and returns random incorrect results.
    const CLEAR_FIELDS = [
      'mbTried', 'auddTried', 'mbReleaseMbid',
      'thumbnailUrl', 'coverUrl',
      // coverBlob (embedded ID3 art) is intentionally preserved — it requires
      // downloading the audio file to obtain and should survive rescans.
      'lfmThumbTried',  // re-attempt Last.fm after rescan
    ];
    for (const f of CLEAR_FIELDS) delete existing[f];
    return _promisify(store.put(existing));
  }

  /**
   * Clear manual-ownership fields so that auto-enrichment can fully overwrite.
   * Clears: manualAt, coverBlob, displayName
   * Preserves: artist, album, year, track (still useful as MB search context)
   * @param {string} fileId
   */
  async function clearManualOverrides(fileId) {
    const store    = _tx('metadata', 'readwrite');
    const existing = await _promisify(store.get(fileId));
    if (!existing) return;
    delete existing.manualAt;
    delete existing.coverBlob;
    delete existing.displayName;
    return _promisify(store.put(existing));
  }

  /**
   * Full virgin reset for a rescan: wipes all enrichment AND manual data,
   * leaving the record as if the file had never been scanned.
   *
   * Only user-interaction data survives:
   *   starred, playCount, playedAt, addedAt
   *
   * Everything else — displayName, artist, album, year, track, covers,
   * manualAt, MB/AudD flags — is deleted so the pipeline starts from scratch
   * using only the original filename as input.
   *
   * @param {string} fileId
   */
  async function resetToVirgin(fileId) {
    const store    = _tx('metadata', 'readwrite');
    const existing = await _promisify(store.get(fileId));
    if (!existing) return;

    // Preserve only the identity + user-interaction fields
    const keep = {};
    for (const f of ['id', 'name', 'folderId', 'starred', 'playCount', 'playedAt', 'addedAt']) {
      if (existing[f] !== undefined) keep[f] = existing[f];
    }
    return _promisify(store.put(keep));
  }

  /**
   * Global orphan purge: removes ALL metadata records whose IDs are not in liveIds.
   * Use after a full Drive BFS scan to reconcile the entire DB against Drive.
   *
   * @param {string[]} liveIds  All file IDs currently found in Drive.
   * @returns {Promise<number>} Number of orphan records deleted.
   */
  async function purgeAllOrphans(liveIds) {
    if (!Array.isArray(liveIds)) return 0;
    const liveSet = new Set(liveIds);
    const store   = _tx('metadata', 'readwrite');
    const all     = await _promisify(store.getAll());
    let removed   = 0;
    for (const rec of all) {
      if (rec.id && !liveSet.has(rec.id)) {
        await _promisify(store.delete(rec.id));
        removed++;
      }
    }
    return removed;
  }

  /**
   * Remove metadata records for a folder whose file IDs are no longer in Drive.
   * Uses the folderId index for efficiency — only scans records for that folder.
   *
   * @param {string}   folderId  The Drive folder ID that was rescanned.
   * @param {string[]} liveIds   Array of file IDs currently present in Drive.
   * @returns {Promise<number>}  Number of orphan records deleted.
   */
  /**
   * Lightweight movement reconciliation — detects files moved in Drive without a full rescan.
   * Called silently while the user navigates Browse; only touches the folderId field.
   *
   * Two cases handled:
   *  A) Files DB has for this folder that Drive no longer lists → set folderId = null
   *     (they were moved out; the next folder the user visits will pick them up via case B)
   *  B) Files Drive lists for this folder that DB has with a different folderId → update folderId
   *     (they were moved in from another folder)
   *
   * @param {string}   folderId    The Drive folder ID just opened.
   * @param {string[]} liveFileIds Array of Drive file IDs currently in the folder.
   * @returns {Promise<number>}    Total number of DB records updated (0 = no change needed).
   */
  /* ── Background collection scan log ─────────────────────── */

  /**
   * Return the array of folder IDs already processed by the background
   * collection scanner.  Persisted in the `state` store so it survives
   * across sessions; new Drive folders are NOT in this list until the
   * scanner sees them.
   * @returns {Promise<string[]>}
   */
  async function getBgScannedFolders() {
    return (await getState('bg_scan_checked_folders')) || [];
  }

  /**
   * Append newly-processed folder IDs to the persistent scan log.
   * Deduplicates automatically; no-op when ids is empty.
   * @param {string[]} ids
   */
  async function addBgScannedFolders(ids) {
    if (!ids || ids.length === 0) return;
    const existing = (await getState('bg_scan_checked_folders')) || [];
    const merged   = [...new Set([...existing, ...ids])];
    await setState('bg_scan_checked_folders', merged);
  }

  async function reconcileFolderContents(folderId, liveFileIds) {
    if (!folderId || !Array.isArray(liveFileIds)) return 0;
    const liveSet = new Set(liveFileIds);
    let changed = 0;

    await new Promise((resolve, reject) => {
      const tx    = _db.transaction('metadata', 'readwrite');
      const store = tx.objectStore('metadata');
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);

      // Case A: records DB thinks belong here but Drive doesn't list → clear folderId
      const req = store.index('folderId').getAll(IDBKeyRange.only(folderId));
      req.onsuccess = () => {
        for (const rec of req.result) {
          if (!liveSet.has(rec.id)) {
            store.put({ ...rec, folderId: null });
            changed++;
          }
        }

        // Case B: live files whose DB record has a wrong folderId → correct it
        // Use a counter so we close the tx only after all gets complete
        let pending = liveFileIds.length;
        if (pending === 0) return; // tx will complete naturally

        for (const fileId of liveFileIds) {
          const gr = store.get(fileId);
          gr.onsuccess = () => {
            const rec = gr.result;
            if (rec && rec.folderId && rec.folderId !== folderId) {
              store.put({ ...rec, folderId });
              changed++;
            }
            // last one — nothing special needed, tx auto-commits
          };
        }
      };
    });

    return changed;
  }

  async function purgeOrphans(folderId, liveIds) {
    if (!folderId || !Array.isArray(liveIds)) return 0;
    const liveSet = new Set(liveIds);
    const store   = _tx('metadata', 'readwrite');
    const index   = store.index('folderId');
    // Fetch all metadata records belonging to this folder
    const records = await _promisify(index.getAll(IDBKeyRange.only(folderId)));
    let removed   = 0;
    for (const rec of records) {
      if (!liveSet.has(rec.id)) {
        await _promisify(store.delete(rec.id));
        removed++;
      }
    }
    return removed;
  }

  /* ── Collections ────────────────────────────────────────── */

  /**
   * Get saved overrides for a collection (name, coverUrl).
   * @param {string} folderId
   * @returns {Promise<Object|null>}
   */
  async function getCollection(folderId) {
    const store = _tx('collections');
    return _promisify(store.get(folderId));
  }

  /**
   * Save/update collection overrides (name, coverUrl).
   * @param {string} folderId
   * @param {Object} changes  — { name?, coverUrl? }
   */
  async function saveCollection(folderId, changes) {
    const store    = _tx('collections', 'readwrite');
    const existing = await _promisify(store.get(folderId)) || { id: folderId };
    const now      = Date.now();
    // manualAt marks that the user explicitly edited the collection's name or cover.
    // Pass manualAt:0 in changes to clear the flag (e.g. on a full reset).
    const manualAt = (changes.manualAt !== undefined) ? changes.manualAt
                   : (changes.name !== undefined || changes.coverUrl !== undefined) ? now
                   : (existing.manualAt || 0);
    return _promisify(store.put({ ...existing, ...changes, id: folderId, manualAt, updatedAt: now }));
  }

  /**
   * Get all saved collection overrides.
   * @returns {Promise<Object[]>}
   */
  async function getAllCollections() {
    const store = _tx('collections');
    return _promisify(store.getAll());
  }

  /**
   * Delete a collection record entirely (used by Reset to originals).
   * @param {string} folderId
   */
  async function deleteCollection(folderId) {
    const store = _tx('collections', 'readwrite');
    return _promisify(store.delete(folderId));
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return {
    open,
    // Blobs
    getCachedBlob,
    setCachedBlob,
    removeCachedBlob,
    isCached,
    getCacheSize,
    clearCache,
    // Metadata
    getMeta,
    getAllMeta,
    getAllMetaLight,
    setMeta,
    clearNormGains,
    incrementPlayCount,
    toggleStar,
    getStarred,
    getTopPlayed,
    getAllPlaycounts,
    // State
    getState,
    setState,
    // Recents
    addRecent,
    getRecents,
    getRecentsAll,
    // Playlists
    createPlaylist,
    putPlaylist,
    getPlaylists,
    getPlaylist,
    updatePlaylist,
    deletePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    // Bulk writes (sync)
    bulkPutRecents,
    bulkPutMeta,
    bulkApplyPlaycounts,
    bulkWriteMeta,
    // Recents management
    removeRecent,
    clearRecents,
    clearPlaylists,
    // History
    addToHistory,
    getHistory,
    getHistoryAll,
    bulkPutHistory,
    removeFromHistory,
    clearHistory,
    clearPinned,
    clearPlaycounts,
    clearStarred,
    // Pins
    getPinned,
    togglePin,
    getPinnedFolders,
    // Rescan
    clearEnrichment,
    clearManualOverrides,
    resetToVirgin,
    purgeOrphans,
    purgeAllOrphans,
    // Collections
    getCollection,
    saveCollection,
    getAllCollections,
    deleteCollection,
    // Background collection scan log
    getBgScannedFolders,
    addBgScannedFolders,
    // Movement reconciliation
    reconcileFolderContents,
  };
})();
