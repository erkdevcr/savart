/* ============================================================
   Savart — YouTube Playlists Sync
   Fetches the authenticated user's YouTube playlists and stores
   them in the local playlist system (DB.putPlaylist).
   - Playlist IDs: 'yt_<ytPlaylistId>'
   - Song IDs:     'sd_<videoId>'  (Soundrop-compatible)
   - Auto-syncs every 30 min while the user is authenticated.
   ============================================================ */

const YTPlaylists = (() => {

  const ID_PREFIX   = 'yt_';
  const SYNC_INTERVAL = 30 * 60 * 1000; // 30 min
  const API_BASE    = 'https://www.googleapis.com/youtube/v3';
  // Same key as soundrop.js — only used for public data; playlist fetches use OAuth token.
  const YT_KEY      = 'AIzaSyBgi4D1UclWh6EVAPaXfApI34AF7lh_O4E';

  let _syncTimer = null;
  let _syncing   = false;

  /* ── Public API ───────────────────────────────────────── */

  /** Start auto-sync (immediate first run). */
  function start() {
    sync();
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = setInterval(sync, SYNC_INTERVAL);
  }

  /** Stop auto-sync (called on YT logout). */
  function stop() {
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
  }

  /** Force an immediate sync. Returns a Promise. */
  async function sync() {
    if (_syncing || !YTAuth.isAuthenticated()) return;
    _syncing = true;
    try {
      await _syncAll();
    } catch (err) {
      console.warn('[YTPlaylists] sync error:', err?.message || err);
    } finally {
      _syncing = false;
    }
  }

  /* ── Internal sync ────────────────────────────────────── */

  async function _syncAll() {
    // 1. Fetch all of the user's playlists (up to 50; paginated if more).
    const ytItems = [];
    let pageToken = undefined;
    do {
      const params = { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;
      const data = await _apiFetch('playlists', params);
      ytItems.push(...(data.items || []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    const ytIdSet = new Set(ytItems.map(i => i.id));

    // 2. Remove local YT playlists that were deleted from YouTube.
    const allLocal = await DB.getPlaylists().catch(() => []);
    for (const pl of allLocal) {
      if (pl.isYouTube && pl.ytPlaylistId && !ytIdSet.has(pl.ytPlaylistId)) {
        await DB.deletePlaylist(pl.id).catch(() => {});
      }
    }

    // 3. Upsert each YT playlist.
    for (const ytItem of ytItems) {
      await _syncOne(ytItem);
    }
  }

  async function _syncOne(ytItem) {
    const ytId = ytItem.id;
    const plId = ID_PREFIX + ytId;
    const existing = await DB.getPlaylist(plId).catch(() => null);

    // Skip if nothing changed (etag match AND we already have songs).
    if (existing?.ytEtag === ytItem.etag && existing?.songIds?.length > 0) return;

    // Fetch all items in the playlist (paginated).
    const songIds = [];
    let pageToken = undefined;
    do {
      const params = { part: 'snippet', playlistId: ytId, maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;
      const data = await _apiFetch('playlistItems', params);
      for (const item of (data.items || [])) {
        const videoId = item.snippet?.resourceId?.videoId;
        // Skip deleted / private videos (title is '[Deleted video]' / '[Private video]').
        if (!videoId) continue;
        const title = item.snippet?.title || '';
        if (title === '[Deleted video]' || title === '[Private video]') continue;

        const sdId = `sd_${videoId}`;
        songIds.push(sdId);

        // Store minimal metadata so the player can display title + cover.
        // Don't overwrite richer metadata that may already exist (e.g. from a search).
        const existingMeta = await DB.getMeta(sdId).catch(() => null);
        if (!existingMeta?.displayName) {
          const thumb = _bestThumb(item.snippet?.thumbnails);
          await DB.setMeta(sdId, {
            displayName:  title,
            artist:       item.snippet?.videoOwnerChannelTitle || '',
            thumbnailUrl: thumb,
            isSoundrop:   true,
            videoId,
          }).catch(() => {});
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    // Persist the playlist.
    const coverUrl = _bestThumb(ytItem.snippet?.thumbnails);
    await DB.putPlaylist({
      id:           plId,
      name:         ytItem.snippet?.title || 'YouTube Playlist',
      songIds,
      coverUrls:    coverUrl ? [coverUrl] : [],
      isYouTube:    true,
      ytPlaylistId: ytId,
      ytEtag:       ytItem.etag || '',
      ytSyncedAt:   Date.now(),
      createdAt:    existing?.createdAt || Date.now(),
      updatedAt:    Date.now(),
    });
  }

  /* ── YouTube Data API helper ──────────────────────────── */

  async function _apiFetch(endpoint, params) {
    const url = new URL(`${API_BASE}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const token = await YTAuth.getToken();
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `YT API ${res.status}`);
    }
    return res.json();
  }

  function _bestThumb(thumbnails) {
    if (!thumbnails) return '';
    return (thumbnails.medium?.url || thumbnails.high?.url || thumbnails.default?.url || '');
  }

  return { start, stop, sync };
})();
