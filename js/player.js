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
  let _audio        = null;      // HTMLAudioElement
  let _audioCtx     = null;      // AudioContext
  let _sourceNode   = null;      // MediaElementAudioSourceNode
  let _gainNode     = null;      // GainNode (master volume)
  let _eqNodes      = [];        // Array of 12 BiquadFilterNode

  let _queue        = [];        // DriveItem[]
  let _queueIndex   = -1;        // current track index
  let _shuffle      = false;
  let _repeatMode   = 'off';     // 'off' | 'all' | 'one'
  let _volume       = 1.0;       // 0.0 – 1.0
  let _currentBlob  = null;      // current blob URL (to revoke on track change)
  let _preloadingId = null;      // fileId being pre-downloaded

  // EQ band gains (dB), indexed same as CONFIG.EQ_BANDS
  let _eqGains = new Array(12).fill(0);

  // Playback rate (tempo)
  let _tempo = 1.0;

  /* ── Event callbacks ────────────────────────────────────── */
  // External UI registers to these
  let _onTrackChange = null;  // (driveItem, index, total) => void
  let _onPlayPause   = null;  // (isPlaying) => void
  let _onProgress    = null;  // (currentTime, duration) => void
  let _onQueueChange = null;  // (queue, index) => void
  let _onError       = null;  // (error) => void
  let _onBlobReady   = null;  // (driveItem, blob) => void — fires after blob is fetched & cached

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
  function init({ onTrackChange, onPlayPause, onProgress, onQueueChange, onError, onBlobReady } = {}) {
    _onTrackChange = onTrackChange || (() => {});
    _onPlayPause   = onPlayPause   || (() => {});
    _onProgress    = onProgress    || (() => {});
    _onQueueChange = onQueueChange || (() => {});
    _onError       = onError       || (() => {});
    _onBlobReady   = onBlobReady   || null;

    _audio = new Audio();
    _audio.preload = 'auto';

    // Wire up audio events
    _audio.addEventListener('play',    () => _onPlayPause(true));
    _audio.addEventListener('pause',   () => _onPlayPause(false));
    _audio.addEventListener('ended',   _handleEnded);
    _audio.addEventListener('error',   _handleAudioError);
    _audio.addEventListener('timeupdate', () => {
      _onProgress(_audio.currentTime, _audio.duration || 0);
    });

    // Build Web Audio graph lazily on first user gesture to satisfy
    // Chrome's AudioContext autoplay policy
    console.log('[Player] Initialized.');
  }

  /**
   * Build the Web Audio graph. Must be called from a user gesture context.
   */
  function _initAudioGraph() {
    if (_audioCtx) return;

    _audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
    _sourceNode = _audioCtx.createMediaElementSource(_audio);
    _gainNode   = _audioCtx.createGain();
    _gainNode.gain.value = _volume;

    // 12-band EQ
    _eqNodes = CONFIG.EQ_BANDS.map((freq, i) => {
      const f = _audioCtx.createBiquadFilter();
      f.type           = (i === 0) ? 'lowshelf' : (i === 11) ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.gain.value      = _eqGains[i];
      if (f.type === 'peaking') f.Q.value = 1.41;
      return f;
    });

    // Chain: source → eq[0..11] → gain → destination
    let prev = _sourceNode;
    for (const eq of _eqNodes) { prev.connect(eq); prev = eq; }
    prev.connect(_gainNode);
    _gainNode.connect(_audioCtx.destination);

    _audioCtx.resume();
    console.log('[Player] Web Audio graph built.');
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
    _initAudioGraph();
    if (_audio.paused) {
      await _audio.play().catch(_handleAudioError);
    } else {
      _audio.pause();
    }
  }

  /**
   * Play immediately.
   */
  async function play() {
    if (!_audio) return;
    _initAudioGraph();
    await _audio.play().catch(_handleAudioError);
  }

  /**
   * Pause.
   */
  function pause() {
    _audio?.pause();
  }

  /**
   * Skip to the next track.
   */
  function next() {
    if (_queue.length === 0) return;
    if (_repeatMode === 'one') {
      _audio.currentTime = 0;
      play();
      return;
    }
    const nextIndex = _queueIndex + 1;
    if (nextIndex >= _queue.length) {
      if (_repeatMode === 'all') {
        _queueIndex = 0;
        _playCurrentTrack();
      }
      // else: end of queue, stop
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
    if (_audio && _audio.currentTime > 3) {
      _audio.currentTime = 0;
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
    if (_audio && isFinite(time)) {
      _audio.currentTime = time;
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
    if (_gainNode) _gainNode.gain.value = _volume;
    else if (_audio) _audio.volume = _volume;
  }

  function getVolume() { return _volume; }

  /* ── Tempo (playback rate) ──────────────────────────────── */

  /**
   * Set playback speed (tempo).
   * @param {number} rate - 0.5 to 2.0
   */
  function setTempo(rate) {
    _tempo = Math.max(0.5, Math.min(2.0, rate));
    if (_audio) _audio.playbackRate = _tempo;
  }

  function getTempo() { return _tempo; }

  /* ── EQ ─────────────────────────────────────────────────── */

  /**
   * Set EQ gain for a specific band.
   * @param {number} bandIndex - 0–11
   * @param {number} gainDb    - -12 to +12
   */
  function setEQBand(bandIndex, gainDb) {
    if (bandIndex < 0 || bandIndex >= _eqNodes.length) return;
    _eqGains[bandIndex] = gainDb;
    if (_eqNodes[bandIndex]) {
      _eqNodes[bandIndex].gain.value = gainDb;
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
  async function _playCurrentTrack() {
    if (_queueIndex < 0 || _queueIndex >= _queue.length) return;

    const item = _queue[_queueIndex];
    _onTrackChange(item, _queueIndex, _queue.length);

    try {
      const blob = await _getBlob(item);
      if (!blob) {
        console.error('[Player] Could not load blob for:', item.name);
        _onError({ message: 'No se pudo cargar la canción', item });
        return;
      }

      // Notify blob is ready (used for ID3 metadata extraction)
      if (_onBlobReady) {
        try { _onBlobReady(item, blob); } catch (e) { console.warn('[Player] onBlobReady error:', e); }
      }

      // Revoke previous blob URL to free memory
      if (_currentBlob) {
        URL.revokeObjectURL(_currentBlob);
        _currentBlob = null;
      }

      _currentBlob = URL.createObjectURL(blob);
      _audio.src = _currentBlob;
      _audio.playbackRate = _tempo;

      _initAudioGraph();
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

      // Increment play count and persist display fields for Top Played section
      DB.incrementPlayCount(item.id).catch(() => {});
      DB.setMeta(item.id, {
        name:         item.name,
        displayName:  item.displayName || item.name,
        thumbnailUrl: item.thumbnailUrl || item.thumbnailLink || null,
        artist:       item.artist    || '',
        album:        item.albumName || item.album || '',
        year:         item.year      || '',
        folderId:     item.parents?.[0] || null,
      }).catch(() => {});

      // Save playback state
      DB.setState('lastTrack', { fileId: item.id, queueIndex: _queueIndex }).catch(() => {});

      // Pre-download next track
      _preloadNext();

    } catch (err) {
      console.error('[Player] Error loading track:', err);

      if (err.name === 'AuthError') {
        _onError({ type: 'auth', message: 'Sesión expirada. Renueva tu sesión.', item });
      } else {
        _onError({ type: 'download', message: 'Error al descargar la canción.', item });
        // Auto-skip after a short delay
        setTimeout(() => next(), 1500);
      }
    }
  }

  /**
   * Get blob for a DriveItem — from cache or Drive download.
   * @param {DriveItem} item
   * @returns {Promise<Blob|null>}
   */
  async function _getBlob(item) {
    // Try cache first
    const cached = await DB.getCachedBlob(item.id);
    if (cached) {
      console.log('[Player] Cache hit:', item.name);
      return cached;
    }

    // Download from Drive
    console.log('[Player] Downloading:', item.name);
    const blob = await Drive.downloadFile(item.id, (loaded, total) => {
      // Could emit download progress if needed
    });

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

    _preloadingId = nextItem.id;
    console.log('[Player] Pre-downloading next:', nextItem.name);

    try {
      const blob = await Drive.downloadFile(nextItem.id);
      await DB.setCachedBlob(nextItem.id, blob, nextItem.mimeType);
      console.log('[Player] Pre-download complete:', nextItem.name);
    } catch (err) {
      console.warn('[Player] Pre-download failed:', err.message);
    } finally {
      _preloadingId = null;
    }
  }

  /* ── Event handlers ─────────────────────────────────────── */

  function _handleEnded() {
    if (_repeatMode === 'one') {
      _audio.currentTime = 0;
      play();
    } else {
      next();
    }
  }

  function _handleAudioError(err) {
    const error = err?.target?.error || err;
    console.error('[Player] Audio error:', error);
    _onError({ type: 'audio', message: 'Error de reproducción.', error });
  }

  /* ── Getters ────────────────────────────────────────────── */

  function isPlaying()      { return _audio ? !_audio.paused : false; }
  function getCurrentTime() { return _audio ? _audio.currentTime : 0; }
  function getDuration()    { return _audio ? (_audio.duration || 0) : 0; }
  function getCurrentTrack() {
    return (_queueIndex >= 0 && _queueIndex < _queue.length)
      ? _queue[_queueIndex]
      : null;
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
    // Queue
    setQueue,
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
  };
})();
