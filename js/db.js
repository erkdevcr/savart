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
      .filter(e => e.playCount > 0)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, limit);
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
    const valid = (items || []).filter(r => r && r.id).slice(0, CONFIG.RECENTS_MAX);
    if (!valid.length) return;
    await new Promise((resolve, reject) => {
      const tx    = _db.transaction('recents', 'readwrite');
      const store = tx.objectStore('recents');
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
      // Fire ALL puts synchronously — no await between them → transaction stays open
      for (const item of valid) {
        store.put({ ...item, accessedAt: item.accessedAt ?? Date.now() });
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
      for (const item of valid) {
        // Strip null/undefined to avoid clobbering existing valid fields
        const clean = Object.fromEntries(
          Object.entries(item).filter(([, v]) => v !== undefined && v !== null)
        );
        // Provide defaults for required fields so the record is always complete
        store.put({ playCount: 0, starred: false, ...clean, id: item.id });
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
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, limit);
  }

  async function _trimRecents() {
    const store   = _tx('recents', 'readwrite');
    const entries = await _promisify(store.getAll());
    if (entries.length <= CONFIG.RECENTS_MAX) return;
    entries.sort((a, b) => a.accessedAt - b.accessedAt);
    const toDelete = entries.slice(0, entries.length - CONFIG.RECENTS_MAX);
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
    return pls.sort((a, b) => b.updatedAt - a.updatedAt);
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
   * @param {string} id
   */
  async function removeRecent(id) {
    const store = _tx('recents', 'readwrite');
    await _promisify(store.delete(id));
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
    const meta = await getState('pinnedMeta') || {};
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
    const safeThumb = (item.thumbnailUrl && !item.thumbnailUrl.startsWith('blob:'))
      ? item.thumbnailUrl : (item.thumbnailLink || null);
    await _promisify(store.put({
      id:           item.id,
      name:         item.name        || '',
      displayName:  item.displayName || item.name || '',
      artist:       item.artist      || '',
      thumbnailUrl: safeThumb,
      folderId:     item.parents?.[0] || item.folderId || null,
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
      .filter(e => e.playedAt >= cutoff)
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
    const store = _tx('history', 'readwrite');
    return _promisify(store.delete(id));
  }

  /**
   * Clear all history (used by LWW sync to replace with remote data).
   */
  async function clearHistory() {
    const store = _tx('history', 'readwrite');
    return _promisify(store.clear());
  }

  /** Trim history: remove oldest entries beyond HISTORY_MAX and older than HISTORY_MAX_DAYS. */
  async function _trimHistory() {
    const store   = _tx('history', 'readwrite');
    const entries = await _promisify(store.getAll());
    const cutoff  = Date.now() - CONFIG.HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;

    // Drop stale entries by age
    for (const e of entries) {
      if (e.playedAt < cutoff) await _promisify(store.delete(e.id));
    }

    // Trim to hard limit (keep most recent)
    const remaining = entries.filter(e => e.playedAt >= cutoff);
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
    const ENRICH_FIELDS = [
      'artist', 'album', 'year', 'track',
      'mbTried', 'auddTried', 'mbReleaseMbid',
      'thumbnailUrl', 'coverUrl',
    ];
    for (const f of ENRICH_FIELDS) delete existing[f];
    return _promisify(store.put(existing));
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
    setMeta,
    incrementPlayCount,
    toggleStar,
    getStarred,
    getTopPlayed,
    // State
    getState,
    setState,
    // Recents
    addRecent,
    getRecents,
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
    // Recents management
    removeRecent,
    clearRecents,
    clearPlaylists,
    // History
    addToHistory,
    getHistory,
    bulkPutHistory,
    removeFromHistory,
    clearHistory,
    // Pins
    getPinned,
    togglePin,
    getPinnedFolders,
    // Rescan
    clearEnrichment,
  };
})();
