/* ============================================================
   Savart — Sync module
   Bidirectional sync of favorites, playlists, and pinned items
   via Google Drive's hidden appDataFolder (drive.appdata scope).

   Strategy:
   - IndexedDB = source of truth (fast, offline)
   - Drive appData = sync layer (cross-device persistence)

   On init() (after auth):
     1. List files in appDataFolder
     2. Pull remote JSON for each data type
     3. Merge with local IndexedDB (union strategy, no deletions propagated)
     4. Write merged result back to Drive

   On change (push(type)):
     - Debounced 2s → serialize IndexedDB → write to Drive in background
     - Errors are non-fatal (app keeps working with local data)

   Files in appDataFolder:
     savart_favorites.json   → starred songs
     savart_playlists.json   → playlists
     savart_pinned.json      → pinned items (home)
   ============================================================ */

const Sync = (() => {

  const API        = CONFIG.API_BASE;
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

  const FILENAMES = {
    favorites: 'savart_favorites.json',
    playlists: 'savart_playlists.json',
    pinned:    'savart_pinned.json',
  };

  /* ── Private state ─────────────────────────────────────── */
  let _fileIds   = {};       // filename → Drive fileId cache
  let _ready     = false;    // true after init() completes (or fails gracefully)
  let _timers    = {};       // debounce timers per type

  /* ── Auth helper ────────────────────────────────────────── */
  function _token() {
    const t = Auth.getValidToken();
    if (!t) throw new Error('[Sync] No valid auth token');
    return t;
  }

  async function _apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${_token()}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`[Sync] Drive API ${res.status}: ${body}`);
    }
    return res;
  }

  /* ── Drive appDataFolder operations ─────────────────────── */

  /**
   * List all files in appDataFolder and populate _fileIds cache.
   */
  async function _refreshFileList() {
    const res  = await _apiFetch(
      `${API}/files?spaces=appDataFolder&fields=files(id,name)&pageSize=20`
    );
    const { files = [] } = await res.json();
    _fileIds = {};
    for (const f of files) _fileIds[f.name] = f.id;
    console.log('[Sync] File list:', Object.keys(_fileIds));
  }

  /**
   * Read a file from appDataFolder and parse as JSON.
   * Returns null if the file doesn't exist yet.
   * @param {string} filename
   * @returns {Promise<any|null>}
   */
  async function _readFile(filename) {
    const fileId = _fileIds[filename];
    if (!fileId) return null;
    const res = await _apiFetch(`${API}/files/${fileId}?alt=media`);
    return res.json();
  }

  /**
   * Create or update a file in appDataFolder with JSON content.
   * Creates the file on first call; patches content-only on subsequent calls.
   * @param {string} filename
   * @param {any}    data
   */
  async function _writeFile(filename, data) {
    const json    = JSON.stringify(data);
    const content = new Blob([json], { type: 'application/json' });
    const fileId  = _fileIds[filename];

    if (fileId) {
      // Update existing file — media-only PATCH (no metadata change needed)
      await _apiFetch(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
        method:  'PATCH',
        body:    content,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      // Create new file in appDataFolder — multipart POST
      const metadata = JSON.stringify({ name: filename, parents: ['appDataFolder'] });
      const form     = new FormData();
      form.append('metadata', new Blob([metadata], { type: 'application/json' }));
      form.append('file', content);

      const res     = await _apiFetch(
        `${UPLOAD_API}/files?uploadType=multipart&fields=id,name`,
        { method: 'POST', body: form }
      );
      const created = await res.json();
      _fileIds[filename] = created.id;
      console.log(`[Sync] Created ${filename} → ${created.id}`);
    }
  }

  /* ── Merge strategies ────────────────────────────────────── */
  // Rule: union — we never delete on merge. Last-write wins on conflicts.
  // A deletion on device A will reappear from device B on next sync.
  // Acceptable for personal single-user use.

  /**
   * Merge starred songs: union by fileId.
   * @param {Object[]} local  — from DB.getStarred()
   * @param {Object[]} remote — from Drive
   * @returns {{ toAdd: Object[], merged: Object[] }}
   */
  function _mergeFavorites(local, remote) {
    const map = new Map();
    // Start with remote so local overwrites (local is always fresher)
    for (const item of remote) map.set(item.id, item);
    for (const item of local)  map.set(item.id, item);
    const merged = Array.from(map.values());
    const localIds = new Set(local.map(m => m.id));
    const toAdd = merged.filter(m => !localIds.has(m.id));
    return { merged, toAdd };
  }

  /**
   * Merge playlists: by id, latest updatedAt wins.
   * @param {Object[]} local
   * @param {Object[]} remote
   * @returns {{ toUpsert: Object[], merged: Object[] }}
   */
  function _mergePlaylists(local, remote) {
    const map = new Map();
    for (const pl of local)  map.set(pl.id, pl);
    for (const pl of remote) {
      const existing = map.get(pl.id);
      if (!existing || pl.updatedAt > existing.updatedAt) map.set(pl.id, pl);
    }
    const merged    = Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    const localMap  = new Map(local.map(p => [p.id, p]));
    const toUpsert  = merged.filter(pl => {
      const loc = localMap.get(pl.id);
      return !loc || pl.updatedAt > loc.updatedAt;
    });
    return { merged, toUpsert };
  }

  /**
   * Merge pinned: remote + local union, local wins on conflicts.
   * @param {Object} localMeta   — { [id]: { id, name, … } }
   * @param {Object} remoteMeta  — same shape
   * @returns {Object} merged pinnedMeta
   */
  function _mergePinned(localMeta, remoteMeta) {
    return { ...remoteMeta, ...localMeta };
  }

  /* ── Push helpers (serialize local → Drive) ──────────────── */

  async function _pushFavorites() {
    const starred = await DB.getStarred();
    const data = starred.map(m => ({
      id:           m.id,
      name:         m.name         || null,
      displayName:  m.displayName  || m.name || null,
      artist:       m.artist       || null,
      albumName:    m.albumName    || null,
      thumbnailUrl: (m.thumbnailUrl && !m.thumbnailUrl.startsWith('blob:'))
                      ? m.thumbnailUrl : null,
      folderId:     m.folderId     || null,
    }));
    await _writeFile(FILENAMES.favorites, data);
    console.log(`[Sync] Pushed favorites (${data.length} items)`);
  }

  async function _pushPlaylists() {
    const playlists = await DB.getPlaylists();
    await _writeFile(FILENAMES.playlists, playlists);
    console.log(`[Sync] Pushed playlists (${playlists.length} items)`);
  }

  async function _pushPinned() {
    const pinnedMeta = (await DB.getState('pinnedMeta')) || {};
    // Strip blob: URLs before sending to Drive
    const clean = {};
    for (const [id, item] of Object.entries(pinnedMeta)) {
      clean[id] = {
        ...item,
        thumbnailUrl: (item.thumbnailUrl && !item.thumbnailUrl.startsWith('blob:'))
                        ? item.thumbnailUrl : null,
      };
    }
    await _writeFile(FILENAMES.pinned, clean);
    console.log(`[Sync] Pushed pinned (${Object.keys(clean).length} items)`);
  }

  /* ── Public API ─────────────────────────────────────────── */

  /**
   * Initialize sync: pull remote data, merge with local, write merged back.
   * Must be called after Auth is ready (valid token available).
   * Non-blocking and non-fatal — the app works fine if sync fails.
   */
  async function init() {
    _ready = false;
    try {
      await _refreshFileList();

      // Pull all three files in parallel
      const [remoteFavs, remotePlaylists, remotePinned] = await Promise.all([
        _readFile(FILENAMES.favorites).catch(() => null),
        _readFile(FILENAMES.playlists).catch(() => null),
        _readFile(FILENAMES.pinned).catch(() => null),
      ]);

      // ── Merge favorites ──────────────────────────────────
      if (Array.isArray(remoteFavs) && remoteFavs.length > 0) {
        const localStarred = await DB.getStarred();
        const localData = localStarred.map(m => ({
          id: m.id, name: m.name, displayName: m.displayName,
          artist: m.artist, albumName: m.albumName, thumbnailUrl: m.thumbnailUrl,
          folderId: m.folderId,
        }));
        const { toAdd } = _mergeFavorites(localData, remoteFavs);
        for (const item of toAdd) {
          await DB.setMeta(item.id, { ...item, starred: true });
        }
        if (toAdd.length > 0) console.log(`[Sync] Merged ${toAdd.length} remote favorites into local`);
      }

      // ── Merge playlists ──────────────────────────────────
      if (Array.isArray(remotePlaylists) && remotePlaylists.length > 0) {
        const localPlaylists = await DB.getPlaylists();
        const { toUpsert } = _mergePlaylists(localPlaylists, remotePlaylists);
        for (const pl of toUpsert) {
          await DB.putPlaylist(pl);
        }
        if (toUpsert.length > 0) console.log(`[Sync] Merged ${toUpsert.length} remote playlists into local`);
      }

      // ── Merge pinned ──────────────────────────────────────
      if (remotePinned && typeof remotePinned === 'object') {
        const localMeta = (await DB.getState('pinnedMeta')) || {};
        const localIds  = (await DB.getState('pinned'))     || [];
        const merged    = _mergePinned(localMeta, remotePinned);
        // Rebuild pinned ID array from merged meta keys
        const remoteIds = Object.keys(remotePinned).filter(id => !localIds.includes(id));
        const mergedIds = [...localIds, ...remoteIds];
        await DB.setState('pinnedMeta', merged);
        await DB.setState('pinned', mergedIds);
        if (remoteIds.length > 0) console.log(`[Sync] Merged ${remoteIds.length} remote pinned items`);
      }

      // Write the merged result back to Drive so all devices converge
      await Promise.allSettled([
        _pushFavorites(),
        _pushPlaylists(),
        _pushPinned(),
      ]);

      console.log('[Sync] Init complete.');
    } catch (err) {
      console.warn('[Sync] init() failed (non-fatal):', err.message);
    } finally {
      _ready = true;
    }
  }

  /**
   * Schedule a debounced push to Drive for the given data type.
   * Safe to call on every user action — only fires 2s after the last call.
   * @param {'favorites'|'playlists'|'pinned'} type
   */
  function push(type) {
    if (!_ready) return;
    if (_timers[type]) clearTimeout(_timers[type]);
    _timers[type] = setTimeout(() => _doPush(type), 2000);
  }

  async function _doPush(type) {
    try {
      if (type === 'favorites') await _pushFavorites();
      else if (type === 'playlists') await _pushPlaylists();
      else if (type === 'pinned')    await _pushPinned();
    } catch (err) {
      console.warn(`[Sync] push(${type}) failed (non-fatal):`, err.message);
    }
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return { init, push };

})();
