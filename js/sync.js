/* ============================================================
   Savart — Sync module
   Bidirectional sync via Google Drive appDataFolder.

   Strategy:
   - IndexedDB = source of truth (fast, offline)
   - Drive appData = sync layer (cross-device persistence)

   Boot (init):
     1. Pull all remote data, merge with local (union), push back.
     2. Start live polling every POLL_INTERVAL ms.

   Live polling (Last-Write-Wins):
     - Every 3s: read savart_manifest.json (1 tiny API call).
     - For each type whose remote timestamp > local timestamp:
         pull that file → overwrite local DB → notify app.
     - Push updates manifest on every local change.

   Files in appDataFolder:
     savart_manifest.json    → { type: timestamp } index
     savart_favorites.json   → starred songs
     savart_playlists.json   → playlists
     savart_pinned.json      → pinned items
     savart_recents.json     → recently played
     savart_playcounts.json  → play counts per song
     savart_settings.json    → EQ state + tempo
   ============================================================ */

const Sync = (() => {

  const API         = CONFIG.API_BASE;
  const UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3';
  const POLL_INTERVAL = 3000; // ms between manifest checks

  const MANIFEST = 'savart_manifest.json';
  const FILENAMES = {
    favorites:  'savart_favorites.json',
    playlists:  'savart_playlists.json',
    pinned:     'savart_pinned.json',
    recents:    'savart_recents.json',
    playcounts: 'savart_playcounts.json',
    settings:   'savart_settings.json',
  };

  /* ── Private state ─────────────────────────────────────── */
  let _fileIds          = {};   // filename → Drive fileId
  let _ready            = false;
  let _timers           = {};   // debounce timers per type
  let _pollTimer        = null; // setInterval handle
  let _polling          = false;// guard against overlapping polls
  let _onDataChanged    = null; // callback(changedTypes[])

  // Local copy of what's currently in the Drive manifest.
  // If remoteTs[type] > localTs[type] → remote is newer → apply LWW.
  let _remoteTs = {}; // { type: timestamp } as seen last time we read manifest
  let _localTs  = {}; // { type: timestamp } of what we last wrote or applied

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
        console.error('[Sync] 403 — drive.appdata scope not granted.');
        throw new SyncScopeError();
      }
      throw new Error(`[Sync] Drive API ${res.status}: ${body}`);
    }
    return res;
  }

  /* ── Drive file operations ───────────────────────────────── */

  async function _refreshFileList() {
    const res = await _apiFetch(
      `${API}/files?spaces=appDataFolder&fields=files(id,name)&pageSize=30`
    );
    const { files = [] } = await res.json();
    _fileIds = {};
    for (const f of files) _fileIds[f.name] = f.id;
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
        method: 'PATCH', body: content,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      const meta = JSON.stringify({ name: filename, parents: ['appDataFolder'] });
      const form = new FormData();
      form.append('metadata', new Blob([meta], { type: 'application/json' }));
      form.append('file', content);
      const res     = await _apiFetch(
        `${UPLOAD_API}/files?uploadType=multipart&fields=id,name`,
        { method: 'POST', body: form }
      );
      const created = await res.json();
      _fileIds[filename] = created.id;
    }
  }

  /* ── Manifest ────────────────────────────────────────────── */

  /** Read manifest from Drive (returns {} if not found). */
  async function _readManifest() {
    const fileId = _fileIds[MANIFEST];
    if (!fileId) return {};
    try {
      const res = await _apiFetch(`${API}/files/${fileId}?alt=media`);
      return await res.json();
    } catch (_) { return {}; }
  }

  /**
   * Update manifest timestamps for the given types and write to Drive.
   * Also updates _localTs so we don't re-pull our own changes.
   */
  async function _bumpManifest(types) {
    const now = Date.now();
    // Read current manifest first so we preserve other types' timestamps
    const current = { ..._remoteTs };
    for (const t of types) {
      current[t] = now;
      _localTs[t] = now;
    }
    await _writeFile(MANIFEST, current);
    _remoteTs = { ...current };
  }

  /* ── Init-time merge strategies ──────────────────────────── */
  // Used only during init() to merge remote + local without data loss.
  // Live polling uses LWW (overwrite) instead.

  function _mergeFavorites(local, remote) {
    const map = new Map();
    for (const item of remote) map.set(item.id, item);
    for (const item of local)  map.set(item.id, item);
    const merged   = Array.from(map.values());
    const localIds = new Set(local.map(m => m.id));
    return { merged, toAdd: merged.filter(m => !localIds.has(m.id)) };
  }

  function _mergePlaylists(local, remote) {
    const map = new Map();
    for (const pl of local)  map.set(pl.id, pl);
    for (const pl of remote) {
      const ex = map.get(pl.id);
      if (!ex || pl.updatedAt > ex.updatedAt) map.set(pl.id, pl);
    }
    const merged   = Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    const localMap = new Map(local.map(p => [p.id, p]));
    return {
      merged,
      toUpsert: merged.filter(pl => {
        const loc = localMap.get(pl.id);
        return !loc || pl.updatedAt > loc.updatedAt;
      }),
    };
  }

  function _mergePinned(localMeta, remoteMeta) {
    return { ...remoteMeta, ...localMeta };
  }

  function _mergeRecents(local, remote) {
    const map = new Map();
    for (const item of remote) map.set(item.id, item);
    for (const item of local) {
      const ex = map.get(item.id);
      if (!ex || item.accessedAt > ex.accessedAt) map.set(item.id, item);
    }
    const merged   = Array.from(map.values())
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, CONFIG.RECENTS_MAX);
    const localIds = new Set(local.map(r => r.id));
    return { merged, toAdd: merged.filter(r => !localIds.has(r.id)) };
  }

  function _mergePlaycounts(local, remote) {
    const map = new Map();
    for (const item of local)  map.set(item.id, { ...item });
    for (const item of remote) {
      const ex = map.get(item.id);
      if (!ex) { map.set(item.id, { ...item }); }
      else { map.set(item.id, { ...ex, ...item, playCount: Math.max(ex.playCount || 0, item.playCount || 0) }); }
    }
    const merged   = Array.from(map.values());
    const localMap = new Map(local.map(m => [m.id, m]));
    return {
      merged,
      toUpsert: merged.filter(m => { const l = localMap.get(m.id); return !l || m.playCount > (l.playCount || 0); }),
    };
  }

  function _mergeSettings(local, remote) {
    if (!remote) return local;
    if (!local)  return remote;
    return (remote.savedAt || 0) > (local.savedAt || 0) ? remote : local;
  }

  /* ── LWW apply (live polling) ────────────────────────────── */
  // Remote is newer → overwrite local entirely. No merge.

  async function _applyRemote(type, data) {
    switch (type) {

      case 'favorites': {
        // Remote is the complete list: unstar anything not in it, star everything in it
        const remoteIds = new Set((data || []).map(d => d.id));
        const localStarred = await DB.getStarred();
        for (const m of localStarred) {
          if (!remoteIds.has(m.id)) await DB.setMeta(m.id, { starred: false });
        }
        for (const item of (data || [])) {
          await DB.setMeta(item.id, { ...item, starred: true });
        }
        break;
      }

      case 'playlists': {
        // Replace local playlists: delete removed, upsert all remote
        const remote   = data || [];
        const remoteIds = new Set(remote.map(p => p.id));
        const local    = await DB.getPlaylists();
        for (const pl of local) {
          if (!remoteIds.has(pl.id)) await DB.deletePlaylist(pl.id);
        }
        for (const pl of remote) await DB.putPlaylist(pl);
        break;
      }

      case 'pinned': {
        const meta = data || {};
        await DB.setState('pinnedMeta', meta);
        await DB.setState('pinned', Object.keys(meta));
        break;
      }

      case 'recents': {
        await DB.clearRecents();
        for (const item of (data || [])) await DB.addRecent(item);
        break;
      }

      case 'playcounts': {
        // Apply remote counts; songs only on this device keep their local counts
        for (const item of (data || [])) await DB.setMeta(item.id, item);
        break;
      }

      case 'settings': {
        if (data && typeof data === 'object') await DB.setState('settings', data);
        break;
      }
    }
  }

  /* ── Push helpers ────────────────────────────────────────── */

  async function _pushFavorites() {
    const starred = await DB.getStarred();
    await _writeFile(FILENAMES.favorites, starred.map(m => ({
      id: m.id, name: m.name || null, displayName: m.displayName || m.name || null,
      artist: m.artist || null, albumName: m.albumName || null, folderId: m.folderId || null,
      thumbnailUrl: (m.thumbnailUrl && !m.thumbnailUrl.startsWith('blob:')) ? m.thumbnailUrl : null,
    })));
    console.log(`[Sync] Pushed favorites (${starred.length})`);
  }

  async function _pushPlaylists() {
    const pls = await DB.getPlaylists();
    await _writeFile(FILENAMES.playlists, pls);
    console.log(`[Sync] Pushed playlists (${pls.length})`);
  }

  async function _pushPinned() {
    const raw = (await DB.getState('pinnedMeta')) || {};
    const clean = {};
    for (const [id, item] of Object.entries(raw)) {
      clean[id] = { ...item, thumbnailUrl: (item.thumbnailUrl && !item.thumbnailUrl.startsWith('blob:')) ? item.thumbnailUrl : null };
    }
    await _writeFile(FILENAMES.pinned, clean);
    console.log(`[Sync] Pushed pinned (${Object.keys(clean).length})`);
  }

  async function _pushRecents() {
    const recents = await DB.getRecents(CONFIG.RECENTS_MAX);
    await _writeFile(FILENAMES.recents, recents.map(r => ({
      id: r.id, name: r.name || null, displayName: r.displayName || r.name || null,
      type: r.type || 'song', folderId: r.folderId || null, mimeType: r.mimeType || null,
      thumbnailUrl: (r.thumbnailUrl && !r.thumbnailUrl.startsWith('blob:')) ? r.thumbnailUrl : null,
      accessedAt: r.accessedAt || Date.now(),
    })));
    console.log(`[Sync] Pushed recents (${recents.length})`);
  }

  async function _pushPlaycounts() {
    const played = await DB.getTopPlayed(10000);
    await _writeFile(FILENAMES.playcounts, played.map(m => ({
      id: m.id, name: m.name || null, displayName: m.displayName || m.name || null,
      artist: m.artist || null, folderId: m.folderId || null, playCount: m.playCount || 0,
      thumbnailUrl: (m.thumbnailUrl && !m.thumbnailUrl.startsWith('blob:')) ? m.thumbnailUrl : null,
    })));
    console.log(`[Sync] Pushed playcounts (${played.length})`);
  }

  async function _pushSettings() {
    const s = await DB.getState('settings');
    if (!s) return;
    await _writeFile(FILENAMES.settings, s);
    console.log('[Sync] Pushed settings');
  }

  const _pushFns = {
    favorites:  _pushFavorites,
    playlists:  _pushPlaylists,
    pinned:     _pushPinned,
    recents:    _pushRecents,
    playcounts: _pushPlaycounts,
    settings:   _pushSettings,
  };

  /* ── Live polling ────────────────────────────────────────── */

  async function _poll() {
    if (_polling || !Auth.isAuthenticated()) return;
    _polling = true;
    try {
      // Refresh file IDs occasionally (new files may have been created on another device)
      if (!_fileIds[MANIFEST]) await _refreshFileList();

      const manifest = await _readManifest();
      if (!manifest || !Object.keys(manifest).length) return;

      // Find types where remote is strictly newer than what we last saw
      const stale = Object.keys(FILENAMES).filter(type =>
        (manifest[type] || 0) > (_localTs[type] || 0)
      );
      if (!stale.length) return;

      console.log('[Sync] Remote changes detected:', stale);

      // Pull stale types in parallel
      const results = await Promise.allSettled(
        stale.map(type => _readFile(FILENAMES[type]).catch(() => null))
      );

      const applied = [];
      for (let i = 0; i < stale.length; i++) {
        const type = stale[i];
        const data = results[i].status === 'fulfilled' ? results[i].value : null;
        if (data !== null) {
          await _applyRemote(type, data);
          _localTs[type]  = manifest[type]; // mark as applied
          _remoteTs[type] = manifest[type];
          applied.push(type);
        }
      }

      if (applied.length > 0 && _onDataChanged) {
        _onDataChanged(applied);
      }
    } catch (err) {
      // Non-fatal — network issues, token expired, etc.
    } finally {
      _polling = false;
    }
  }

  /** Start 3-second live polling. Call once after init(). */
  function startLiveSync(onDataChanged) {
    _onDataChanged = onDataChanged || null;
    if (_pollTimer) return; // already running
    _pollTimer = setInterval(_poll, POLL_INTERVAL);
    console.log('[Sync] Live polling started (every ' + POLL_INTERVAL + 'ms)');
  }

  /** Stop polling (call on logout). */
  function stopLiveSync() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _polling = false;
    console.log('[Sync] Live polling stopped');
  }

  /* ── Public API ─────────────────────────────────────────── */

  /**
   * One-time init: pull remote, merge with local, push merged back.
   * Then starts live polling.
   */
  async function init() {
    _ready = false;
    try {
      await _refreshFileList();

      // Pull everything in parallel (including manifest)
      const [
        manifest,
        remoteFavs, remotePlaylists, remotePinned,
        remoteRecents, remotePlaycounts, remoteSettings,
      ] = await Promise.all([
        _readManifest(),
        _readFile(FILENAMES.favorites).catch(() => null),
        _readFile(FILENAMES.playlists).catch(() => null),
        _readFile(FILENAMES.pinned).catch(() => null),
        _readFile(FILENAMES.recents).catch(() => null),
        _readFile(FILENAMES.playcounts).catch(() => null),
        _readFile(FILENAMES.settings).catch(() => null),
      ]);

      // Seed remote timestamps from manifest
      _remoteTs = { ...manifest };

      // ── Merge favorites ───────────────────────────────────
      if (Array.isArray(remoteFavs) && remoteFavs.length > 0) {
        const local = await DB.getStarred();
        const localData = local.map(m => ({ id: m.id, name: m.name, displayName: m.displayName, artist: m.artist, albumName: m.albumName, thumbnailUrl: m.thumbnailUrl, folderId: m.folderId }));
        const { toAdd } = _mergeFavorites(localData, remoteFavs);
        for (const item of toAdd) await DB.setMeta(item.id, { ...item, starred: true });
        if (toAdd.length) console.log(`[Sync] Merged ${toAdd.length} remote favorites`);
      }

      // ── Merge playlists ───────────────────────────────────
      if (Array.isArray(remotePlaylists) && remotePlaylists.length > 0) {
        const local = await DB.getPlaylists();
        const { toUpsert } = _mergePlaylists(local, remotePlaylists);
        for (const pl of toUpsert) await DB.putPlaylist(pl);
        if (toUpsert.length) console.log(`[Sync] Merged ${toUpsert.length} remote playlists`);
      }

      // ── Merge pinned ──────────────────────────────────────
      if (remotePinned && typeof remotePinned === 'object') {
        const localMeta = (await DB.getState('pinnedMeta')) || {};
        const localIds  = (await DB.getState('pinned'))     || [];
        const merged    = _mergePinned(localMeta, remotePinned);
        const newIds    = Object.keys(remotePinned).filter(id => !localIds.includes(id));
        await DB.setState('pinnedMeta', merged);
        await DB.setState('pinned', [...localIds, ...newIds]);
        if (newIds.length) console.log(`[Sync] Merged ${newIds.length} remote pinned`);
      }

      // ── Merge recents ─────────────────────────────────────
      if (Array.isArray(remoteRecents) && remoteRecents.length > 0) {
        const local = await DB.getRecents(CONFIG.RECENTS_MAX);
        const { toAdd } = _mergeRecents(local, remoteRecents);
        for (const item of toAdd) await DB.addRecent(item);
        if (toAdd.length) console.log(`[Sync] Merged ${toAdd.length} remote recents`);
      }

      // ── Merge play counts ─────────────────────────────────
      if (Array.isArray(remotePlaycounts) && remotePlaycounts.length > 0) {
        const local = await DB.getTopPlayed(10000);
        const { toUpsert } = _mergePlaycounts(local, remotePlaycounts);
        for (const item of toUpsert) await DB.setMeta(item.id, item);
        if (toUpsert.length) console.log(`[Sync] Merged ${toUpsert.length} remote playcounts`);
      }

      // ── Merge settings ────────────────────────────────────
      if (remoteSettings && typeof remoteSettings === 'object') {
        const localSettings = (await DB.getState('settings')) || null;
        const merged = _mergeSettings(localSettings, remoteSettings);
        if (merged !== localSettings) {
          await DB.setState('settings', merged);
          console.log('[Sync] Merged remote settings');
        }
      }

      // Push merged state back + update manifest
      const now = Date.now();
      await Promise.allSettled(Object.values(_pushFns).map(fn => fn()));
      // Stamp all types in manifest with now
      const allTypes = Object.keys(FILENAMES);
      for (const t of allTypes) _localTs[t] = now;
      await _bumpManifest(allTypes);

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
   * Debounced push: called by app after any local data change.
   * Writes data to Drive and bumps the manifest so other devices pick it up.
   * @param {'favorites'|'playlists'|'pinned'|'recents'|'playcounts'|'settings'} type
   */
  function push(type) {
    if (!_ready) return;
    if (_timers[type]) clearTimeout(_timers[type]);
    _timers[type] = setTimeout(async () => {
      try {
        await _pushFns[type]?.();
        await _bumpManifest([type]);
      } catch (err) {
        if (err.isScope) return;
        console.warn(`[Sync] push(${type}) failed:`, err.message);
      }
    }, 2000);
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return { init, push, startLiveSync, stopLiveSync };

})();
