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
   * Ask the Cloudflare Worker for an audio URL for a given YouTube video.
   * The Worker uses cobalt.tools API — no PO token needed.
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
   * Usa cobalt.tools API a través del Cloudflare Worker en modo proxy (&proxy=1).
   * El Worker llama a cobalt.tools, obtiene el audio y lo hace streaming al browser.
   * Reintentos automáticos (hasta 3) para manejar errores transitorios.
   *
   * @param {string} videoId  — bare YouTube video ID (no "sd_" prefix)
   * @returns {Promise<Blob>}
   */
  async function fetchBlob(videoId) {
    const MAX_ATTEMPTS = 3;
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const url = `${WORKER_URL}?id=${encodeURIComponent(videoId)}&proxy=1`;

      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      } catch (err) {
        lastErr = new Error(`[Soundrop] Worker no responde (intento ${attempt}): ${err.message}`);
        console.warn(lastErr.message);
        continue;
      }

      if (!res.ok) {
        let msg = `Worker HTTP ${res.status}`;
        try {
          const ct = (res.headers.get('Content-Type') || '');
          if (ct.includes('json')) { const d = await res.json(); msg = d.msg || msg; }
        } catch { /* ignore */ }
        lastErr = new Error(`[Soundrop] ${msg} (intento ${attempt})`);
        console.warn(lastErr.message);
        continue;
      }

      // Validate content-type — debe ser audio, no HTML/JSON de error
      const ct = (res.headers.get('Content-Type') || '').toLowerCase();
      if (ct.startsWith('text/') || ct.includes('html') || ct.includes('json')) {
        lastErr = new Error(`[Soundrop] Respuesta inesperada del Worker (tipo: ${ct})`);
        console.warn(lastErr.message);
        continue;
      }

      let blob;
      try {
        blob = await res.blob();
      } catch (err) {
        lastErr = new Error(`[Soundrop] Error leyendo blob (intento ${attempt}): ${err.message}`);
        console.warn(lastErr.message);
        continue;
      }

      // Magic-byte validation — guard against non-audio responses
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
