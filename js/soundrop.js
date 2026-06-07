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
   * Strategy:
   *   Android native (Capacitor): use CapacitorHttp.request() — bypasses WebView CORS
   *     completely, allowing direct download of the CDN URL (which is IP-locked and
   *     unreachable from Cloudflare datacenter IPs).
   *   Web / PWA: use Worker proxy (?download=1) — Cloudflare adds CORS headers.
   *     Note: this path may fail (cdn 404) if the CDN URL is IP-locked.
   *
   * @param {string} videoId  — bare YouTube video ID (no "sd_" prefix)
   * @returns {Promise<Blob>}
   */
  async function fetchBlob(videoId) {
    // ── Android native path: CapacitorHttp bypasses WebView CORS ──────────────
    const capHttp = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform?.()
      ? (Capacitor.Plugins?.CapacitorHttp || Capacitor.Plugins?.Http)
      : null;

    if (capHttp) {
      // 1. Get CDN URL from Worker (normal JSON mode — no ?download=1)
      const audioUrl = await getAudioLink(videoId);

      // 2. Download via native HTTP (no CORS restriction)
      let nativeRes;
      try {
        nativeRes = await capHttp.request({
          method:       'GET',
          url:          audioUrl,
          responseType: 'blob',        // returns base64-encoded binary
          connectTimeout: 30000,
          readTimeout:  120000,
        });
      } catch (err) {
        throw new Error(`[Soundrop] Descarga nativa falló: ${err.message}`);
      }
      if (nativeRes.status < 200 || nativeRes.status >= 300) {
        throw new Error(`[Soundrop] Descarga nativa HTTP ${nativeRes.status}`);
      }

      // Convert base64 → Blob
      let base64 = nativeRes.data || '';
      // Strip data-URL prefix if present (e.g. "data:audio/mpeg;base64,...")
      const comma = base64.indexOf(',');
      if (comma !== -1) base64 = base64.slice(comma + 1);
      const byteChars  = atob(base64);
      const byteArray  = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
      const ct = (nativeRes.headers?.['content-type'] || '').split(';')[0].trim() || 'audio/mpeg';
      return new Blob([byteArray], { type: ct });
    }

    // ── Web / PWA path: Worker proxy with CORS headers ─────────────────────────
    const proxyUrl = `${WORKER_URL}?id=${encodeURIComponent(videoId)}&download=1`;
    let res;
    try {
      res = await fetch(proxyUrl, { signal: AbortSignal.timeout(120000) });
    } catch (err) {
      throw new Error(`[Soundrop] Descarga falló: ${err.message}`);
    }
    if (!res.ok) {
      // Read Worker error body for diagnostics (shown in UI toast)
      let detail = '';
      try {
        const errBody = await res.clone().json();
        if (errBody.error)       detail = `: ${errBody.error}`;
        if (errBody.rapidStatus) detail += ` (rapidAPI: ${errBody.rapidStatus})`;
        if (errBody.cdnStatus)   detail += ` (cdn: ${errBody.cdnStatus})`;
        if (errBody.msg)         detail += ` — ${errBody.msg}`;
      } catch {}
      throw new Error(`[Soundrop] Descarga HTTP ${res.status}${detail}`);
    }

    // Validate content-type — CDN sometimes returns HTML error pages with status 200
    const ct = (res.headers.get('Content-Type') || '').toLowerCase();
    if (ct.startsWith('text/') || ct.includes('html')) {
      throw new Error(`[Soundrop] Link de audio expirado o inválido (tipo: ${ct})`);
    }

    let blob;
    try {
      blob = await res.blob();
    } catch (err) {
      throw new Error(`[Soundrop] Error leyendo blob: ${err.message}`);
    }

    // Magic-byte validation — guard against non-audio responses
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const isMP3  = (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) ||
                   (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33);
    const isWebM = head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
    const isMP4  = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
    const isOGG  = head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53;
    if (!isMP3 && !isWebM && !isMP4 && !isOGG) {
      throw new Error('[Soundrop] El archivo descargado no es audio válido (link expirado o bloqueado)');
    }

    return blob;
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
    const soundropRootId = await Drive.findOrCreateFolder('Soundrop', CONFIG.ROOT_FOLDER_ID);
    let folderId = soundropRootId;

    const artist = (meta.artist || '').trim();
    const album  = (meta.album  || '').trim();

    let artistFolderId = null;
    let albumFolderId  = null;

    if (artist) {
      artistFolderId = await Drive.findOrCreateFolder(artist, soundropRootId);
      folderId = artistFolderId;
      if (album) {
        albumFolderId = await Drive.findOrCreateFolder(album, artistFolderId);
        folderId = albumFolderId;
      }
    }

    // Derive MIME type and extension from the actual blob content.
    // YouTube/Worker can return audio/webm (Opus), audio/mp4 (AAC), audio/mpeg, etc.
    // Using the wrong MIME type causes Drive to show the file as unplayable.
    const mimeType = blob.type && blob.type !== 'application/octet-stream'
      ? blob.type.split(';')[0].trim()   // strip parameters (e.g. "audio/mpeg; codecs=...")
      : 'audio/mpeg';

    const EXT_MAP = {
      'audio/mpeg':  'mp3',
      'audio/mp3':   'mp3',
      'audio/webm':  'webm',
      'audio/ogg':   'ogg',
      'audio/mp4':   'm4a',
      'audio/aac':   'aac',
      'audio/x-m4a': 'm4a',
      'video/mp4':   'mp4',
      'video/webm':  'webm',
    };
    const ext = EXT_MAP[mimeType] || 'mp3';

    // Filename: "Artist - Title.ext" (or just "Title.ext" when no artist)
    const titlePart = (meta.title || 'Soundrop track').trim();
    const filename  = artist ? `${artist} - ${titlePart}.${ext}` : `${titlePart}.${ext}`;

    // Upload via multipart
    const fileId = await Drive.uploadFile(blob, filename, mimeType, folderId);

    // Return full folder hierarchy so the caller can write it to local DB.
    // This enables _isInSoundropFolder to walk the tree without Drive API calls.
    const folderHierarchy = [
      { id: soundropRootId, name: 'Soundrop',  parentId: CONFIG.ROOT_FOLDER_ID },
      ...(artistFolderId ? [{ id: artistFolderId, name: artist, parentId: soundropRootId }] : []),
      ...(albumFolderId  ? [{ id: albumFolderId,  name: album,  parentId: artistFolderId  }] : []),
    ];

    return { fileId, folderId, filename, folderHierarchy };
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
