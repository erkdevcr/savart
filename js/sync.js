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
     savart_home.json        → home snapshot (pinned+recents+playcounts+playlists+history)
                               read first on boot for instant cross-device home state
   ============================================================ */

const Sync = (() => {

  const API         = CONFIG.API_BASE;
  const UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3';
  const POLL_INTERVAL = 3000; // ms between manifest checks

  const MANIFEST = 'savart_manifest.json';
  const FILENAMES = {
    favorites:   'savart_favorites.json',
    playlists:   'savart_playlists.json',
    pinned:      'savart_pinned.json',
    recents:     'savart_recents.json',
    playcounts:  'savart_playcounts.json',
    settings:    'savart_settings.json',
    history:     'savart_history.json',
    metadata:    'savart_metadata.json',
    collections: 'savart_collections.json', // collection overrides: name, coverUrl, forceType
    hot:         'savart_hot.json',   // delta: only the most recent rescan batch (~5–50 songs)
    home:        'savart_home.json',  // home snapshot — read at boot via readHome(), not merged in init()
  };

  // Types that should not be pushed or merged during init().
  // 'hot' is a transient delta — the full metadata.json covers initial sync.
  // 'home' is handled separately via readHome() + a post-init push.
  const SKIP_ON_INIT = new Set(['hot', 'home']);

  // Types whose changes should also trigger a home snapshot push
  const HOME_TYPES = new Set(['pinned', 'recents', 'playcounts', 'playlists', 'history', 'favorites']);

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
      cache: 'no-store', // never serve stale manifest/file content from browser cache
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
    let fileId = _fileIds[filename];
    if (!fileId) {
      // File may have been created on another device after our init().
      // Refresh the file list once to discover any new files, then retry.
      await _refreshFileList();
      fileId = _fileIds[filename];
    }
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
   *
   * Does a live read of the manifest first so we don't overwrite timestamps
   * that another device may have written since our last poll.  We take the
   * MAX of the live value and our cached _remoteTs for every key so timestamps
   * never roll backwards.
   */
  async function _bumpManifest(types) {
    const now = Date.now();
    // Live read to capture changes made by other devices since our last poll
    let live = {};
    try { live = await _readManifest(); } catch (_) {}
    // Merge: for every known key take the higher of the live manifest and our
    // cached _remoteTs to prevent accidentally rolling back another device's ts.
    const current = {};
    const allKeys = new Set([...Object.keys(live), ...Object.keys(_remoteTs)]);
    for (const k of allKeys) {
      current[k] = Math.max(live[k] || 0, _remoteTs[k] || 0);
    }
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

  function _mergePinned(localMeta, remoteMeta, remoteManifestTs) {
    // Remote is the authoritative base — remote deletions are respected.
    // LWW per-item using pinnedAt timestamp:
    //   • If a local-only item's pinnedAt > remoteManifestTs → pinned after the
    //     remote was last written → genuine offline addition → keep it.
    //   • If pinnedAt ≤ remoteManifestTs (or missing) → remote had the chance to
    //     include it but didn't → it was deleted on another device → drop it.
    const remoteTs = remoteManifestTs || 0;
    const merged = { ...remoteMeta };
    for (const [id, item] of Object.entries(localMeta)) {
      if (merged[id]) continue; // already in remote — remote wins
      const pinnedAt = item.pinnedAt || 0;
      if (pinnedAt > remoteTs) {
        merged[id] = item; // pinned after remote snapshot → genuine offline addition
      }
      // else: remote knew about this item and chose to omit it → respect the deletion
    }
    return merged;
  }

  function _mergeRecents(local, remote) {
    // Build a unified tombstone map: highest removedAt wins across both sides
    const tombstones = new Map();
    for (const item of [...local, ...remote]) {
      if (!item.id) continue;
      if (item.removedAt) {
        const prev = tombstones.get(item.id) || 0;
        if (item.removedAt > prev) tombstones.set(item.id, item.removedAt);
      }
    }

    // Merge live items (remote base, local wins on newer accessedAt)
    const map = new Map();
    for (const item of remote) {
      if (!item.id || item.removedAt) continue;
      map.set(item.id, item);
    }
    for (const item of local) {
      if (!item.id || item.removedAt) continue;
      const ex = map.get(item.id);
      if (!ex || item.accessedAt > ex.accessedAt) map.set(item.id, item);
    }

    // Apply tombstones: remove any item whose tombstone is newer than its accessedAt
    for (const [id, removedAt] of tombstones) {
      const item = map.get(id);
      if (item && removedAt > (item.accessedAt || 0)) map.delete(id);
    }

    const merged   = Array.from(map.values())
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, CONFIG.RECENTS_MAX);

    // Tombstone records to apply locally (so this device doesn't re-add deleted items)
    const tombstoneRecords = [...tombstones.entries()]
      .map(([id, removedAt]) => ({ id, removedAt }));

    const localIds = new Set(local.filter(r => !r.removedAt).map(r => r.id));
    return { merged, toAdd: merged.filter(r => !localIds.has(r.id)), tombstoneRecords };
  }

  function _mergePlaycounts(local, remote) {
    const map = new Map();
    for (const item of local)  map.set(item.id, { ...item });
    for (const item of remote) {
      const ex = map.get(item.id);
      if (!ex) {
        map.set(item.id, { ...item });
      } else {
        // "hide" is permanent — if either side flagged hiddenFromTopPlayed, it wins.
        const hidden = !!(ex.hiddenFromTopPlayed || item.hiddenFromTopPlayed);
        map.set(item.id, {
          ...ex, ...item,
          playCount: hidden ? 0 : Math.max(ex.playCount || 0, item.playCount || 0),
          ...(hidden ? { hiddenFromTopPlayed: true } : {}),
        });
      }
    }
    const merged   = Array.from(map.values());
    const localMap = new Map(local.map(m => [m.id, m]));
    return {
      merged,
      toUpsert: merged.filter(m => {
        const l = localMap.get(m.id);
        if (!l) return true;                                          // new remote item
        if (m.hiddenFromTopPlayed && !l.hiddenFromTopPlayed) return true; // hide from remote
        return m.playCount > (l.playCount || 0);                     // higher remote count
      }),
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
        // Support both old format (plain meta dict) and new format ({ meta, order }).
        const remoteMeta  = (data?.meta ?? data) || {};
        const remoteOrder = Array.isArray(data?.order) ? data.order : Object.keys(remoteMeta);

        // Use _mergePinned (per-item LWW by pinnedAt) instead of a pure overwrite so
        // simultaneous pins on two devices don't lose each other's items.
        let localMeta = (await DB.getState('pinnedMeta')) || {};
        // Unwrap if still in the corrupted { meta, order } wrapper format
        if (localMeta && typeof localMeta.meta === 'object' && !Array.isArray(localMeta.meta)
            && Array.isArray(localMeta.order)) {
          localMeta = localMeta.meta || {};
        }
        // Remote wins for deletions (items absent from remote with older pinnedAt than
        // the remote file was last written — heuristic: use max remote pinnedAt as ts).
        const remoteTs    = Math.max(0, ...Object.values(remoteMeta).map(v => v?.pinnedAt || 0));
        const mergedPinned = _mergePinned(localMeta, remoteMeta, remoteTs);

        // Preserve order: remote order first, then any local-only pins appended.
        const localOnlyIds = Object.keys(mergedPinned).filter(id => !remoteMeta[id]);
        const finalOrder   = [...remoteOrder, ...localOnlyIds];

        await DB.setState('pinnedMeta', mergedPinned);
        await DB.setState('pinned', finalOrder);
        break;
      }

      case 'recents': {
        // LWW per-item by accessedAt — keep whichever device accessed each song more recently.
        // Avoids wiping a song just played on this device (within the debounce window)
        // when an older push from another device arrives.
        // savart_recents.json includes tombstones; _mergeRecents handles them correctly.
        const remote = (data || []).filter(r => r && r.id);
        if (!remote.length) {
          // Remote has no live items — Device A cleared recents; propagate the clear.
          await DB.clearRecents();
          break;
        }
        const local = await DB.getRecentsAll(); // include local tombstones
        const { merged, tombstoneRecords } = _mergeRecents(local, remote);

        // Preserve local tombstones + apply new remote tombstones so deletions survive
        // subsequent clearRecents() calls.
        const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const localTombstones = local.filter(r => r.removedAt && r.removedAt > week);
        const localMap = new Map(local.map(r => [r.id, r]));
        const newRemoteTombstones = tombstoneRecords.filter(t => {
          const l = localMap.get(t.id);
          return !l || (!l.removedAt && t.removedAt > (l.accessedAt || 0));
        }).map(t => ({ id: t.id, removedAt: t.removedAt }));

        await DB.clearRecents();
        const allToWrite = [...merged, ...localTombstones, ...newRemoteTombstones];
        if (allToWrite.length) await DB.bulkPutRecents(allToWrite);
        break;
      }

      case 'playcounts': {
        // MAX(local, remote) per song — prevents a lower remote count from overwriting
        // a higher local count when two devices have played the same song differently.
        const validCounts = (data || []).filter(r => r && r.id);
        if (validCounts.length) {
          await DB.bulkApplyPlaycounts(validCounts);
        } else {
          // Remote cleared playcounts — propagate the clear.
          await DB.clearPlaycounts();
        }
        break;
      }

      case 'settings': {
        // Only apply the shared portion (custom presets). Never touch 'settings_local'
        // which holds device-specific EQ state (gains, enabled, preset, tempo).
        if (data && typeof data === 'object') {
          const current = (await DB.getState('settings')) || {};
          await DB.setState('settings', {
            ...current,
            eqCustomPresets: data.eqCustomPresets || current.eqCustomPresets || [],
            savedAt:         data.savedAt || current.savedAt,
          });
        }
        break;
      }

      case 'history': {
        // LWW per-item by playedAt — keep the most recent play record for each song.
        const remote = (data || []).filter(r => r && r.id);
        if (!remote.length) {
          // Remote cleared history — propagate the clear.
          await DB.clearHistory();
          break;
        }
        const local   = await DB.getHistory();
        const map     = new Map();
        for (const item of local)  map.set(item.id, item);
        for (const item of remote) {
          const ex = map.get(item.id);
          if (!ex || (item.playedAt || 0) > (ex.playedAt || 0)) map.set(item.id, item);
        }
        const cutoff  = Date.now() - CONFIG.HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
        const merged  = Array.from(map.values())
          .filter(e => (e.playedAt || 0) >= cutoff)
          .sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0))
          .slice(0, CONFIG.HISTORY_MAX);
        await DB.clearHistory();
        if (merged.length) await DB.bulkPutHistory(merged);
        break;
      }

      case 'home': {
        // Atomic home snapshot: restore all home-relevant state from a single file.
        // LWW: the manifest guarantees this file is newer, so we overwrite local state.

        // Guard: if the user ran "clear home" more recently than this snapshot was pushed,
        // the snapshot carries stale data (recents/playcounts/history that were just cleared).
        // Skip it entirely — the debounced pushes will update the snapshot in Drive shortly,
        // and the next restart will find a snapshot newer than homeCleared.
        const _homeCleared  = await DB.getState('homeCleared').catch(() => 0) || 0;
        const _snapshotTs   = (data || {}).ts || 0;
        if (_homeCleared > 0 && _snapshotTs > 0 && _snapshotTs <= _homeCleared) break;

        const { pinned, pinnedOrder, recents, recentTombstones, playcounts, playlists, history } = data || {};

        if (pinned && typeof pinned === 'object') {
          // LWW per-item: remote wins for deletions & updates.
          // Local-only items kept only if pinnedAt > remote home timestamp (offline addition).
          let localMeta = (await DB.getState('pinnedMeta')) || {};
          // Unwrap if still in the corrupted wrapper format
          if (localMeta && typeof localMeta.meta === 'object' && !Array.isArray(localMeta.meta)
              && Array.isArray(localMeta.order)) {
            localMeta = localMeta.meta || {};
          }
          const remoteHomeTs = data.ts || 0;
          const mergedPinned = _mergePinned(localMeta, pinned, remoteHomeTs);
          const remoteOrder  = Array.isArray(pinnedOrder) ? pinnedOrder : Object.keys(pinned);
          const localOnlyIds = Object.keys(mergedPinned).filter(id => !pinned[id]);
          await DB.setState('pinnedMeta', mergedPinned);
          await DB.setState('pinned', [...remoteOrder, ...localOnlyIds]);
        }

        if (Array.isArray(recents) && recents.length) {
          // Merge home-snapshot live items with any tombstones bundled in the snapshot.
          // This lets readHome() honour deletions even when local IndexedDB is empty
          // (e.g. after logout → login) and before init() pulls savart_recents.json.
          const remoteTombstones = Array.isArray(recentTombstones) ? recentTombstones : [];
          const validRemote = [...recents, ...remoteTombstones].filter(r => r && r.id);
          const local = await DB.getRecentsAll();
          const { merged: mergedR, tombstoneRecords } = _mergeRecents(local, validRemote);

          // Write the merged state to DB.
          // IMPORTANT: after clearRecents() we write back both the live merged result
          // AND all local tombstones still within their 7-day window.  Without this,
          // clearRecents() would destroy the local tombstone and a subsequent init()
          // merge with a stale savart_recents.json would resurrect the deleted item.
          const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const localTombstones = local.filter(r => r.removedAt && r.removedAt > week);
          // Also apply remote tombstones that aren't already local
          const localHomeMap = new Map(local.map(r => [r.id, r]));
          const newRemoteTombstones = tombstoneRecords.filter(t => {
            const l = localHomeMap.get(t.id);
            return !l || (!l.removedAt && t.removedAt > (l.accessedAt || 0));
          }).map(t => ({ id: t.id, removedAt: t.removedAt }));

          await DB.clearRecents();
          // Write live items + preserved tombstones in one batch
          const allToWrite = [...mergedR, ...localTombstones, ...newRemoteTombstones];
          if (allToWrite.length) await DB.bulkPutRecents(allToWrite);
        } else if (Array.isArray(recents)) {
          // recents: [] — Device A cleared home. Preserve only items played after the snapshot.
          const snapshotTs = data.ts || 0;
          const local = await DB.getRecentsAll();
          const survived = snapshotTs > 0
            ? local.filter(r => !r.removedAt && (r.accessedAt || 0) > snapshotTs)
            : [];
          await DB.clearRecents();
          if (survived.length) await DB.bulkPutRecents(survived);
        }

        if (Array.isArray(playcounts)) {
          // MAX(local, remote) per song (same as case 'playcounts')
          const valid = playcounts.filter(m => m && m.id);
          if (valid.length) {
            await DB.bulkApplyPlaycounts(valid);
          } else {
            // playcounts: [] — Device A cleared play counts; propagate the clear.
            await DB.clearPlaycounts();
          }
        }

        if (Array.isArray(playlists)) {
          // Per-playlist LWW using updatedAt; deletions follow remote as authoritative.
          // Empty array means all playlists were deleted on Device A — the remoteIds.has()
          // check below will delete all local playlists, which is the correct behaviour.
          const local    = await DB.getPlaylists();
          const localMap = new Map(local.map(p => [p.id, p]));
          const remoteIds = new Set(playlists.map(p => p.id));
          for (const pl of local) {
            if (!remoteIds.has(pl.id)) await DB.deletePlaylist(pl.id);
          }
          for (const pl of playlists) {
            const loc = localMap.get(pl.id);
            if (!loc || (pl.updatedAt || 0) >= (loc.updatedAt || 0)) await DB.putPlaylist(pl);
          }
        }

        if (Array.isArray(history) && history.length) {
          // Per-item LWW by playedAt (same as case 'history')
          const remote  = history.filter(r => r && r.id);
          const local   = await DB.getHistory();
          const map     = new Map();
          for (const item of local)  map.set(item.id, item);
          for (const item of remote) {
            const ex = map.get(item.id);
            if (!ex || (item.playedAt || 0) > (ex.playedAt || 0)) map.set(item.id, item);
          }
          const cutoff  = Date.now() - CONFIG.HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
          const mergedH = Array.from(map.values())
            .filter(e => (e.playedAt || 0) >= cutoff)
            .sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0))
            .slice(0, CONFIG.HISTORY_MAX);
          await DB.clearHistory();
          if (mergedH.length) await DB.bulkPutHistory(mergedH);
        } else if (Array.isArray(history)) {
          // history: [] — Device A cleared history; propagate the clear.
          await DB.clearHistory();
        }
        break;
      }

      case 'metadata':
      case 'hot': {
        // Shared merge logic for both metadata (full library) and hot (rescan delta).
        // Strategy:
        //   • name / displayName / folderId / mbReleaseMbid → fill-only
        //   • mbTried / auddTried → adopt if remote is true
        //   • artist / album / year → overwrite if remote was MB/AudD-enriched; else fill-only
        //   • thumbnailUrl / coverUrl → OVERWRITE if remote was manually edited (remoteManualAt > 0);
        //                               fill-only otherwise (never silently downgrade a local cover)
        //
        // Performance: single bulk read + bulk write instead of per-song DB round-trips.
        // With 68K+ songs, per-song getMeta calls would take minutes; this takes seconds.
        // For 'hot' (typically 5–50 songs), getAllMeta is still fast since IDB scan is indexed.
        const FILL_ONLY     = ['name', 'displayName', 'folderId', 'mbReleaseMbid'];
        const ENRICH_FIELDS = ['artist', 'album', 'year'];

        const allLocal = await DB.getAllMeta();
        const localMap = new Map(allLocal.map(m => [m.id, m]));
        const toWrite  = [];

        for (const item of (data || [])) {
          if (!item?.id) continue;
          const ex     = localMap.get(item.id) || {};
          const merged = { ...ex, id: item.id };   // start with full local record; id always set

          if (item.mbTried)   merged.mbTried   = true;
          if (item.auddTried) merged.auddTried = true;

          // rescannedAt: take the most recent timestamp (folder rescan status)
          if (item.rescannedAt && (item.rescannedAt > (merged.rescannedAt || 0))) {
            merged.rescannedAt = item.rescannedAt;
          }

          for (const f of FILL_ONLY) {
            if (!item[f]) continue;
            if (!merged[f]) merged[f] = item[f];
          }

          // LWW guard: if local record was manually edited more recently than
          // the remote record, keep local values for artist/album/year/thumbnailUrl.
          // manualAt is a Unix ms timestamp written by the app whenever the user
          // manually edits a field. Remote wins only if its manualAt is strictly newer.
          const localManualAt  = ex.manualAt  || 0;
          const remoteManualAt = item.manualAt || 0;
          const localManualWins = localManualAt > remoteManualAt;

          // Propagate manualAt: take the newer of the two
          if (remoteManualAt > localManualAt) merged.manualAt = remoteManualAt;

          const remoteIsEnriched = item.mbTried || item.auddTried;
          for (const f of ENRICH_FIELDS) {
            if (!item[f]) continue;
            // If local was manually edited more recently, never overwrite with remote
            if (localManualWins) continue;
            if (remoteIsEnriched || !merged[f]) merged[f] = item[f];
          }

          // thumbnailUrl / coverUrl — cover sync rules:
          //   • Remote was manually edited (remoteManualAt > 0) and local didn't win:
          //     OVERWRITE — the user on the remote device explicitly chose this cover;
          //     it must propagate even when this device already has an ID3 blob or URL.
          //   • Remote is auto-enrichment (remoteManualAt === 0):
          //     FILL-ONLY — only apply when this device has no cover at all, so we never
          //     silently downgrade a good local cover (ID3 blob, CDN URL) with a stale
          //     enrichment URL from another device.
          //   'id3' sentinel is never synced — item.thumbnailUrl is always a real URL.
          if (item.thumbnailUrl && !localManualWins) {
            if (remoteManualAt > 0) {
              merged.thumbnailUrl = item.thumbnailUrl; // manual edit — always propagate
            } else {
              const hasLocalCover = (merged.thumbnailUrl && merged.thumbnailUrl !== 'id3')
                                  || merged.coverBlob;
              if (!hasLocalCover) merged.thumbnailUrl = item.thumbnailUrl;
            }
          }
          // coverUrl (album folder header cover) — same manual-override / fill-only rules.
          if (item.coverUrl && !localManualWins) {
            if (remoteManualAt > 0 || !merged.coverUrl) {
              merged.coverUrl = item.coverUrl;
            }
          }

          // durationSec: take the larger non-zero value — it's a physical property of
          // the file so both devices should converge to the same reading eventually.
          if (item.durationSec > 0 && item.durationSec > (merged.durationSec || 0)) {
            merged.durationSec = item.durationSec;
          }

          // Derive CAA URL if mbReleaseMbid present and still no cover URL.
          if (merged.mbReleaseMbid && !merged.thumbnailUrl) {
            merged.thumbnailUrl = `https://coverartarchive.org/release/${merged.mbReleaseMbid}/front-250`;
          }

          // Only queue if something actually changed vs local record
          const changed = Object.keys(merged).some(k => merged[k] !== ex[k])
                       || Object.keys(ex).some(k => merged[k] !== ex[k]);
          if (changed) toWrite.push(merged);
        }

        if (toWrite.length > 0) {
          await DB.bulkWriteMeta(toWrite);
          if (type === 'hot') console.log(`[Sync] Applied hot delta: ${toWrite.length} songs updated`);

          // For any record that arrived with a new thumbnailUrl, download and cache
          // the image as a local blob so it's available offline on this device.
          // force=true because the remote edit is newer (manualAt / remoteManualAt won).
          if (typeof App !== 'undefined' && App.cacheExternalCover) {
            for (const rec of toWrite) {
              if (rec.thumbnailUrl && !rec.thumbnailUrl.startsWith('blob:')) {
                App.cacheExternalCover(rec.id, rec.thumbnailUrl, true).catch(() => {});
              }
            }
          }

          // Propagate remote metadata to in-memory caches so the miniplayer
          // updates immediately without a track reload (Drive DB = single source of truth).
          if (typeof App !== 'undefined' && App.liveMetaUpdate) {
            for (const rec of toWrite) {
              const patch = {};
              if (rec.artist)       patch.artist       = rec.artist;
              if (rec.album)        patch.album        = rec.album;
              if (rec.year)         patch.year         = rec.year;
              if (rec.thumbnailUrl) patch.thumbnailUrl = rec.thumbnailUrl;
              if (rec.coverUrl)     patch.coverUrl     = rec.coverUrl;
              if (Object.keys(patch).length) {
                App.liveMetaUpdate([rec.id], patch);
              }
            }
          }
        }
        break;
      }

      case 'collections': {
        // LWW per collection: remote wins when its manualAt is strictly newer.
        // forceType is fill-only — once a folder is marked collection, it stays so.
        const remote   = Array.isArray(data) ? data : [];
        const localMap = new Map((await DB.getAllCollections()).map(c => [c.id, c]));
        for (const item of remote) {
          if (!item?.id) continue;
          const local = localMap.get(item.id) || {};
          const remoteManualAt = item.manualAt || 0;
          const localManualAt  = local.manualAt  || 0;
          const remoteWins = remoteManualAt >= localManualAt;
          const patch = {};
          // forceType: fill-only — set if local doesn't have it yet
          if (item.forceType && !local.forceType) patch.forceType = item.forceType;
          // name / coverUrl: remote wins only when its manualAt is newer or equal
          if (item.name     && (remoteWins || !local.name))     patch.name     = item.name;
          if (item.coverUrl && (remoteWins || !local.coverUrl)) patch.coverUrl = item.coverUrl;
          if (remoteManualAt > localManualAt) patch.manualAt = remoteManualAt;
          if (Object.keys(patch).length) {
            await DB.saveCollection(item.id, { ...local, ...patch, manualAt: patch.manualAt ?? localManualAt });
          }
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
      thumbnailUrl: (m.thumbnailUrl && !m.thumbnailUrl.startsWith('blob:') && m.thumbnailUrl !== 'id3') ? m.thumbnailUrl : null,
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
    let raw   = (await DB.getState('pinnedMeta')) || {};
    let order = (await DB.getState('pinned'))     || [];
    // Guard: if IndexedDB still holds the 3.5.1-corrupted wrapper, unwrap it before pushing.
    // (DB.getPinnedFolders auto-repairs on read, but _pushPinned reads raw via getState.)
    if (raw && typeof raw.meta === 'object' && !Array.isArray(raw.meta) && Array.isArray(raw.order)) {
      const savedOrder = raw.order; // save before overwriting raw
      raw   = raw.meta || {};
      order = savedOrder.filter(id => raw[id]); // drop 'meta'/'order' wrapper keys
    }
    const now   = Date.now();
    const clean = {};
    for (const [id, item] of Object.entries(raw)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue; // skip wrapper keys
      clean[id] = {
        ...item,
        // Backfill pinnedAt for items pinned before the field was added —
        // without it the LWW merge can't distinguish offline-pins from deletions.
        pinnedAt:     item.pinnedAt || now,
        thumbnailUrl: (item.thumbnailUrl && !item.thumbnailUrl.startsWith('blob:')) ? item.thumbnailUrl : null,
      };
    }
    // Include pinnedOrder so the receiving device can restore drag order.
    // Wrap as { meta, order } object — backward-compatible: old clients ignore order.
    await _writeFile(FILENAMES.pinned, { meta: clean, order });
    console.log(`[Sync] Pushed pinned (${Object.keys(clean).length})`);
  }

  async function _pushRecents() {
    const all  = await DB.getRecentsAll();
    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Live items (up to RECENTS_MAX)
    const liveRaw = all
      .filter(r => !r.removedAt)
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, CONFIG.RECENTS_MAX);

    // Cross-reference the metadata store so cover URLs discovered AFTER addRecent
    // (e.g. by _preScanBeforePlay or _softScanItems) are included in the push.
    // The recents store records the thumbnail at play-time; the metadata store is
    // always the authoritative, up-to-date source.
    const metaRecords = await Promise.all(liveRaw.map(r => DB.getMeta(r.id).catch(() => null)));

    const _safeUrl = u => (u && !u.startsWith('blob:') && u !== 'id3') ? u : null;

    const live = liveRaw.map((r, i) => {
      const m = metaRecords[i];
      const isSd = r.isSoundrop || m?.isSoundrop || false;
      return {
        id: r.id, name: r.name || null,
        displayName: m?.displayName || r.displayName || r.name || null,
        artist:      m?.artist      || r.artist      || null,
        type: r.type || 'song', folderId: r.folderId || null, mimeType: r.mimeType || null,
        // thumbnailUrl: metadata store wins (most up-to-date) → recents record → thumbnailLink fallback
        // 'id3' is local-only (blob in IDB) — never sync it.
        thumbnailUrl: _safeUrl(m?.thumbnailUrl) || _safeUrl(r.thumbnailUrl)
                   || _safeUrl(r.thumbnailLink)  || null,
        accessedAt: r.accessedAt ?? Date.now(),
        // SD fields — must survive sync so other devices can play Soundrop tracks
        ...(isSd ? { isSoundrop: true, videoId: r.videoId || m?.videoId || null } : {}),
        ...((m?.durationSec > 0 || r.durationSec > 0) ? { durationSec: m?.durationSec || r.durationSec } : {}),
      };
    });

    // Tombstones from the last 7 days (so other devices can honour the deletion)
    const tombstones = all
      .filter(r => r.removedAt && r.removedAt > week)
      .map(r => ({ id: r.id, removedAt: r.removedAt }));

    await _writeFile(FILENAMES.recents, [...live, ...tombstones]);
    console.log(`[Sync] Pushed recents (${live.length} live, ${tombstones.length} tombstones)`);
  }

  async function _pushPlaycounts() {
    // getAllPlaycounts includes songs hidden from top-played so other devices
    // receive the hiddenFromTopPlayed flag and can hide them locally too.
    const played = await DB.getAllPlaycounts();
    await _writeFile(FILENAMES.playcounts, played.map(m => ({
      id: m.id, name: m.name || null, displayName: m.displayName || m.name || null,
      artist: m.artist || null, folderId: m.folderId || null, playCount: m.playCount || 0,
      thumbnailUrl: (m.thumbnailUrl && !m.thumbnailUrl.startsWith('blob:') && m.thumbnailUrl !== 'id3') ? m.thumbnailUrl : null,
      ...(m.hiddenFromTopPlayed ? { hiddenFromTopPlayed: true } : {}),
    })));
    console.log(`[Sync] Pushed playcounts (${played.length})`);
  }

  async function _pushSettings() {
    // Only push the shared portion of settings (custom EQ presets).
    // EQ state (gains, enabled, preset, tempo) lives in 'settings_local' and
    // is intentionally device-specific — it is never written to Drive.
    const s = (await DB.getState('settings')) || {};
    const payload = {
      eqCustomPresets: s.eqCustomPresets || [],
      savedAt:         s.savedAt || Date.now(),
    };
    await _writeFile(FILENAMES.settings, payload);
    console.log('[Sync] Pushed settings (custom presets only)');
  }

  async function _pushHistory() {
    const history = await DB.getHistory(CONFIG.HISTORY_MAX);
    await _writeFile(FILENAMES.history, history.map(h => ({
      id:           h.id,
      name:         h.name         || null,
      displayName:  h.displayName  || h.name || null,
      artist:       h.artist       || null,
      folderId:     h.folderId     || null,
      thumbnailUrl: (h.thumbnailUrl && !h.thumbnailUrl.startsWith('blob:') && h.thumbnailUrl !== 'id3') ? h.thumbnailUrl : null,
      playedAt:     h.playedAt     ?? Date.now(),
    })));
    console.log(`[Sync] Pushed history (${history.length})`);
  }

  async function _pushCollections() {
    const all = await DB.getAllCollections();
    const isExternalUrl = u => u && !u.startsWith('blob:') && !u.includes('googleapis.com');
    const payload = all
      .filter(c => c?.id)
      .map(c => {
        const rec = { id: c.id };
        if (c.forceType)             rec.forceType = c.forceType;
        if (c.name)                  rec.name      = c.name;
        if (isExternalUrl(c.coverUrl)) rec.coverUrl = c.coverUrl;
        if (c.manualAt)              rec.manualAt  = c.manualAt;
        if (c.updatedAt)             rec.updatedAt = c.updatedAt;
        return rec;
      });
    await _writeFile(FILENAMES.collections, payload);
    console.log(`[Sync] Pushed collections (${payload.length})`);
  }

  async function _pushMetadata() {
    // Fields that identify the song and its album membership —
    // synced so that other devices can rebuild the Library without re-scanning.
    const SYNC_FIELDS = [
      'name', 'displayName', 'folderId',           // album membership + display title
      'artist', 'album', 'year',                    // enriched text
      'mbTried', 'auddTried', 'mbReleaseMbid',      // enrichment flags / IDs
      'manualAt',                                   // LWW guard: timestamp of last manual edit
      'rescannedAt',                                // folder rescan timestamp (folder records)
      'durationSec',                                // audio duration — captured on first play
    ];
    // googleusercontent.com = Drive CDN thumbnailLinks — accessible in <img> without auth.
    // googleapis.com       = Drive API download endpoints — require Bearer token, skip those.
    const isExternalUrl = u => u && !u.startsWith('blob:') && u !== 'id3'
      && !u.includes('googleapis.com');

    const all = await DB.getAllMeta();
    const toSync = all
      // Include every song that has been scanned into any folder OR has any enrichment.
      // Songs with only a folderId carry name/displayName/folderId so other devices can
      // build the Library; enrichment flags prevent redundant lookups on the remote device.
      // Also include folder records (id === folderId) that carry rescannedAt.
      .filter(m => m.folderId || m.mbTried || m.auddTried || m.artist || m.album || m.year || m.rescannedAt || m.manualAt)
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

  /**
   * Push a small delta file with only the songs from the current rescan batch.
   * Called immediately (no debounce) from pushHot().
   * Device B picks this up within 3 seconds and applies it without touching the
   * full metadata.json — so album art and enrichment appear in near-real-time.
   * @param {Object[]} metas  — full DB metadata records for just the rescanned songs
   */
  async function _pushHot(metas) {
    if (!metas?.length) return;
    const SYNC_FIELDS = [
      'name', 'displayName', 'folderId',
      'artist', 'album', 'year',
      'mbTried', 'auddTried', 'mbReleaseMbid',
      'manualAt', 'rescannedAt',
      'durationSec',
    ];
    const isExternalUrl = u => u && !u.startsWith('blob:') && u !== 'id3'
      && !u.includes('googleapis.com');

    const toSync = metas.map(m => {
      const rec = { id: m.id };
      for (const f of SYNC_FIELDS) {
        if (m[f] !== null && m[f] !== undefined && m[f] !== '') rec[f] = m[f];
      }
      if (isExternalUrl(m.thumbnailUrl)) rec.thumbnailUrl = m.thumbnailUrl;
      if (isExternalUrl(m.coverUrl))     rec.coverUrl     = m.coverUrl;
      return rec;
    });
    await _writeFile(FILENAMES.hot, toSync);
    console.log(`[Sync] Pushed hot delta (${toSync.length} songs)`);
  }

  /**
   * Push a single atomic home snapshot to Drive.
   * Bundles pinned + recents + playcounts + playlists + history into one file
   * so boot reads can restore the entire home screen in a single API call.
   */
  async function _pushHome() {
    // googleusercontent.com = Drive CDN thumbnails — work in <img> without auth, sync them.
    // googleapis.com        = Drive API download endpoints — need Bearer token, skip.
    const isExternal = u => u && !u.startsWith('blob:') && u !== 'id3'
      && !u.includes('googleapis.com');
    const cleanUrl = u => isExternal(u) ? u : null;

    let [pinnedMeta, pinnedOrder, allRecents, playcounts, playlists, history] = await Promise.all([
      DB.getState('pinnedMeta'),
      DB.getState('pinned'),
      DB.getRecentsAll(),          // ALL records including tombstones
      DB.getAllPlaycounts(),   // includes hidden songs so other devices get hiddenFromTopPlayed
      DB.getPlaylists(),
      DB.getHistory(CONFIG.HISTORY_MAX),
    ]);
    // Unwrap corrupted format if present
    if (pinnedMeta && typeof pinnedMeta.meta === 'object' && !Array.isArray(pinnedMeta.meta)
        && Array.isArray(pinnedMeta.order)) {
      pinnedOrder = pinnedMeta.order;
      pinnedMeta  = pinnedMeta.meta || {};
    }

    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Separate live items and fresh tombstones
    const recentsLive = (allRecents || []).filter(r => !r.removedAt)
      .sort((a, b) => (b.accessedAt || 0) - (a.accessedAt || 0))
      .slice(0, CONFIG.RECENTS_MAX);
    const recentTombstones = (allRecents || [])
      .filter(r => r.removedAt && r.removedAt > week)
      .map(r => ({ id: r.id, removedAt: r.removedAt }));

    // Cross-reference the metadata store so covers found after addRecent
    // (e.g. by _preScanBeforePlay / _softScanItems) are included in the snapshot.
    const recentMetaRecords = await Promise.all(
      recentsLive.map(r => DB.getMeta(r.id).catch(() => null))
    );

    const payload = {
      ts:          Date.now(),
      pinned:      pinnedMeta  || {},
      pinnedOrder: pinnedOrder || [],
      recents: recentsLive.map((r, i) => {
        const m = recentMetaRecords[i];
        const isSd = r.isSoundrop || m?.isSoundrop || false;
        return {
          id: r.id, name: r.name || null,
          displayName: m?.displayName || r.displayName || r.name || null,
          artist:      m?.artist      || r.artist      || null,
          album:       m?.album       || r.album       || null,
          type: r.type || 'song', folderId: r.folderId || null, mimeType: r.mimeType || null,
          // metadata store wins for thumbnailUrl — it's updated by scans/recognition
          // after the recent was originally added; recents store may still be stale.
          // Drive CDN thumbnailLink is stable across sessions and works in <img> without auth.
          thumbnailUrl: cleanUrl(m?.thumbnailUrl) || cleanUrl(r.thumbnailUrl)
                     || cleanUrl(r.thumbnailLink) || null,
          accessedAt: r.accessedAt ?? Date.now(),
          // SD fields — must survive sync so other devices can play Soundrop tracks
          ...(isSd ? { isSoundrop: true, videoId: r.videoId || m?.videoId || null } : {}),
        };
      }),
      // Tombstones let readHome() honour deletions even before init() runs.
      recentTombstones,
      playcounts: (playcounts || []).map(m => ({
        id: m.id, name: m.name || null, displayName: m.displayName || m.name || null,
        artist: m.artist || null, folderId: m.folderId || null, playCount: m.playCount || 0,
        thumbnailUrl: cleanUrl(m.thumbnailUrl),
        ...(m.hiddenFromTopPlayed ? { hiddenFromTopPlayed: true } : {}),
      })),
      playlists: (playlists || []),
      history: (history || []).map(h => ({
        id: h.id, name: h.name || null, displayName: h.displayName || h.name || null,
        artist: h.artist || null, album: h.album || h.albumName || null,
        folderId: h.folderId || null,
        thumbnailUrl: cleanUrl(h.thumbnailUrl), playedAt: h.playedAt ?? Date.now(),
      })),
    };

    await _writeFile(FILENAMES.home, payload);
    console.log('[Sync] Pushed home snapshot');
  }

  const _pushFns = {
    favorites:   _pushFavorites,
    playlists:   _pushPlaylists,
    pinned:      _pushPinned,
    recents:     _pushRecents,
    playcounts:  _pushPlaycounts,
    settings:    _pushSettings,
    history:     _pushHistory,
    metadata:    _pushMetadata,
    collections: _pushCollections,
    hot:         () => Promise.resolve(), // no-op — hot is pushed only via pushHot(), not init
    home:        _pushHome,
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

      // Always bring _remoteTs up to date (take MAX to prevent rollbacks).
      // This keeps _bumpManifest's base accurate even for types that aren't stale
      // on this device — so our next write doesn't accidentally zero out another
      // device's timestamp for a type we haven't touched ourselves.
      for (const [k, v] of Object.entries(manifest)) {
        if ((v || 0) > (_remoteTs[k] || 0)) _remoteTs[k] = v;
      }

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
          try {
            await _applyRemote(type, data);
            _localTs[type]  = manifest[type]; // mark as applied
            _remoteTs[type] = manifest[type];
            applied.push(type);
          } catch (applyErr) {
            // Non-fatal per type — log so failures are visible, then continue with next type
            console.warn(`[Sync] _applyRemote(${type}) failed:`, applyErr?.message || applyErr);
          }
        }
      }

      if (applied.length > 0 && _onDataChanged) {
        _onDataChanged(applied);
      }
    } catch (err) {
      // Non-fatal — network issues, token expired, etc.
      if (err?.message) console.warn('[Sync] poll error:', err.message);
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
  async function init({ onProgress } = {}) {
    _ready = false;
    const _prog = (p) => { try { onProgress?.(p); } catch (_) {} };
    _prog(0);

    // Track which merge steps failed so we can skip their push (prevents data-poisoning:
    // a failed merge leaves local DB empty for that type — pushing that empty state to Drive
    // would wipe the source device's data via LWW on its next poll).
    const _failedTypes = new Set();

    // Types whose remote snapshot hasn't changed since our last successful merge —
    // no need to download or re-merge them this session.
    const _skippedTypes = new Set();

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
      _prog(8);

      // ── Phase 0: restore persisted timestamps from last session ──────────────
      // _localTs is in-memory and resets every page load.
      // 'sync_localTs' in IDB bridges sessions so we know which remote snapshots
      // we already merged — avoiding redundant downloads on subsequent logins.
      const _savedTs = (await DB.getState('sync_localTs').catch(() => null)) || {};
      for (const [k, v] of Object.entries(_savedTs)) {
        if ((v || 0) > (_localTs[k] || 0)) _localTs[k] = v;
      }

      // ── Phase 1: read manifest only (tiny, always needed) ───────────────────
      const manifest = await _readManifest();
      _remoteTs = { ...manifest };
      _prog(14);

      // ── Classify types: stale (need download) vs fresh (can skip) ───────────
      const PULL_TYPES = ['favorites', 'playlists', 'pinned', 'recents',
                          'playcounts', 'settings', 'history', 'metadata', 'collections'];
      for (const type of PULL_TYPES) {
        const remoteTs = _remoteTs[type] || 0;
        const localTs  = _localTs[type]  || 0;
        // Skip only when remote has been written at least once AND we've already merged it.
        if (remoteTs > 0 && remoteTs <= localTs) _skippedTypes.add(type);
      }
      if (_skippedTypes.size) {
        console.log(`[Sync] Fresh — skipping download+merge for: [${[..._skippedTypes].join(', ')}]`);
      }

      // ── Phase 2: pull only stale types in parallel ───────────────────────────
      const _pull = (type) =>
        _skippedTypes.has(type) ? Promise.resolve(null) : _readFile(FILENAMES[type]).catch(() => null);

      const [
        remoteFavs, remotePlaylists, remotePinned,
        remoteRecents, remotePlaycounts, remoteSettings, remoteHistory,
        remoteMetadata, remoteCollections,
      ] = await Promise.all([
        _pull('favorites'), _pull('playlists'),  _pull('pinned'),
        _pull('recents'),   _pull('playcounts'), _pull('settings'), _pull('history'),
        _pull('metadata'),  _pull('collections'),
      ]);
      _prog(24);

      // ── Merge favorites ───────────────────────────────────
      // Full LWW merge using starredAt timestamps:
      //   - Remote items not in local   → add locally (starred on another device while offline)
      //   - Local items not in remote   → remove IF starredAt ≤ remoteManifestTs
      //     (meaning the remote had a chance to include them but didn't → un-starred elsewhere)
      //     If starredAt > remoteManifestTs the song was starred offline → keep & push it back.
      await _mergeStep('favorites', async () => {
        // remoteFavs is null when type was skipped (fresh) — treat as "nothing to merge"
        // rather than empty list (which would delete all local favorites).
        if (remoteFavs === null) return;
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
      _prog(32);

      // ── Merge playlists ───────────────────────────────────
      await _mergeStep('playlists', async () => {
        if (!Array.isArray(remotePlaylists) || remotePlaylists.length === 0) return;
        const local = await DB.getPlaylists();
        const { toUpsert } = _mergePlaylists(local, remotePlaylists);
        for (const pl of toUpsert) await DB.putPlaylist(pl);
        if (toUpsert.length) console.log(`[Sync] Merged ${toUpsert.length} remote playlists`);
      });
      _prog(40);

      // ── Merge pinned ──────────────────────────────────────
      await _mergeStep('pinned', async () => {
        if (!remotePinned || typeof remotePinned !== 'object') return;
        let localMeta = (await DB.getState('pinnedMeta')) || {};
        // Unwrap if still in the corrupted wrapper format
        if (localMeta && typeof localMeta.meta === 'object' && !Array.isArray(localMeta.meta)
            && Array.isArray(localMeta.order)) {
          localMeta = localMeta.meta || {};
        }
        // Support new { meta, order } format (from _pushPinned 3.5.1+) and old plain-dict format.
        // IMPORTANT: do NOT pass the whole remotePinned object to _mergePinned — it expects
        // a plain { id: item } dict, not { meta: {...}, order: [...] }.
        const remoteMeta  = (remotePinned?.meta ?? remotePinned) || {};
        const remoteOrder = Array.isArray(remotePinned?.order) ? remotePinned.order : Object.keys(remoteMeta);
        // _mergePinned: remote is base (deletions respected).
        // Local-only items kept only if pinnedAt > remote manifest timestamp
        // (i.e., pinned offline after the remote was last written).
        const merged      = _mergePinned(localMeta, remoteMeta, _remoteTs.pinned || 0);
        const mergedIds   = Object.keys(merged);
        await DB.setState('pinnedMeta', merged);
        // Order: remote order first, then any local-only additions at the end
        const localOnlyIds = mergedIds.filter(id => !remoteMeta[id]);
        await DB.setState('pinned', [...remoteOrder, ...localOnlyIds]);
        console.log(`[Sync] Merged pinned: ${mergedIds.length} items (remote: ${remoteOrder.length}, local-only: ${localOnlyIds.length})`);
      });
      _prog(48);

      // ── Merge recents ─────────────────────────────────────
      await _mergeStep('recents', async () => {
        if (!Array.isArray(remoteRecents) || remoteRecents.length === 0) return;
        const validRemote = remoteRecents.filter(r => r && r.id);
        if (!validRemote.length) return;
        const local = await DB.getRecentsAll(); // includes local tombstones
        const { merged, tombstoneRecords } = _mergeRecents(local, validRemote);

        // Apply remote tombstones locally so deleted items don't come back
        const localMap = new Map(local.map(r => [r.id, r]));
        const toTombstone = tombstoneRecords.filter(t => {
          const l = localMap.get(t.id);
          return l && !l.removedAt && t.removedAt > (l.accessedAt || 0);
        });
        if (toTombstone.length) await DB.bulkPutRecents(toTombstone);

        if (!merged.length) return;

        // Write live items where remote is newer
        const toWrite = merged.filter(m => {
          const l = localMap.get(m.id);
          return !l || m.accessedAt > (l.accessedAt || 0);
        });
        if (toWrite.length) {
          await DB.bulkPutRecents(toWrite);
          console.log(`[Sync] Merged recents: ${toWrite.filter(m => !localMap.has(m.id)).length} added, ${toWrite.filter(m => localMap.has(m.id)).length} updated, ${toTombstone.length} tombstoned`);
        }
      });
      _prog(56);

      // ── Merge play counts ─────────────────────────────────
      await _mergeStep('playcounts', async () => {
        if (!Array.isArray(remotePlaycounts) || remotePlaycounts.length === 0) return;
        const validRemote = remotePlaycounts.filter(r => r && r.id);
        if (!validRemote.length) return;
        // Use getAllPlaycounts (includes hidden) so removed items aren't re-upserted
        // as if they were brand-new remote records by _mergePlaycounts.
        const local = await DB.getAllPlaycounts();
        const { toUpsert } = _mergePlaycounts(local, validRemote);
        if (toUpsert.length) {
          await DB.bulkPutMeta(toUpsert);
          console.log(`[Sync] Merged ${toUpsert.length} remote playcounts`);
        }
      });
      _prog(63);

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
      _prog(68);

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
      _prog(74);

      // ── Merge song metadata (name, album membership, enrichment) ─────────────
      // Text fields (artist/album/year): overwrite if remote was MB/AudD-enriched —
      // those values are authoritative over locally folder-inferred names.
      // Structural fields (name/displayName/folderId) and cover URLs: fill-only.
      await _mergeStep('metadata', async () => {
        if (!Array.isArray(remoteMetadata) || remoteMetadata.length === 0) return;
        const FILL_ONLY     = ['name', 'displayName', 'folderId', 'mbReleaseMbid'];
        const ENRICH_FIELDS = ['artist', 'album', 'year'];

        // Single bulk read — avoids per-song getMeta overhead with large libraries
        const allLocal = await DB.getAllMeta();
        const localMap = new Map(allLocal.map(m => [m.id, m]));
        const toWrite  = [];

        for (const item of remoteMetadata) {
          if (!item?.id) continue;
          const ex     = localMap.get(item.id) || {};
          const merged = { ...ex, id: item.id };   // id always set even for new records

          if (item.mbTried)   merged.mbTried   = true;
          if (item.auddTried) merged.auddTried = true;

          // rescannedAt: take the most recent timestamp (folder rescan status)
          if (item.rescannedAt && (item.rescannedAt > (merged.rescannedAt || 0))) {
            merged.rescannedAt = item.rescannedAt;
          }

          // manualAt: take the most recent timestamp (manual-edit indicator / blue dot)
          const localManualAt  = ex.manualAt   || 0;
          const remoteManualAt = item.manualAt  || 0;
          if (remoteManualAt > localManualAt) merged.manualAt = remoteManualAt;
          const localManualWins = localManualAt > remoteManualAt;

          for (const f of FILL_ONLY) {
            if (!item[f]) continue;
            if (!merged[f]) merged[f] = item[f];
          }

          const remoteIsEnriched = item.mbTried || item.auddTried;
          for (const f of ENRICH_FIELDS) {
            if (!item[f]) continue;
            if (localManualWins) continue;   // local was manually edited more recently — keep it
            if (remoteIsEnriched || !merged[f]) merged[f] = item[f];
          }

          // thumbnailUrl / coverUrl — same manual-override / fill-only rules as _applyRemote.
          if (item.thumbnailUrl && !localManualWins) {
            if (remoteManualAt > 0) {
              merged.thumbnailUrl = item.thumbnailUrl; // manual edit — always propagate
            } else {
              const hasLocalCover = (merged.thumbnailUrl && merged.thumbnailUrl !== 'id3')
                                  || merged.coverBlob;
              if (!hasLocalCover) merged.thumbnailUrl = item.thumbnailUrl;
            }
          }
          // coverUrl (album folder header cover) — same rules
          if (item.coverUrl && !localManualWins) {
            if (remoteManualAt > 0 || !merged.coverUrl) {
              merged.coverUrl = item.coverUrl;
            }
          }

          if (merged.mbReleaseMbid && !merged.thumbnailUrl) {
            merged.thumbnailUrl = `https://coverartarchive.org/release/${merged.mbReleaseMbid}/front-250`;
          }

          // durationSec: take the larger non-zero value — physical property of the file,
          // both devices converge to the same reading. Same rule as _applyRemote.
          if (item.durationSec > 0 && item.durationSec > (merged.durationSec || 0)) {
            merged.durationSec = item.durationSec;
          }

          const changed = Object.keys(merged).some(k => merged[k] !== ex[k])
                       || Object.keys(ex).some(k => merged[k] !== ex[k]);
          if (changed) toWrite.push(merged);
        }

        if (toWrite.length > 0) {
          await DB.bulkWriteMeta(toWrite);
          console.log(`[Sync] Merged metadata: ${toWrite.length} songs updated from remote`);

          // Cache cover blobs locally for any record that arrived with a thumbnailUrl
          if (typeof App !== 'undefined' && App.cacheExternalCover) {
            for (const rec of toWrite) {
              if (rec.thumbnailUrl && !rec.thumbnailUrl.startsWith('blob:')) {
                App.cacheExternalCover(rec.id, rec.thumbnailUrl, true).catch(() => {});
              }
            }
          }

          // Propagate merged metadata to in-memory caches (Drive DB = single source of truth)
          if (typeof App !== 'undefined' && App.liveMetaUpdate) {
            for (const rec of toWrite) {
              const patch = {};
              if (rec.artist)       patch.artist       = rec.artist;
              if (rec.album)        patch.album        = rec.album;
              if (rec.year)         patch.year         = rec.year;
              if (rec.thumbnailUrl) patch.thumbnailUrl = rec.thumbnailUrl;
              if (rec.coverUrl)     patch.coverUrl     = rec.coverUrl;
              if (Object.keys(patch).length) {
                App.liveMetaUpdate([rec.id], patch);
              }
            }
          }
        }
      });

      // ── Collections merge (init) ──────────────────────────────
      await _mergeStep('collections', async () => {
        const remote = Array.isArray(remoteCollections) ? remoteCollections : [];
        if (remote.length === 0) return;
        const localMap = new Map((await DB.getAllCollections()).map(c => [c.id, c]));
        for (const item of remote) {
          if (!item?.id) continue;
          const local = localMap.get(item.id) || {};
          const remoteManualAt = item.manualAt || 0;
          const localManualAt  = local.manualAt  || 0;
          const remoteWins = remoteManualAt >= localManualAt;
          const patch = {};
          if (item.forceType && !local.forceType) patch.forceType = item.forceType;
          if (item.name     && (remoteWins || !local.name))     patch.name     = item.name;
          if (item.coverUrl && (remoteWins || !local.coverUrl)) patch.coverUrl = item.coverUrl;
          if (remoteManualAt > localManualAt) patch.manualAt = remoteManualAt;
          if (Object.keys(patch).length) {
            await DB.saveCollection(item.id, { ...local, ...patch, manualAt: patch.manualAt ?? localManualAt });
          }
        }
        console.log(`[Sync] Merged collections (${remote.length} remote records)`);
      });
      _prog(86);

      // Push merged state back + update manifest.
      // Only push types that were actually stale (downloaded + merged this session).
      // Fresh/skipped types are NOT re-pushed — their remote snapshot is already
      // up-to-date, and pushing identical data would bump timestamps and force all
      // other devices to re-download unnecessarily (cascade download loop).
      // Live push() already handles in-session changes (with debounce + _localTs persist).
      // Skip types whose merge step failed (prevents data-poisoning via LWW).
      // Skip SKIP_ON_INIT types (e.g. 'hot' — transient delta, not pushed at init).
      const now = Date.now();
      const safeToPush = Object.keys(FILENAMES).filter(t =>
        !_failedTypes.has(t) &&
        !SKIP_ON_INIT.has(t) &&
        !_skippedTypes.has(t)   // fresh types: remote already has latest data — don't re-push
      );
      await Promise.allSettled(safeToPush.map(t => _pushFns[t]()));
      for (const t of safeToPush) _localTs[t] = now;
      if (safeToPush.length) await _bumpManifest(safeToPush);
      if (_failedTypes.size) console.warn('[Sync] Skipped push for failed types:', [..._failedTypes]);
      _prog(95);

      // Push home snapshot last — after all individual types are merged and pushed,
      // so the snapshot reflects the fully-merged state (not stale pre-merge data).
      try {
        await _pushHome();
        const homeTs = Date.now();
        _localTs.home  = homeTs;
        _remoteTs.home = homeTs;
        await _bumpManifest(['home']);
      } catch (_) {}

      // ── Persist local timestamps so next session can skip fresh types ────────
      // Saved AFTER all pushes so the stored values reflect what was actually written.
      await DB.setState('sync_localTs', { ..._localTs }).catch(() => {});

      _prog(100);

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

  // Per-type debounce delays (ms).
  // recents / history write the moment a song starts playing — near-zero debounce
  // so Device B sees the change within the next poll cycle (~3 s) rather than 5-8 s.
  // Other types keep a longer debounce to batch rapid changes (e.g. metadata edits).
  const PUSH_DELAY = {
    recents:     300,   // song just started → write fast
    history:     300,   // same
    favorites:   1500,
    pinned:      1500,
    playlists:   1500,
    playcounts:  3000,
    settings:    2000,
    metadata:    2000,
    collections: 2000,
  };

  /**
   * Debounced push: called by app after any local data change.
   * Writes data to Drive and bumps the manifest so other devices pick it up.
   * @param {'favorites'|'playlists'|'pinned'|'recents'|'playcounts'|'settings'|'metadata'} type
   */
  function push(type) {
    if (!_ready) return;
    const delay = PUSH_DELAY[type] ?? 2000;
    if (_timers[type]) clearTimeout(_timers[type]);
    _timers[type] = setTimeout(async () => {
      try {
        await _pushFns[type]?.();
        await _bumpManifest([type]);
        // Update and persist _localTs so next session knows this type is already
        // up-to-date and skips the download — fixes the re-download loop.
        _localTs[type] = Date.now();
        await DB.setState('sync_localTs', { ..._localTs }).catch(() => {});
      } catch (err) {
        if (err.isScope) return;
        console.warn(`[Sync] push(${type}) failed:`, err.message);
      }
    }, delay);

    // Any change to a home-relevant type also triggers a home snapshot push.
    // For recents/history: 1 s after the fast individual push so home reflects
    // the new song quickly. Other types use 3 s to let their push complete first.
    if (HOME_TYPES.has(type)) {
      const homeDelay = (type === 'recents' || type === 'history') ? 1000 : 3000;
      if (_timers._home) clearTimeout(_timers._home);
      _timers._home = setTimeout(async () => {
        try {
          await _pushHome();
          await _bumpManifest(['home']);
        } catch (err) {
          if (err.isScope) return;
          console.warn('[Sync] push(home) failed:', err.message);
        }
      }, homeDelay);
    }
  }

  /**
   * Immediate (no debounce) hot-delta push for rescan results.
   * Writes only the rescanned songs to savart_hot.json (~5 KB) so other
   * devices see enriched metadata and album art within the next poll cycle (≤ 3 s).
   * The full metadata push via push('metadata') continues in the background for
   * initial-setup sync on new devices.
   *
   * @param {Array<{id:string}>} files — Drive file objects (or any objects with .id)
   *   whose current DB metadata should be pushed.
   */
  async function pushHot(files) {
    if (!_ready || !files?.length) return;
    try {
      // Fetch fresh DB records for just these songs (small count — no bulk needed)
      const metas = await Promise.all(files.map(f => DB.getMeta(f.id || f).catch(() => null)));
      const valid  = metas.filter(m => m?.id);
      if (!valid.length) return;
      await _pushHot(valid);
      await _bumpManifest(['hot']);
    } catch (err) {
      if (err.isScope) return;
      console.warn('[Sync] pushHot() failed:', err.message);
    }
  }

  /**
   * Fast boot read: pulls savart_home.json from Drive and applies it to local DB.
   * ─────────────────────────────────────────────────────────────────────────────
   * Call this immediately after auth (before Sync.init()) so the home screen
   * renders with fresh cross-device data in ~300 ms instead of waiting for the
   * full init() merge cycle. Sync.init() runs in parallel and overwrites with
   * fully-merged data once complete.
   *
   * Returns the raw snapshot payload, or null if unavailable / on error.
   */
  async function readHome() {
    try {
      await _refreshFileList();
      const data = await _readFile(FILENAMES.home).catch(() => null);
      if (!data) return null;

      await _applyRemote('home', data);

      // Seed timestamps so init()/polling don't re-apply this same snapshot
      const ts = data.ts || Date.now();
      _localTs.home  = ts;
      _remoteTs.home = ts;

      console.log('[Sync] readHome() applied ✓');
      return data;
    } catch (err) {
      if (err.isScope) return null;
      console.warn('[Sync] readHome() failed (non-fatal):', err.message);
      return null;
    }
  }

  /* ── Expose ─────────────────────────────────────────────── */
  /**
   * Fetch all savart_*.json files from appDataFolder and return their sizes.
   * @returns {Promise<{ files: {name:string, size:number}[], totalBytes:number }>}
   */
  async function getDbStats() {
    const res = await _apiFetch(
      `${API}/files?spaces=appDataFolder&fields=files(name,size)&pageSize=30`
    );
    const { files = [] } = await res.json();
    const savartFiles = files
      .filter(f => f.name && f.name.startsWith('savart_'))
      .map(f => ({ name: f.name, size: parseInt(f.size || 0, 10) }))
      .sort((a, b) => b.size - a.size);
    const totalBytes = savartFiles.reduce((s, f) => s + f.size, 0);
    return { files: savartFiles, totalBytes };
  }

  return { init, push, pushHot, readHome, startLiveSync, stopLiveSync, getDbStats };

})();
