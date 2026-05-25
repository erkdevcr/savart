/* ============================================================
   Savart — Soundrop module
   YouTube search → Cloudflare Worker MP3 link → Savart player.
   Separate from Drive; tracks are not cached in IndexedDB.
   ============================================================ */

const Soundrop = (() => {

  // ── Constants ─────────────────────────────────────────────
  const YT_SEARCH  = 'https://www.googleapis.com/youtube/v3/search';
  const YT_VIDEOS  = 'https://www.googleapis.com/youtube/v3/videos';
  const WORKER_URL = 'https://sounddrop-worker.erisd17.workers.dev';
  const YT_KEY     = 'AIzaSyBgi4D1UclWh6EVAPaXfApI34AF7lh_O4E';

  // ── Search YouTube ────────────────────────────────────────

  /**
   * Search YouTube for audio tracks matching `term`.
   * Returns an array of Soundrop track objects ready to hand to the player.
   *
   * @param {string} term
   * @returns {Promise<SoundropTrack[]>}
   */
  async function search(term) {
    // 1. Search request
    const searchParams = new URLSearchParams({
      part: 'snippet',
      q: term,
      type: 'video',
      videoCategoryId: '10', // Music
      maxResults: '20',
      key: YT_KEY,
    });
    const searchRes = await fetch(`${YT_SEARCH}?${searchParams}`);
    if (!searchRes.ok) throw new Error(`YouTube search failed: ${searchRes.status}`);
    const searchData = await searchRes.json();
    const items = searchData.items || [];
    if (!items.length) return [];

    const videoIds = items.map(i => i.id.videoId).filter(Boolean).join(',');

    // 2. Content details (duration) for each video
    const detailParams = new URLSearchParams({
      part: 'snippet,contentDetails',
      id: videoIds,
      key: YT_KEY,
    });
    const detailRes = await fetch(`${YT_VIDEOS}?${detailParams}`);
    if (!detailRes.ok) throw new Error(`YouTube videos failed: ${detailRes.status}`);
    const detailData = await detailRes.json();

    // Build a map videoId → details
    const detailMap = {};
    (detailData.items || []).forEach(v => { detailMap[v.id] = v; });

    // 3. Build Soundrop track objects
    return items.map(item => {
      const vid     = item.id.videoId;
      const snippet = item.snippet;
      const detail  = detailMap[vid];

      // Parse ISO 8601 duration → seconds
      const durStr  = detail?.contentDetails?.duration || '';
      const durSec  = _parseDuration(durStr);

      // Decode HTML entities — YouTube API encodes ' → &#39;, & → &amp;, etc.
      const rawTitle   = _decodeHtml(snippet.title || '');
      const channelTitle = _decodeHtml(snippet.channelTitle || '');

      // Heuristic title split: "Artist - Title"
      let artist = '', title = rawTitle;
      const dash = rawTitle.indexOf(' - ');
      if (dash > 0) {
        artist = rawTitle.slice(0, dash).trim();
        title  = rawTitle.slice(dash + 3).trim();
      }

      return {
        id:           `sd_${vid}`,
        videoId:      vid,
        isSoundrop:   true,
        name:         rawTitle,
        displayName:  title,
        artist:       artist,
        album:        '',
        year:         (snippet.publishedAt || '').slice(0, 4),
        thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
        channelTitle: channelTitle,
        mimeType:     'audio/mpeg',
        durationSec:  durSec,
        size:         0,
      };
    });
  }

  /**
   * Ask the Cloudflare Worker for a streamable MP3 URL for a given YouTube video.
   * Returns a string URL on success, or throws.
   *
   * @param {string} videoId  — bare YouTube video ID (no "sd_" prefix)
   * @returns {Promise<string>}
   */
  async function getAudioLink(videoId) {
    const url = `${WORKER_URL}?id=${encodeURIComponent(videoId)}`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new Error(`[Soundrop] Worker no responde: ${err.message}`);
    }
    if (!res.ok) throw new Error(`[Soundrop] Worker HTTP ${res.status}`);
    let data;
    try { data = await res.json(); } catch { throw new Error('[Soundrop] Worker respuesta inválida'); }
    if (data.status !== 'ok' || !data.link) {
      throw new Error(`[Soundrop] Worker: ${data.msg || 'sin link de audio'}`);
    }
    return data.link;
  }

  /**
   * Download the audio for a Soundrop track as a Blob.
   * Used only during the "save to Drive" flow.
   *
   * @param {string} audioUrl  — URL returned by getAudioLink()
   * @returns {Promise<Blob>}
   */
  async function fetchBlob(audioUrl) {
    let res;
    try {
      res = await fetch(audioUrl, { signal: AbortSignal.timeout(120000) });
    } catch (err) {
      throw new Error(`[Soundrop] Descarga falló: ${err.message}`);
    }
    if (!res.ok) throw new Error(`[Soundrop] Descarga HTTP ${res.status}`);
    try {
      return await res.blob();
    } catch (err) {
      throw new Error(`[Soundrop] Error leyendo blob: ${err.message}`);
    }
  }

  // ── Upload to Drive ───────────────────────────────────────

  /**
   * Save a Soundrop track to the user's Drive "Soundrop" folder.
   * Creates the folder if it doesn't exist.
   *
   * @param {Blob}   blob      — audio blob
   * @param {object} meta      — { title, artist, album, year }
   * @returns {Promise<string>}  — Drive file ID of the uploaded file
   */
  async function saveToDrive(blob, meta) {
    // Build nested folder path inside MSK:
    //   Soundrop/                        (always)
    //   Soundrop/{Artist}/               (if artist set)
    //   Soundrop/{Artist}/{Album}/       (if artist + album set)
    let folderId = await Drive.findOrCreateFolder('Soundrop', CONFIG.ROOT_FOLDER_ID);

    const artist = (meta.artist || '').trim();
    const album  = (meta.album  || '').trim();

    if (artist) {
      folderId = await Drive.findOrCreateFolder(artist, folderId);
      if (album) {
        folderId = await Drive.findOrCreateFolder(album, folderId);
      }
    }

    // Filename: "Artist - Title.mp3" (or just "Title.mp3" when no artist)
    const titlePart  = (meta.title || 'Soundrop track').trim();
    const filename   = artist ? `${artist} - ${titlePart}.mp3` : `${titlePart}.mp3`;

    // Upload via multipart
    const fileId = await Drive.uploadFile(blob, filename, 'audio/mpeg', folderId);
    return { fileId, folderId, filename };
  }

  // ── Helpers ───────────────────────────────────────────────

  /**
   * Decode HTML entities returned by the YouTube Data API.
   * e.g. &#39; → '   &amp; → &   &quot; → "
   * Uses a temporary textarea so the browser's HTML parser handles all cases.
   * @param {string} str
   * @returns {string}
   */
  function _decodeHtml(str) {
    if (!str) return '';
    const el = document.createElement('textarea');
    el.innerHTML = str;
    return el.value;
  }

  /**
   * Parse ISO 8601 duration string (e.g. "PT3M45S") to seconds.
   * @param {string} str
   * @returns {number}
   */
  function _parseDuration(str) {
    if (!str) return 0;
    const m = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || 0) * 3600)
         + (parseInt(m[2] || 0) * 60)
         + parseInt(m[3] || 0);
  }

  // ── Expose ────────────────────────────────────────────────
  return { search, getAudioLink, fetchBlob, saveToDrive };

})();
