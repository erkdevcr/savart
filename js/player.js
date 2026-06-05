/* ============================================================
   Savart — Player module
   Audio playback, queue management, Web Audio graph
   ============================================================
   Web Audio chain:
     <audio> → MediaElementSource → [12× BiquadFilter] → GainNode → destination

   Queue model:
   - _queue[]     : full list of DriveItem objects in play order
   - _queueIndex  : current position in _queue
   - Click folder : replaces queue with all folder songs (shuffled if shuffle on)
   - "A continuación" : insert after current index
   - "Después"        : append at end

   Pre-download:
   - When a song starts, immediately begin downloading the next one in queue.
   - If it's already in DB cache, skip download.
   ============================================================ */

const Player = (() => {

  /* ── State ──────────────────────────────────────────────── */
  let _audio        = null;      // HTMLAudioElement — Drive tracks (Web Audio graph)
  let _sdAudio      = null;      // HTMLAudioElement — Soundrop tracks (crossOrigin + same graph)
  let _sdSourceNode = null;      // MediaElementAudioSourceNode for _sdAudio
  let _sdGainNode   = null;      // GainNode — compensates YouTube's -14 LUFS vs Drive's ~-9 LUFS
  let _sdActive      = false;    // true while a Soundrop track is playing
  let _sdPlaySession = 0;       // incremented on each SD play attempt
  let _sdSrcSession  = 0;       // session# when _sdAudio.src was last written; stale errors ignored
  let _audioCtx     = null;      // AudioContext
  let _sourceNode   = null;      // MediaElementAudioSourceNode for _audio
  let _gainNode     = null;      // GainNode (master volume)
  let _preAmpNode   = null;      // GainNode (pre-amp, before EQ) — default 1.0 (0 dB)
  let _pannerNode   = null;      // StereoPannerNode (balance) — default 0 (center)
  let _eqNodes      = [];        // Array of 12 BiquadFilterNode
  let _normalNode   = null;      // GainNode — per-track loudness normalization
  let _normalizerEnabled = false;// whether normalizer is active
  let _normalizerGain    = 1.0;  // current track's linear gain (1.0 = no change)
  let _compressorNode  = null;   // DynamicsCompressorNode — live gain limiter (post-EQ)
  let _liveGainEnabled = false;  // whether live gain limiter is active

  let _queue        = [];        // DriveItem[]
  let _queueIndex   = -1;        // current track index
  let _shuffle      = false;
  let _repeatMode   = 'off';     // 'off' | 'all' | 'one'
  let _volume       = 1.0;       // 0.0 – 1.0
  let _currentBlob      = null;  // current blob URL (to revoke on track change)
  let _preloadingId     = null;  // fileId being pre-downloaded
  let _preloadAbortCtrl = null;  // AbortController for the in-flight preload fetch
  let _activeDownloadCtrl = null; // AbortController for the in-flight main download
  let _fastStartActive    = false; // true while playing a partial (head) blob; full download pending

  // EQ band gains (dB), indexed same as CONFIG.EQ_BANDS
  let _eqGains = new Array(12).fill(0);

  // Playback rate (tempo)
  let _tempo = 1.0;

  // ── Android background-audio keepalive ──────────────────
  // A looping near-silent audio element that keeps the browser's audio
  // session alive during the gap between tracks. Without it, Android
  // detects "no audio playing" between tracks and freezes the page,
  // cutting off the queue. Stops only on explicit user pause, not on
  // natural track end.
  let _keepAlive    = null;      // HTMLAudioElement (looping silent audio)
  let _keepAliveUrl = null;      // blob URL for the silent audio clip

  /* ── Event callbacks ────────────────────────────────────── */
  // External UI registers to these
  let _onTrackChange = null;  // (driveItem, index, total) => void
  let _onPlayPause   = null;  // (isPlaying) => void
  let _onProgress    = null;  // (currentTime, duration) => void
  let _onQueueChange = null;  // (queue, index) => void
  let _onError       = null;  // (error) => void
  let _onBlobReady      = null;  // (driveItem, blob) => void — fires after blob is fetched & cached
  let _onFullBlobReady  = null;  // (driveItem, blob) => void — fires after full file is downloaded (fast-start only)
  let _onPreloadComplete = null; // (driveItem, blob) => void — fires after next-track preload is cached
  let _onBeforePlay     = null;  // async (driveItem) => void — awaited before blob fetch (e.g. soft scan)
  let _onDurationReady  = null;  // (driveItem, durationSec) => void — fires on loadedmetadata with real duration

  /* ── Web Audio comment ─────────────────────────────────── */
  /*
   * Web Audio chain:
   *   <audio> → MediaElementSource → [12× BiquadFilter] → GainNode → destination
   */

  /* ── Init ───────────────────────────────────────────────── */

  /**
   * Initialize the audio element and Web Audio graph.
   * Call once on app startup.
   * @param {Object} callbacks
   */
  function init({ onTrackChange, onPlayPause, onProgress, onQueueChange, onError, onBlobReady, onFullBlobReady, onBeforePlay, onDurationReady, onPreloadComplete } = {}) {
    _onTrackChange    = onTrackChange    || (() => {});
    _onPlayPause      = onPlayPause      || (() => {});
    _onProgress       = onProgress       || (() => {});
    _onQueueChange    = onQueueChange    || (() => {});
    _onError          = onError          || (() => {});
    _onBlobReady      = onBlobReady      || null;
    _onFullBlobReady   = onFullBlobReady   || null;
    _onBeforePlay      = onBeforePlay      || null;
    _onDurationReady   = onDurationReady   || null;
    _onPreloadComplete = onPreloadComplete || null;

    _audio = new Audio();
    _audio.preload    = 'auto';
    _audio.playsInline = true;  // required for iOS background audio

    // Wire up audio events
    _audio.addEventListener('play',  () => {
      _onPlayPause(true);
      _msSetPlaybackState('playing');
    });
    _audio.addEventListener('pause', () => {
      _onPlayPause(false);
      _msSetPlaybackState('paused');
    });
    _audio.addEventListener('ended',   _handleEnded);
    _audio.addEventListener('error',   _handleAudioError);
    _audio.addEventListener('timeupdate', () => {
      _onProgress(_audio.currentTime, _audio.duration || 0);
      _msUpdatePositionState();
    });
    _audio.addEventListener('durationchange', _msUpdatePositionState);
    _audio.addEventListener('loadedmetadata', () => {
      // Fire once the browser has parsed the audio headers and duration is accurate.
      // This is the only reliable moment to capture duration — timeupdate can carry
      // stale values from the previous track during the brief transition window.
      if (_onDurationReady && isFinite(_audio.duration) && _audio.duration > 0) {
        const item = _queue[_queueIndex];
        if (item) _onDurationReady(item, _audio.duration);
      }
    });

    // Resume AudioContext when page comes back from background/lock screen
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && _audioCtx?.state === 'suspended') {
        _audioCtx.resume().catch(() => {});
      }
    });

    // Register Media Session action handlers (once)
    _msRegisterHandlers();

    // Build Web Audio graph lazily on first user gesture to satisfy
    // Chrome's AudioContext autoplay policy
    console.log('[Player] Initialized.');
  }

  /* ── Media Session API ──────────────────────────────────── */
  // Registers this PWA as a media app with the OS so audio keeps
  // playing when the screen locks and shows lock-screen controls.

  // ── Native MediaSession bridge (Android Capacitor) ───────────────────────
  function _nativeMS() {
    return window.Capacitor?.isNativePlatform?.()
      ? window.Capacitor?.Plugins?.MediaSession
      : null;
  }

  function _nativeMSRegister() {
    const plugin = _nativeMS();
    if (!plugin) return;

    // Transport controls from notification / lock screen
    plugin.addListener('play',     () => play());
    plugin.addListener('pause',    () => pause());
    plugin.addListener('next',     () => next());
    plugin.addListener('previous', () => prev());
    plugin.addListener('seekto',   (e) => { if (e.seekTime != null) seekTo(e.seekTime); });

    // Audio Focus events — handle notification sounds / calls gracefully
    let _preDuckVolume = 1.0;
    let _duckedAudio   = null;  // element that was actually ducked — restored on gain
    let _pausedByFocus = false;
    let _fadeTimer     = null;

    // Smoothly animate audio volume from current to target over `ms` milliseconds
    // Pass an explicit `audioEl` to target a specific element (e.g. the one that was
    // ducked), ignoring whatever _getAudio() would return at the time of the call.
    function _fadeVolume(target, ms, audioEl) {
      const audio = audioEl || _getAudio();
      if (!audio) return;
      if (_fadeTimer) { clearInterval(_fadeTimer); _fadeTimer = null; }
      const steps    = Math.max(1, Math.round(ms / 16)); // ~60fps
      const start    = audio.volume;
      const delta    = (target - start) / steps;
      let   step     = 0;
      _fadeTimer = setInterval(() => {
        step++;
        audio.volume = Math.min(1, Math.max(0, start + delta * step));
        if (step >= steps) {
          audio.volume = target;
          clearInterval(_fadeTimer);
          _fadeTimer = null;
        }
      }, 16);
    }

    plugin.addListener('audioFocusDuck', (e) => {
      // Notification sound → fade down to 20% over 200ms, keep playing.
      // Save the exact element being ducked so audioFocusGain restores the
      // right one even if the user switches Drive↔Soundrop in between.
      const audio = _getAudio();
      _duckedAudio   = audio;
      _preDuckVolume = audio ? audio.volume : 1.0;
      _fadeVolume(e.volume ?? 0.2, 200, audio);
    });

    plugin.addListener('audioFocusGain', () => {
      // Restore the element that was ducked, not necessarily the current one.
      const toRestore = _duckedAudio || _getAudio();
      _duckedAudio = null;
      _fadeVolume(_preDuckVolume, 400, toRestore);
      if (_pausedByFocus) {
        _pausedByFocus = false;
        play();
      }
    });

    plugin.addListener('audioFocusLossTransient', () => {
      // Phone call / navigation voice → pause, will resume on gain
      const audio = _getAudio();
      if (audio && !audio.paused) {
        _pausedByFocus = true;
        pause();
      }
    });

    plugin.addListener('audioFocusLoss', () => {
      // Another music app took focus permanently → just pause, don't auto-resume
      _pausedByFocus = false;
      pause();
    });

    // Bluetooth / headphones disconnected → pause so audio doesn't blare from speaker
    plugin.addListener('audioBecomingNoisy', () => {
      pause();
    });
  }

  function _msRegisterHandlers() {
    // Web Media Session (browser / PWA)
    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play',          () => { play(); });
      ms.setActionHandler('pause',         () => { pause(); });
      ms.setActionHandler('previoustrack', () => { prev(); });
      ms.setActionHandler('nexttrack',     () => { next(); });
      ms.setActionHandler('seekto',        (e) => { if (e.seekTime != null) seekTo(e.seekTime); });
      ms.setActionHandler('seekforward',   (e) => { seekTo(Math.min(getDuration(), getCurrentTime() + (e.seekOffset || 10))); });
      ms.setActionHandler('seekbackward',  (e) => { seekTo(Math.max(0, getCurrentTime() - (e.seekOffset || 10))); });
    }
    // Native bridge
    _nativeMSRegister();
  }

  function _msSetMetadata(item) {
    const artworkUrl = (item.thumbnailUrl && item.thumbnailUrl.startsWith('http'))
      ? item.thumbnailUrl
      : null;
    // Web Media Session
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  item.displayName || item.name || '',
        artist: item.artist      || '',
        album:  item.albumName   || item.album || '',
        artwork: artworkUrl
          ? [{ src: artworkUrl, sizes: '250x250', type: 'image/jpeg' }]
          : [],
      });
    }
    // Native bridge
    const plugin = _nativeMS();
    if (plugin) {
      plugin.updateMetadata({
        title:      item.displayName || item.name || '',
        artist:     item.artist      || '',
        album:      item.albumName   || item.album || '',
        artworkUrl: artworkUrl || '',
      }).catch(() => {});
    }
  }

  function _msSetPlaybackState(state) {
    // Web Media Session
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state;
    }
    // Native bridge
    const plugin = _nativeMS();
    if (plugin) {
      plugin.setPlaybackState({ state }).catch(() => {});
    }
  }

  function _msUpdatePositionState() {
    if (!('mediaSession' in navigator) || !_audio) return;
    const duration = _audio.duration;
    if (!duration || !isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration:     duration,
        playbackRate: _audio.playbackRate || 1,
        position:     Math.min(_audio.currentTime, duration),
      });
    } catch (_) { /* not supported on all browsers */ }
  }

  // Called externally (from app.js _onBlobReady) to refresh artwork
  // after ID3 cover is extracted — thumbnailUrl may have changed.
  function updateMediaSessionArtwork(item) {
    _msSetMetadata(item);
  }

  /* ── Android keepalive ──────────────────────────────────── */

  /**
   * Build a 1-second silent WAV and return a blob URL.
   * 8-bit PCM, mono, 8000 Hz — smallest valid audio Android will accept.
   */
  function _createSilentBlob() {
    const SR = 8000, SAMPLES = SR; // 1 second
    const buf = new ArrayBuffer(44 + SAMPLES);
    const v   = new DataView(buf);
    const w32 = (o, n, le) => v.setUint32(o, n, le);
    const w16 = (o, n)     => v.setUint16(o, n, true);
    // RIFF header
    w32(0, 0x52494646, false); // "RIFF"
    w32(4, 36 + SAMPLES, true);
    w32(8, 0x57415645, false); // "WAVE"
    // fmt chunk
    w32(12, 0x666D7420, false); // "fmt "
    w32(16, 16, true);
    w16(20, 1);                 // PCM
    w16(22, 1);                 // mono
    w32(24, SR, true);          // sample rate
    w32(28, SR, true);          // byte rate
    w16(32, 1);                 // block align
    w16(34, 8);                 // bits/sample
    // data chunk
    w32(36, 0x64617461, false); // "data"
    w32(40, SAMPLES, true);
    // 8-bit PCM silence = 0x80 (midpoint)
    new Uint8Array(buf).fill(0x80, 44);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /**
   * Start the silent keepalive loop.
   * Must be called from within a user-gesture or trusted audio-event context.
   */
  function _keepAliveStart() {
    if (_keepAlive) return; // already running
    if (!_keepAliveUrl) _keepAliveUrl = _createSilentBlob();
    _keepAlive = new Audio(_keepAliveUrl);
    _keepAlive.loop   = true;
    _keepAlive.volume = 0.001; // inaudible but non-zero — Android needs non-zero to keep session
    _keepAlive.play().catch(() => {}); // may fail if called too early; that's fine
  }

  /** Stop the keepalive — only call on explicit user pause, not on track end. */
  function _keepAliveStop() {
    if (!_keepAlive) return;
    _keepAlive.pause();
    _keepAlive.src = '';
    _keepAlive = null;
  }

  /**
   * Build the Web Audio graph. Must be called from a user gesture context.
   */
  /**
   * Returns the currently active HTMLAudioElement.
   * Soundrop tracks play through _sdAudio (no Web Audio graph → no CORS silence).
   * Drive tracks play through _audio (full EQ/gain pipeline).
   */
  function _getAudio() { return _sdActive ? _sdAudio : _audio; }

  /**
   * Create _sdAudio once and wire its events to the same callbacks as _audio.
   */
  function _initSdAudio() {
    if (_sdAudio) return;
    _sdAudio              = new Audio();
    _sdAudio.preload      = 'auto';
    _sdAudio.playsInline  = true;
    // crossOrigin must be set BEFORE src and BEFORE createMediaElementSource
    // so the browser sends CORS headers — required for Web Audio processing.
    // The Soundrop worker URL supports CORS (fetch() works in the download flow).
    _sdAudio.crossOrigin  = 'anonymous';

    _sdAudio.addEventListener('play',  () => { if (_sdActive) { _onPlayPause(true);  _msSetPlaybackState('playing'); } });
    _sdAudio.addEventListener('pause', () => { if (_sdActive) { _onPlayPause(false); _msSetPlaybackState('paused');  } });
    _sdAudio.addEventListener('ended',   _handleEnded);
    _sdAudio.addEventListener('error',   _handleAudioError);
    _sdAudio.addEventListener('timeupdate', () => {
      _onProgress(_sdAudio.currentTime, _sdAudio.duration || 0);
      _msUpdatePositionState();
    });
    _sdAudio.addEventListener('durationchange', _msUpdatePositionState);
    _sdAudio.addEventListener('loadedmetadata', () => {
      if (_onDurationReady && isFinite(_sdAudio.duration) && _sdAudio.duration > 0) {
        const item = _queue[_queueIndex];
        if (item) _onDurationReady(item, _sdAudio.duration);
      }
    });
  }

  function _initAudioGraph() {
    if (_audioCtx) return;

    // _sdAudio must exist before createMediaElementSource is called on it
    _initSdAudio();

    _audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
    _sourceNode   = _audioCtx.createMediaElementSource(_audio);
    _sdSourceNode = _audioCtx.createMediaElementSource(_sdAudio);
    _gainNode     = _audioCtx.createGain();
    _gainNode.gain.value = _volume;
    _preAmpNode   = _audioCtx.createGain();
    _preAmpNode.gain.value = 1.0; // 0 dB
    // YouTube normalizes to -14 LUFS; Drive MP3s average ~-9 LUFS (~5 dB gap).
    // A 1.2x gain on the SD branch closes that gap without clipping typical tracks.
    _sdGainNode   = _audioCtx.createGain();
    _sdGainNode.gain.value = 1.2;
    _pannerNode   = _audioCtx.createStereoPanner
                  ? _audioCtx.createStereoPanner()
                  : null; // fallback: not all browsers support StereoPanner
    if (_pannerNode) _pannerNode.pan.value = 0; // center

    // Normalizer — static per-track gain applied before EQ
    _normalNode = _audioCtx.createGain();
    _normalNode.gain.value = (_normalizerEnabled && _normalizerGain !== 1.0)
      ? _normalizerGain : 1.0;

    // 12-band EQ — create nodes with neutral gain (0 dB).
    // Real gains are applied AFTER connect + resume below.
    // Android WebView computes BiquadFilter coefficients on first audio flow, not at
    // creation time. Setting gains before connect/resume causes incorrect coefficients
    // on the first play, making Drive tracks sound low when EQ is active at login.
    _eqNodes = CONFIG.EQ_BANDS.map((freq, i) => {
      const f = _audioCtx.createBiquadFilter();
      f.type            = (i === 0) ? 'lowshelf' : (i === 11) ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.gain.value      = 0; // neutral — real gains applied after connect + resume below
      if (f.type === 'peaking') f.Q.value = 1.41;
      return f;
    });

    // Live gain — DynamicsCompressor used as soft limiter after EQ.
    // Catches loud peaks that the static normalizer missed (e.g. louder passages mid-song).
    // Transparent when disabled (ratio 1:1, threshold 0 dB).
    _compressorNode = _audioCtx.createDynamicsCompressor();
    _compressorNode.attack.value   = 0.003; // 3 ms — fast enough to catch transients
    _compressorNode.release.value  = 0.2;   // 200 ms — natural recovery
    if (_liveGainEnabled) {
      // Active: threshold −6 dB, ratio 12:1 → limiter-like behavior
      _compressorNode.threshold.value = -6;
      _compressorNode.knee.value      = 3;
      _compressorNode.ratio.value     = 12;
    } else {
      // Transparent bypass
      _compressorNode.threshold.value = 0;
      _compressorNode.knee.value      = 0;
      _compressorNode.ratio.value     = 1;
    }

    // Graph: sources → preAmp → normalizer → EQ[12] → compressor → volume → panner → destination
    // _sourceNode: Drive tracks  |  _sdSourceNode: Soundrop tracks (crossOrigin).
    // When one is paused it produces silence, so only the active one is heard.
    _sourceNode.connect(_preAmpNode);
    _sdSourceNode.connect(_sdGainNode);   // SD branch: boost to match Drive loudness
    _sdGainNode.connect(_preAmpNode);
    _preAmpNode.connect(_normalNode);
    _normalNode.connect(_eqNodes[0]);
    for (let i = 0; i < _eqNodes.length - 1; i++) {
      _eqNodes[i].connect(_eqNodes[i + 1]);
    }
    _eqNodes[_eqNodes.length - 1].connect(_compressorNode);
    _compressorNode.connect(_gainNode);
    if (_pannerNode) {
      _gainNode.connect(_pannerNode);
      _pannerNode.connect(_audioCtx.destination);
    } else {
      _gainNode.connect(_audioCtx.destination);
    }

    _audioCtx.resume();

    // Apply real EQ gains NOW — after graph is connected and context resumed.
    // This guarantees Android WebView computes correct filter coefficients on first play.
    _eqNodes.forEach((node, i) => { node.gain.value = _eqGains[i]; });

    console.log('[Player] Web Audio graph built (Drive + Soundrop sources).');
  }

  /* ── Queue management ───────────────────────────────────── */

  /**
   * Replace the current queue with a list of songs from a folder.
   * If shuffle is on, randomizes the order.
   * Optionally starts playing from a specific song.
   *
   * @param {DriveItem[]} songs        - Array of playable DriveItems
   * @param {number}      [startIndex] - Index of the song to play first (before shuffle)
   */
  function setQueue(songs, startIndex = 0) {
    _queue = [...songs];

    if (_shuffle) {
      // Move the startIndex song to front, then shuffle the rest
      const startSong = _queue.splice(startIndex, 1)[0];
      _queue = [startSong, ..._shuffleArray(_queue)];
      _queueIndex = 0;
    } else {
      _queueIndex = Math.max(0, Math.min(startIndex, _queue.length - 1));
    }

    _onQueueChange([..._queue], _queueIndex);

    // Build the Web Audio graph NOW while still inside the user gesture context.
    // _playCurrentTrack() is async and loses the gesture context through multiple
    // awaits (_onBeforePlay → DB.getMeta, _getBlob → Drive.downloadFile).
    // If _initAudioGraph() is called after those awaits, Chrome creates the
    // AudioContext in 'suspended' state and resume() fails silently → no sound.
    // Calling it here (synchronously, in the same call stack as the user's click)
    // ensures the AudioContext is created and resumed in a trusted gesture context.
    _initAudioGraph();
    _audioCtx?.resume().catch(() => {});

    // Pre-unlock _sdAudio within the gesture context so play() succeeds even
    // after the async getAudioLink() network call on Android WebView.
    // (_sdActive guard prevents interference with an already-playing SD track.)
    if (_sdAudio && !_sdActive) {
      _sdAudio.play().catch(() => {});
      _sdAudio.pause();
    }

    _playCurrentTrack();
  }

  /**
   * Insert songs right after the current track ("A continuación").
   * @param {DriveItem|DriveItem[]} songs
   */
  function insertNext(songs) {
    const items = Array.isArray(songs) ? songs : [songs];
    _queue.splice(_queueIndex + 1, 0, ...items);
    _onQueueChange([..._queue], _queueIndex);
  }

  /**
   * Append songs at the end of the queue ("Después").
   * @param {DriveItem|DriveItem[]} songs
   */
  function appendToQueue(songs) {
    const items = Array.isArray(songs) ? songs : [songs];
    _queue.push(...items);
    _onQueueChange([..._queue], _queueIndex);
  }

  /**
   * Get a copy of the current queue.
   * @returns {{ queue: DriveItem[], index: number }}
   */
  function getQueue() {
    return { queue: [..._queue], index: _queueIndex };
  }

  /**
   * Restore a previously saved queue without starting playback.
   * Used on boot to reload the last session's queue so the user can
   * resume manually. Unlike setQueue(), this does NOT call _playCurrentTrack().
   * @param {DriveItem[]} songs
   * @param {number}      [index=0] - Index to restore as "current" track
   */
  function loadState(songs, index = 0) {
    if (!Array.isArray(songs) || songs.length === 0) return;
    _queue      = [...songs];
    _queueIndex = Math.max(0, Math.min(index, _queue.length - 1));
    _onQueueChange([..._queue], _queueIndex);
    // Do NOT call _playCurrentTrack() — the user decides when to play
  }

  /**
   * Remove a track from the queue by index.
   * Cannot remove the currently playing track.
   * @param {number} index
   */
  function removeFromQueue(index) {
    if (index < 0 || index >= _queue.length) return;
    if (index === _queueIndex) return; // can't remove current track
    _queue.splice(index, 1);
    // Adjust current index if we removed something before it
    if (index < _queueIndex) _queueIndex--;
    _onQueueChange([..._queue], _queueIndex);
  }

  /* ── Playback controls ──────────────────────────────────── */

  /**
   * Play or pause the current track.
   */
  async function togglePlayPause() {
    if (!_audio) return;
    const el = _getAudio();
    if (!_sdActive) _initAudioGraph();
    if (el.paused) {
      // No content loaded yet — happens when queue is restored from saved state
      if (!_sdActive && !_currentBlob) {
        await _playCurrentTrack();
        return;
      }
      _keepAliveStart();
      await el.play().catch(_handleAudioError);
    } else {
      _keepAliveStop();
      el.pause();
    }
  }

  /**
   * Play immediately.
   */
  async function play() {
    if (!_audio) return;
    if (!_sdActive) _initAudioGraph();
    _keepAliveStart();
    await _getAudio().play().catch(_handleAudioError);
  }

  /**
   * Pause.
   */
  function pause() {
    _keepAliveStop();
    _getAudio()?.pause();
  }

  /**
   * Skip to the next track.
   */
  function next() {
    if (_queue.length === 0) return;
    if (_repeatMode === 'one') {
      _getAudio().currentTime = 0;
      play();
      return;
    }
    const nextIndex = _queueIndex + 1;
    if (nextIndex >= _queue.length) {
      if (_repeatMode === 'all') {
        _queueIndex = 0;
        _playCurrentTrack();
      } else {
        // End of queue — notify UI so EQ bars and play state indicators clear
        _msSetPlaybackState('paused');
        _onPlayPause?.(false);
      }
      return;
    }
    _queueIndex = nextIndex;
    _playCurrentTrack();
  }

  /**
   * Go to the previous track (or restart current if >3s played).
   */
  function prev() {
    if (_queue.length === 0) return;
    const el = _getAudio();
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      return;
    }
    if (_queueIndex > 0) {
      _queueIndex--;
      _playCurrentTrack();
    }
  }

  /**
   * Seek to a specific time.
   * @param {number} time - seconds
   */
  function seekTo(time) {
    const el = _getAudio();
    if (el && isFinite(time)) {
      el.currentTime = time;
    }
  }

  /**
   * Jump to a specific index in the queue.
   * @param {number} index
   */
  function jumpTo(index) {
    if (index < 0 || index >= _queue.length) return;
    _queueIndex = index;
    _onQueueChange([..._queue], _queueIndex);
    _playCurrentTrack();
  }

  /* ── Shuffle & repeat ───────────────────────────────────── */

  /**
   * Toggle shuffle on/off.
   * @returns {boolean} new shuffle state
   */
  function toggleShuffle() {
    _shuffle = !_shuffle;
    if (_shuffle && _queue.length > 1) {
      // Keep current track in place, re-shuffle the rest
      const current = _queue[_queueIndex];
      const rest    = _queue.filter((_, i) => i !== _queueIndex);
      _queue = [current, ..._shuffleArray(rest)];
      _queueIndex = 0;
      _onQueueChange([..._queue], _queueIndex);
    }
    return _shuffle;
  }

  function isShuffled() { return _shuffle; }

  /**
   * Cycle repeat modes: off → all → one → off.
   * @returns {string} new mode
   */
  function cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    const idx   = modes.indexOf(_repeatMode);
    _repeatMode = modes[(idx + 1) % modes.length];
    return _repeatMode;
  }

  function getRepeatMode() { return _repeatMode; }

  /* ── Volume ─────────────────────────────────────────────── */

  /**
   * Set master volume.
   * @param {number} value - 0.0 to 1.0
   */
  function setVolume(value) {
    _volume = Math.max(0, Math.min(1, value));
    if (_gainNode) _gainNode.gain.value = _volume; // controls both sources via the shared graph
    else if (_audio) _audio.volume = _volume;      // fallback before graph is built
  }

  function getVolume() { return _volume; }

  /**
   * Set pre-amp gain in dB (-12 to +12).
   * Applied before the EQ chain so all bands are boosted/cut uniformly.
   */
  function setPreAmp(db) {
    const clamped = Math.max(-12, Math.min(12, db));
    if (_preAmpNode) _preAmpNode.gain.value = Math.pow(10, clamped / 20);
  }

  /**
   * Set stereo balance (-1 = full left, 0 = center, +1 = full right).
   */
  function setBalance(pan) {
    const clamped = Math.max(-1, Math.min(1, pan));
    if (_pannerNode) _pannerNode.pan.value = clamped;
  }

  /* ── Normalizer ─────────────────────────────────────────── */

  /**
   * Enable or disable the per-track loudness normalizer.
   * When disabled, _normalNode gain is reset to 1.0 (bypass).
   * @param {boolean} enabled
   */
  function setNormalizerEnabled(enabled) {
    _normalizerEnabled = !!enabled;
    if (_normalNode && _audioCtx) {
      const target = (_normalizerEnabled && _normalizerGain !== 1.0) ? _normalizerGain : 1.0;
      _normalNode.gain.setTargetAtTime(target, _audioCtx.currentTime, 0.07); // ~200ms fade
    }
  }

  /**
   * Apply a linear gain to the normalizer node for the current track.
   * Call this after analyzing the track's loudness. Only takes effect if
   * the normalizer is enabled.
   * @param {number} linearGain  - e.g. 1.4 for +3dB, 0.7 for -3dB
   */
  function setNormalizerGain(linearGain) {
    _normalizerGain = linearGain;
    if (_normalNode && _audioCtx) {
      const target = (_normalizerEnabled && _normalizerGain !== 1.0) ? _normalizerGain : 1.0;
      _normalNode.gain.setTargetAtTime(target, _audioCtx.currentTime, 0.07); // ~200ms fade
    }
  }

  function getNormalizerEnabled() { return _normalizerEnabled; }
  function getNormalizerGain()    { return _normalizerGain; }

  /* ── Live Gain (dynamic limiter) ───────────────────────── */

  /**
   * Enable or disable the live gain limiter.
   * When on: threshold −6 dB, ratio 12:1 — catches loud peaks post-normalizer.
   * When off: ratio 1:1, threshold 0 dB — fully transparent.
   * @param {boolean} enabled
   */
  function setLiveGainEnabled(enabled) {
    _liveGainEnabled = !!enabled;
    if (_compressorNode && _audioCtx) {
      const t = _audioCtx.currentTime;
      if (_liveGainEnabled) {
        _compressorNode.threshold.setTargetAtTime(-6, t, 0.05);
        _compressorNode.knee.setTargetAtTime(3,    t, 0.05);
        _compressorNode.ratio.setTargetAtTime(12,  t, 0.05);
      } else {
        _compressorNode.threshold.setTargetAtTime(0, t, 0.05);
        _compressorNode.knee.setTargetAtTime(0,     t, 0.05);
        _compressorNode.ratio.setTargetAtTime(1,    t, 0.05);
      }
    }
  }

  function getLiveGainEnabled() { return _liveGainEnabled; }

  /* ── Tempo (playback rate) ──────────────────────────────── */

  /**
   * Set playback speed (tempo).
   * @param {number} rate - 0.5 to 2.0
   */
  function setTempo(rate) {
    _tempo = Math.max(0.5, Math.min(2.0, rate));
    if (_audio)   _audio.playbackRate   = _tempo;
    if (_sdAudio) _sdAudio.playbackRate = _tempo;
  }

  function getTempo() { return _tempo; }

  /* ── EQ ─────────────────────────────────────────────────── */

  /**
   * Set EQ gain for a specific band.
   * @param {number} bandIndex - 0–11
   * @param {number} gainDb    - -12 to +12
   */
  function setEQBand(bandIndex, gainDb) {
    if (bandIndex < 0 || bandIndex >= CONFIG.EQ_BANDS.length) return;
    _eqGains[bandIndex] = gainDb;           // always update state (even before audio graph is built)
    if (_eqNodes[bandIndex]) {
      _eqNodes[bandIndex].gain.value = gainDb; // update audio node only once graph exists
    }
  }

  /**
   * Set all 12 EQ bands at once.
   * @param {number[]} gains - array of 12 dB values
   */
  function setEQGains(gains) {
    gains.forEach((g, i) => setEQBand(i, g));
  }

  function getEQGains() { return [..._eqGains]; }

  /**
   * Reset all EQ bands to 0 dB.
   */
  function resetEQ() {
    setEQGains(new Array(12).fill(0));
  }

  /* ── Internal playback ──────────────────────────────────── */

  /**
   * Load and play the track at _queueIndex.
   */
  // _sdRetry=true means this is an automatic second attempt after a Soundrop cold-start
  // failure.  Only one silent retry is allowed; if it also fails, the error toast shows.
  async function _playCurrentTrack(_sdRetry = false) {
    if (_queueIndex < 0 || _queueIndex >= _queue.length) return;

    // Cancel any in-flight preload and active download so they don't compete
    // for bandwidth with the track the user actually wants to hear right now.
    if (_preloadAbortCtrl) {
      _preloadAbortCtrl.abort();
      _preloadAbortCtrl = null;
      _preloadingId     = null;
    }
    if (_activeDownloadCtrl) {
      _activeDownloadCtrl.abort();
      _activeDownloadCtrl = null;
    }
    _fastStartActive = false;

    // *** RACE-CONDITION FIX: create the session controller HERE — before any
    // awaits — so that the *next* _playCurrentTrack() call can abort this one
    // via _activeDownloadCtrl even while we are still inside a DB lookup or
    // _onBeforePlay hook.  Without this, switching tracks while getCachedBlob /
    // isCached is pending leaves _activeDownloadCtrl null and the old download
    // keeps running in parallel with the new one. ***
    const myCtrl = new AbortController();
    _activeDownloadCtrl = myCtrl;

    const item = _queue[_queueIndex];
    _onTrackChange(item, _queueIndex, _queue.length);

    // Wait for the pre-play hook (e.g. soft scan) before fetching audio.
    // _onTrackChange fires first so the miniplayer shows the song name immediately.
    if (_onBeforePlay) {
      try { await _onBeforePlay(item); } catch (_) {}
    }
    if (myCtrl.signal.aborted) return; // switched during onBeforePlay

    try {
      // ── Soundrop track ────────────────────────────────────────
      // _sdAudio has crossOrigin='anonymous', so the Web Audio graph can
      // process it through the full EQ/gain chain without CORS silence.
      if (item.isSoundrop) {
        _initAudioGraph(); // builds graph + _sdSourceNode if not yet done
        _sdActive = true;

        // Tag this play attempt so stale errors from the previous attempt are ignored
        const mySession = ++_sdPlaySession;

        // Pause Drive element so only one source is heard
        _audio.pause();

        // Auto-retry getAudioLink — Cloudflare Worker cold starts can fail
        // the first request; up to 3 attempts with 1 s / 2 s back-off.
        let audioUrl, lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { audioUrl = await Soundrop.getAudioLink(item.videoId); break; }
          catch (err) {
            lastErr = err;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        // If the user clicked something else while we were retrying, bail out
        if (mySession !== _sdPlaySession) return;
        if (!audioUrl) throw lastErr;

        _sdSrcSession         = mySession;   // mark this src as belonging to current session
        _sdAudio.src          = audioUrl;
        _sdAudio.playbackRate = _tempo;

        if (_audioCtx?.state === 'suspended') {
          await _audioCtx.resume().catch(() => {});
        }
        _keepAliveStart();
        _msSetMetadata(item);
        _msSetPlaybackState('playing');
        await _sdAudio.play();

        // Save Soundrop track to recents so it appears on Home
        DB.addRecent({
          id:           item.id,
          videoId:      item.videoId,
          isSoundrop:   true,
          name:         item.name,
          displayName:  item.displayName,
          type:         'song',
          mimeType:     item.mimeType,
          thumbnailUrl: item.thumbnailUrl,
          artist:       item.artist  || '',
          album:        item.album   || '',
          year:         item.year    || '',
          folderId:     null,
          ...(item.durationSec > 0 ? { durationSec: item.durationSec } : {}),
        }).catch(() => {});
        // Chain setMeta AFTER incrementPlayCount so the final IDB write always
        // includes isSoundrop + videoId (avoids a race where incrementPlayCount's
        // read-modify-write overwrites a concurrent setMeta and strips those fields).
        DB.incrementPlayCount(item.id)
          .then(() => DB.setMeta(item.id, {
            name:         item.name,
            displayName:  item.displayName || item.name,
            thumbnailUrl: item.thumbnailUrl || null,
            artist:       item.artist  || '',
            album:        item.album   || '',
            year:         item.year    || '',
            isSoundrop:   true,
            videoId:      item.videoId,
            ...(item.durationSec > 0 ? { durationSec: item.durationSec } : {}),
          }))
          .catch(() => {});
        return;
      }

      // ── Drive track: deactivate Soundrop element if it was on ─
      if (_sdActive) {
        _sdActive = false;
        if (_sdAudio) { _sdAudio.pause(); _sdAudio.src = ''; }
      }

      // ── Drive track: blob path ────────────────────────────────
      // Fast-start: for uncached files >5MB, download only the first 3MB to start
      // playback immediately, then fetch the full file in background and swap.
      // For cached files and small files, download the full blob as usual.
      const FAST_START_THRESHOLD  = 5  * 1024 * 1024; // 5MB
      const FAST_START_HEAD_BYTES = 3  * 1024 * 1024; // 3MB initial chunk
      const fileSize  = item.size || 0;
      const isCached  = await DB.isCached(item.id).catch(() => false);
      if (myCtrl.signal.aborted) return; // switched while checking cache
      const useFastStart = !isCached && fileSize > FAST_START_THRESHOLD;

      let blob;
      if (useFastStart) {
        console.log('[Player] Fast-start: downloading head for:', item.name);
        blob = await Drive.downloadFileHead(item.id, FAST_START_HEAD_BYTES, myCtrl.signal);
        if (myCtrl.signal.aborted) return;
        // Head done — clear ctrl so _finishFastStartDownload can set its own.
        if (_activeDownloadCtrl === myCtrl) _activeDownloadCtrl = null;
        _fastStartActive = true;
      } else {
        blob = await _getBlob(item, myCtrl.signal);
        if (_activeDownloadCtrl === myCtrl) _activeDownloadCtrl = null;
        _fastStartActive = false;
      }

      if (!blob) {
        console.error('[Player] Could not load blob for:', item.name);
        _onError({ message: 'No se pudo cargar la canción', item });
        return;
      }

      // Notify blob is ready (used for ID3 metadata extraction)
      if (_onBlobReady) {
        try { _onBlobReady(item, blob); } catch (e) { console.warn('[Player] onBlobReady error:', e); }
      }

      // Release previous audio: clear src FIRST so Chrome's media engine drops its
      // internal decoded PCM buffer, THEN revoke the object URL so the GC can free
      // the underlying blob data. Without src='', Chrome holds decoded audio in the
      // renderer heap even after the blob URL is revoked.
      if (_currentBlob) {
        _audio.src = '';
        URL.revokeObjectURL(_currentBlob);
        _currentBlob = null;
      }

      _currentBlob = URL.createObjectURL(blob);
      _audio.src = _currentBlob;
      _audio.playbackRate = _tempo;

      _initAudioGraph();
      // Explicitly resume AudioContext before every play — on Android with screen off
      // the context may have been suspended during the async blob fetch.
      if (_audioCtx?.state === 'suspended') {
        await _audioCtx.resume().catch(() => {});
      }
      // Ensure keepalive is running (guards automatic queue advance with screen off)
      _keepAliveStart();
      // Defensive reset: if audioFocusDuck left _audio.volume below 1.0 and
      // audioFocusGain never restored it (Android timing edge case), reset to
      // full volume. If a duck is legitimately active, the OS will re-fire
      // audioFocusDuck immediately and bring it back down.
      if (_audio.volume < 1.0) _audio.volume = 1.0;
      // Set Media Session metadata before play so lock screen shows correct info
      _msSetMetadata(item);
      _msSetPlaybackState('playing');
      await _audio.play();

      // Save to recents
      DB.addRecent({
        id:           item.id,
        name:         item.name,
        displayName:  item.displayName,
        type:         'song',
        mimeType:     item.mimeType,
        thumbnailUrl: item.thumbnailUrl,
        folderId:     item.parents?.[0] || null,
      }).catch(() => {});

      // Increment play count and persist display fields for Top Played section.
      // durationSec is included here — _audio.duration is accurate at this point
      // because loadedmetadata always fires before play() can resolve.
      // Combining into one write prevents race conditions with _onDurationReady.
      DB.incrementPlayCount(item.id).catch(() => {});
      // Guard: never overwrite a manually-set thumbnailUrl with stale queue data.
      // Queue items are built from Drive API responses and may lack the manual URL.
      DB.getMeta(item.id).then(existing => {
        const hasManual = (existing?.manualAt || 0) > 0;
        return DB.setMeta(item.id, {
          name:         item.name,
          displayName:  item.displayName || item.name,
          // Only write thumbnailUrl if the user has NOT manually set it.
          // If manualAt is set, preserve whatever is already in DB.
          ...(!hasManual ? { thumbnailUrl: item.thumbnailUrl || item.thumbnailLink || null } : {}),
          artist:       item.artist    || '',
          album:        item.albumName || item.album || '',
          year:         item.year      || '',
          folderId:     item.parents?.[0] || null,
          ...(isFinite(_audio.duration) && _audio.duration > 0
            ? { durationSec: _audio.duration } : {}),
        });
      }).catch(() => {});

      // Save playback state
      DB.setState('lastTrack', { fileId: item.id, queueIndex: _queueIndex }).catch(() => {});

      // Pre-download next track (only when not in fast-start mode — the background
      // full-download below already saturates available bandwidth for this track)
      if (!useFastStart) _preloadNext();

      // Fast-start: kick off background full-download now that audio is playing
      if (useFastStart) _finishFastStartDownload(item);

    } catch (err) {
      if (_activeDownloadCtrl === myCtrl) _activeDownloadCtrl = null;
      if (err.name === 'AbortError') {
        // User switched tracks mid-download — not an error, just bail out silently
        console.log('[Player] Download aborted (track switched):', item?.name);
        return;
      }
      console.error('[Player] Error loading track:', err);

      if (err.name === 'AuthError') {
        _onError({ type: 'auth', message: 'Sesión expirada. Renueva tu sesión.', item });
      } else if (item?.isSoundrop && !_sdRetry) {
        // Soundrop first failure — Cloudflare Worker was likely cold-starting.
        // Silently retry the same track after 2 s (Worker is warm by then).
        // Guard: only retry if the user hasn't switched to a different track.
        console.log('[Player] Soundrop cold-start — silent retry in 2 s:', item.name);
        setTimeout(() => {
          if (_queue[_queueIndex]?.id === item.id) _playCurrentTrack(/* _sdRetry= */ true);
        }, 2000);
      } else {
        _onError({ type: 'download', message: 'toast_download_error', item });
        // Drive tracks: auto-skip after a short delay.
        // Soundrop: don't skip — the queue may contain only this one track.
        if (!item?.isSoundrop) setTimeout(() => next(), 1500);
      }
    }
  }

  /**
   * Background full-file download for fast-start.
   * Called after the 3MB head is already playing. Downloads the full file,
   * caches it, then seamlessly swaps the audio src at the current position.
   * @param {DriveItem} item
   */
  async function _finishFastStartDownload(item) {
    const ctrl = new AbortController();
    _activeDownloadCtrl = ctrl;
    console.log('[Player] Fast-start: fetching full file in background…', item.name);
    try {
      const fullBlob = await Drive.downloadFile(item.id, null, ctrl.signal);
      if (ctrl.signal.aborted) return;

      // Cache the full file for future plays
      await DB.setCachedBlob(item.id, fullBlob, item.mimeType).catch(() => {});

      // Notify that the full file is now available (e.g. for accurate loudness analysis).
      // Only fire if this track is still the one playing.
      if (_queue[_queueIndex]?.id === item.id && _onFullBlobReady) {
        try { _onFullBlobReady(item, fullBlob); } catch (e) { console.warn('[Player] onFullBlobReady error:', e); }
      }

      // Only swap if this track is still the one playing
      if (_queue[_queueIndex]?.id !== item.id) return;

      const savedTime  = _audio.currentTime;
      const wasPlaying = !_audio.paused;
      const prevUrl    = _currentBlob;

      // Swap audio src to full blob
      _audio.src = '';
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      _currentBlob     = URL.createObjectURL(fullBlob);
      _fastStartActive = false;
      _audio.src       = _currentBlob;
      _audio.playbackRate = _tempo;

      // Wait for the audio element to be ready at the new src
      await new Promise(resolve => {
        _audio.addEventListener('canplay', resolve, { once: true });
        setTimeout(resolve, 3000); // safety timeout in case canplay doesn't fire
      });

      if (_queue[_queueIndex]?.id !== item.id) return; // user switched while waiting

      _audio.currentTime = savedTime;
      if (wasPlaying) await _audio.play().catch(_handleAudioError);
      console.log('[Player] Fast-start: swapped to full blob at', savedTime.toFixed(1), 's');

      // Now safe to preload next
      _preloadNext();

    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[Player] Fast-start background download failed:', err.message);
        _fastStartActive = false;
      }
    } finally {
      if (_activeDownloadCtrl === ctrl) _activeDownloadCtrl = null;
    }
  }

  /**
   * Get blob for a DriveItem — from cache or Drive download.
   * @param {DriveItem} item
   * @returns {Promise<Blob|null>}
   */
  async function _getBlob(item, signal = null) {
    // Try cache first
    const cached = await DB.getCachedBlob(item.id);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); // switched during cache check
    if (cached) {
      console.log('[Player] Cache hit:', item.name);
      return cached;
    }

    // Download from Drive — retry once on failure (screen-off networks can hiccup).
    // signal comes from _playCurrentTrack's myCtrl — already set on _activeDownloadCtrl
    // before any await, so it is always abortable from the moment this play session starts.
    console.log('[Player] Downloading:', item.name);
    let blob = null;
    try {
      blob = await Drive.downloadFile(item.id, null, signal);
    } catch (firstErr) {
      if (firstErr.name === 'AbortError') throw firstErr; // propagate — user switched tracks
      console.warn('[Player] Download failed, retrying in 1s…', firstErr?.message);
      await new Promise(r => setTimeout(r, 1000));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      blob = await Drive.downloadFile(item.id, null, signal);
    }

    // Cache it
    await DB.setCachedBlob(item.id, blob, item.mimeType);

    return blob;
  }

  /**
   * Pre-download the next track in queue.
   */
  async function _preloadNext() {
    const nextIndex = _queueIndex + 1;
    if (nextIndex >= _queue.length) return;

    const nextItem = _queue[nextIndex];
    if (!nextItem || nextItem.id === _preloadingId) return;

    const alreadyCached = await DB.isCached(nextItem.id);
    if (alreadyCached) return;

    // Each preload gets its own AbortController so _playCurrentTrack can
    // cancel it instantly when the user selects a different track.
    const ctrl        = new AbortController();
    _preloadAbortCtrl = ctrl;
    _preloadingId     = nextItem.id;
    console.log('[Player] Pre-downloading next:', nextItem.name);

    try {
      const blob = await Drive.downloadFile(nextItem.id, null, ctrl.signal);
      // Only cache if we were not aborted mid-flight
      if (!ctrl.signal.aborted) {
        await DB.setCachedBlob(nextItem.id, blob, nextItem.mimeType);
        console.log('[Player] Pre-download complete:', nextItem.name);
        if (_onPreloadComplete) {
          try { _onPreloadComplete(nextItem, blob); } catch (e) { console.warn('[Player] onPreloadComplete error:', e); }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[Player] Pre-download failed:', err.message);
      }
    } finally {
      if (_preloadAbortCtrl === ctrl) {
        _preloadAbortCtrl = null;
      }
      _preloadingId = null;
    }
  }

  /* ── Event handlers ─────────────────────────────────────── */

  function _handleEnded() {
    // Resume AudioContext NOW — we are inside a trusted audio event context.
    // On Android with screen off, the AudioContext gets suspended between tracks.
    // Calling resume() here (synchronously, before any await) works because
    // 'ended' is considered a user-initiated / trusted audio context event.
    if (_audioCtx?.state === 'suspended') {
      _audioCtx.resume().catch(() => {});
    }

    // Fast-start guard: the partial (head) blob was exhausted before the full
    // download completed. Hold playback here — _finishFastStartDownload will
    // seek back and resume as soon as the full file is swapped in.
    if (_fastStartActive) {
      console.log('[Player] Fast-start: head blob exhausted, waiting for full download…');
      _msSetPlaybackState('paused');
      _onPlayPause?.(false);
      return; // don't advance to next track
    }

    // Tell Android MediaSession we intend to keep playing — prevents the OS
    // from treating the gap between tracks as a "pause" and killing playback.
    _msSetPlaybackState('playing');

    if (_repeatMode === 'one') {
      _audio.currentTime = 0;
      play();
    } else {
      next();
    }
  }

  function _handleAudioError(err) {
    if (err?.target === _sdAudio) {
      // Ignore errors when SD is not the active source (e.g. src='' after switching to Drive)
      if (!_sdActive) return;
      // Ignore errors from a stale src — cold-start retries or the previous song's element
      // still loading when a new play has already overwritten it.
      if (_sdSrcSession !== _sdPlaySession) return;
    }
    const error = err?.target?.error || err;
    console.error('[Player] Audio error:', error);
    _onError({ type: 'audio', message: 'toast_audio_error', error });
  }

  /* ── Getters ────────────────────────────────────────────── */

  function isPlaying()      { const el = _getAudio(); return el ? !el.paused : false; }
  function getCurrentTime() { const el = _getAudio(); return el ? el.currentTime : 0; }
  function getDuration()    { const el = _getAudio(); return el ? (el.duration || 0) : 0; }
  function getCurrentTrack() {
    return (_queueIndex >= 0 && _queueIndex < _queue.length)
      ? _queue[_queueIndex]
      : null;
  }

  /**
   * Silently patch metadata fields on every matching queue item.
   * Does NOT trigger any playback callbacks — purely a data update so that
   * subsequent calls to getCurrentTrack() return the fresh values.
   * Returns true if the currently-playing track was among the patched items.
   * @param {string} fileId
   * @param {Object} patch
   * @returns {boolean}
   */
  function patchQueueItem(fileId, patch) {
    let currentPatched = false;
    for (let i = 0; i < _queue.length; i++) {
      if (_queue[i].id === fileId) {
        _queue[i] = { ..._queue[i], ...patch };
        if (i === _queueIndex) currentPatched = true;
      }
    }
    return currentPatched;
  }

  /* ── Utils ──────────────────────────────────────────────── */

  function _shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return {
    init,
    updateMediaSessionArtwork,
    // Queue
    setQueue,
    loadState,
    insertNext,
    appendToQueue,
    removeFromQueue,
    getQueue,
    jumpTo,
    // Playback
    togglePlayPause,
    play,
    pause,
    next,
    prev,
    seekTo,
    // Shuffle / repeat
    toggleShuffle,
    isShuffled,
    cycleRepeat,
    getRepeatMode,
    // Volume
    setVolume,
    getVolume,
    // Pre-amp & Balance
    setPreAmp,
    setBalance,
    // Normalizer
    setNormalizerEnabled,
    setNormalizerGain,
    getNormalizerEnabled,
    getNormalizerGain,
    // Live Gain
    setLiveGainEnabled,
    getLiveGainEnabled,
    // Tempo
    setTempo,
    getTempo,
    // EQ
    setEQBand,
    setEQGains,
    getEQGains,
    resetEQ,
    // State
    isPlaying,
    getCurrentTime,
    getDuration,
    getCurrentTrack,
    patchQueueItem,
  };
})();
