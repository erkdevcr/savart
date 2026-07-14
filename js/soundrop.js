/* ============================================================
   Savart — Soundrop module
   YouTube search → Cloudflare Worker MP3 link → Savart player.
   Separate from Drive; tracks are not cached in IndexedDB.
   ============================================================ */

const Soundrop = (() => {

  // ── Constants ─────────────────────────────────────────────
  const YT_SEARCH  = 'https://www.googleapis.com/youtube/v3/search';
  const YT_VIDEOS  = 'https://www.googleapis.com/youtube/v3/videos';
  const WORKER_URL = 'https://sounddrop-worker.erisd17.workers.dev'; // v8 — cobalt.tools
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

    // 2. Content details (duration) + status (embeddable) for each video.
    // 'status' viene gratis en la misma llamada y trae status.embeddable —
    // permite marcar con candado los videos que requerirán conversión.
    const detailParams = new URLSearchParams({
      part: 'snippet,contentDetails,status',
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

      // Restricción de incrustado: embeddable=false (errores 101/150 del iframe)
      // o restricción de edad (tampoco reproduce embebido). El chip SD muestra
      // un candado para avisar ANTES de tocar play que requerirá conversión.
      const embedBlocked =
        detail?.status?.embeddable === false ||
        detail?.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted';

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
        embedBlocked: embedBlocked,
      };
    });
  }

  /**
   * Ask the Cloudflare Worker for the cobalt.tools audio URL for a YouTube video.
   * Returns the cobalt URL directly — the browser fetches audio from cobalt's servers,
   * which include CORS headers (Access-Control-Allow-Origin: *) required so that
   * createMediaElementSource can route the audio through the Web Audio graph (EQ/preamp).
   *
   * @param {string} videoId  — bare YouTube video ID (no "sd_" prefix)
   * @returns {Promise<string>}
   */
  async function getAudioLink(videoId, onStatus) {
    return _getLinkPolling(videoId, onStatus);
  }

  /**
   * Obtiene el link MP3 del Worker, POLLEANDO mientras la conversión esté en
   * curso. Los videos largos (15-30+ min) tardan MINUTOS en convertirse en
   * youtube-mp36 — antes el Worker devolvía error a los ~12 s y el cliente se
   * rendía, por eso las canciones largas fallaban y las de 3-4 min no.
   *
   * @param {string}   videoId
   * @param {function} [onStatus]  — recibe 'converting' en cada poll
   * @param {number}   [totalMs]   — presupuesto total de espera (def. 5 min)
   */
  async function _getLinkPolling(videoId, onStatus, totalMs = 300000) {
    const url      = `${WORKER_URL}?id=${encodeURIComponent(videoId)}`;
    const deadline = Date.now() + totalMs;
    // Backoff progresivo: 5s → 7.5s → 11s → 17s → 25s → 30s (cap).
    // CADA poll consume 1 request de RapidAPI (el Worker re-consulta el estado),
    // así que menos polls = menos cuota gastada. ~12 polls máx. en 5 min
    // en vez de ~60 con intervalo fijo de 5 s.
    let pollMs = 5000;

    while (true) {
      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      } catch (err) {
        throw new Error(`[Soundrop] Worker no responde: ${err.message}`);
      }
      if (!res.ok) throw new Error(`[Soundrop] Worker HTTP ${res.status}`);
      let data;
      try { data = await res.json(); } catch { throw new Error('[Soundrop] Worker respuesta inválida'); }

      if (data.status === 'ok' && data.link) return data.link;

      if (data.status === 'processing') {
        if (Date.now() + pollMs > deadline) {
          throw new Error('[Soundrop] La conversión no terminó a tiempo (video muy largo)');
        }
        try { onStatus?.('converting'); } catch (_) {}
        await new Promise(r => setTimeout(r, pollMs));
        pollMs = Math.min(30000, Math.round(pollMs * 1.5));
        continue; // volver a consultar — la conversión sigue en curso
      }

      throw new Error(`[Soundrop] Worker: ${data.msg || 'sin link de audio'}`);
    }
  }

  /**
   * Descarga el audio con watchdog de INACTIVIDAD (45 s sin recibir bytes)
   * en vez de un timeout total fijo — un archivo de 30-60 MB en conexión
   * lenta excedía los 90 s aunque estuviera bajando perfectamente.
   */
  async function _downloadWithWatchdog(link, onStatus) {
    try { onStatus?.('downloading'); } catch (_) {}
    const ctrl = new AbortController();
    let watchdog = setTimeout(() => ctrl.abort(), 45000);
    let res;
    try {
      res = await fetch(link, { signal: ctrl.signal });
    } catch (err) {
      clearTimeout(watchdog);
      throw err;
    }
    if (!res.ok) { clearTimeout(watchdog); throw new Error(`CDN HTTP ${res.status}`); }
    if (!res.body) { clearTimeout(watchdog); return res.blob(); }
    const reader = res.body.getReader();
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        clearTimeout(watchdog);
        if (done) break;
        watchdog = setTimeout(() => ctrl.abort(), 45000); // reset con cada chunk recibido
        chunks.push(value);
      }
    } catch (err) {
      clearTimeout(watchdog);
      throw new Error(`descarga interrumpida: ${err.message}`);
    }
    const type = (res.headers.get('Content-Type') || 'audio/mpeg').split(';')[0].trim();
    return new Blob(chunks, { type });
  }

  /* Cache de blobs por sesión (videoId → Blob). El fallback de reproducción y
     el guardado a Drive comparten la misma descarga — sin convertir dos veces. */
  const _blobCache = new Map();
  const BLOB_CACHE_MAX = 3; // blobs de audio pesan MB — cota corta

  /**
   * Download the audio for a Soundrop track as a Blob.
   * Used only during the "save to Drive" flow. Playback uses _ytProxy (0 API requests).
   *
   * Flujo:
   *   1. Llama al Worker ?id=VIDEO_ID → RapidAPI youtube-mp36 → JSON { status, link }
   *   2. Fetchea el link MP3 directamente (URL pública, sin IP restriction)
   *   3. Valida magic bytes
   *
   * Reintentos automáticos (hasta 3) para manejar errores transitorios.
   *
   * @param {string} videoId  — bare YouTube video ID (no "sd_" prefix)
   * @returns {Promise<Blob>}
   */
  async function fetchBlob(videoId, onStatus) {
    // Cache de sesión: si el fallback de reproducción ya convirtió/descargó
    // este video, el guardado a Drive lo reutiliza (y viceversa).
    if (_blobCache.has(videoId)) return _blobCache.get(videoId);

    const MAX_ATTEMPTS = 2; // el polling interno ya es paciente — menos reintentos externos
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Step 1: link MP3 del Worker — pollea mientras la conversión esté en curso
      let link;
      try {
        link = await _getLinkPolling(videoId, onStatus);
      } catch (err) {
        lastErr = new Error(`[Soundrop] Worker error (intento ${attempt}): ${err.message}`);
        console.warn(lastErr.message);
        // Overcuota (429) o timeout de conversión: reintentar no ayuda
        if (err.message.includes('429') ||
            err.message.toLowerCase().includes('quota') ||
            err.message.includes('no terminó a tiempo')) break;
        continue;
      }

      // Step 2: descarga con watchdog de inactividad (sin límite total fijo)
      let blob;
      try {
        blob = await _downloadWithWatchdog(link, onStatus);
      } catch (err) {
        lastErr = new Error(`[Soundrop] Error descargando audio (intento ${attempt}): ${err.message}`);
        console.warn(lastErr.message);
        continue;
      }

      // Step 3: Magic-byte validation — guard against non-audio responses
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      const isMP3  = (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) ||
                     (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33);
      const isWebM = head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
      const isMP4  = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
      const isOGG  = head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53;
      if (!isMP3 && !isWebM && !isMP4 && !isOGG) {
        lastErr = new Error('[Soundrop] El archivo descargado no es audio válido');
        console.warn(lastErr.message);
        continue;
      }

      // Cachear (cota FIFO corta — los blobs pesan varios MB)
      _blobCache.set(videoId, blob);
      if (_blobCache.size > BLOB_CACHE_MAX) {
        _blobCache.delete(_blobCache.keys().next().value);
      }

      return blob;  // ✓ éxito
    }

    throw lastErr || new Error('[Soundrop] Descarga fallida después de 3 intentos');
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
  async function saveToDrive(blob, meta, rootFolderId) {
    // Build nested folder path inside the user's root folder:
    //   Soundrop/                        (always)
    //   Soundrop/{Artist}/               (if artist set)
    //   Soundrop/{Artist}/{Album}/       (if artist + album set)
    // rootFolderId is passed from App._rootFolderId so it works for any account.
    const _rootId = rootFolderId || CONFIG.ROOT_FOLDER_ID;
    const soundropRootId = await Drive.findOrCreateFolder('Soundrop', _rootId);
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
      { id: soundropRootId, name: 'Soundrop',  parentId: _rootId },
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

  // ── YouTube iframe player ─────────────────────────────────
  //
  // Replaces the Cloudflare Worker approach for browser playback.
  // The iframe player runs in the user's browser (residential IP), so
  // YouTube's InnerTube is called from a real browser session — no
  // datacenter IP restrictions.  The Worker is kept only for fetchBlob
  // (save-to-Drive flow).
  //
  // Requires a <div id="yt-player-anchor"> in index.html.

  const yt = (() => {
    let _p      = null;    // YT.Player instance
    let _ready  = false;   // API + player both ready
    let _cbs    = {};      // callbacks set by the current load() call
    let _paused = true;    // tracks playback state

    // Must be defined BEFORE the API script fires onYouTubeIframeAPIReady.
    window.onYouTubeIframeAPIReady = () => {
      const anchor = document.getElementById('yt-player-anchor');
      if (!anchor) return;
      _p = new YT.Player(anchor, {
        width: 1, height: 1,
        playerVars: {
          controls: 0, disablekb: 1, fs: 0,
          playsinline: 1, enablejsapi: 1,
          origin: location.origin,
        },
        events: {
          onReady:       () => { _ready = true; },
          onStateChange: _onState,
          onError:       (e) => { if (_cbs.onError) _cbs.onError(e.data); },
        },
      });
    };

    function _onState(e) {
      const S = e.data;
      if (S === 1 /* PLAYING */) {
        _paused = false;
        const dur = _p.getDuration() || 0;
        if (_cbs.onPlay) _cbs.onPlay(dur);
        // Start 250 ms polling for timeupdate
        _startTick();
      }
      if (S === 2 /* PAUSED */) {
        _paused = true;
        _stopTick();
        if (_cbs.onPause) _cbs.onPause();
      }
      if (S === 0 /* ENDED */) {
        _paused = true;
        _stopTick();
        if (_cbs.onEnded) _cbs.onEnded();
      }
    }

    let _tickId = null;
    function _startTick() {
      _stopTick();
      _tickId = setInterval(() => {
        if (_p && _cbs.onTick) _cbs.onTick(_p.getCurrentTime() || 0, _p.getDuration() || 0);
      }, 250);
    }
    function _stopTick() {
      if (_tickId) { clearInterval(_tickId); _tickId = null; }
    }

    function _whenReady(fn) {
      if (_ready && _p) fn();
      else setTimeout(() => _whenReady(fn), 100);
    }

    // Load the YouTube iframe API dynamically (standard Google approach).
    // onYouTubeIframeAPIReady is already defined above, so the callback fires
    // correctly regardless of when the script finishes loading.
    const _s  = document.createElement('script');
    _s.src    = 'https://www.youtube.com/iframe_api';
    (_s.parentNode || document.head).appendChild(_s);

    return {
      /**
       * Load and auto-play a YouTube video.
       * @param {string} videoId
       * @param {object} cbs  — { onPlay(dur), onPause, onEnded, onError(code), onTick(ct,dur) }
       */
      load(videoId, cbs) {
        _stopTick();
        _cbs   = cbs || {};
        _paused = true;
        _whenReady(() => _p.loadVideoById({ videoId, startSeconds: 0 }));
      },
      pause()      { if (_p) _p.pauseVideo(); },
      play()       { if (_p) _p.playVideo();  },
      stop()       { _stopTick(); _cbs = {}; _paused = true; if (_p) _p.stopVideo(); },
      seekTo(s)    { if (_p) _p.seekTo(s, true); },
      setRate(r)   { if (_p) _p.setPlaybackRate(r); },
      setVolume(v) { if (_p) _p.setVolume(Math.round(v * 100)); },
      setMuted(m)  { if (_p) { m ? _p.mute() : _p.unMute(); } },
      currentTime(){ return (_p && _ready) ? (_p.getCurrentTime() || 0) : 0; },
      duration()   { return (_p && _ready) ? (_p.getDuration()    || 0) : 0; },
      isPaused()   { return _paused; },
    };
  })();

  // ── Expose ────────────────────────────────────────────────
  return { search, getAudioLink, fetchBlob, saveToDrive, yt };

})();
