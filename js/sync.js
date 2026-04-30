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
    history:    'savart_history.json',
    metadata:   'savart_metadata.json',
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
    // Start with remote, then let local win only when it has a newer (or equal) starredAt.
    // This gives LWW per-item: if remote was starred more recently, it takes priority.
    for (const item of remote) map.set(item.id, item);
    for (const item of local) {
      const ex = map.get(item.id);
      if (!ex || (item.starredAt || 0) >= (ex.starredAt || 0)) map.set(item.id, item);
    }
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

  function _mergeHistory(local, remote) {
    const map = new Map();
    for (const item of remote) map.set(item.id, item);
    for (const item of local) {
      const ex = map.get(item.id);
      if (!ex || (item.playedAt || 0) >= (ex.playedAt || 0)) map.set(item.id, item);
    }
    const cutoff = Date.now() - CONFIG.HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
    const merged = Array.from(map.values())
      .filter(e => (e.playedAt || 0) >= cutoff)
      .sort((a, b) => b.playedAt - a.playedAt)
      .slice(0, CONFIG.HISTORY_MAX);
    const localIds = new Set(local.map(r => r.id));
    return { merged, toAdd: merged.filter(r => !localIds.has(r.id)) };
  }

  /* ── LWW apply (live polling) ────────────────────────────── */
  // Remote is newer → overwrite local entirely. No merge.

  async function _applyRemote(type, data) {
    switch (type) {

      case 'favorites': {
        // LWW per item: for additions, only apply if remote starredAt >= local starredAt.
        // For removals (item in local but not in remote), remote wins — the manifest timestamp
        // already guarantees the remote file is newer overall, so a missing item means un-starred.
        const remote       = data || [];
        const remoteIds    = new Set(remote.map(d => d.id));
        const localStarred = await DB.getStarred();
        const localMap     = new Map(localStarred.map(m => [m.id, m]));

        // Un-star items absent from remote (remote is newer per manifest LWW)
        for (const m of localStarred) {
          if (!remoteIds.has(m.id)) await DB.setMeta(m.id, { starred: false, starredAt: undefined });
        }
        // Star/update remote items — only overwrite if remote is newer or item is new locally
        for (const item of remote) {
          const loc = localMap.get(item.id);
          const remoteTs = item.starredAt || 0;
          const localTs  = loc?.starredAt  || 0;
          if (!loc || remoteTs >= localTs) {
            await DB.setMeta(item.id, { ...item, starred: true });
          }
        }
        break;
      }

      case 'playlists': {
        // LWW per playlist using updatedAt.
        // Deletions: if remote doesn't have a playlist that exists locally, remote wins (it was deleted).
        // Upserts: only overwrite local if remote version has a newer or equal updatedAt.
        const remote    = data || [];
        const remoteIds = new Set(remote.map(p => p.id));
        const local     = await DB.getPlaylists();
        const localMap  = new Map(local.map(p => [p.id, p]));

        // Delete playlists absent from remote (remote is authoritative per LWW manifest)
        for (const pl of local) {
          if (!remoteIds.has(pl.id)) await DB.deletePlaylist(pl.id);
        }
        // Upsert remote playlists — skip if local version is newer (per-playlist LWW)
        for (const pl of remote) {
          const loc = localMap.get(pl.id);
          if (!loc || (pl.updatedAt || 0) >= (loc.updatedAt || 0)) {
            await DB.putPlaylist(pl);
          }
        }
        break;
      }

      case 'pinned': {
        const meta = data || {};
        await DB.setState('pinnedMeta', meta);
        await DB.setState('pinned', Object.keys(meta));
        break;
      }

      case 'recents': {
        const validRecents = (data || []).filter(r => r && r.id);
        await DB.clearRecents();
        if (validRecents.length) await DB.bulkPutRecents(validRecents);
        break;
      }

      case 'playcounts': {
        // Apply remote counts using a single transaction (avoids IDB async-deadlock)
        const validCounts = (data || []).filter(r => r && r.id);
        if (validCounts.length) await DB.bulkPutMeta(validCounts);
        break;
      }

      case 'settings': {
        if (data && typeof data === 'object') await DB.setState('settings', data);
        break;
      }

      case 'history': {
        const validHistory = (data || []).filter(r => r && r.id);
        await DB.clearHistory();
        if (validHistory.length) await DB.bulkPutHistory(validHistory);
        break;
      }

      case 'metadata': {
        // Merge strategy:
        //   • name / displayName / folderId / thumbnailUrl / coverUrl → fill-only (local file data wins)
        //   • mbTried / auddTried → adopt if remote is true (skip redundant enrichment)
        //   • mbReleaseMbid → fill-only (both devices queried MB independently)
        //   • artist / album / year → fill-only normally, BUT overwrite if remote was MB/AudD-enriched
        //     (mbTried || auddTried on the remote record means those values came from a real lookup,
        //      not from folder-name inference — they should win over the locally inferred values)
        const FILL_ONLY   = ['name', 'displayName', 'folderId', 'mbReleaseMbid', 'thumbnailUrl', 'coverUrl'];
        const TEXT_FIELDS = ['artist', 'album', 'year'];
        for (const item of (data || [])) {
          if (!item?.id) continue;
          const ex = await DB.getMeta(item.id);
          const patch = {};

          // Enrichment flags
          if (item.mbTried)   patch.mbTried   = true;
          if (item.auddTried) patch.auddTried = true;

          // Fill-only fields
          for (const f of FILL_ONLY) {
            if (item[f] === null || item[f] === undefined || item[f] === '') continue;
            if (!ex?.[f]) patch[f] = item[f];
          }

          // Text fields: overwrite if remote is enriched (MB/AudD), otherwise fill-only
          const remoteIsEnriched = item.mbTried || item.auddTried;
          for (const f of TEXT_FIELDS) {
            if (item[f] === null || item[f] === undefined || item[f] === '') continue;
            if (remoteIsEnriched || !ex?.[f]) patch[f] = item[f];
          }

          if (Object.keys(patch).length > 0) await DB.setMeta(item.id, patch);
        }
        break;
      }
    }
  }

  /* ── Push helpers ────────────────────────────────────────── */

  async function _pushFavorites() {
    const starred = await DB.getStarred();
    const now = Date.now();
    await _writeFile(FILENAMES.favorites, starred.map(m => ({
      id: m.id, name: m.name || null, displayName: m.displayName || m.name || null,
      artist: m.artist || null, albumName: m.albumName || null, folderId: m.folderId || null,
      thumbnailUrl: (m.thumbnailUrl && !m.thumbnailUrl.startsWith('blob:')) ? m.thumbnailUrl : null,
      starredAt: m.starredAt || now, // LWW: carry timestamp; existing items without starredAt get push-time
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
      accessedAt: r.accessedAt ?? Date.now(),
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
    // Always write something so other devices can pick up settings on first sync.
    // Fall back to an empty-but-valid object if the user hasn't changed anything yet.
    const s = (await DB.getState('settings')) || {};
    await _writeFile(FILENAMES.settings, s);
    console.log('[Sync] Pushed settings');
  }

  async function _pushHistory() {
    const history = await DB.getHistory(CONFIG.HISTORY_MAX);
    await _writeFile(FILENAMES.history, history.map(h => ({
      id:           h.id,
      name:         h.name         || null,
      displayName:  h.displayName  || h.name || null,
      artist:       h.artist       || null,
      folderId:     h.folderId     || null,
      thumbnailUrl: (h.thumbnailUrl && !h.thumbnailUrl.startsWith('blob:')) ? h.thumbnailUrl : null,
      playedAt:     h.playedAt     ?? Date.now(),
    })));
    console.log(`[Sync] Pushed history (${history.length})`);
  }

  async function _pushMetadata() {
    // Fields that identify the song and its album membership —
    // synced so that other devices can rebuild the Library without re-scanning.
    const SYNC_FIELDS = [
      'name', 'displayName', 'folderId',           // album membership + display title
      'artist', 'album', 'year',                    // enriched text
      'mbTried', 'auddTried', 'mbReleaseMbid',      // enrichment flags / IDs
    ];
    const isExternalUrl = u => u && !u.startsWith('blob:')
      && !u.includes('googleusercontent.com') && !u.includes('googleapis.com');

    const all = await DB.getAllMeta();
    const toSync = all
      // Include every song that has been scanned into any folder OR has any enrichment.
      // Songs with only a folderId carry name/displayName/folderId so other devices can
      // build the Library; enrichment flags prevent redundant lookups on the remote device.
      .filter(m => m.folderId || m.mbTried || m.auddTried || m.artist || m.album || m.year)
      .map(m => {
        const rec = { id: m.id };
        for (const f of SYNC_FIELDS) {
          if (m[f] !== null && m[f] !== undefined && m[f] !== '') rec[f] = m[f];
        }
        if (isExternalUrl(m.thumbnailUrl)) rec.thumbnailUrl = m.thumbnailUrl;
        if (isExternalUrl(m.coverUrl))     rec.coverUrl     = m.coverUrl;
        return rec;
      });
    await _writeFile(FILENAMES.metadata, toSync);
    console.log(`[Sync] Pushed metadata (${toSync.length} songs)`);
  }

  const _pushFns = {
    favorites:  _pushFavorites,
    playlists:  _pushPlaylists,
    pinned:     _pushPinned,
    recents:    _pushRecents,
    playcounts: _pushPlaycounts,
    settings:   _pushSettings,
    history:    _pushHistory,
    metadata:   _pushMetadata,
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

    // Track which merge steps failed so we can skip their push (prevents data-poisoning:
    // a failed merge leaves local DB empty for that type — pushing that empty state to Drive
    // would wipe the source device's data via LWW on its next poll).
    const _failedTypes = new Set();

    // Helper: run a merge step, logging errors without aborting other steps
    async function _mergeStep(name, fn) {
      try {
        await fn();
      } catch (err) {
        _failedTypes.add(name);
        console.warn(`[Sync] Merge step "${name}" failed (skipped):`, err.message || err);
      }
    }

    try {
      await _refreshFileList();

      // Pull everything in parallel (including manifest)
      const [
        manifest,
        remoteFavs, remotePlaylists, remotePinned,
        remoteRecents, remotePlaycounts, remoteSettings, remoteHistory,
        remoteMetadata,
      ] = await Promise.all([
        _readManifest(),
        _readFile(FILENAMES.favorites).catch(() => null),
        _readFile(FILENAMES.playlists).catch(() => null),
        _readFile(FILENAMES.pinned).catch(() => null),
        _readFile(FILENAMES.recents).catch(() => null),
        _readFile(FILENAMES.playcounts).catch(() => null),
        _readFile(FILENAMES.settings).catch(() => null),
        _readFile(FILENAMES.history).catch(() => null),
        _readFile(FILENAMES.metadata).catch(() => null),
      ]);

      // Seed remote timestamps from manifest
      _remoteTs = { ...manifest };

      // ── Merge favorites ───────────────────────────────────
      // Full LWW merge using starredAt timestamps:
      //   - Remote items not in local   → add locally (starred on another device while offline)
      //   - Local items not in remote   → remove IF starredAt ≤ remoteManifestTs
      //     (meaning the remote had a chance to include them but didn't → un-starred elsewhere)
      //     If starredAt > remoteManifestTs the song was starred offline → keep & push it back.
      await _mergeStep('favorites', async () => {
        const local      = await DB.getStarred();
        const remoteList = Array.isArray(remoteFavs) ? remoteFavs : [];
        const remoteIds  = new Set(remoteList.map(r => r.id));
        const localIds   = new Set(local.map(m => m.id));
        // Timestamp of last known remote snapshot — used as the un-star cutoff.
        const remoteManifestTs = _remoteTs.favorites || 0;

        let added = 0, removed = 0;

        // Add remote items missing locally
        for (const item of remoteList) {
          if (!localIds.has(item.id)) {
            await DB.setMeta(item.id, { ...item, starred: true });
            added++;
          }
        }

        // Remove local items absent from remote that predate the remote snapshot
        for (const m of local) {
          if (!remoteIds.has(m.id) && remoteManifestTs > 0 && (m.starredAt || 0) <= remoteManifestTs) {
            await DB.setMeta(m.id, { starred: false });
            removed++;
          }
        }

        if (added || removed) console.log(`[Sync] Favorites merged: +${added} added, −${removed} removed`);
      });

      // ── Merge playlists ───────────────────────────────────
      await _mergeStep('playlists', async () => {
        if (!Array.isArray(remotePlaylists) || remotePlaylists.length === 0) return;
        const local = await DB.getPlaylists();
        const { toUpsert } = _mergePlaylists(local, remotePlaylists);
        for (const pl of toUpsert) await DB.putPlaylist(pl);
        if (toUpsert.length) console.log(`[Sync] Merged ${toUpsert.length} remote playlists`);
      });

      // ── Merge pinned ──────────────────────────────────────
      await _mergeStep('pinned', async () => {
        if (!remotePinned || typeof remotePinned !== 'object') return;
        const localMeta = (await DB.getState('pinnedMeta')) || {};
        const localIds  = (await DB.getState('pinned'))     || [];
        const merged    = _mergePinned(localMeta, remotePinned);
        const newIds    = Object.keys(remotePinned).filter(id => !localIds.includes(id));
        await DB.setState('pinnedMeta', merged);
        await DB.setState('pinned', [...localIds, ...newIds]);
        if (newIds.length) console.log(`[Sync] Merged ${newIds.length} remote pinned`);
      });

      // ── Merge recents ─────────────────────────────────────
      await _mergeStep('recents', async () => {
        if (!Array.isArray(remoteRecents) || remoteRecents.length === 0) return;
        const validRemote = remoteRecents.filter(r => r && r.id);
        if (!validRemote.length) return;
        const local = await DB.getRecents(CONFIG.RECENTS_MAX);
        const { merged } = _mergeRecents(local, validRemote);
        if (!merged.length) return;

        // Write the FULL merged set, not just toAdd (new-id items).
        // Bug without this: an item present on both devices keeps the LOCAL accessedAt
        // even when remote is newer. The next push then writes stale timestamps to Drive,
        // which LWW applies back to the other device — making old items look "fresh".
        const localMap = new Map(local.map(r => [r.id, r]));
        const toWrite  = merged.filter(m => {
          const l = localMap.get(m.id);
          return !l || m.accessedAt > (l.accessedAt || 0);
        });
        if (toWrite.length) {
          await DB.bulkPutRecents(toWrite);
          console.log(`[Sync] Merged recents: ${toWrite.filter(m => !localMap.has(m.id)).length} added, ${toWrite.filter(m => localMap.has(m.id)).length} updated`);
        }
      });

      // ── Merge play counts ─────────────────────────────────
      await _mergeStep('playcounts', async () => {
        if (!Array.isArray(remotePlaycounts) || remotePlaycounts.length === 0) return;
        const validRemote = remotePlaycounts.filter(r => r && r.id);
        if (!validRemote.length) return;
        const local = await DB.getTopPlayed(10000);
        const { toUpsert } = _mergePlaycounts(local, validRemote);
        if (toUpsert.length) {
          await DB.bulkPutMeta(toUpsert);
          console.log(`[Sync] Merged ${toUpsert.length} remote playcounts`);
        }
      });

      // ── Merge settings ────────────────────────────────────
      await _mergeStep('settings', async () => {
        if (!remoteSettings || typeof remoteSettings !== 'object') return;
        const localSettings = (await DB.getState('settings')) || null;
        const merged = _mergeSettings(localSettings, remoteSettings);
        if (merged !== localSettings) {
          await DB.setState('settings', merged);
          console.log('[Sync] Merged remote settings');
        }
      });

      // ── Merge history ─────────────────────────────────────
      await _mergeStep('history', async () => {
        if (!Array.isArray(remoteHistory) || remoteHistory.length === 0) return;
        const validRemote = remoteHistory.filter(r => r && r.id);
        if (!validRemote.length) return;
        const local = await DB.getHistory(CONFIG.HISTORY_MAX);
        const { merged } = _mergeHistory(local, validRemote);
        if (!merged.length) return;
        const localMap = new Map(local.map(r => [r.id, r]));
        const toWrite  = merged.filter(m => {
          const l = localMap.get(m.id);
          return !l || m.playedAt > (l.playedAt || 0);
        });
        if (toWrite.length) {
          await DB.bulkPutHistory(toWrite);
          console.log(`[Sync] Merged history: ${toWrite.filter(m => !localMap.has(m.id)).length} added, ${toWrite.filter(m => localMap.has(m.id)).length} updated`);
        }
      });

      // ── Merge song metadata (name, album membership, enrichment) ─────────────
      // Text fields (artist/album/year): overwrite if remote was MB/AudD-enriched —
      // those values are authoritative over locally folder-inferred names.
      // Structural fields (name/displayName/folderId) and cover URLs: fill-only.
      await _mergeStep('metadata', async () => {
        if (!Array.isArray(remoteMetadata) || remoteMetadata.length === 0) return;
        const FILL_ONLY   = ['name', 'displayName', 'folderId', 'mbReleaseMbid', 'thumbnailUrl', 'coverUrl'];
        const TEXT_FIELDS = ['artist', 'album', 'year'];
        let applied = 0;
        for (const item of remoteMetadata) {
          if (!item?.id) continue;
          const ex = await DB.getMeta(item.id);
          const patch = {};

          if (item.mbTried)   patch.mbTried   = true;
          if (item.auddTried) patch.auddTried = true;

          for (const f of FILL_ONLY) {
            if (item[f] === null || item[f] === undefined || item[f] === '') continue;
            if (!ex?.[f]) patch[f] = item[f];
          }

          const remoteIsEnriched = item.mbTried || item.auddTried;
          for (const f of TEXT_FIELDS) {
            if (item[f] === null || item[f] === undefined || item[f] === '') continue;
            if (remoteIsEnriched || !ex?.[f]) patch[f] = item[f];
          }

          if (Object.keys(patch).length > 0) {
            await DB.setMeta(item.id, patch);
            applied++;
          }
        }
        if (applied) console.log(`[Sync] Merged metadata: ${applied} songs updated from remote`);
      });

      // Push merged state back + update manifest.
      // Skip any type whose merge step failed — pushing empty data would overwrite
      // the source device's records via LWW on its next poll (data-poisoning).
      const now = Date.now();
      const safeToPush = Object.keys(FILENAMES).filter(t => !_failedTypes.has(t));
      await Promise.allSettled(safeToPush.map(t => _pushFns[t]()));
      for (const t of safeToPush) _localTs[t] = now;
      if (safeToPush.length) await _bumpManifest(safeToPush);
      if (_failedTypes.size) console.warn('[Sync] Skipped push for failed types:', [..._failedTypes]);

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
