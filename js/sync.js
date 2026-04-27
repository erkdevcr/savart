/* ============================================================
   Savart — Sync module
   Bidirectional sync of user data via Google Drive appDataFolder.

   Strategy:
   - IndexedDB = source of truth (fast, offline)
   - Drive appData = sync layer (cross-device persistence)

   On init() (after auth):
     1. List files in appDataFolder
     2. Pull remote JSON for each data type
     3. Merge with local IndexedDB (union strategy)
     4. Write merged result back to Drive

   On change (push(type)):
     - Debounced 2s → serialize IndexedDB → write to Drive
     - Errors are non-fatal

   Files in appDataFolder:
     savart_favorites.json   → starred songs
     savart_playlists.json   → playlists
     savart_pinned.json      → pinned items (home)
     savart_recents.json     → recently played
     savart_playcounts.json  → play counts per song
     savart_settings.json    → EQ state + tempo
   ============================================================ */

const Sync = (() => {

  const API        = CONFIG.API_BASE;
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

  const FILENAMES = {
    favorites:  'savart_favorites.json',
    playlists:  'savart_playlists.json',
    pinned:     'savart_pinned.json',
    recents:    'savart_recents.json',
    playcounts: 'savart_playcounts.json',
    settings:   'savart_settings.json',
  };

  /* ── Private state ─────────────────────────────────────── */
  let _fileIds   = {};       // filename → Drive fileId cache
  let _ready     = false;    // true after init() completes (or fails gracefully)
  let _timers    = {};       // debounce timers per type

  /* ── Error types ────────────────────────────────────────── */
  class SyncScopeError extends Error {
    constructor() { super('drive.appdata scope not granted'); this.isScope = true; }
  }

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
      if (res.status === 403) {
        console.error('[Sync] 403 — drive.appdata scope not granted. Body:', body);
        throw new SyncScopeError();
      }
      throw new Error(`[Sync] Drive API ${res.status}: ${body}`);
    }
    return res;
  }

  /* ── Drive appDataFolder operations ─────────────────────── */

  async function _refreshFileList() {
    const res  = await _apiFetch(
      `${API}/files?spaces=appDataFolder&fields=files(id,name)&pageSize=20`
    );
    const { files = [] } = await res.json();
    _fileIds = {};
    for (const f of files) _fileIds[f.name] = f.id;
    console.log('[Sync] File list:', Object.keys(_fileIds));
  }

  async function _readFile(filename) {
    const fileId = _fileIds[filename];
    if (!fileId) return null;
    const res = await _apiFetch(`${API}/files/${fileId}?alt=media`);
    return res.json();
  }

  async function _writeFile(filename, data) {
    const json    = JSON.stringify(data);
    const content = new Blob([json], { type: 'application/json' });
    const fileId  = _fileIds[filename];

    if (fileId) {
      await _apiFetch(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
        method:  'PATCH',
        body:    content,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
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

  /** Favorites: union by fileId. Local always wins on conflict. */
  function _mergeFavorites(local, remote) {
    const map = new Map();
    for (const item of remote) map.set(item.id, item);
    for (const item of local)  map.set(item.id, item);
    const merged  = Array.from(map.values());
    const localIds = new Set(local.map(m => m.id));
    const toAdd   = merged.filter(m => !localIds.has(m.id));
    return { merged, toAdd };
  }

  /** Playlists: by id, latest updatedAt wins. */
  function _mergePlaylists(local, remote) {
    const map = new Map();
    for (const pl of local)  map.set(pl.id, pl);
    for (const pl of remote) {
      const existing = map.get(pl.id);
      if (!existing || pl.updatedAt > existing.updatedAt) map.set(pl.id, pl);
    }
    const merged   = Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    const localMap = new Map(local.map(p => [p.id, p]));
    const toUpsert = merged.filter(pl => {
      const loc = localMap.get(pl.id);
      return !loc || pl.updatedAt > loc.updatedAt;
    });
    return { merged, toUpsert };
  }

  /** Pinned: union, local wins on conflict. */
  function _mergePinned(localMeta, remoteMeta) {
    return { ...remoteMeta, ...localMeta };
  }

  /** Recents: union by id, most recent accessedAt wins, sorted desc, capped. */
  function _mergeRecents(local, remote) {
    const map = new Map();
    for (const item of remote) map.set(item.id, item);
    for (const item of local) {
      const ex = map.get(item.id);
      if (!ex || item.accessedAt > ex.accessedAt) map.set(item.id, item);
    }
    const merged  = Array.from(map.values())
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, CONFIG.RECENTS_MAX);
    const localIds = new Set(local.map(r => r.id));
    const toAdd   = merged.filter(r => !localIds.has(r.id));
    return { merged, toAdd };
  }

  /** Play counts: union by id, take maximum playCount. */
  function _mergePlaycounts(local, remote) {
    const map = new Map();
    for (const item of local)  map.set(item.id, { ...item });
    for (const item of remote) {
      const ex = map.get(item.id);
      if (!ex) {
        map.set(item.id, { ...item });
      } else {
        map.set(item.id, {
          ...ex, ...item,
          playCount: Math.max(ex.playCount || 0, item.playCount || 0),
        });
      }
    }
    const merged   = Array.from(map.values());
    const localMap = new Map(local.map(m => [m.id, m]));
    const toUpsert = merged.filter(m => {
      const loc = localMap.get(m.id);
      return !loc || m.playCount > (loc.playCount || 0);
    });
    return { merged, toUpsert };
  }

  /** Settings (EQ + tempo): last-write wins by savedAt timestamp. */
  function _mergeSettings(local, remote) {
    if (!remote) return local;
    if (!local)  return remote;
    return (remote.savedAt || 0) > (local.savedAt || 0) ? remote : local;
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

  async function _pushRecents() {
    const recents = await DB.getRecents(CONFIG.RECENTS_MAX);
    const data = recents.map(r => ({
      id:           r.id,
      name:         r.name         || null,
      displayName:  r.displayName  || r.name || null,
      type:         r.type         || 'song',
      folderId:     r.folderId     || null,
      mimeType:     r.mimeType     || null,
      thumbnailUrl: (r.thumbnailUrl && !r.thumbnailUrl.startsWith('blob:'))
                      ? r.thumbnailUrl : null,
      accessedAt:   r.accessedAt   || Date.now(),
    }));
    await _writeFile(FILENAMES.recents, data);
    console.log(`[Sync] Pushed recents (${data.length} items)`);
  }

  async function _pushPlaycounts() {
    // getTopPlayed with a high limit returns all tracks with playCount > 0
    const played = await DB.getTopPlayed(10000);
    const data = played.map(m => ({
      id:           m.id,
      name:         m.name         || null,
      displayName:  m.displayName  || m.name || null,
      artist:       m.artist       || null,
      folderId:     m.folderId     || null,
      thumbnailUrl: (m.thumbnailUrl && !m.thumbnailUrl.startsWith('blob:'))
                      ? m.thumbnailUrl : null,
      playCount:    m.playCount    || 0,
    }));
    await _writeFile(FILENAMES.playcounts, data);
    console.log(`[Sync] Pushed playcounts (${data.length} items)`);
  }

  async function _pushSettings() {
    const settings = (await DB.getState('settings')) || null;
    if (!settings) return; // nothing saved yet — skip
    await _writeFile(FILENAMES.settings, settings);
    console.log('[Sync] Pushed settings');
  }

  /* ── Public API ─────────────────────────────────────────── */

  /**
   * Initialize sync: pull remote data, merge with local, write merged back.
   * Must be called after Auth is ready (valid token available).
   * Non-blocking and non-fatal. Returns a Promise so callers can await it.
   */
  async function init() {
    _ready = false;
    try {
      await _refreshFileList();

      // Pull all six files in parallel
      const [
        remoteFavs, remotePlaylists, remotePinned,
        remoteRecents, remotePlaycounts, remoteSettings,
      ] = await Promise.all([
        _readFile(FILENAMES.favorites).catch(() => null),
        _readFile(FILENAMES.playlists).catch(() => null),
        _readFile(FILENAMES.pinned).catch(() => null),
        _readFile(FILENAMES.recents).catch(() => null),
        _readFile(FILENAMES.playcounts).catch(() => null),
        _readFile(FILENAMES.settings).catch(() => null),
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
        for (const item of toAdd) await DB.setMeta(item.id, { ...item, starred: true });
        if (toAdd.length > 0) console.log(`[Sync] Merged ${toAdd.length} remote favorites`);
      }

      // ── Merge playlists ──────────────────────────────────
      if (Array.isArray(remotePlaylists) && remotePlaylists.length > 0) {
        const localPlaylists = await DB.getPlaylists();
        const { toUpsert } = _mergePlaylists(localPlaylists, remotePlaylists);
        for (const pl of toUpsert) await DB.putPlaylist(pl);
        if (toUpsert.length > 0) console.log(`[Sync] Merged ${toUpsert.length} remote playlists`);
      }

      // ── Merge pinned ─────────────────────────────────────
      if (remotePinned && typeof remotePinned === 'object') {
        const localMeta = (await DB.getState('pinnedMeta')) || {};
        const localIds  = (await DB.getState('pinned'))     || [];
        const merged    = _mergePinned(localMeta, remotePinned);
        const remoteIds = Object.keys(remotePinned).filter(id => !localIds.includes(id));
        await DB.setState('pinnedMeta', merged);
        await DB.setState('pinned', [...localIds, ...remoteIds]);
        if (remoteIds.length > 0) console.log(`[Sync] Merged ${remoteIds.length} remote pinned`);
      }

      // ── Merge recents ────────────────────────────────────
      if (Array.isArray(remoteRecents) && remoteRecents.length > 0) {
        const localRecents = await DB.getRecents(CONFIG.RECENTS_MAX);
        const { toAdd } = _mergeRecents(localRecents, remoteRecents);
        for (const item of toAdd) await DB.addRecent(item);
        if (toAdd.length > 0) console.log(`[Sync] Merged ${toAdd.length} remote recents`);
      }

      // ── Merge play counts ────────────────────────────────
      if (Array.isArray(remotePlaycounts) && remotePlaycounts.length > 0) {
        const localPlayed = await DB.getTopPlayed(10000);
        const { toUpsert } = _mergePlaycounts(localPlayed, remotePlaycounts);
        for (const item of toUpsert) await DB.setMeta(item.id, item);
        if (toUpsert.length > 0) console.log(`[Sync] Merged ${toUpsert.length} remote playcounts`);
      }

      // ── Merge settings (EQ + tempo) ──────────────────────
      if (remoteSettings && typeof remoteSettings === 'object') {
        const localSettings = (await DB.getState('settings')) || null;
        const merged = _mergeSettings(localSettings, remoteSettings);
        if (merged !== localSettings) {
          // Remote was newer — persist so app restores it on next _restoreSettings() call
          await DB.setState('settings', merged);
          console.log('[Sync] Merged remote settings (newer)');
        }
      }

      // Write the fully merged state back to Drive so all devices converge
      await Promise.allSettled([
        _pushFavorites(),
        _pushPlaylists(),
        _pushPinned(),
        _pushRecents(),
        _pushPlaycounts(),
        _pushSettings(),
      ]);

      console.log('[Sync] Init complete ✓');
    } catch (err) {
      if (err.isScope) {
        console.warn('[Sync] Missing drive.appdata scope — requesting consent.');
        setTimeout(() => Auth.requestTokenWithConsent(), 800);
      } else {
        console.warn('[Sync] init() failed (non-fatal):', err.message);
      }
    } finally {
      _ready = true;
    }
  }

  /**
   * Schedule a debounced push to Drive for the given data type.
   * @param {'favorites'|'playlists'|'pinned'|'recents'|'playcounts'|'settings'} type
   */
  function push(type) {
    if (!_ready) return;
    if (_timers[type]) clearTimeout(_timers[type]);
    _timers[type] = setTimeout(() => _doPush(type), 2000);
  }

  async function _doPush(type) {
    try {
      if      (type === 'favorites')  await _pushFavorites();
      else if (type === 'playlists')  await _pushPlaylists();
      else if (type === 'pinned')     await _pushPinned();
      else if (type === 'recents')    await _pushRecents();
      else if (type === 'playcounts') await _pushPlaycounts();
      else if (type === 'settings')   await _pushSettings();
    } catch (err) {
      if (err.isScope) return;
      console.warn(`[Sync] push(${type}) failed:`, err.message);
    }
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return { init, push };

})();
