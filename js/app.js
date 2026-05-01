/* ============================================================
   Savart — App entry point
   Wires Auth, Drive, DB, Player, and UI together.
   ============================================================
   Boot sequence:
   1. DB.open()
   2. Auth.init()
   3. If user was previously authenticated → show renew banner
      else → show login screen
   4. On token ready → show Home, load home data

   All user-triggered events from the UI route through App.*
   so that the UI module stays free of business logic.
   ============================================================ */

const App = (() => {

  /* ── Browse state ────────────────────────────────────────── */
  let _breadcrumb      = [];    // [{ id, name }] from root to current
  let _rootFolderId    = 'root';
  let _browseFolderId  = null;  // current open folder id (for rescan)
  let _browseFiles     = [];    // current open folder audio files (for rescan)

  /* ── Folder cover art cache ──────────────────────────────── */
  // folderId → object URL string | null (null = no image found)
  const _folderCoverCache = new Map();


  /* ── Blob size cache ─────────────────────────────────────── */
  // fileId → blob.size (bytes). Populated in _onBlobReady.
  // Needed because queue items loaded from recents lack a size field,
  // and _onPlayPause calls _enrichTrack which would otherwise show "—".
  const _blobSizeCache = new Map();

  /* ── Loading-spinner timer ───────────────────────────────── */
  // We delay showing the spinner by 120ms to avoid a visual flash for
  // cached (instantly loaded) tracks.
  let _loadingTimer = null;

  /* ── Radio mode ──────────────────────────────────────────── */
  // Activated when the user plays a single song from Home, Search, or Library.
  // Automatically finds more songs by the same artist in Drive and appends
  // them to the queue after all recognition passes complete (ID3→Last.fm→AudD).
  let _radioModeActive = false;  // true = radio is running
  let _radioArtist     = null;   // artist name being radiated
  let _radioInFlight   = false;  // prevents concurrent Drive searches
  let _radioQueuedIds  = new Set(); // IDs ever added via radio (cross-refill dedup)
  let _radioTriggered  = false;  // true after the initial Drive search fires once

  /**
   * Best-effort artist extraction for radio mode when ID3 tags are absent.
   * Priority:
   *  1. item.artist (already set from DB / previous ID3 parse)
   *  2. Filename pattern "Artist - Title.mp3" (split on first " - ")
   *  3. Parent folder hierarchy (up to 4 levels) — handles:
   *       song.mp3 → Album → Artist        (returns Artist)
   *       song.mp3 → Artist → ...          (returns Artist)
   *       song.mp3 → Artist – Discography  (strips suffix, returns Artist)
   *     Skips folders that look like albums (start with year "2019 - ...")
   *     and skips known root/drive folders.
   * Returns null if nothing useful is found.
   * @param {DriveItem} item
   * @returns {string|null}
   */
  function _guessArtistFromItem(item) {
    if (item.artist) return item.artist;

    // Try filename: "Christian Nodal - Botella.mp3" → "Christian Nodal"
    const base = (item.name || '').replace(/\.[^.]+$/, '').trim();
    const dashIdx = base.indexOf(' - ');
    if (dashIdx > 0) {
      const candidate = base.slice(0, dashIdx)
        .replace(/^\d+\.?\s*/, '')        // strip leading track number "01. "
        .replace(/^track\s+\d+\s*/i, '')  // strip "Track 01 "
        .trim();
      if (candidate.length >= 2) return candidate;
    }

    // Walk up the cached folder hierarchy (up to 4 levels)
    const _cleanFolderName = name => name
      .replace(/[-–]\s*(discography|discografia|music|musica|collection|compilacion|complete|obras).*$/i, '')
      .replace(/\s*\(\d{4}\)\s*$/, '')   // trailing year "(2020)"
      .replace(/\s*\[\d{4}\]\s*$/, '')   // trailing year "[2020]"
      .trim();

    const _looksLikeAlbum = name =>
      /^\d{4}\s*[-–]/.test(name) ||          // starts with year "1998 - Americana"
      /^(vol|volume|disc|cd)\s*\d/i.test(name); // "Vol 2", "Disc 1"

    let currentId = item.parents?.[0];
    for (let depth = 0; depth < 4; depth++) {
      if (!currentId || currentId === CONFIG.ROOT_FOLDER_ID) break;
      const folder = _itemCache.get(currentId);
      if (!folder) break;

      const cleaned = _cleanFolderName(folder.name || '');
      if (cleaned.length >= 2 && !_looksLikeAlbum(folder.name)) {
        return cleaned;
      }

      currentId = folder.parents?.[0];
    }

    return null;
  }

  /** Reset all radio state. Call whenever the user starts a new multi-song queue. */
  function _resetRadio() {
    _radioModeActive = false;
    _radioArtist     = null;
    _radioInFlight   = false;
    _radioQueuedIds  = new Set();
    _radioTriggered  = false;
  }

  function _startLoadingSpinner() {
    _cancelLoadingSpinner();
    _loadingTimer = setTimeout(() => {
      UI.setPlayerLoading(true);
      _loadingTimer = null;
    }, 120);
  }

  function _cancelLoadingSpinner() {
    if (_loadingTimer !== null) { clearTimeout(_loadingTimer); _loadingTimer = null; }
    UI.setPlayerLoading(false);
  }

  /* ── Boot ───────────────────────────────────────────────── */

  async function boot() {
    console.log('[App] Booting Savart', CONFIG.VERSION);

    // Stamp the version label in Settings so it always matches CONFIG.VERSION
    const verLabel = document.getElementById('app-version-label');
    if (verLabel) verLabel.textContent = `Savart — versión ${CONFIG.VERSION}`;

    // 1. Open IndexedDB
    try {
      await DB.open();
    } catch (err) {
      console.error('[App] DB init failed:', err);
      // App can still work without cache — continue
    }

    // 2. Restore user preferences
    const savedLang = localStorage.getItem('savart_lang') || 'es';
    UI.setLanguage(savedLang);

    // 3. Root folder is fixed to MSK — never changes
    _rootFolderId = CONFIG.ROOT_FOLDER_ID;

    // 4. Init player
    Player.init({
      onTrackChange: _onTrackChange,
      onPlayPause:   _onPlayPause,
      onProgress:    _onProgress,
      onQueueChange: _onQueueChange,
      onError:       _onPlayerError,
      onBlobReady:   _onBlobReady,
    });

    // 5. Init auth
    Auth.init({
      onReady:    _onTokenReady,
      onExpiring: _onTokenExpiring,
      onLogout:   _onLogout,
    });

    // 6. Bind static UI events
    _bindEvents();

    // 6b. Desktop: pre-build EQ sliders (EQ is already in settings HTML)
    if (window.matchMedia('(min-width: 768px)').matches) {
      _buildEQSliders();
      _applyEQPreset(_currentPreset || 'flat');
      _loadCustomPresets();
    }

    // 7. Back gesture prevention
    _initBackGuard();

    // 8. Decide initial screen
    if (Auth.isAuthenticated()) {
      _onTokenReady();
    } else if (Auth.wasAuthenticated()) {
      // Was logged in before — attempt silent re-auth transparently.
      // Show the login screen but hide the login button while we try.
      // Only reveal the button if silent auth fails (or after a safety timeout).
      UI.showView('login');
      _startSilentReconnect();
    } else {
      UI.showView('login');
    }
  }

  /**
   * Attempt silent re-auth while showing a "Reconectando…" spinner
   * instead of the login button. Reveals the button on failure.
   */
  function _startSilentReconnect() {
    const btnLogin      = document.getElementById('btn-login');
    const reconnecting  = document.getElementById('login-reconnecting');
    const disclaimer    = document.querySelector('.login-disclaimer');

    // Enter reconnecting state: hide button & disclaimer, show spinner
    if (btnLogin)     btnLogin.style.display     = 'none';
    if (disclaimer)   disclaimer.style.display   = 'none';
    if (reconnecting) reconnecting.style.display = 'flex';

    // Safety timeout — if GIS doesn't respond in 5s, give up silently
    const safetyTimer = setTimeout(() => _exitSilentReconnect(), 5000);

    function _exitSilentReconnect() {
      clearTimeout(safetyTimer);
      if (btnLogin)     btnLogin.style.display     = '';
      if (disclaimer)   disclaimer.style.display   = '';
      if (reconnecting) reconnecting.style.display = 'none';
    }

    Auth.tryAutoLogin(_exitSilentReconnect);
  }

  /**
   * Prevent browser back gesture from reloading the page (and dropping
   * the in-memory auth token). Pushes a dummy history state and re-pushes
   * on every popstate so the stack never empties.
   * Skipped in standalone PWA mode — Android handles it natively there.
   */
  function _initBackGuard() {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    history.replaceState({ savart: true }, '', location.href);
    history.pushState({ savart: true }, '', location.href);
    window.addEventListener('popstate', () => {
      history.pushState({ savart: true }, '', location.href);
    });
  }

  /* ── Auth events ─────────────────────────────────────────── */

  function _onTokenReady() {
    // If silent re-auth completed, clean up reconnecting UI before transition
    const reconnecting = document.getElementById('login-reconnecting');
    if (reconnecting) reconnecting.style.display = 'none';

    UI.hideTokenBanner();
    UI.showView('home');
    _loadHomeData();
    // Fetch real user info and update Settings panel
    Auth.fetchUserInfo().then(info => {
      if (!info) return;
      const emailEl = document.getElementById('account-email');
      if (emailEl) emailEl.textContent = info.email || info.name || '—';
      try { localStorage.setItem('savart_user_email', info.email || '');
            localStorage.setItem('savart_user_name',  info.name  || ''); } catch (_) {}
    }).catch(() => {});
    // Restore cached user info immediately (avoids flicker on re-load)
    _restoreUserInfo();
    // Restore EQ + tempo from DB before first render
    _restoreSettings();
    // Sync in background — when it finishes, refresh the UI so data from Drive
    // appears immediately on the second device (local DB was empty before sync).
    Sync.init().then(() => {
      _restoreSettings();
      _loadHomeData();
      const view = UI.getCurrentView();
      if (view === 'library') _setLibTab(_currentLibTab || 'albums');
      // Start live 3-second polling (Last-Write-Wins)
      Sync.startLiveSync(_onSyncDataChanged);
    }).catch(() => {});

    // Auto-open Deep Scan if launched from "Abrir en pestaña"
    if (location.hash === '#deep-scan' || location.hash === '#deep-scan-artists') {
      _openDeepScan();
    }
  }

  /**
   * Called by Sync whenever live polling detects remote changes.
   * Refreshes whichever parts of the UI are affected.
   * @param {string[]} types — e.g. ['recents', 'pinned', 'settings']
   */
  function _onSyncDataChanged(types) {
    console.log('[App] Live sync applied:', types);
    const view = UI.getCurrentView();

    const needsHome = types.some(t => ['recents', 'pinned', 'playcounts', 'favorites'].includes(t));
    if (needsHome) _loadHomeData();

    if (view === 'library' && types.some(t => ['playlists', 'favorites'].includes(t))) {
      _setLibTab(_currentLibTab || 'albums');
    }

    // Metadata sync (full or hot delta): re-render the active library tab so covers/names appear immediately
    if (types.includes('metadata') || types.includes('hot')) {
      if (view === 'library' && !_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
      }
      // Also refresh home cards (top-played, recents may show stale covers)
      _loadHomeData();
    }

    if (view === 'history' && types.includes('history')) _loadHistory();

    if (types.includes('settings')) _restoreSettings();

    // When favorites sync in, refresh the heart button for the currently playing track
    if (types.includes('favorites')) {
      const track = Player.getCurrentTrack();
      if (track?.id) {
        DB.getMeta(track.id).then(m => {
          if (Player.getCurrentTrack()?.id === track.id) {
            UI.setHeartActive(!!m?.starred);
          }
        }).catch(() => {});
      }
    }
  }

  function _restoreUserInfo() {
    try {
      const email  = localStorage.getItem('savart_user_email');
      if (!email) return;
      const emailEl = document.getElementById('account-email');
      if (emailEl) emailEl.textContent = email;
    } catch (_) {}
  }

  /**
   * Restore EQ and tempo from DB.setState('settings').
   * Called on boot and again after Sync.init() in case remote had newer settings.
   */
  async function _restoreSettings() {
    try {
      const s = await DB.getState('settings');
      if (!s) return;

      // ── Restore tempo ──────────────────────────────────────
      if (typeof s.tempo === 'number') {
        Player.setTempo(s.tempo);
        const sliderVal    = Math.round(s.tempo * 100);
        const display      = s.tempo.toFixed(2) + '×';
        const tempoSlider  = document.getElementById('tempo-slider');
        const tempoVal     = document.getElementById('tempo-val');
        const oSlider      = document.getElementById('overlay-tempo-slider');
        const oVal         = document.getElementById('overlay-tempo-val');
        if (tempoSlider) tempoSlider.value    = sliderVal;
        if (tempoVal)    tempoVal.textContent = display;
        if (oSlider)     oSlider.value        = sliderVal;
        if (oVal)        oVal.textContent     = display;
      }

      // ── Restore EQ enabled state ───────────────────────────
      const eqToggle = document.getElementById('eq-toggle');
      if (eqToggle) {
        const isOn = s.eqEnabled !== false; // default on
        eqToggle.classList.toggle('on', isOn);
        // Apply visual disabled state to sliders panel and EQ screen
        document.getElementById('eq-sliders')?.classList.toggle('eq-off', !isOn);
        document.getElementById('screen-eq')?.classList.toggle('eq-controls-off', !isOn);
      }

      // ── Restore EQ gains ───────────────────────────────────
      if (Array.isArray(s.eqGains) && s.eqGains.length === CONFIG.EQ_BANDS.length) {
        Player.setEQGains(s.eqGains);
        _currentPreset = s.eqPreset || null;
        // Update sliders if the EQ panel is already in the DOM
        s.eqGains.forEach((g, i) => {
          const slider = document.getElementById(`eq-slider-${i}`);
          const valEl  = document.getElementById(`eq-val-${i}`);
          if (slider) slider.value    = g;
          if (valEl)  valEl.textContent = g > 0 ? `+${g}` : `${g}`;
        });
        document.querySelectorAll('.eq-preset-chip').forEach(c => {
          c.classList.toggle('active', c.dataset.preset === _currentPreset);
        });
        _drawEQCurve();
      }

      // ── Restore custom presets ─────────────────────────────
      if (Array.isArray(s.eqCustomPresets) && s.eqCustomPresets.length > 0) {
        _customPresets = s.eqCustomPresets;
        // Keep localStorage in sync for any legacy reads
        try { localStorage.setItem('savart_eq_presets', JSON.stringify(_customPresets)); } catch (_) {}
        _renderCustomPresets();
      }

      console.log('[App] Settings restored from DB');
    } catch (err) {
      console.warn('[App] Could not restore settings:', err);
    }
  }

  /**
   * Persist current EQ + tempo to DB and schedule a sync push.
   * Call after any EQ or tempo change.
   */
  function _saveSettings() {
    const gains      = Player.getEQGains();
    const eqOn       = document.getElementById('eq-toggle')?.classList.contains('on') ?? true;
    const tempoRaw   = parseFloat(document.getElementById('tempo-slider')?.value ?? 100);
    const tempo      = tempoRaw / 100;
    DB.setState('settings', {
      eqGains:        gains,
      eqEnabled:      eqOn,
      eqPreset:       _currentPreset || null,
      tempo,
      eqCustomPresets: _customPresets,
      savedAt:        Date.now(),
    }).catch(() => {});
    Sync.push('settings');
  }

  function _onTokenExpiring() {
    UI.showTokenBanner();
  }

  function _onLogout() {
    Sync.stopLiveSync();
    UI.showView('login');
    UI.hideTokenBanner();
    // Clear cached user info so it doesn't bleed into the next account
    try {
      localStorage.removeItem('savart_user_email');
      localStorage.removeItem('savart_user_name');
    } catch (_) {}
    const emailEl = document.getElementById('account-email');
    if (emailEl) emailEl.textContent = '—';
  }

  /* ── Player events ───────────────────────────────────────── */

  function _onTrackChange(track, index, total) {
    // Show loading spinner (delayed 120ms to avoid flash for cached tracks)
    _startLoadingSpinner();
    // Enrich immediately if metadata was already cached (e.g. track played before)
    const enriched = _enrichTrack(track);
    UI.updateMiniPlayer(enriched, true);
    UI.updateExpandedPlayer(enriched, true);
    UI.setActiveSongRow(track?.id);
    document.title = track ? `${track.displayName} — Savart` : 'Savart';

    // Sync heart button state with DB
    UI.setHeartActive(false); // reset while loading
    if (track?.id) {
      DB.getMeta(track.id).then(m => {
        // Only apply if this is still the current track
        if (Player.getCurrentTrack()?.id === track.id) {
          UI.setHeartActive(!!m?.starred);
        }
      }).catch(() => {});
    }

    // Save to recents (type: 'song') so Home shows it in "Canciones recientes"
    if (track) {
      const safeThumb = (() => { const u = track.thumbnailUrl || track.thumbnailLink || null; return (u && u.startsWith('blob:')) ? (track.thumbnailLink || null) : u; })();
      const recentData = {
        id:           track.id,
        name:         track.name,
        displayName:  track.displayName || track.name || '',
        type:         'song',
        artist:       track.artist       || '',
        thumbnailUrl:  safeThumb,
        thumbnailLink: track.thumbnailLink || null,
        folderId:     track.parents?.[0]  || track.folderId || null,
      };
      DB.addRecent(recentData).then(() => {
        Sync.push('recents');
        // Refresh Home in real-time if it's the active view
        if (UI.getCurrentView() === 'home') _loadHomeData();
      }).catch(() => {});
      // Add to playback history (no-duplicates, most-recent-first, 7-day / 100-item store)
      DB.addToHistory({
        id:          track.id,
        name:        track.name,
        displayName: track.displayName || track.name || '',
        artist:      track.artist      || '',
        thumbnailUrl: safeThumb,
        folderId:    track.parents?.[0] || track.folderId || null,
      }).then(() => Sync.push('history')).catch(() => {});
      // Also persist display fields to metadata store so topPlayed can show them.
      // IMPORTANT: only write non-empty artist/displayName so we never overwrite
      // enriched values (from a previous AudD/Last.fm pass) with empty strings.
      const _metaUpdate = { name: recentData.name, folderId: recentData.folderId };
      if (recentData.displayName)  _metaUpdate.displayName  = recentData.displayName;
      if (recentData.thumbnailUrl) _metaUpdate.thumbnailUrl = recentData.thumbnailUrl;
      if (recentData.artist)       _metaUpdate.artist       = recentData.artist;
      DB.setMeta(track.id, _metaUpdate).catch(() => {});
      // Schedule sync for play counts (incremented by player.js after audio starts)
      setTimeout(() => Sync.push('playcounts'), 3000);
    }
  }

  function _onPlayPause(isPlaying) {
    // Cancel loading spinner the moment audio actually starts playing
    if (isPlaying) _cancelLoadingSpinner();
    const track = Player.getCurrentTrack();
    const enriched = _enrichTrack(track);
    UI.updateMiniPlayer(enriched, isPlaying);
    UI.updateExpandedPlayer(enriched, isPlaying);
  }

  function _onProgress(currentTime, duration) {
    UI.updateProgress(currentTime, duration);
    if (UI.isExpandedPlayerVisible()) {
      UI.updateExpandedPlayerProgress(currentTime, duration);
    }
  }

  function _onQueueChange(queue, index) {
    // Re-render queue panel if it's currently open
    if (UI.isQueuePanelVisible()) {
      UI.renderQueuePanel(queue, index);
      _prefetchQueueCovers(queue).catch(() => {});
    }

    // Radio refill: if the queue is running low, fetch another batch for the artist
    if (_radioModeActive && _radioArtist && !_radioInFlight) {
      const remaining = queue.length - index - 1;
      if (remaining <= 2) {
        _triggerRadio(_radioArtist, null).catch(() => {});
      }
    }
  }

  function _onPlayerError({ type, message, item }) {
    UI.showToast(message, 'error');
    if (type === 'auth') {
      UI.showTokenBanner();
    }
  }

  /* ── Metadata / cover art ────────────────────────────────── */

  /**
   * Enrich a DriveItem with cached ID3 metadata (cover art, artist, album, year).
   * Returns the original item if no metadata is cached yet.
   * @param {DriveItem|null} track
   * @returns {DriveItem|null}
   */
  function _enrichTrack(track) {
    if (!track || typeof Meta === 'undefined') return track;
    const meta = Meta.getCached(track.id);
    if (!meta) return track;
    return {
      ...track,
      displayName:   meta.title        || track.displayName,
      artist:        meta.artist       || track.artist    || '',
      albumName:     meta.album        || track.albumName || '',
      year:          meta.year         || track.year      || '',
      thumbnailUrl:  meta.coverUrl     || track.thumbnailUrl,
      bitrate:       meta.bitrate      ?? track.bitrate      ?? null,
      sampleRate:    meta.sampleRate   ?? track.sampleRate   ?? null,
      bitsPerSample: meta.bitsPerSample ?? track.bitsPerSample ?? null,
      // Use cached blob size if the queue item lacks one (e.g. loaded from recents)
      size:          _blobSizeCache.get(track.id) ?? track.size ?? 0,
    };
  }

  /**
   * Called by Player once the blob is ready (cache hit or fresh download).
   * Parses ID3/FLAC tags and applies cover art + text metadata to UI.
   * @param {DriveItem} item
   * @param {Blob}      blob
   */
  /**
   * Radio mode: search Drive for more songs by the given artist and
   * append them to the queue in shuffle order.
   *
   * Search strategy (2-level expansion):
   *   searchFiles(artist) → artist-named folders → album subfolders → songs
   *   Also takes any audio files whose filenames contain the artist name.
   *
   * @param {string}      artist        - artist name from AudD / ID3 / Last.fm
   * @param {string|null} triggerItemId - if non-null, abort if no longer current track
   */
  async function _triggerRadio(artist, triggerItemId) {
    if (!_radioModeActive || !artist || _radioInFlight) return;

    // For the initial trigger (from _onBlobReady): verify we're still on that track.
    // For refill triggers (from _onQueueChange): triggerItemId is null → skip check.
    if (triggerItemId !== null) {
      const current = Player.getCurrentTrack();
      if (!current || current.id !== triggerItemId) return;
    }

    _radioInFlight = true;
    try {
      console.log(`[Radio] Searching Drive for artist: "${artist}"`);

      // ── Step 1: Drive full-text search by artist name ─────────
      const results = await Drive.searchFiles(artist);

      // Build the blocked set.
      // Initial trigger (triggerItemId != null): block current queue + prior radio adds
      //   → prevents immediate re-queuing of songs added this session.
      // Refill trigger (triggerItemId === null): block ONLY the current queue
      //   → songs that have already played (left the queue) are recyclable,
      //     so radio keeps working even when the artist has ≤ 25 songs in Drive.
      const { queue } = Player.getQueue();
      const blocked   = triggerItemId !== null
        ? new Set([...queue.map(q => q.id), ..._radioQueuedIds])
        : new Set(queue.map(q => q.id));

      // ── Artist name matcher ────────────────────────────────────
      // Normalizes both strings (lowercase, no accents, no punctuation) then
      // checks that the full artist name appears as a substring in the item name.
      // "Christian Nodal" → folder "Christian Nodal - Discography" ✓
      //                   → folder "Christian Castro"              ✗ (no "nodal")
      // "Korn"            → folder "Korn"                          ✓
      const _normStr = s => s.toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
        .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const _normArtist = _normStr(artist);
      const _matchesArtist = name => _normStr(name).includes(_normArtist);

      const candidates = [];
      const seen       = new Set();

      const _collect = (f) => {
        if (!seen.has(f.id) && !blocked.has(f.id) && isPlayable(f.mimeType)) {
          seen.add(f.id);
          candidates.push(f);
        }
      };

      // Direct audio files: only collect those whose name matches the full artist
      results.files.filter(f => _matchesArtist(f.name)).forEach(_collect);

      // ── Step 2: expand artist-named folders (max 3) ───────────
      // Filter folders to those whose name actually matches the artist.
      // This prevents expanding "Cristian Castro" when searching "Cristian Nodal".
      const artistFolders = results.folders.filter(f => _matchesArtist(f.name)).slice(0, 3);
      const level1 = await Promise.allSettled(
        artistFolders.map(f => Drive.listFolderAll(f.id))
      );

      const albumFolders = [];
      for (const r of level1) {
        if (r.status !== 'fulfilled') continue;
        r.value.files.forEach(_collect);           // loose songs in artist folder
        albumFolders.push(...r.value.folders);     // album subfolders
      }

      // ── Step 3: expand album subfolders (max 8) ───────────────
      const level2 = await Promise.allSettled(
        albumFolders.slice(0, 8).map(f => Drive.listFolderAll(f.id))
      );
      for (const r of level2) {
        if (r.status !== 'fulfilled') continue;
        r.value.files.forEach(_collect);
      }

      if (candidates.length === 0) {
        console.log(`[Radio] No new songs found for: "${artist}"`);
        return;
      }

      // ── Step 4: shuffle and append (max 25 per batch) ─────────
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      const toAdd = candidates.slice(0, 25);
      toAdd.forEach(f => { _cacheItem(f); _radioQueuedIds.add(f.id); });

      Player.appendToQueue(toAdd);
      _radioArtist = artist; // confirm for future refill cycles

      UI.showToast(`Radio · ${artist} · +${toAdd.length}`, 'default');
      console.log(`[Radio] ✓ ${toAdd.length} songs queued for: "${artist}"`);

    } catch (err) {
      console.warn('[Radio] Search error:', err);
    } finally {
      _radioInFlight = false;
    }
  }

  async function _onBlobReady(item, blob) {
    if (typeof Meta === 'undefined') return;
    try {
      const meta = await Meta.parse(item.id, blob);

      // Cache blob.size so _enrichTrack can always provide it
      if (blob.size > 0) {
        _blobSizeCache.set(item.id, blob.size);
        item = { ...item, size: blob.size };
      }

      // Persist embedded cover blob immediately — playlists/favorites can use it
      // across sessions without re-parsing the file.
      if (meta?.coverBlob) {
        DB.setMeta(item.id, { coverBlob: meta.coverBlob }).catch(() => {});
      }

      /* ── PASS 1 — IDENTIFICATION ──────────────────────────────
         Goal: assemble the best possible artist / title / album
         from every local source. AudD runs here if anything is
         still missing — its output feeds Pass 2 (Last.fm / Lyrics).
         Cover is NOT the goal here; only identity metadata.
      ─────────────────────────────────────────────────────────── */

      // 1a. DB — data persisted from a previous session
      // (AudD artist/title/album stored earlier, or cached thumbnailUrl)
      const dbMeta = await DB.getMeta(item.id).catch(() => null);
      if (dbMeta) {
        if (!meta.artist && dbMeta.artist)      meta.artist = dbMeta.artist;
        if (!meta.title  && dbMeta.displayName) meta.title  = dbMeta.displayName;
        if (!meta.album  && dbMeta.album)       meta.album  = dbMeta.album;
        // Restore a previously-found external cover URL (not a Drive thumbnail)
        if (!meta.coverUrl) {
          const stored = dbMeta.coverUrl || dbMeta.thumbnailUrl;
          const isExternal = stored
            && !stored.startsWith('blob:')
            && !stored.includes('googleusercontent.com')
            && !stored.includes('googleapis.com');
          if (isExternal) meta.coverUrl = stored;
        }
      }

      // 1b. Drive appProperties — synced from another device
      if (item.appProperties) {
        if (!meta.coverUrl && item.appProperties.s_cover)  meta.coverUrl = item.appProperties.s_cover;
        if (!meta.artist   && item.appProperties.s_artist) meta.artist   = item.appProperties.s_artist;
        if (!meta.title    && item.appProperties.s_title)  meta.title    = item.appProperties.s_title;
        if (!meta.album    && item.appProperties.s_album)  meta.album    = item.appProperties.s_album;
      }

      // 1c. AudD fingerprinting — runs when any key identity field is missing
      //     (artist, title, or cover). Being here means its results are available
      //     to Last.fm and Lyrics in Pass 2 below.
      const _needsAudd = !meta.coverUrl || !meta.artist || !meta.title;
      if (_needsAudd && typeof Audd !== 'undefined') {
        try {
          const sample = blob.slice(0, 1024 * 1024); // first 1MB is enough for fingerprinting
          const result = await Audd.identify(sample);
          if (result) {
            if (!meta.coverUrl && result.coverUrl) meta.coverUrl = result.coverUrl;
            if (!meta.title    && result.title)    meta.title    = result.title;
            if (!meta.artist   && result.artist)   meta.artist   = result.artist;
            if (!meta.album    && result.album)    meta.album    = result.album;
            // Persist everything AudD found
            const update = { auddTried: true };
            if (result.title)    update.displayName  = result.title;
            if (result.artist)   update.artist       = result.artist;
            if (result.album)    update.album        = result.album;
            if (result.coverUrl) update.thumbnailUrl = result.coverUrl;
            DB.setMeta(item.id, update).catch(() => {});
          }
        } catch (_) { /* network / API error — non-fatal */ }
      }

      // 1d. Filename / folder-hierarchy fallback — runs when artist is still unknown
      //     after ID3, DB, appProperties, and AudD.  _guessArtistFromItem walks:
      //       1. filename pattern "Artist - Title.mp3"
      //       2. parent folder chain (up to 4 levels, skips album-like names)
      //     This gives Last.fm a real artist to query in Pass 2, and the result is
      //     persisted to DB so the name shows everywhere (queue, home, top-played…).
      if (!meta.artist) {
        const guessed = _guessArtistFromItem(item);
        if (guessed) meta.artist = guessed;
      }

      /* ── PASS 2 — ENRICHMENT ──────────────────────────────────
         Goal: find cover art using the best metadata now available
         (which may include artist/album/title found by AudD above).
         Last.fm runs with artist+album or artist+title.
         Folder image is the last resort.
      ─────────────────────────────────────────────────────────── */

      // 2a. Last.fm by album (album.getInfo — most reliable when album is known)
      if (!meta.coverUrl && typeof Lastfm !== 'undefined' && meta.artist && meta.album) {
        const lfmUrl = await Lastfm.fetchCover(meta.artist, meta.album);
        if (lfmUrl) {
          meta.coverUrl = lfmUrl;
          DB.setMeta(item.id, { thumbnailUrl: lfmUrl }).catch(() => {});
        }
      }

      // 2b. Last.fm by track (track.getInfo — works with artist+title alone)
      if (!meta.coverUrl && typeof Lastfm !== 'undefined' && meta.artist && (meta.title || item.displayName)) {
        const trackTitle = meta.title || item.displayName;
        const lfmUrl = await Lastfm.fetchCoverByTrack(meta.artist, trackTitle);
        if (lfmUrl) {
          meta.coverUrl = lfmUrl;
          DB.setMeta(item.id, { thumbnailUrl: lfmUrl }).catch(() => {});
        }
      }

      // 2c. Folder cover — generic fallback shared by all songs in the folder
      if (!meta.coverUrl) {
        const folderId = item.parents?.[0];
        if (folderId) meta.coverUrl = await _getFolderCover(folderId);
      }

      /* ── FINALIZE ─────────────────────────────────────────────
         Write enriched metadata to the in-memory Meta cache,
         apply to UI, prefetch lyrics, and trigger radio if needed.
      ─────────────────────────────────────────────────────────── */

      Meta.patchCached(item.id, {
        coverUrl: meta.coverUrl || undefined,
        artist:   meta.artist   || undefined,
        title:    meta.title    || undefined,
        album:    meta.album    || undefined,
      });

      // Persist the final enriched identity back to DB so home / top-played
      // can show it in future sessions without replaying the song.
      // (ID3 artist / Last.fm artist are NOT otherwise saved to DB.)
      {
        const _persist = {};
        if (meta.artist) _persist.artist      = meta.artist;
        if (meta.title)  _persist.displayName = meta.title;
        if (meta.album)  _persist.album       = meta.album;
        if (meta.year)   _persist.year        = meta.year;
        if (meta.track)  _persist.track       = meta.track;
        if (Object.keys(_persist).length > 0) DB.setMeta(item.id, _persist).catch(() => {});
      }

      // Propagate enriched album/artist/year/cover to sibling songs in the same folder
      _propagateAlbumMeta(item, meta).catch(() => {});

      _applyMeta(item, meta);

      // If home is currently visible and we enriched the artist/title, refresh it
      // so recents cards show the updated text immediately in this session.
      // (_patchMetaText already handled DOM-level patches; this keeps the data
      //  model consistent for subsequent re-renders like live sync.)
      if ((meta.artist || meta.title) && UI.getCurrentView() === 'home') {
        _loadHomeData().catch(() => {});
      }

      // Prefetch lyrics now that artist + title are fully resolved
      if (typeof Lyrics !== 'undefined' && meta.artist && (meta.title || item.displayName)) {
        const lyricsTitle = meta.title || item.displayName;
        Lyrics.fetch(meta.artist, lyricsTitle).catch(() => {});
        const expanded = document.getElementById('player-expanded');
        if (expanded?.classList.contains('showing-lyrics') &&
            Player.getCurrentTrack()?.id === item.id) {
          _loadLyricsForCurrentTrack();
        }
      }

      // Radio mode: trigger initial Drive search once, after full identification.
      // Priority: pre-seeded _radioArtist (from item selection) → meta.artist
      // (ID3/AudD) → filename/folder extraction as last resort.
      if (_radioModeActive && !_radioTriggered) {
        const radioArtist = _radioArtist || meta.artist || _guessArtistFromItem(item);
        if (radioArtist) {
          _radioTriggered = true;
          _radioArtist    = radioArtist;
          _triggerRadio(radioArtist, item.id).catch(() => {});
        }
      }

    } catch (err) {
      console.warn('[App] Meta parse error:', err);
    }
  }

  /**
   * Find (and cache) a cover image from a Drive folder.
   * First call: hits Drive API, downloads the image blob, creates object URL.
   * Subsequent calls for same folder: returns cached URL instantly.
   * @param {string} folderId
   * @returns {Promise<string|null>}
   */
  async function _getFolderCover(folderId) {
    if (_folderCoverCache.has(folderId)) return _folderCoverCache.get(folderId);

    // Check for a persisted cover blob from a previous session
    try {
      const stored = await DB.getState('folderCover:' + folderId);
      if (stored?.blob) {
        const url = URL.createObjectURL(stored.blob);
        _folderCoverCache.set(folderId, url);
        return url;
      }
    } catch (_) {}

    try {
      const imgFile = await Drive.findCoverImage(folderId);
      if (!imgFile) {
        _folderCoverCache.set(folderId, null);
        return null;
      }

      // Use thumbnailLink if available (saves a full download)
      if (imgFile.thumbnailLink) {
        // thumbnailLink is a Google-signed URL — works as <img src>
        _folderCoverCache.set(folderId, imgFile.thumbnailLink);
        return imgFile.thumbnailLink;
      }

      // Otherwise download the full image blob, make an object URL, and persist it
      const blob = await Drive.downloadFile(imgFile.id);
      const url  = URL.createObjectURL(blob);
      _folderCoverCache.set(folderId, url);
      DB.setState('folderCover:' + folderId, { blob }).catch(() => {});
      return url;
    } catch (err) {
      console.warn('[App] Folder cover fetch failed:', err.message);
      _folderCoverCache.set(folderId, null);
      return null;
    }
  }

  /**
   * Background metadata + cover enrichment for a folder / album view.
   *
   * Pass 0  — DB cache                  (instant, no network; skipped when force=true)
   * Pass 1  — In-memory Meta cache      (instant, session)
   * Pre-2   — ID3 blob parse [force only] (overwrites artist/album/year from file tags first)
   * Pass 2  — MusicBrainz              (text: artist, album, year, track — no file download)
   *             normal: fills empty fields | force: has clean ID3 context → better accuracy
   * Pass 3  — ID3 blob parse [normal / cover-only force]
   *             normal: fills what MB missed + embedded cover
   *             force:  only songs without a cover (pre-2 covered the rest)
   * Pass 4  — Cover Art Archive (CAA)  (MusicBrainz cover for songs without embedded art)
   * Pass 5  — Folder cover.jpg         (generic fallback)
   * Pass 6  — Last.fm                  (external cover by artist+album)
   * Pass 7  — AudD.io fingerprinting   (last resort: identifies song from audio)
   *
   * @param {string}      folderId
   * @param {DriveItem[]} files
   */
  /**
   * @param {boolean} [force=false] — when true, performs a full re-enrichment:
   *   • Skips Pass 0 (appProperties/DB restore) so stale data doesn't block MB.
   *   • Forces MB to run on every file regardless of existing text metadata.
   *   • Forces ID3 parse on every file regardless of DOM cover state.
   *   MB is always the primary source; ID3 and AudD fill only what MB missed.
   */
  async function _prefetchAndApplyFolderCovers(folderId, files, force = false) {
    if (!files || files.length === 0) return;

    // ── Pass -1: Ensure every file has folderId + basic info in DB ───────────
    // _inferAlbumMeta (background scan) sets this, but files opened directly
    // via Browse may have never passed through it. Without folderId, _loadAlbums
    // skips the song entirely and the album never appears in the Library.
    if (folderId) {
      await Promise.allSettled(files.map(async file => {
        try {
          const existing = await DB.getMeta(file.id).catch(() => null);
          const patch = {};
          if (!existing?.folderId)    patch.folderId    = folderId;
          if (!existing?.name)        patch.name        = file.name;
          if (!existing?.displayName) patch.displayName = file.displayName || cleanTitle(file.name);
          if (Object.keys(patch).length > 0) DB.setMeta(file.id, { id: file.id, ...patch }).catch(() => {});
        } catch (_) {}
      }));
    }

    // ── Pass 0: Drive appProperties + IndexedDB (instant, no network) ─────────
    // 0a. appProperties.s_cover — synced cover from another device via Drive API
    // 0b. coverBlob             — ID3 embedded art saved locally (highest quality)
    // 0c. coverUrl / thumbnailUrl — external URL persisted from a prior session
    // Skipped on force-rescan so stale synced values don't prevent MB from re-running.
    if (!force) {
      await Promise.allSettled(files.map(async file => {
        try {
          const ap = file.appProperties;
          if (ap?.s_cover) {
            _updateRowThumbnail(file.id, ap.s_cover);
            const save = { thumbnailUrl: ap.s_cover };
            if (ap.s_title)  save.displayName = ap.s_title;
            if (ap.s_artist) save.artist      = ap.s_artist;
            if (ap.s_album)  save.album       = ap.s_album;
            if (ap.s_year)   save.year        = ap.s_year;
            DB.setMeta(file.id, save).catch(() => {});
            return;
          }
          const dbMeta = await DB.getMeta(file.id);
          if (!dbMeta) return;
          if (dbMeta.coverBlob && typeof Meta !== 'undefined') {
            const url = Meta.injectCover(file.id, dbMeta.coverBlob);
            if (url) { _updateRowThumbnail(file.id, url, true); return; }
          }
          const persistedUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
          if (persistedUrl) _updateRowThumbnail(file.id, persistedUrl);
        } catch (_) {}
      }));
    }

    // ── Pass 1: in-memory Meta cache (always ID3, session) ────────────────────
    files.forEach(file => {
      const meta = (typeof Meta !== 'undefined') ? Meta.getCached(file.id) : null;
      if (meta?.coverUrl) _updateRowThumbnail(file.id, meta.coverUrl, true);
    });

    // ── Force pre-pass: ID3 first (when force=true) ──────────────────────────
    // In force mode, ID3 runs BEFORE MusicBrainz so MB gets clean artist/album context
    // directly from the actual audio file tags. MB then overwrites with its canonical data
    // if it finds a match. In normal mode this block is skipped — MB runs first (Pass 2).
    if (force && typeof Meta !== 'undefined') {
      const forceId3Queue = [...files];
      const CONCURRENCY_PRE = 3;
      async function forceId3Worker() {
        while (forceId3Queue.length > 0) {
          const file = forceId3Queue.shift();
          try {
            let blob = await DB.getCachedBlob(file.id);
            if (!blob) blob = await Drive.downloadFileHead(file.id);
            if (!blob) continue;
            const meta = await Meta.parse(file.id, blob);
            if (!meta) continue;
            const textPatch = {};
            if (meta.title)  textPatch.displayName = meta.title;
            if (meta.artist) textPatch.artist       = meta.artist;  // force: overwrite always
            if (meta.album)  textPatch.album        = meta.album;
            if (meta.year)   textPatch.year         = meta.year;
            if (meta.track)  textPatch.track        = meta.track;
            if (Object.keys(textPatch).length > 0) {
              await DB.setMeta(file.id, textPatch).catch(() => {});
              _patchMetaText(file.id, {
                title:  meta.title  || null,
                artist: meta.artist || null,
                album:  meta.album  || null,
                year:   meta.year   || null,
              });
            }
            if (meta.coverUrl) {
              _updateRowThumbnail(file.id, meta.coverUrl, true);
              if (meta.coverBlob) DB.setMeta(file.id, { coverBlob: meta.coverBlob }).catch(() => {});
            }
            if (Player.getCurrentTrack()?.id === file.id) _applyMeta(file, meta);
          } catch (_) {}
        }
      }
      await Promise.allSettled(Array.from({ length: CONCURRENCY_PRE }, () => forceId3Worker()));
    }

    // ── Pass 2: MusicBrainz — text metadata ───────────────────────────────────
    // MB is the authoritative source: artist, album, year always come from MB when found.
    // In force mode, ID3 pre-pass has already set correct context so MB gets accurate input.
    // ID3 (Pass 3) only fills fields MB left empty. AudD (Pass 7) fills what ID3 also missed.
    // Sequential: 1 req/sec rate limit.
    if (typeof MusicBrainz !== 'undefined') {
      const mbQueue = [];
      for (const file of files) {
        try {
          const m = await DB.getMeta(file.id);
          if (m?.mbTried) continue;
          const title = m?.displayName || m?.name || file.name || '';
          if (!title) continue;
          // On force-rescan always query MB. On normal load, skip if all text fields are filled.
          const needsText = force || !m?.artist || !m?.album || !m?.year || !m?.track;
          if (!needsText) { DB.setMeta(file.id, { mbTried: true }).catch(() => {}); continue; }
          mbQueue.push({ file, title, artist: m?.artist || '', album: m?.album || '', m: m || {} });
        } catch (_) {}
      }

      let anyTrackFoundMB = false;
      for (const { file, title, artist, album, m } of mbQueue) {
        try {
          const result = await MusicBrainz.lookup(file.id, title, artist, album);
          DB.setMeta(file.id, { mbTried: true }).catch(() => {});
          if (!result) continue;

          const patch = {};
          // MB always wins for artist/album/year — it is the canonical metadata source.
          // Track is fill-only: MB numbering may differ from physical disc order.
          if (result.track   && !m.track)  patch.track         = result.track;
          if (result.artist)               patch.artist        = result.artist;
          if (result.album)                patch.album         = result.album;
          if (result.year)                 patch.year          = result.year;
          if (result.releaseMbid)          patch.mbReleaseMbid = result.releaseMbid;

          if (Object.keys(patch).filter(k => k !== 'mbReleaseMbid').length > 0 || patch.mbReleaseMbid) {
            // Derive a stable CAA cover URL from the MBID and store locally
            if (patch.mbReleaseMbid && !m.thumbnailUrl) {
              patch.thumbnailUrl = `https://coverartarchive.org/release/${patch.mbReleaseMbid}/front-250`;
              _updateRowThumbnail(file.id, patch.thumbnailUrl);
            }
            await DB.setMeta(file.id, patch);
            if (patch.artist || patch.album || patch.year) {
              _patchMetaText(file.id, {
                title:  null,
                artist: patch.artist || m.artist || null,
                album:  patch.album  || m.album  || null,
                year:   patch.year   || m.year   || null,
              });
            }
            if (patch.track) anyTrackFoundMB = true;
            const logParts = Object.entries(patch).filter(([k]) => k !== 'mbReleaseMbid').map(([k,v]) => `${k}:${v}`);
            if (logParts.length) console.log(`[MusicBrainz] ✓ ${result.artist || artist} — ${title}`, logParts.join(' '));
          }
        } catch (_) { /* non-fatal */ }
      }
      if (anyTrackFoundMB && _libInDetail) _resortAlbumDetail(files).catch(() => {});
    }

    // ── Pass 3: ID3 blob parse — text + embedded cover ────────────────────────
    // In force mode: ID3 pre-pass already ran before MB with full overwrite rights.
    //   Pass 3 here only handles songs that failed the pre-pass (no cached blob, no cover yet).
    //   Text is fill-only — MB already had its turn and is authoritative.
    // In normal mode: MB ran first; ID3 fills remaining gaps + embedded cover.
    // displayName always comes from ID3 — it's the cleanest display title source.
    // Embedded cover = highest priority (isId3=true, protected from external overwrite).
    const needEnrichment = force
      ? files.filter(file => !_rowHasCover(file.id))   // pre-pass covered the rest
      : files.filter(file => {
          const eid = CSS.escape(file.id);
          const img = document.querySelector(`.top-list-item[data-id="${eid}"] .top-list-thumb img`)
                   || document.querySelector(`.song-row[data-id="${eid}"] .song-thumb img`);
          if (!img || img.dataset.coverSrc !== 'id3') return true;
          const artistEl = document.querySelector(`.top-list-item[data-id="${eid}"] .top-list-artist`);
          return !!(artistEl && !artistEl.textContent.trim());
        });
    if (needEnrichment.length > 0 && typeof Meta !== 'undefined') {
      const CONCURRENCY = 3;
      const queue = [...needEnrichment];
      async function id3Worker() {
        while (queue.length > 0) {
          const file = queue.shift();
          try {
            let blob = await DB.getCachedBlob(file.id);
            if (!blob) blob = await Drive.downloadFileHead(file.id);
            if (!blob) continue;
            const meta = await Meta.parse(file.id, blob);
            if (!meta) continue;

            // Fill-only: MB is authoritative (it already ran in Pass 2).
            // displayName always comes from ID3 regardless.
            const existingMeta = await DB.getMeta(file.id).catch(() => null);
            const textPatch = {};
            if (meta.title)                        textPatch.displayName = meta.title;
            if (meta.artist && !existingMeta?.artist) textPatch.artist   = meta.artist;
            if (meta.album  && !existingMeta?.album)  textPatch.album    = meta.album;
            if (meta.year   && !existingMeta?.year)   textPatch.year     = meta.year;
            if (meta.track  && !existingMeta?.track)  textPatch.track    = meta.track;
            if (Object.keys(textPatch).length > 0) {
              DB.setMeta(file.id, textPatch).catch(() => {});
              _patchMetaText(file.id, {
                title:  meta.title          || null,
                artist: textPatch.artist    || null,
                album:  textPatch.album     || null,
                year:   textPatch.year      || null,
              });
            }

            // Embedded cover — top priority (isId3=true)
            if (meta.coverUrl) {
              _updateRowThumbnail(file.id, meta.coverUrl, true);
              if (meta.coverBlob) DB.setMeta(file.id, { coverBlob: meta.coverBlob }).catch(() => {});
            }

            if (Player.getCurrentTrack()?.id === file.id) _applyMeta(file, meta);
          } catch (_) { /* non-fatal */ }
        }
      }
      await Promise.allSettled(Array.from({ length: CONCURRENCY }, () => id3Worker()));
    }

    // ── Pass 4: Cover Art Archive (MusicBrainz) ───────────────────────────────
    // For songs still without an embedded ID3 cover but with a MB release ID.
    // CAA URL: https://coverartarchive.org/release/{mbid}/front-250
    if (typeof MusicBrainz !== 'undefined') {
      const caaFiles = files.filter(file => {
        const eid = CSS.escape(file.id);
        const img = document.querySelector(`.top-list-item[data-id="${eid}"] .top-list-thumb img`)
                 || document.querySelector(`.song-row[data-id="${eid}"] .song-thumb img`);
        return !img || img.dataset.coverSrc !== 'id3'; // no embedded cover yet
      });
      if (caaFiles.length > 0) {
        await Promise.allSettled(caaFiles.map(async file => {
          try {
            const m = await DB.getMeta(file.id);
            if (!m?.mbReleaseMbid) return;
            if (_rowHasCover(file.id)) {
              // Only upgrade if not already an ID3 cover
              const eid = CSS.escape(file.id);
              const img = document.querySelector(`.top-list-item[data-id="${eid}"] .top-list-thumb img`)
                       || document.querySelector(`.song-row[data-id="${eid}"] .song-thumb img`);
              if (img?.dataset.coverSrc === 'id3') return;
            }
            const url = await MusicBrainz.fetchCoverUrl(m.mbReleaseMbid);
            if (!url) return;
            _updateRowThumbnail(file.id, url);
            DB.setMeta(file.id, { thumbnailUrl: url }).catch(() => {});
          } catch (_) {}
        }));
      }
    }

    // ── Pass 5: folder cover.jpg fallback ─────────────────────────────────────
    // Skipped for search results (folderId=null).
    const stillNeed = files.filter(file => !_rowHasCover(file.id));
    if (stillNeed.length > 0 && folderId) {
      const folderCover = await _getFolderCover(folderId);
      if (folderCover) stillNeed.forEach(file => _updateRowThumbnail(file.id, folderCover));
    }

    // ── Pass 6: Last.fm cover lookup ──────────────────────────────────────────
    // Deduped by artist+album inside Lastfm module, so one request per album.
    //
    // Runs in two modes:
    //   • Normal: only for songs without a cover in DOM (primary goal = display cover).
    //   • Force:  also for songs WITH a DOM cover (coverBlob / folder cover.jpg) that
    //             have NO thumbnailUrl in DB. Goal = persist an external URL so other
    //             devices (which don't have the local blob) can show the album thumbnail.
    if (typeof Lastfm === 'undefined') return;
    let lfmEntries; // [{ file, updateDom }]
    if (force) {
      const checks = await Promise.all(files.map(async file => {
        if (!_rowHasCover(file.id)) return { file, updateDom: true };
        const m = await DB.getMeta(file.id).catch(() => null);
        if (!m?.thumbnailUrl) return { file, updateDom: false }; // needs sync backup URL
        return null;
      }));
      lfmEntries = checks.filter(Boolean);
    } else {
      lfmEntries = files
        .filter(file => !_rowHasCover(file.id))
        .map(file => ({ file, updateDom: true }));
    }
    if (lfmEntries.length === 0) return;
    await Promise.allSettled(lfmEntries.map(async ({ file, updateDom }) => {
      try {
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(file.id) : null;
        const dbM    = await DB.getMeta(file.id);
        const artist = inMem?.artist || dbM?.artist || '';
        const album  = inMem?.album  || dbM?.album  || '';
        if (!artist || !album) return;
        const url = await Lastfm.fetchCover(artist, album);
        if (!url) return;
        if (updateDom) _updateRowThumbnail(file.id, url);
        DB.setMeta(file.id, { thumbnailUrl: url }).catch(() => {});
      } catch (_) { /* non-fatal */ }
    }));

    // ── Pass 7: AudD.io audio fingerprinting ──────────────────────────────────
    // Last resort: identifies songs with no metadata at all from their audio content.
    // Limited per folder open to conserve daily quota (CONFIG.AUDD_MAX_PER_FOLDER).
    if (typeof Audd === 'undefined') return;
    const auddCandidates = files.filter(file => !_rowHasCover(file.id));
    if (auddCandidates.length === 0) return;
    const auddLimit = Math.min(auddCandidates.length, CONFIG.AUDD_MAX_PER_FOLDER || 5);
    for (let i = 0; i < auddLimit; i++) {
      const file = auddCandidates[i];
      try {
        const dbMeta = await DB.getMeta(file.id);
        if (dbMeta?.auddTried) continue;
        const blob = await Drive.downloadFileHead(file.id, 1024 * 1024);
        if (!blob) continue;
        let result = null;
        try { result = await Audd.identify(blob); }
        catch (_) { continue; } // network error — allow retry next session
        await DB.setMeta(file.id, { auddTried: true });
        if (!result) continue;
        if (result.coverUrl) _updateRowThumbnail(file.id, result.coverUrl);
        const update = { auddTried: true };
        if (result.title)    update.displayName  = result.title;
        if (result.artist)   update.artist       = result.artist;
        if (result.album)    update.album        = result.album;
        if (result.coverUrl) update.thumbnailUrl = result.coverUrl;
        DB.setMeta(file.id, update).catch(() => {});
        console.log(`[Audd] ✓ ${result.artist} — ${result.title}`);
      } catch (_) { /* non-fatal */ }
    }

    // Persist any newly enriched metadata to Drive for cross-device sync
    if (typeof Sync !== 'undefined') Sync.push('metadata');
  }

  /**
   * After a rescan, update the album detail header: title, subtitle, and cover art.
   * Reads fresh meta from DB, finds majority year + album name, picks best cover.
   */
  async function _patchAlbumDetailHeader(songs) {
    const container = document.getElementById('lib-detail-content');
    if (!container) return;
    const nameEl = container.querySelector('.lib-detail-entity-name');
    const subEl  = container.querySelector('.lib-detail-entity-sub');
    const artEl  = container.querySelector('.lib-detail-entity-art');
    if (!nameEl) return;

    // Re-read meta for all songs and tally year + album
    const metas = await Promise.all(songs.map(s => DB.getMeta(s.id).catch(() => null)));
    const yearCounts  = new Map();
    const albumCounts = new Map();
    let artist   = null;
    let coverUrl = null;  // best cover found: ID3 blob > thumbnailUrl

    for (const m of metas) {
      if (!m) continue;
      if (m.year)  yearCounts.set(m.year,  (yearCounts.get(m.year)  || 0) + 1);
      if (m.album) albumCounts.set(m.album, (albumCounts.get(m.album) || 0) + 1);
      if (!artist && m.artist) artist = m.artist;

      // Prefer ID3-embedded blob cover (already resolved to an object URL by Meta)
      if (!coverUrl && typeof Meta !== 'undefined') {
        const cached = Meta.getCached(m.id);
        if (cached?.coverUrl) { coverUrl = cached.coverUrl; continue; }
        if (m.coverBlob) {
          const url = Meta.injectCover(m.id, m.coverBlob);
          if (url) { coverUrl = url; continue; }
        }
      }
      // Fall back to external thumbnail
      if (!coverUrl && m.thumbnailUrl) coverUrl = m.thumbnailUrl;
    }

    const topYear  = [...yearCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topAlbum = [...albumCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    if (!topAlbum) return; // nothing to patch

    // Update or create the year element (above the title)
    let yearEl = container.querySelector('.lib-detail-entity-year');
    if (topYear) {
      if (!yearEl) {
        yearEl = document.createElement('div');
        yearEl.className = 'lib-detail-entity-year';
        nameEl.parentNode.insertBefore(yearEl, nameEl);
      }
      yearEl.textContent = `(${topYear})`;
    } else if (yearEl) {
      yearEl.remove();
    }

    // Album name — clean, no year prefix
    nameEl.textContent = topAlbum;

    // Subtitle: artist · N canciones
    if (subEl) {
      subEl.textContent = [artist, songs.length + ' canciones'].filter(Boolean).join(' · ');
    }

    // Update cover art in the entity header
    if (artEl && coverUrl) {
      // Only replace if there's no img yet, or the existing one is from a different source
      const existing = artEl.querySelector('img');
      if (!existing || existing.src !== coverUrl) {
        artEl.innerHTML = `<img src="${coverUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)">`;
      }
    }
  }

  /**
   * Force a full re-enrichment of an album's songs, ignoring the mbTried flag.
   * Called from the Rescan button in the album detail view.
   * @param {Object[]} songs   — song objects currently rendered
   * @param {string}   folderId
   */
  async function onAlbumRescan(songs, folderId) {
    if (!songs || songs.length === 0) return;
    UI.showToast('Rescaneando álbum…');

    // ── Purge orphans: remove DB records for files no longer in Drive ──
    // songs[] is the fresh Drive listing for this folder.
    if (folderId) {
      const liveIds = songs.map(s => s.id);
      const pruned  = await DB.purgeOrphans(folderId, liveIds).catch(() => 0);
      if (pruned > 0) console.log(`[App] Purged ${pruned} orphan(s) from folder ${folderId}`);
    }

    // Full reset: clear all enrichment fields so MB re-runs on clean data.
    // coverBlob (embedded ID3 art) and user data (starred, playCount) are preserved.
    await Promise.all(songs.map(async s => {
      await DB.clearEnrichment(s.id).catch(() => {});
      if (typeof Meta !== 'undefined') Meta.revoke(s.id); // clear in-memory ID3 cache
    }));
    // Clear folder cover cache so cover.jpg is re-fetched
    if (folderId) _folderCoverCache.delete(folderId);
    await _prefetchAndApplyFolderCovers(folderId, songs, true); // force=true
    await _patchAlbumDetailHeader(songs);
    if (typeof Sync !== 'undefined') {
      // Hot push: immediate small delta (~5–50 songs, ~5 KB) so Device B sees changes within 3 s
      Sync.pushHot(songs).catch(() => {});
      // Full metadata push: background, for initial-setup on new devices (debounced 2 s)
      Sync.push('metadata');
    }
    // Run Last.fm thumb pass for this album in case the pipeline didn't produce a URL.
    // Runs in background — does not block the UI toast.
    _lfmThumbLibrary().catch(() => {});
    UI.showToast('Rescan completado');
  }

  /**
   * Force a full re-enrichment of the currently open browse folder.
   * Called from the Rescan button in the browse action bar.
   */
  async function onBrowseRescan() {
    if (!_browseFiles.length) return;
    const btn  = document.getElementById('btn-browse-rescan');
    const icon = document.getElementById('browse-rescan-icon');
    if (btn)  btn.disabled = true;
    if (icon) icon.style.animation = 'spin 1s linear infinite';
    try {
      UI.showToast('Rescaneando carpeta…');

      // ── Purge orphans: remove DB records for files no longer in Drive ──
      // _browseFiles is always refreshed from Drive before this point,
      // so it represents the current live listing of the folder.
      if (_browseFolderId) {
        const liveIds = _browseFiles.map(f => f.id);
        const pruned  = await DB.purgeOrphans(_browseFolderId, liveIds).catch(() => 0);
        if (pruned > 0) {
          console.log(`[App] Purged ${pruned} orphan(s) from folder ${_browseFolderId}`);
          // Immediately refresh Albums/Artists so removed songs vanish from the grid
          if (!_libInDetail) {
            if (_currentLibTab === 'albums')  _loadAlbums();
            if (_currentLibTab === 'artists') _loadArtists();
          }
        }
      }

      // Full reset: clear all enrichment fields so MB re-runs on clean data.
      await Promise.all(_browseFiles.map(async f => {
        await DB.clearEnrichment(f.id).catch(() => {});
        if (typeof Meta !== 'undefined') Meta.revoke(f.id);
      }));
      if (_browseFolderId) _folderCoverCache.delete(_browseFolderId);
      await _prefetchAndApplyFolderCovers(_browseFolderId, _browseFiles, true); // force=true
      if (typeof Sync !== 'undefined') {
        // Hot push: immediate small delta so Device B sees changes within 3 s
        Sync.pushHot(_browseFiles).catch(() => {});
        // Full metadata push: background, for initial-setup on new devices (debounced 2 s)
        Sync.push('metadata');
      }
      _lfmThumbLibrary().catch(() => {});
      UI.showToast('Rescan completado');
      // Refresh Albums/Artists grid so the newly enriched folder appears there
      if (!_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
      }
    } finally {
      if (btn)  btn.disabled = false;
      if (icon) icon.style.animation = '';
    }
  }

  /**
   * After MusicBrainz fills in track numbers, re-sort the currently rendered
   * album detail list without wiping covers or text already in the DOM.
   * Simply rebuilds the <ul> order in place.
   */
  async function _resortAlbumDetail(files) {
    const container = document.querySelector('#lib-detail-content .top-list');
    if (!container) return;

    // Re-fetch track numbers for all files
    const items = await Promise.all(files.map(async f => {
      const m = await DB.getMeta(f.id).catch(() => null);
      return { id: f.id, track: m?.track || '', el: container.querySelector(`.top-list-item[data-id="${CSS.escape(f.id)}"]`) };
    }));

    // Sort by track number, items without a track go to the end (by current DOM order)
    items.sort((a, b) => {
      const ta = parseInt(a.track, 10);
      const tb = parseInt(b.track, 10);
      if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
      if (!isNaN(ta)) return -1;
      if (!isNaN(tb)) return  1;
      return 0;  // preserve relative order for untracked items
    });

    // Re-append in new order (moves existing DOM nodes, no flicker)
    items.forEach(({ el }) => { if (el) container.appendChild(el); });
  }

  /**
   * Returns true if the song row already has a cover image set.
   * Checks both browse rows (.song-row) and library detail rows (.top-list-item).
   * @param {string} fileId
   */
  function _rowHasCover(fileId) {
    const eid = CSS.escape(fileId);
    const _validImg = img => img && img.src
      && !img.src.endsWith(window.location.href)
      && img.style.display !== 'none'; // onerror hides broken imgs
    // Browse view
    const browseRow = document.querySelector(`.song-row[data-id="${eid}"]`);
    if (_validImg(browseRow?.querySelector('.song-thumb img'))) return true;
    // Library detail (top-list)
    const listRow = document.querySelector(`.top-list-item[data-id="${eid}"]`);
    if (_validImg(listRow?.querySelector('.top-list-thumb img'))) return true;
    return false;
  }

  /**
   * Apply parsed metadata to all relevant UI surfaces.
   * @param {DriveItem} item
   * @param {Object}    meta  — { title, artist, album, year, track, coverUrl }
   */
  function _applyMeta(item, meta) {
    if (!meta) return;

    // Build enriched display name from ID3 tags if available
    const title  = meta.title  || item.displayName;
    const artist = meta.artist || '';

    // Only update if this is still the current track
    const currentTrack = Player.getCurrentTrack();
    if (currentTrack?.id !== item.id) return;

    // Update mini-player and expanded player with cover art + richer names
    // ui.js reads thumbnailUrl, artist, albumName, year — map ID3 fields accordingly
    // By the time _applyMeta runs the audio element has the real duration —
    // use it as fallback when Drive API didn't return videoMediaMetadata.durationMillis.
    const audioDur    = Player.getDuration(); // seconds, finite once blob is loaded
    const audioDurMs  = (isFinite(audioDur) && audioDur > 0) ? Math.round(audioDur * 1000) : 0;
    const enriched = {
      ...item,
      displayName:   title,
      artist:        artist,
      albumName:     meta.album        || item.albumName    || '',
      year:          meta.year         || item.year         || '',
      thumbnailUrl:  meta.coverUrl     || item.thumbnailUrl,
      bitrate:       meta.bitrate      ?? item.bitrate      ?? null,
      sampleRate:    meta.sampleRate   ?? item.sampleRate   ?? null,
      bitsPerSample: meta.bitsPerSample ?? item.bitsPerSample ?? null,
      // Prefer real audio-element duration; fall back to Drive API field
      durationMs:    audioDurMs || item.durationMs || 0,
    };
    UI.updateMiniPlayer(enriched, Player.isPlaying());
    UI.updateExpandedPlayer(enriched, Player.isPlaying());

    // Update all visible thumbnail surfaces with the resolved cover (ID3 = protected)
    if (meta.coverUrl) {
      _updateRowThumbnail(item.id, meta.coverUrl, true);
      _updateHomeCardThumbnail(item.id, meta.coverUrl);
      _updateTopListThumb(item.id, meta.coverUrl, true);
      // Queue panel: patch the row for this song (needed when AudD resolves
      // after the panel was already open, since _prefetchQueueCovers ran before
      // the cover was available)
      _updateQueueItemCover(item.id, meta.coverUrl);
    }

    // Patch title/artist text in all visible surfaces (queue, home, top-played, browse).
    // Runs regardless of whether a cover was found — enriched text matters too.
    _patchMetaText(item.id, {
      title:  meta.title  || null,
      artist: meta.artist || null,
      album:  meta.album  || null,
      year:   meta.year   || null,
    });
  }

  /**
   * Swap the thumbnail in a visible song row with the cover art URL.
   * Handles both browse rows (.song-row / .song-thumb) and library
   * detail rows (.top-list-item / .top-list-thumb).
   *
   * @param {string}  fileId
   * @param {string}  coverUrl — URL (blob: from ID3, or https: from Drive/Last.fm)
   * @param {boolean} [isId3=false] — true when the cover is embedded in the audio file.
   *   ID3 covers always replace whatever is currently shown (they are the highest-quality
   *   source).  External covers (thumbnailLink, Last.fm, folder.jpg) only fill empty
   *   slots and never overwrite a previously set ID3 cover.
   */
  function _updateRowThumbnail(fileId, coverUrl, isId3 = false) {
    const eid    = CSS.escape(fileId);
    const srcTag = isId3 ? ' data-cover-src="id3"' : '';
    const IMG    = `<img src="${coverUrl}"${srcTag} alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.parentNode.innerHTML='<div class=\\'thumb-placeholder\\'></div>'">`;

    function _applyToThumb(thumb) {
      if (!thumb) return;
      const img = thumb.querySelector('img');
      if (!isId3 && img) {
        if (img.dataset.coverSrc === 'id3') return; // ID3 is always protected
        img.src = coverUrl; // external can replace other external (e.g. CAA over expired Drive URL)
        return;
      }
      if (isId3 && img?.dataset.coverSrc === 'id3') return; // already ID3 — keep it
      thumb.innerHTML = IMG;
    }

    // Browse view (.song-row → .song-thumb)
    const browseRow = document.querySelector(`.song-row[data-id="${eid}"]`);
    if (browseRow) _applyToThumb(browseRow.querySelector('.song-thumb'));

    // Library detail view (.top-list-item → .top-list-thumb)
    const listRow = document.querySelector(`.top-list-item[data-id="${eid}"]`);
    if (listRow) _applyToThumb(listRow.querySelector('.top-list-thumb'));
  }

  /**
   * Update a home card's thumbnail image (song cover art).
   * @param {string} fileId
   * @param {string} coverUrl
   */
  function _updateHomeCardThumbnail(fileId, coverUrl) {
    const card = document.querySelector(`#screen-home .home-card[data-id="${CSS.escape(fileId)}"]`);
    if (!card) return;
    const art = card.querySelector('.home-card-art');
    if (!art) return;
    let img = art.querySelector('img');
    if (img) {
      img.src = coverUrl;
    } else {
      art.innerHTML = `<img src="${coverUrl}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">`;
    }
  }

  /**
   * Background cover prefetch for Home song cards.
   * Pass 1: Meta in-memory cache (instant).
   * Pass 2: IndexedDB cached blobs → parse ID3 (async, non-blocking).
   * @param {Object[]} items — recents array from DB
   */
  async function _prefetchHomeCovers(items) {
    const songs = items.filter(r => r.type === 'song');
    if (!songs.length || typeof Meta === 'undefined') return;

    // Pass 0: persisted covers from IndexedDB — blob first, then external URL (Last.fm / AudD.io)
    await Promise.allSettled(songs.map(async song => {
      try {
        const dbMeta = await DB.getMeta(song.id);
        if (!dbMeta) return;
        if (dbMeta.coverBlob) {
          const url = Meta.injectCover(song.id, dbMeta.coverBlob);
          if (url) { _updateHomeCardThumbnail(song.id, url); return; }
        }
        // External URL persisted from Last.fm / AudD.io in a previous session
        const persistedUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
        if (persistedUrl && !persistedUrl.startsWith('blob:')) {
          _updateHomeCardThumbnail(song.id, persistedUrl);
        }
      } catch (_) {}
    }));

    const stillNeed = [];

    // Pass 1: in-memory Meta cache
    songs.forEach(song => {
      const meta = Meta.getCached(song.id);
      if (meta?.coverUrl) {
        _updateHomeCardThumbnail(song.id, meta.coverUrl);
      } else {
        stillNeed.push(song);
      }
    });

    if (!stillNeed.length) return;

    // Pass 2: IndexedDB blobs → parse ID3 (2 parallel workers)
    const queue = [...stillNeed];
    async function worker() {
      while (queue.length > 0) {
        const song = queue.shift();
        try {
          const blob = await DB.getCachedBlob(song.id);
          if (!blob) continue;
          const meta = await Meta.parse(song.id, blob);
          if (meta?.coverUrl) {
            _updateHomeCardThumbnail(song.id, meta.coverUrl);
            if (meta.coverBlob) DB.setMeta(song.id, { coverBlob: meta.coverBlob }).catch(() => {});
          }
        } catch (_) { /* non-fatal */ }
      }
    }
    await Promise.allSettled([worker(), worker()]);

    // Pass 3: Drive API fallback — for songs still without cover after local passes
    // (e.g. synced from another device: no local blob, no stored coverBlob)
    await _driveThumbFallback(songs, _homeCardHasCover, _updateHomeCardThumbnail);
  }

  /**
   * Background cover prefetch for Top Played list items.
   * Reads cached blobs → parses ID3 → updates .top-list-item thumbnails.
   * @param {Object[]} items — topPlayed array
   */
  async function _prefetchTopPlayedCovers(items) {
    if (!items || !items.length || typeof Meta === 'undefined') return;

    // Pass 0: persisted covers from IndexedDB — blob first, then external URL (Last.fm / AudD.io)
    await Promise.allSettled(items.map(async item => {
      try {
        const dbMeta = await DB.getMeta(item.id);
        if (!dbMeta) return;
        if (dbMeta.coverBlob) {
          const url = Meta.injectCover(item.id, dbMeta.coverBlob);
          if (url) { _updateTopListThumb(item.id, url, true); return; }  // ID3 embedded
        }
        // External URL persisted from Last.fm / AudD.io in a previous session
        const persistedUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
        if (persistedUrl && !persistedUrl.startsWith('blob:')) {
          _updateTopListThumb(item.id, persistedUrl);
        }
      } catch (_) {}
    }));

    // Pass 1: in-memory Meta cache (always ID3)
    items.forEach(item => {
      const meta = Meta.getCached(item.id);
      if (meta?.coverUrl) _updateTopListThumb(item.id, meta.coverUrl, true);
    });

    // Pass 2: IndexedDB cached blobs → parse ID3 (2 workers)
    const stillNeed = items.filter(item => !_topListHasCover(item.id));
    if (!stillNeed.length) return;

    const queue = [...stillNeed];
    async function worker() {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          const blob = await DB.getCachedBlob(item.id);
          if (!blob) continue;
          const meta = await Meta.parse(item.id, blob);
          if (meta?.coverUrl) {
            _updateTopListThumb(item.id, meta.coverUrl, true);  // ID3 embedded
            if (meta.coverBlob) DB.setMeta(item.id, { coverBlob: meta.coverBlob }).catch(() => {});
          }
        } catch (_) { /* non-fatal */ }
      }
    }
    await Promise.allSettled([worker(), worker()]);

    // Pass 3: Drive API fallback — songs synced from another device with no local blob
    await _driveThumbFallback(items, _topListHasCover, _updateTopListThumb);
  }

  function _topListHasCover(fileId) {
    const el = document.querySelector(`.top-list-item[data-id="${CSS.escape(fileId)}"]`);
    return !!(el && el.querySelector('.top-list-thumb img'));
  }

  function _updateTopListThumb(fileId, coverUrl, isId3 = false) {
    const el = document.querySelector(`.top-list-item[data-id="${CSS.escape(fileId)}"]`);
    if (!el) return;
    const thumb = el.querySelector('.top-list-thumb');
    if (!thumb) return;
    const img = thumb.querySelector('img');
    if (!isId3 && img) {
      if (img.dataset.coverSrc === 'id3') return;  // ID3 cover protected
      img.src = coverUrl; // external replaces external
    } else if (isId3 && img?.dataset.coverSrc === 'id3') {
      return;  // already ID3, don't overwrite
    } else {
      const srcTag = isId3 ? ' data-cover-src="id3"' : '';
      thumb.innerHTML = `<img src="${coverUrl}"${srcTag} alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">`;
    }
  }

  /* ── DOM helpers for song rows (Favorites / Playlist detail) ── */

  /** Returns true if the .song-row for this id already shows a cover <img>. */
  function _songRowHasCover(fileId) {
    const row = document.querySelector(`.song-row[data-id="${CSS.escape(fileId)}"]`);
    return !!(row && row.querySelector('.song-thumb img'));
  }

  /** Inject (or replace) a cover image inside the .song-thumb of a .song-row. */
  function _updateSongRowThumb(fileId, url, isId3 = false) {
    const row = document.querySelector(`.song-row[data-id="${CSS.escape(fileId)}"]`);
    if (!row) return;
    const thumb = row.querySelector('.song-thumb');
    if (!thumb) return;
    const img = thumb.querySelector('img');
    if (!isId3 && img) {
      if (img.dataset.coverSrc === 'id3') return;  // ID3 cover protected
      img.src = url;
    } else if (isId3 && img?.dataset.coverSrc === 'id3') {
      return;  // already ID3, don't overwrite
    } else {
      // Remove placeholder icon if present
      const ph = thumb.querySelector('.thumb-placeholder');
      if (ph) ph.remove();
      const newImg = document.createElement('img');
      newImg.src = url;
      newImg.alt = '';
      newImg.setAttribute('loading', 'lazy');
      if (isId3) newImg.dataset.coverSrc = 'id3';
      thumb.insertBefore(newImg, thumb.firstChild);
    }
  }

  /** Returns true if the home-card for this id already shows a cover <img>. */
  function _homeCardHasCover(fileId) {
    const card = document.querySelector(`#screen-home .home-card[data-id="${CSS.escape(fileId)}"]`);
    return !!(card && card.querySelector('.home-card-art img'));
  }

  /**
   * Pass 3 — Drive API thumbnail fallback.
   * For every item still without a rendered cover, calls Drive.getFileInfo to get
   * the thumbnailLink that Google extracts from the file (e.g. embedded ID3 art).
   * Runs at most 3 concurrent Drive calls. Persists found URLs to DB so future
   * sessions skip the API call entirely.
   *
   * @param {Object[]} items      — items to check (must have .id)
   * @param {function} hasCoverFn — (id) → bool: true if cover already rendered
   * @param {function} updateFn   — (id, url) → void: injects cover into DOM
   */
  /**
   * Drive cover fallback — for items without a locally-resolved cover art.
   * Used by recents, top-played, pinned, favorites and playlist detail.
   *
   * Pipeline per item (same as what Browse / playlist sidebar do):
   *   1. Download first 1 MB of the audio file (Drive.downloadFileHead) →
   *      parse ID3 tags (Meta.parse) → extract embedded album art.
   *      Result is persisted as coverBlob so future sessions are instant.
   *   2. If the ID3 parse yields nothing, fall back to Drive file metadata
   *      thumbnailLink (rarely set for audio, but free to check).
   *
   * Runs 2 workers in parallel (partial downloads are heavier than API calls).
   *
   * @param {Object[]} items      — items to check (must have .id)
   * @param {function} hasCoverFn — (id) → bool: true if cover already rendered
   * @param {function} updateFn   — (id, url) → void: injects cover into DOM
   */
  async function _driveThumbFallback(items, hasCoverFn, updateFn) {
    if (!Auth.isAuthenticated() || !items.length) return;
    if (typeof Drive === 'undefined') return;

    const need = items.filter(item => !hasCoverFn(item.id));
    if (!need.length) return;

    const queue = [...need];
    async function worker() {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          // ── Pass A: download ID3 header → parse embedded cover art ──────
          if (typeof Meta !== 'undefined') {
            const headBlob = await Drive.downloadFileHead(item.id).catch(() => null);
            if (headBlob) {
              const meta = await Meta.parse(item.id, headBlob).catch(() => null);
              if (meta?.coverUrl) {
                updateFn(item.id, meta.coverUrl);
                // Persist coverBlob so future sessions skip this download
                if (meta.coverBlob) {
                  DB.setMeta(item.id, { coverBlob: meta.coverBlob }).catch(() => {});
                }
                continue; // got cover — skip Pass B
              }
            }
          }
          // ── Pass B: Drive file metadata thumbnailLink (rarely set for audio) ──
          const info = await Drive.getFileInfo(item.id).catch(() => null);
          const url  = info?.thumbnailUrl || null;
          if (url) {
            updateFn(item.id, url);
            DB.setMeta(item.id, { thumbnailUrl: url }).catch(() => {});
          }
        } catch (_) { /* non-fatal */ }
      }
    }
    // 2 parallel workers — partial downloads are heavier than metadata calls
    await Promise.allSettled([worker(), worker()]);
  }

  /**
   * Update the name label on a Home song card (recents row).
   * @param {string} fileId
   * @param {string} displayName
   */
  function _updateHomeCardName(fileId, displayName) {
    const card = document.querySelector(`#screen-home .home-card[data-id="${CSS.escape(fileId)}"]`);
    if (!card) return;
    const nameEl = card.querySelector('.home-card-name');
    if (nameEl && displayName) nameEl.textContent = displayName;
  }

  /**
   * Update the title label on a Top-Played list item.
   * @param {string} fileId
   * @param {string} displayName
   */
  function _updateTopListName(fileId, displayName) {
    const el = document.querySelector(`.top-list-item[data-id="${CSS.escape(fileId)}"]`);
    if (!el) return;
    const titleEl = el.querySelector('.top-list-title');
    if (titleEl && displayName) titleEl.textContent = displayName;
  }

  /**
   * For any items in enrichedRecents / topPlayed that still have no displayName,
   * fetch the filename from Drive API and backfill the DB + DOM.
   * Non-fatal — silently ignored if offline or auth-expired.
   * @param {Object[]} enrichedRecents
   * @param {Object[]} topPlayed
   */
  async function _fixMissingNames(enrichedRecents, topPlayed) {
    if (!Auth.isAuthenticated()) return;

    // Collect all song items across both lists, de-duplicate by id
    const allItems = [
      ...enrichedRecents.filter(r => r.type === 'song'),
      ...topPlayed,
    ];
    const noName = [];
    const seen   = new Set();
    for (const item of allItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (!item.displayName || !item.displayName.trim()) {
        noName.push(item);
      }
    }

    if (!noName.length) return;

    for (const item of noName) {
      try {
        const info = await Drive.getFileInfo(item.id);
        if (!info?.name) continue;

        // Build clean display name (strip extension + separators)
        const dispName = info.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
                      || info.name;

        // Persist to DB so future renders have the name
        DB.setMeta(item.id, {
          name:        info.name,
          displayName: dispName,
        }).catch(() => {});

        DB.addRecent({
          ...item,
          name:        info.name,
          displayName: dispName,
        }).catch(() => {});

        // Update visible DOM cards immediately (no full re-render needed)
        _updateHomeCardName(item.id, dispName);
        _updateTopListName(item.id, dispName);
      } catch (_) {
        // Non-fatal: Drive API unavailable, auth expired, etc.
      }
    }
  }

  /* ── Home ────────────────────────────────────────────────── */

  async function _loadHomeData() {
    try {
      const [pinned, recents, topPlayedRaw, rawPlaylists] = await Promise.all([
        DB.getPinnedFolders(),
        DB.getRecents(20),
        DB.getTopPlayed(20),
        DB.getPlaylists(),
      ]);

      // Load metadata store records for all song recents (for name/cover backfill)
      const metaRecords = await Promise.all(
        recents.filter(r => r.type === 'song').map(r => DB.getMeta(r.id).catch(() => null))
      );
      const metaMap = new Map();
      recents.filter(r => r.type === 'song').forEach((r, i) => {
        if (metaRecords[i]) metaMap.set(r.id, metaRecords[i]);
      });

      // Enrich pinned songs with artist, displayName, thumbnailUrl from metadata store
      // (togglePin only saves id/name/displayName/type/thumbnailUrl — no artist)
      const pinnedSongs = pinned.filter(p => p.type !== 'folder' && !p.isFolder);
      const pinnedMetaRecords = await Promise.all(
        pinnedSongs.map(p => DB.getMeta(p.id).catch(() => null))
      );
      const pinnedMetaMap = new Map();
      pinnedSongs.forEach((p, i) => { if (pinnedMetaRecords[i]) pinnedMetaMap.set(p.id, pinnedMetaRecords[i]); });

      const _pick = (...vals) => vals.find(v => v && String(v).trim() !== '') || '';

      const enrichedPinned = pinned.map(p => {
        if (p.type === 'folder' || p.isFolder) return p;
        const dbMeta = pinnedMetaMap.get(p.id);
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(p.id) : null;
        return {
          ...p,
          displayName:  _pick(inMem?.title,   p.displayName,  dbMeta?.displayName, p.name, dbMeta?.name),
          artist:       _pick(inMem?.artist,  p.artist,       dbMeta?.artist),
          thumbnailUrl: _pick(inMem?.coverUrl, p.thumbnailUrl, dbMeta?.thumbnailUrl, dbMeta?.coverUrl),
        };
      });

      // Enrich recents songs with metadata store data (fixes bare/empty-name records)
      const enrichedRecents = recents.map(r => {
        if (r.type !== 'song') return r;
        const dbMeta = metaMap.get(r.id);
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(r.id) : null;
        return {
          ...r,
          displayName:  _pick(inMem?.title, r.displayName, dbMeta?.displayName, r.name, dbMeta?.name),
          name:         _pick(r.name, dbMeta?.name),
          thumbnailUrl: _pick(inMem?.coverUrl, r.thumbnailUrl, dbMeta?.thumbnailUrl, dbMeta?.coverUrl),
          artist:       _pick(inMem?.artist,   r.artist,      dbMeta?.artist),
        };
      });

      // Enrich topPlayed with recents + metadata store + in-memory Meta cache
      const recentMap = new Map(enrichedRecents.map(r => [r.id, r]));
      const topPlayed = topPlayedRaw.map(item => {
        const r     = recentMap.get(item.id);
        const dbMeta = metaMap.get(item.id);
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
        return {
          ...item,
          displayName:  _pick(inMem?.title,   item.displayName, r?.displayName, dbMeta?.displayName, r?.name, item.name, dbMeta?.name),
          name:         _pick(item.name,       r?.name,          dbMeta?.name),
          thumbnailUrl: _pick(inMem?.coverUrl, item.thumbnailUrl, item.coverUrl, r?.thumbnailUrl, dbMeta?.thumbnailUrl, dbMeta?.coverUrl),
          artist:       _pick(inMem?.artist,   item.artist,      r?.artist,      dbMeta?.artist),
          albumName:    _pick(inMem?.album,    item.albumName,   item.album,     r?.albumName,    dbMeta?.album),
          year:         _pick(inMem?.year,     item.year,        r?.year,        dbMeta?.year),
        };
      });

      // Resolve covers for recent playlists (first 4 unique non-Google cover URLs per playlist)
      const enrichedPlaylists = await Promise.all(
        rawPlaylists.slice(0, 12).map(async pl => {
          const covers = [];
          const songIds = pl.songIds || [];
          for (const sid of songIds.slice(0, 16)) {
            if (covers.length >= 4) break;
            // Check in-memory Meta cache first (fastest, includes blob URLs)
            const inMem = (typeof Meta !== 'undefined') ? Meta.getCached(sid) : null;
            let url = inMem?.coverUrl || null;
            // Fall back to DB metadata for external URLs
            if (!url) {
              try {
                const dbM = await DB.getMeta(sid);
                url = dbM?.thumbnailUrl || dbM?.coverUrl || null;
              } catch (_) {}
            }
            // Skip Google Drive thumbnail URLs (require auth header, won't load in <img>)
            if (url && !url.includes('googleusercontent.com') && !url.includes('googleapis.com')) {
              covers.push(url);
            }
          }
          return { ...pl, resolvedCovers: covers };
        })
      );

      UI.renderHome({ pinned: enrichedPinned, recents: enrichedRecents, topPlayed, playlists: enrichedPlaylists });

      // Async: load cover art for song cards and top-played in the background
      _prefetchHomeCovers(enrichedRecents).catch(() => {});
      _prefetchTopPlayedCovers(topPlayed).catch(() => {});
      _prefetchPinnedCovers(enrichedPinned).catch(() => {});

      // Async: fix any items still with no name by fetching from Drive API
      _fixMissingNames(enrichedRecents, topPlayed).catch(() => {});
    } catch (err) {
      console.error('[App] Home data error:', err);
    }
  }

  function onHomeCardClick(item) {
    if (item.isFolder || item.type === 'folder') {
      _breadcrumb = []; // fresh context — don't inherit stale browse history
      _resetRadio();
      _openFolder({ id: item.id, name: item.name });
    } else {
      // Single song from Home → enable radio mode
      _resetRadio();
      _radioModeActive = true;
      _radioQueuedIds  = new Set([item.id]);
      _radioArtist = _guessArtistFromItem(item) || null;
      Player.setQueue([item], 0);
    }
  }

  /** Play all songs in a playlist immediately (called from playlist detail header button). */
  function onPlaylistDetailPlay(songs) {
    if (!songs || songs.length === 0) return;
    _resetRadio();
    Player.setQueue(songs, 0);
  }

  /** Open Library view and navigate directly to the tapped playlist. */
  function onPlaylistHomeCardClick(pl) {
    UI.showView('library');
    _setLibTab('playlists');
    // Small delay so Library renders before we open the detail
    setTimeout(() => onPlaylistClick(pl), 80);
  }

  /* ── Browse ──────────────────────────────────────────────── */

  /**
   * Builds the full breadcrumb trail from root down to the given folder.
   * Walks up Drive hierarchy via getFileInfo(parents[0]) until hitting root.
   * Returns [{id, name}, ...] from root to folder (inclusive).
   */
  async function _buildBreadcrumbForFolder(folderId) {
    const chain = [];
    let currentId = folderId;
    const visited = new Set();

    while (currentId && currentId !== 'root' && currentId !== _rootFolderId && !visited.has(currentId)) {
      visited.add(currentId);
      try {
        const info = await Drive.getFileInfo(currentId);
        if (!info) break;
        chain.unshift({ id: info.id, name: info.name });
        const parentId = info.parents?.[0];
        if (!parentId || parentId === 'root' || parentId === _rootFolderId) break;
        currentId = parentId;
      } catch (err) {
        console.warn('[App] breadcrumb walk error at', currentId, err);
        break;
      }
    }

    // Always prepend root (MSK) so breadcrumb starts from the top
    if (chain.length > 0) {
      chain.unshift({ id: _rootFolderId, name: CONFIG.ROOT_FOLDER_NAME });
    }

    return chain;
  }

  async function _openFolder(folder, appendToBreadcrumb = true) {
    UI.showView('browse');

    // Detect "fresh navigation" — breadcrumb was reset before this call
    const freshNavigation = _breadcrumb.length === 0 && appendToBreadcrumb;

    if (appendToBreadcrumb) {
      // Check if folder is already in breadcrumb (going back via breadcrumb chips)
      const existingIdx = _breadcrumb.findIndex(b => b.id === folder.id);
      if (existingIdx >= 0) {
        _breadcrumb = _breadcrumb.slice(0, existingIdx + 1);
      } else {
        _breadcrumb.push({ id: folder.id, name: folder.name });
      }
    }

    UI.renderBreadcrumb(_breadcrumb);
    UI.showLoading('screen-browse');

    // If fresh navigation (from Recents/Home), resolve full path in parallel
    if (freshNavigation) {
      _buildBreadcrumbForFolder(folder.id).then(fullPath => {
        if (fullPath.length > 0) {
          // Only update if breadcrumb still points to the same folder
          const last = _breadcrumb[_breadcrumb.length - 1];
          if (last?.id === folder.id) {
            _breadcrumb = fullPath;
            UI.renderBreadcrumb(_breadcrumb);
          }
        }
      }).catch(() => {});
    }

    try {
      const result = await Drive.listFolderAll(folder.id);
      _sortItems(result.folders, result.files);
      const activeSong = Player.getCurrentTrack();
      UI.renderFolderContents(result.folders, result.files, activeSong?.id);

      // Update item count badge
      const total = result.folders.length + result.files.length;
      const countEl = document.getElementById('browse-item-count');
      if (countEl) countEl.textContent = total > 0 ? `${total} elemento${total !== 1 ? 's' : ''}` : '';

      // Track current browse folder for rescan
      _browseFolderId = folder.id;
      _browseFiles    = result.files;

      // Cache all items for queue resolution
      result.files.forEach(f => _cacheItem(f));

      // Prefetch folder cover art and apply to all song rows (fire-and-forget)
      _prefetchAndApplyFolderCovers(folder.id, result.files);

      // Add to recents
      DB.addRecent({
        id:   folder.id,
        name: folder.name,
        displayName: folder.name,
        type: 'folder',
      }).then(() => Sync.push('recents')).catch(() => {});

    } catch (err) {
      if (err.name === 'AuthError') {
        UI.showToast(UI.t('toast_session_expired'), 'error');
        UI.showTokenBanner();
      } else {
        UI.showToast(UI.t('toast_folder_error'), 'error');
        console.error('[App] Folder load error:', err);
      }
    }
  }

  function onFolderClick(folder) {
    // If navigating from outside Browse (e.g. Search), reset breadcrumb context
    if (UI.getCurrentView() !== 'browse') _breadcrumb = [];
    _openFolder(folder);
  }

  /**
   * "Ir al álbum" — navigate Browse to the folder that contains a song,
   * or to the folder itself if the item IS a folder.
   * @param {DriveItem} item
   */
  async function onGoToFolder(item) {
    if (item.isFolder || item.type === 'folder') {
      // The item is already a folder — open it directly
      _breadcrumb = [];
      _openFolder({ id: item.id, name: item.name || item.displayName });
    } else {
      // Song — navigate to its containing folder.
      // 1. Try fields already on the item
      let folderId = item.parents?.[0] || item.folderId;

      // 2. Fall back to DB meta (folderId is stored there on first play)
      if (!folderId) {
        const dbMeta = await DB.getMeta(item.id).catch(() => null);
        folderId = dbMeta?.folderId;
      }

      // 3. Last resort: ask Drive for the file's parents
      if (!folderId) {
        try {
          const fileInfo = await Drive.getFileInfo(item.id);
          folderId = fileInfo.parents?.[0];
        } catch (_) {}
      }

      if (!folderId) { UI.showToast(UI.t('toast_folder_unavailable'), 'error'); return; }

      try {
        const folder = await Drive.getFileInfo(folderId);
        _breadcrumb = [];
        _openFolder({ id: folder.id, name: folder.name });
      } catch (err) {
        UI.showToast(UI.t('toast_folder_open_error'), 'error');
      }
    }
  }

  function onBreadcrumbClick(crumb, index) {
    _breadcrumb = _breadcrumb.slice(0, index + 1);
    _openFolder(crumb, false);
  }

  /* ── Song click ──────────────────────────────────────────── */

  /**
   * User tapped a song row.
   * Replaces the queue with all songs in the current folder view,
   * starting from the clicked song.
   */
  function onSongClick(clickedSong) {
    // Only in Browse do we load the whole folder as queue.
    // In Search, Home, Library, etc. we play just the clicked song —
    // so the queue never auto-fills with files from other folders.
    if (UI.getCurrentView() === 'browse') {
      // Scope strictly to the Browse item-list — never leak into other screens
      const browseList = document.querySelector('#screen-browse .item-list');
      const rows       = Array.from(browseList?.querySelectorAll('.song-row:not(.wma)') || []);
      const ids        = rows.map(r => r.dataset.id);
      const allSongs   = ids.map(id => _resolveItemById(id)).filter(Boolean);

      _resetRadio(); // Browse always queues the folder — no radio needed
      if (allSongs.length > 0) {
        const startIdx = allSongs.findIndex(s => s.id === clickedSong.id);
        Player.setQueue(allSongs, startIdx >= 0 ? startIdx : 0);
      } else {
        // Only one song visible — treat as single-song play → enable radio
        _radioModeActive = true;
        _radioQueuedIds  = new Set([clickedSong.id]);
        Player.setQueue([clickedSong], 0);
      }
    } else {
      // Search, Library, History, Top Played: single song → enable radio mode
      _resetRadio();
      _radioModeActive = true;
      _radioQueuedIds  = new Set([clickedSong.id]);
      // Pre-seed artist from item metadata or filename — avoids waiting for AudD
      _radioArtist = _guessArtistFromItem(clickedSong) || null;
      Player.setQueue([clickedSong], 0);
    }
  }

  /**
   * Resolve a DriveItem from the DOM by fileId.
   * Since we render rows from Drive results, we keep a local cache.
   */
  const _itemCache = new Map();

  function _resolveItemById(id) {
    return _itemCache.get(id) || null;
  }

  /**
   * Register a DriveItem so it can be resolved by ID later.
   * Called when rendering song rows.
   * @param {DriveItem} item
   */
  function _cacheItem(item) {
    _itemCache.set(item.id, item);
    // Persist thumbnailUrl to DB so playlists/favorites can show covers across sessions
    const thumb = item.thumbnailLink || item.thumbnailUrl;
    if (thumb && !thumb.startsWith('blob:')) {
      DB.setMeta(item.id, { thumbnailUrl: thumb }).catch(() => {});
    }
  }

  /* ── Context menu actions ────────────────────────────────── */

  async function onToggleStar(item) {
    // Save display fields before toggling so getStarred() can show them later
    if (item.id) await _saveItemMeta(item);
    const isNowStarred = await DB.toggleStar(item.id);
    UI.showToast(isNowStarred ? UI.t('toast_added_fav') : UI.t('toast_removed_fav'), 'default');
    // Sync heart if this is the currently playing track
    if (Player.getCurrentTrack()?.id === item.id) {
      UI.setHeartActive(isNowStarred);
    }
    // Refresh Favoritos pane if it's selected
    const favItem = document.getElementById('lib-fav-item');
    if (favItem?.classList.contains('active')) _loadStarred();
    Sync.push('favorites');
  }

  async function onTogglePin(item) {
    const isNowPinned = await DB.togglePin(item);
    const label = item.type === 'folder' || item.isFolder ? 'Carpeta' : 'Canción';
    UI.showToast(isNowPinned ? `${label} fijada en Inicio` : `${label} quitada de Inicio`, 'default');
    _loadHomeData();
    Sync.push('pinned');
  }

  async function onRemoveFromHistory(item) {
    await DB.removeRecent(item.id).catch(() => {});
    UI.showToast(UI.t('toast_removed_history'));
    _loadHomeData();
  }

  async function onRemoveFromHistoryItem(item) {
    await DB.removeFromHistory(item.id).catch(() => {});
    UI.showToast(UI.t('toast_removed_history'));
    _loadHistory();
    Sync.push('history');
  }

  /* ── History screen ──────────────────────────────────────── */

  async function _loadHistory() {
    const screen = document.getElementById('screen-history');
    if (!screen) return;
    try {
      const raw = await DB.getHistory(CONFIG.HISTORY_MAX);

      // Load persisted metadata from DB for all items (artist, album, title
      // saved by _onBlobReady — not available in the history store itself).
      const metaRecords = await Promise.all(
        raw.map(r => DB.getMeta(r.id).catch(() => null))
      );

      const _pick = (...vals) => vals.find(v => v && String(v).trim() !== '') || '';

      const items = raw.map((item, i) => {
        const dbMeta  = metaRecords[i];
        const inMem   = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
        return {
          ...item,
          displayName:  _pick(inMem?.title,    item.displayName,  dbMeta?.displayName, item.name, dbMeta?.name),
          artist:       _pick(inMem?.artist,   item.artist,       dbMeta?.artist),
          albumName:    _pick(inMem?.album,    item.albumName,    dbMeta?.album),
          thumbnailUrl: _pick(inMem?.coverUrl, item.thumbnailUrl, dbMeta?.thumbnailUrl, dbMeta?.coverUrl),
        };
      });

      UI.renderHistory(items);
      // Async: apply covers from DB coverBlobs
      _prefetchTopPlayedCovers(items).catch(() => {});
    } catch (err) {
      console.error('[App] Load history error:', err);
    }
  }

  async function onFolderQueue(folder, mode) {
    try {
      const { files } = await Drive.listFolderAll(folder.id);
      const playable  = files.filter(f => f.isPlayable);
      if (playable.length === 0) { UI.showToast(UI.t('toast_no_playable'), 'error'); return; }
      if (mode === 'next') Player.insertNext(playable);
      else                 Player.appendToQueue(playable);
      UI.showToast(mode === 'next'
        ? `${playable.length} ${UI.t('songs').toLowerCase()} ${UI.t('play_next').toLowerCase()}`
        : `${playable.length} ${UI.t('songs').toLowerCase()} ${UI.t('play_after').toLowerCase()}`,
        'default');
    } catch (err) {
      UI.showToast(UI.t('toast_queue_error'), 'error');
    }
  }

  /**
   * Show the playlist picker panel for choosing where to add item.
   * Called from context menu "Agregar a playlist" — loads playlists async then delegates to UI.
   * @param {MouseEvent} e
   * @param {DriveItem}  item
   */
  async function onShowPlaylistPicker(e, item) {
    try {
      const playlists = await DB.getPlaylists();
      UI.showPlaylistPicker(e, item, playlists);
    } catch (err) {
      UI.showToast(UI.t('toast_pl_load_error'), 'error');
    }
  }

  /**
   * Add item to an existing playlist (called from playlist picker row click).
   * @param {DriveItem} item
   * @param {string}    playlistId
   */
  async function onAddToPlaylist(item, playlistId) {
    try {
      if (!playlistId) return;
      const playlists = await DB.getPlaylists();
      const pl = playlists.find(p => p.id === playlistId);
      await DB.addToPlaylist(playlistId, item.id);
      await _saveItemMeta(item);
      UI.showToast(`${UI.t('toast_added_to_pl')} "${pl?.name || 'playlist'}"`);
      Sync.push('playlists');
    } catch (err) {
      UI.showToast(UI.t('toast_pl_add_error'), 'error');
    }
  }

  /**
   * Create a new playlist, add item, show toast.
   * Called from playlist picker "Nueva playlist" confirm.
   * @param {DriveItem} item
   * @param {string}    name — playlist name from input
   */
  async function onCreateAndAddPlaylist(item, name) {
    try {
      const pl = await DB.createPlaylist(name);
      await DB.addToPlaylist(pl.id, item.id);
      await _saveItemMeta(item);
      UI.showToast(`"${name}" — ${UI.t('toast_pl_created')}`);
      _loadPlaylists(); // refresh Library if open
      Sync.push('playlists');
    } catch (err) {
      UI.showToast(UI.t('toast_pl_create_error'), 'error');
    }
  }

  /** Save all displayable metadata for an item to DB (never saves blob: URLs). */
  async function _saveItemMeta(item) {
    const thumb = item.thumbnailLink || item.thumbnailUrl || null;
    const safeThumb = (thumb && !thumb.startsWith('blob:')) ? thumb : null;
    await DB.setMeta(item.id, {
      name:         item.name        || undefined,
      displayName:  item.displayName || item.name || undefined,
      thumbnailUrl: safeThumb        || undefined,
      artist:       item.artist      || undefined,
      albumName:    item.albumName   || undefined,
      size:         item.size        || undefined,
      folderId:     item.parents?.[0] || item.folderId || undefined,
    }).catch(() => {});
  }

  /* ── Search ──────────────────────────────────────────────── */

  /* ── Fuzzy search helpers ──────────────────────────────────
   * Used to rank Drive results by relevance after multi-query expansion.
   * Handles: accents, case, typos, dyslexia, missing vowels, char transpositions.
   */

  /** Strip diacritics + lowercase. "Música" → "musica", "niño" → "nino" */
  function _searchNorm(str) {
    return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /** Levenshtein distance between two strings (2-row DP). */
  function _levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = i;
      for (let j = 1; j <= b.length; j++) {
        const val = Math.min(row[j] + 1, prev + 1, row[j - 1] + (a[i-1] !== b[j-1] ? 1 : 0));
        row[j - 1] = prev;
        prev = val;
      }
      row[b.length] = prev;
    }
    return row[b.length];
  }

  /**
   * Similarity score [0..1] between two single (normalized) words.
   * 1.0 = exact, 0.9 = prefix/substring, else Levenshtein-based.
   */
  function _wordSim(a, b) {
    if (a === b) return 1;
    if (b.startsWith(a) || a.startsWith(b)) return 0.9;
    if (b.includes(a) || a.includes(b)) return 0.8;
    const dist    = _levenshtein(a, b);
    const maxLen  = Math.max(a.length, b.length);
    // Tighten penalty: 1 edit in a 5-char word = 0.7, 2 edits = 0.4
    return Math.max(0, 1 - (dist * 1.5) / maxLen);
  }

  /**
   * Overall fuzzy score [0..1] of a search query against a filename.
   * Splits both into words and scores best-matching pair per query word.
   * "mi mrjor amigo" vs "Mi Mejor Amigo.mp3" → ~0.9
   */
  function _fuzzyScore(query, filename) {
    const qNorm = _searchNorm(query);
    const fNorm = _searchNorm(filename.replace(/\.[^.]+$/, '')); // strip extension

    // Fast path: exact substring
    if (fNorm.includes(qNorm)) return 1;

    const qWords = qNorm.split(/\s+/).filter(Boolean);
    const fWords = fNorm.split(/[\s\-_\.]+/).filter(Boolean);
    if (!qWords.length || !fWords.length) return 0;

    let total = 0;
    for (const qw of qWords) {
      let best = 0;
      for (const fw of fWords) {
        const s = _wordSim(qw, fw);
        if (s > best) best = s;
      }
      total += best;
    }
    return total / qWords.length;
  }

  /**
   * Fuzzy-rank a Drive results object.
   * Items below MIN_SCORE are dropped; survivors sorted by score desc.
   */
  function _fuzzyRank(term, result) {
    const MIN_SCORE = 0.45; // allow ~1 edit in 5-char word
    const score = item => _fuzzyScore(term, item.name || item.displayName || '');

    const rankList = arr => arr
      .map(item => ({ item, score: score(item) }))
      .filter(x => x.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .map(x => x.item);

    return {
      folders: rankList(result.folders || []),
      files:   rankList(result.files   || []),
    };
  }

  async function _doSearch(term) {
    const container = document.getElementById('search-results');
    if (!container) return;

    const activeChip = document.querySelector('[data-filter].active');
    const filter = activeChip?.dataset.filter || 'all';

    container.innerHTML = '<div class="empty-state"><p>Buscando…</p></div>';
    UI.updateSearchChipCounts(null); // clear counts while loading
    if (!Auth.isAuthenticated()) { UI.showTokenBanner(); return; }

    try {
      const raw = await Drive.searchFiles(term, _rootFolderId);
      // Fuzzy-score + sort — drops unrelated results from word-expansion queries
      const result = _fuzzyRank(term, raw);
      // Cache all items for queue resolution
      [...(result.folders || []), ...(result.files || [])].forEach(item => _cacheItem(item));
      // Render sorted results
      UI.renderSearchResults(result, filter);
      // Prefetch covers (same pipeline as Browse)
      if (result.files?.length) {
        _prefetchAndApplyFolderCovers(null, result.files).catch(() => {});
      }
    } catch (err) {
      console.error('[App] Search error:', err);
      if (err.name === 'AuthError') { UI.showTokenBanner(); return; }
      container.innerHTML = '<div class="empty-state"><p>Error al buscar. Inténtalo de nuevo.</p></div>';
    }
  }

  /* ── Library ─────────────────────────────────────────────── */

  let _currentLibTab  = 'albums'; // persists tab across sync refreshes
  let _libInDetail    = false;       // true while showing an artist/album drill-down

  const LIB_TAB_PLACEHOLDERS = {
    favorites: 'Buscar en Favoritos…',
    artists:   'Buscar artista…',
    albums:    'Buscar álbum…',
    playlists: 'Buscar playlist…',
  };

  /**
   * Switch the active library tab: update DOM active state,
   * update search placeholder and load the tab's data.
   */
  function _setLibTab(tab) {
    _currentLibTab = tab;
    _libInDetail   = false; // leaving any drill-down view

    // Active state on tab items
    document.querySelectorAll('#lib-sidebar .lib-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });

    // Clear search input
    const searchInput = document.getElementById('lib-search-input');
    if (searchInput) searchInput.value = '';

    // Update placeholder
    UI.setLibSearchPlaceholder(LIB_TAB_PLACEHOLDERS[tab] || 'Buscar…');

    // Load data
    if (tab === 'favorites') _loadStarred();
    if (tab === 'artists')   { _loadArtists();  setTimeout(_scanLibraryBackground, 400); }
    if (tab === 'albums')    { _loadAlbums();   setTimeout(_scanLibraryBackground, 400); }
    if (tab === 'playlists') _loadPlaylists();
  }

  /**
   * Navigate back to a parent list tab WITHOUT clearing the search input.
   * Used by all back-buttons inside drill-down views (album detail, artist detail).
   * After re-rendering the list, re-applies whatever is currently in the search bar.
   */
  function _libGoBack(tab) {
    _currentLibTab = tab;
    _libInDetail   = false;

    document.querySelectorAll('#lib-sidebar .lib-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });

    // Update placeholder but leave the search input text intact
    UI.setLibSearchPlaceholder(LIB_TAB_PLACEHOLDERS[tab] || 'Buscar…');

    // Reload data — each loader re-applies the current search filter after render
    if (tab === 'artists') { _loadArtists();  setTimeout(_scanLibraryBackground, 400); }
    if (tab === 'albums')  { _loadAlbums();   setTimeout(_scanLibraryBackground, 400); }
    if (tab === 'playlists') _loadPlaylists();
  }

  /** Filter visible items in #lib-detail-content by search text. */
  function _onLibSearch(query) {
    const q = query.trim().toLowerCase();
    const container = document.getElementById('lib-detail-content');
    if (!container) return;

    container.querySelectorAll('[data-search-key]').forEach(el => {
      const match = !q || el.dataset.searchKey.includes(q);
      el.style.display = match ? '' : 'none';
    });
  }

  async function _loadPlaylists() {
    try {
      const playlists = await DB.getPlaylists();
      const enriched = await Promise.all(playlists.map(async pl => {
        const songIds = pl.songIds || [];
        const coverUrls = [];
        for (const sid of songIds) {
          if (coverUrls.length >= 4) break;
          const m = await DB.getMeta(sid).catch(() => null);
          const url = await _resolveCoverUrl(sid, m?.thumbnailUrl);
          if (url) coverUrls.push(url);
        }
        return { ...pl, songCount: songIds.length, coverUrls };
      }));
      UI.renderPlaylists(enriched);
      _setLibTabCount('playlists', enriched.length);
      // Background: resolve covers for playlists that still have none
      // (happens when songs were never played — no coverBlob in DB yet)
      _prefetchPlaylistCovers(enriched).catch(() => {});
    } catch (err) {
      console.error('[App] Load playlists error:', err);
    }
  }

  /**
   * Background cover fetch for the playlist sidebar.
   * For each playlist without a cover:
   *   Pass 1 — check DB for a persisted coverBlob (instant, no network)
   *   Pass 2 — download the first 1MB of a song (range request) and parse ID3
   * Updates the sidebar thumbnail in-place when a cover is found.
   * @param {Object[]} playlists — enriched playlists from _loadPlaylists
   */
  async function _prefetchPlaylistCovers(playlists) {
    if (typeof Meta === 'undefined') return;

    for (const pl of playlists) {
      // Already has a cover — skip
      if ((pl.coverUrls || []).length > 0) continue;

      const songIds = (pl.songIds || []).slice(0, 5); // try first 5 songs
      let found = false;

      for (const sid of songIds) {
        if (found) break;
        try {
          // Pass 1: persisted coverBlob (no network, instant)
          const dbMeta = await DB.getMeta(sid).catch(() => null);
          if (dbMeta?.coverBlob) {
            const url = Meta.injectCover(sid, dbMeta.coverBlob);
            if (url) { UI.updatePlaylistSidebarCover(pl.id, url); found = true; break; }
          }

          // Pass 2: try cached audio blob first, then range request
          let blob = await DB.getCachedBlob(sid).catch(() => null);
          if (!blob && Auth.isAuthenticated()) {
            blob = await Drive.downloadFileHead(sid).catch(() => null);
          }
          if (!blob) continue;

          const meta = await Meta.parse(sid, blob);
          if (meta?.coverUrl) {
            // Persist coverBlob so next session is instant
            if (meta.coverBlob) DB.setMeta(sid, { coverBlob: meta.coverBlob }).catch(() => {});
            _updatePlaylistSidebarCover(pl.id, meta.coverUrl);
            found = true;
          }
        } catch (_) { /* non-fatal */ }
      }
    }
  }

  /**
   * Background cover resolver for the queue panel.
   * Pass 1 (fast, no network): Meta cache → DB coverBlob → external URL → Drive thumb.
   * Pass 2 (network, limited): ID3 head-download via _driveThumbFallback for songs
   *   still without art after Pass 1 (e.g. new radio-added songs never played before).
   *   Limited to 10 items so we don't hammer Drive on long queues.
   * @param {DriveItem[]} queue
   */
  async function _prefetchQueueCovers(queue) {
    if (typeof Meta === 'undefined') return;

    const needsNetwork = [];

    for (const item of queue) {
      try {
        // 1. In-memory Meta cache — songs played this session (instant)
        const inMem = Meta.getCached(item.id);
        if (inMem?.coverUrl) { _updateQueueItemCover(item.id, inMem.coverUrl); continue; }

        // 2. DB: embedded art saved as binary blob (highest fidelity)
        const dbMeta = await DB.getMeta(item.id).catch(() => null);
        if (dbMeta?.coverBlob) {
          const url = Meta.injectCover(item.id, dbMeta.coverBlob);
          if (url) { _updateQueueItemCover(item.id, url); continue; }
        }

        // 3. DB: external cover URL persisted from AudD / Last.fm
        if (dbMeta) {
          const extUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
          const isExternal = extUrl
            && !extUrl.startsWith('blob:')
            && !extUrl.includes('googleusercontent.com')
            && !extUrl.includes('googleapis.com');
          if (isExternal) { _updateQueueItemCover(item.id, extUrl); continue; }
        }

        // 4. Drive thumbnailLink on the item itself (rare for audio, common for video)
        const driveThumb = item.thumbnailUrl || item.thumbnailLink;
        if (driveThumb && !driveThumb.startsWith('blob:')) {
          _updateQueueItemCover(item.id, driveThumb);
          continue;
        }

        // 5. Folder cover — already cached in memory if the user browsed this folder.
        //    Free lookup: _folderCoverCache is a Map; _getFolderCover returns instantly
        //    for folders already visited this session.
        const folderId = item.parents?.[0];
        if (folderId) {
          const folderCover = await _getFolderCover(folderId);
          if (folderCover) { _updateQueueItemCover(item.id, folderCover); continue; }
        }

        // Still no cover — mark for network resolution
        needsNetwork.push(item);
      } catch (_) { /* non-fatal */ }
    }

    // Pass 2: ID3 head-download for songs still without cover (new radio songs, etc.)
    if (needsNetwork.length > 0) {
      await _driveThumbFallback(
        needsNetwork.slice(0, 10),
        id => {
          const el = document.querySelector(`.queue-item[data-id="${CSS.escape(id)}"] .queue-item-thumb`);
          return !!(el && el.querySelector('img'));
        },
        _updateQueueItemCover
      ).catch(() => {});
    }
  }

  /** Patch the cover thumbnail of all visible queue rows for a given song id. */
  function _updateQueueItemCover(id, url) {
    document.querySelectorAll(`.queue-item[data-id="${CSS.escape(id)}"]`).forEach(el => {
      const thumb = el.querySelector('.queue-item-thumb');
      if (!thumb) return;
      const img = thumb.querySelector('img');
      if (img) { img.src = url; }
      else { thumb.innerHTML = `<img src="${url}" alt="">`; }
    });
  }

  /**
   * Patch title / artist text in all currently visible elements that reference
   * this song — queue panel, home recents cards, top-played list, history list,
   * and browse rows.  Called from _applyMeta after _onBlobReady enriches metadata.
   *
   * Elements are created on the fly when they were omitted because the value was
   * empty at render time (e.g. artist row in queue, .home-card-sub).
   *
   * @param {string} id — Drive file id
   * @param {{title:string|null, artist:string|null, album:string|null, year:string|null}} fields
   */
  function _patchMetaText(id, { title, artist, album, year }) {
    const eid = CSS.escape(id);

    if (title) {
      // Browse rows (title only — no artist line in browse)
      document.querySelectorAll(`.song-row[data-id="${eid}"] .song-row-title`).forEach(el => {
        el.textContent = title;
      });
      // Queue items
      document.querySelectorAll(`.queue-item[data-id="${eid}"] .queue-item-title`).forEach(el => {
        el.textContent = title;
      });
      // Home recents cards
      document.querySelectorAll(`#screen-home .home-card[data-id="${eid}"] .home-card-name`).forEach(el => {
        el.textContent = title;
      });
      // Top-played & history list
      document.querySelectorAll(`.top-list-item[data-id="${eid}"] .top-list-title`).forEach(el => {
        el.textContent = title;
      });
    }

    if (artist) {
      // ── Queue item artist ──────────────────────────────────────
      document.querySelectorAll(`.queue-item[data-id="${eid}"]`).forEach(el => {
        let artistEl = el.querySelector('.queue-item-artist');
        if (artistEl) {
          artistEl.textContent = artist;
        } else {
          // Row was built without an artist line — inject it now
          const info = el.querySelector('.queue-item-info');
          if (info) {
            artistEl = document.createElement('div');
            artistEl.className = 'queue-item-artist';
            artistEl.textContent = artist;
            info.appendChild(artistEl);
          }
        }
      });

      // ── Home recents card artist ───────────────────────────────
      document.querySelectorAll(`#screen-home .home-card[data-id="${eid}"]`).forEach(el => {
        let subEl = el.querySelector('.home-card-sub');
        if (subEl) {
          subEl.textContent = artist;
        } else {
          subEl = document.createElement('div');
          subEl.className = 'home-card-sub';
          subEl.textContent = artist;
          el.appendChild(subEl);
        }
      });

      // ── Top-played / library-detail artist line ─────────────────
      // Library album-detail rows use .top-list-artist; home/top-played use .top-list-meta.
      const metaLine = [artist, [album, year].filter(Boolean).join(' · ')].filter(Boolean).join(' — ');
      document.querySelectorAll(`.top-list-item[data-id="${eid}"]`).forEach(el => {
        // Library detail layout: update or inject .top-list-artist
        const artistEl = el.querySelector('.top-list-artist');
        if (artistEl) {
          artistEl.textContent = artist;
          return;
        }
        // Home / top-played layout: update or inject .top-list-meta
        let metaEl = el.querySelector('.top-list-meta');
        if (metaEl) {
          metaEl.textContent = metaLine;
        } else {
          const info = el.querySelector('.top-list-info');
          if (info) {
            metaEl = document.createElement('div');
            metaEl.className = 'top-list-meta';
            metaEl.textContent = metaLine;
            info.appendChild(metaEl);
          }
        }
      });
    }
  }

  /**
   * Background cover loader for pinned song cards.
   * Folders are skipped (they show a static folder icon).
   * @param {Object[]} pinned — items from DB.getPinnedFolders()
   */
  async function _prefetchPinnedCovers(pinned) {
    if (typeof Meta === 'undefined') return;
    const songs = pinned.filter(item => item.type !== 'folder' && !item.isFolder);
    for (const item of songs) {
      try {
        const inMem = Meta.getCached(item.id);
        if (inMem?.coverUrl) { _updatePinnedItemCover(item.id, inMem.coverUrl); continue; }
        const meta = await DB.getMeta(item.id).catch(() => null);
        if (meta?.coverBlob) {
          const url = Meta.injectCover(item.id, meta.coverBlob);
          if (url) _updatePinnedItemCover(item.id, url);
        }
      } catch (_) { /* non-fatal */ }
    }
    // Drive fallback: songs synced from another device with no local blob
    await _driveThumbFallback(
      songs,
      id => {
        const art = document.querySelector(`.pinned-card-art[data-id="${CSS.escape(id)}"]`);
        return !!(art && art.querySelector('.pinned-art-img'));
      },
      _updatePinnedItemCover
    );
  }

  /** Patch the cover art of a pinned card for a given song id. */
  function _updatePinnedItemCover(id, url) {
    const art = document.querySelector(`.pinned-card-art[data-id="${CSS.escape(id)}"]`);
    if (!art) return;
    // Inject or update the cover image
    let img = art.querySelector('.pinned-art-img');
    if (img) {
      img.src = url;
    } else {
      img = document.createElement('img');
      img.className = 'pinned-art-img';
      img.alt = '';
      img.src = url;
      art.insertBefore(img, art.firstChild);
    }
    // Hide the music-note placeholder now that real art is loaded
    const icon = art.querySelector('.pinned-art-icon');
    if (icon) icon.style.display = 'none';
  }

  /** Swap the thumbnail of a playlist sidebar item to a resolved cover URL. */
  /**
   * Resolve a valid cover URL for a song id.
   * Skips stale blob: URLs, tries coverBlob, then itemCache thumbnailLink.
   * @param {string} id
   * @param {string|null} storedUrl - value from DB (may be stale blob:)
   * @returns {Promise<string|null>}
   */
  async function _resolveCoverUrl(id, storedUrl) {
    // Priority: ID3 embedded art > external persisted URL
    // 1. In-memory Meta cache: song was parsed this session (fastest, no DB round-trip)
    const inMem = (typeof Meta !== 'undefined') ? Meta.getCached(id) : null;
    if (inMem?.coverUrl) return inMem.coverUrl;
    // 2. Persisted coverBlob in DB (ID3 embedded — wins over external URLs)
    const dbMeta = await DB.getMeta(id).catch(() => null);
    if (dbMeta?.coverBlob && typeof Meta !== 'undefined') {
      const url = Meta.injectCover(id, dbMeta.coverBlob);
      if (url) return url;
    }
    // 3. Stored web URL (non-blob, from Last.fm / AudD / Drive thumbnailLink)
    const ext = dbMeta?.thumbnailUrl || storedUrl || null;
    if (ext && !ext.startsWith('blob:')) return ext;
    // 4. Drive thumbnail from item cache (rarely set for audio)
    const cached = _itemCache.get(id);
    return cached?.thumbnailLink || cached?.thumbnailUrl || null;
  }

  async function _loadStarred() {
    try {
      const starred = await DB.getStarred();
      const enriched = await Promise.all(starred.map(async song => {
        const url = await _resolveCoverUrl(song.id, song.thumbnailUrl);
        return url ? { ...song, thumbnailUrl: url } : song;
      }));
      UI.renderStarredSongs(enriched);
      _setLibTabCount('fav', enriched.length);
      _driveThumbFallback(
        enriched.filter(s => !s.thumbnailUrl),
        _songRowHasCover,
        _updateSongRowThumb
      ).catch(() => {});
    } catch (err) {
      console.error('[App] Load starred error:', err);
    }
  }

  /* ── Library background scanner ─────────────────────────── */

  let _libScanDone  = false; // run once per session
  let _lastLibScanAt = null; // ISO timestamp of the last completed BFS scan

  /**
   * BFS scan from ROOT_FOLDER_ID.
   * For each folder that contains ≥2 audio files:
   *   - album   = folder name
   *   - artist  = parent folder name (if not root)
   *   - cover   = cover/folder.jpg in the folder → common thumbnailLink → first DB thumbnailUrl
   * Only patches fields that are missing in DB (never overwrites enriched values).
   * Runs entirely in background; refreshes the active library tab when done.
   */
  async function _scanLibraryBackground() {
    if (_libScanDone) return;
    if (!Auth.getValidToken()) return;
    _libScanDone = true;

    console.log('[LibScan] Starting background library scan…');

    // BFS queue: { id, name, parentName }
    const queue   = [{ id: CONFIG.ROOT_FOLDER_ID, name: CONFIG.ROOT_FOLDER_NAME, parentName: '' }];
    const visited = new Set();
    let   patched = 0;

    while (queue.length > 0) {
      const { id, name: folderName, parentName } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      let page;
      try {
        page = await Drive.listFolderScan(id);
      } catch (err) {
        if (err instanceof Drive.AuthError || err?.name === 'AuthError') break;
        console.warn('[LibScan] Error scanning folder:', folderName, err);
        continue;
      }

      // Push subfolders — current folder becomes the artist level for its children
      for (const f of page.folders) {
        queue.push({ id: f.id, name: f.name, parentName: folderName });
      }

      // Only process folders with ≥2 audio files (single files are loose tracks, not albums)
      if (page.audioFiles.length >= 2) {
        const n = await _inferAlbumMeta(folderName, parentName, page.audioFiles, page.imageFiles);
        patched += n;
      }

      // Small yield to avoid blocking audio playback / UI
      await new Promise(r => setTimeout(r, 60));
    }

    _lastLibScanAt = new Date().toISOString();
    console.log(`[LibScan] Done. Patched metadata for ${patched} files.`);

    // Single metadata push for the entire scan — avoids one push per folder
    if (patched > 0 && typeof Sync !== 'undefined') Sync.push('metadata');

    // Refresh the current library tab so newly inferred data shows up.
    // Skip if the user is inside a drill-down — the list re-renders on back-navigation.
    if (!_libInDetail) {
      const tab = _currentLibTab;
      if (tab === 'artists') _loadArtists();
      if (tab === 'albums')  _loadAlbums();
    }

    // ── MusicBrainz background enrichment for the whole library ───────────────
    // Runs after the structural scan. Processes every song that hasn't been tried
    // yet (no mbTried flag). Sequential at 1 req/sec — silently enriches in background.
    // Each session only processes songs not yet tried; subsequent sessions are no-ops
    // for already-enriched files.
    _mbEnrichLibrary().catch(() => {});
  }

  /**
   * Full library refresh: BFS scan of all Drive from ROOT_FOLDER_ID, then
   * purges DB records for files that no longer exist in Drive.
   *
   * Differences from _scanLibraryBackground:
   *  - Always runs (ignores _libScanDone guard)
   *  - Collects every live file ID across all folders
   *  - After BFS, deletes DB records not found in Drive (global orphan cleanup)
   *  - Shows live progress to the user via toasts
   *  - Triggered explicitly by the user from Settings
   */
  async function _fullLibraryRefresh() {
    const btn  = document.getElementById('btn-library-refresh');
    const icon = document.getElementById('library-refresh-icon');
    if (btn)  btn.disabled = true;
    if (icon) icon.style.animation = 'spin 1s linear infinite';

    try {
      UI.showToast('Escaneando Drive…');

      const liveIds     = new Set();
      const queue       = [{ id: CONFIG.ROOT_FOLDER_ID, name: CONFIG.ROOT_FOLDER_NAME, parentName: '' }];
      const visited     = new Set();
      let   foldersScanned = 0;

      while (queue.length > 0) {
        const { id, name: folderName, parentName } = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        foldersScanned++;

        let page;
        try {
          page = await Drive.listFolderScan(id);
        } catch (err) {
          if (err instanceof Drive.AuthError || err?.name === 'AuthError') break;
          console.warn('[LibRefresh] Error scanning folder:', folderName, err);
          continue;
        }

        // Enqueue subfolders
        for (const f of page.folders) {
          queue.push({ id: f.id, name: f.name, parentName: folderName });
        }

        // Track all live audio file IDs
        for (const f of page.audioFiles) liveIds.add(f.id);

        // Patch missing metadata (same logic as background scan)
        if (page.audioFiles.length >= 2) {
          await _inferAlbumMeta(folderName, parentName, page.audioFiles, page.imageFiles);
        }

        // Progress feedback every 10 folders
        if (foldersScanned % 10 === 0) {
          UI.showToast(`Escaneando… ${foldersScanned} carpetas, ${liveIds.size} archivos`);
        }

        // Yield to avoid blocking playback / UI
        await new Promise(r => setTimeout(r, 60));
      }

      // ── Purge global orphans ─────────────────────────────────
      const pruned = await DB.purgeAllOrphans([...liveIds]).catch(() => 0);
      if (pruned > 0) console.log(`[LibRefresh] Purged ${pruned} orphan record(s) from DB`);

      // Mark scan timestamp and reset guard
      _lastLibScanAt = new Date().toISOString();
      _libScanDone   = false;

      // Push updated metadata to sync channel
      if (typeof Sync !== 'undefined') Sync.push('metadata');

      // Refresh current library view
      if (!_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
      }

      const msg = pruned > 0
        ? `Biblioteca actualizada — ${liveIds.size} archivos, ${pruned} eliminados`
        : `Biblioteca actualizada — ${liveIds.size} archivos`;
      UI.showToast(msg);

    } catch (err) {
      console.error('[LibRefresh] Error:', err);
      UI.showToast('Error al actualizar la biblioteca');
    } finally {
      if (btn)  btn.disabled = false;
      if (icon) icon.style.animation = '';
    }
  }

  /* ── Deep Scan tool  (v1.6.24) ─────────────────────────────
     BFS scan with:
       • Selectable root folder
       • Drive appDataFolder scan-history (which folders were scanned)
       • Rescan confirmation if previously-scanned folders found
       • LED activity indicator + discrete counters row
       • Log strip (3 visible lines, rotating)
       • Sin datos / Completas list toggle + Mostrar for completed
       • Artistas tab: 3-col grid, per-artist photo URL editor
  ─────────────────────────────────────────────────────────── */

  let _dsRunning       = false;
  let _dsPaused        = false;
  let _dsStopFlag      = false;
  let _dsSession       = null;
  let _dsListMode      = 'attn';     // 'attn' | 'done'
  let _dsArtistsLoaded = false;
  let _dsOnlyNoPhoto   = false;

  // ── Scan history stored in Drive appDataFolder ─────────────
  // Shape: { folders: { folderId: { name, scannedAt } } }
  const DS_HISTORY_FILE = 'savart-scan-history.json';
  let _dsScanHistory   = null;   // cached in memory once loaded
  let _dsHistoryFileId = null;   // Drive file ID once created/found

  /* ── Drive appDataFolder helpers ──────────────────────────── */

  async function _dsApiFetch(url, opts = {}) {
    const token = Auth.getValidToken();
    if (!token) throw new Error('No auth token');
    const res = await fetch(url, {
      ...opts,
      headers: { 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive ${res.status}: ${body.slice(0, 120)}`);
    }
    return res;
  }

  async function _dsLoadHistory() {
    if (_dsScanHistory !== null) return _dsScanHistory;
    try {
      // Search for existing file
      const q = encodeURIComponent(`name='${DS_HISTORY_FILE}' and trashed=false`);
      const res = await _dsApiFetch(
        `${CONFIG.API_BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=1`
      );
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        _dsHistoryFileId = data.files[0].id;
        const mediaRes = await _dsApiFetch(
          `${CONFIG.API_BASE}/files/${_dsHistoryFileId}?alt=media`
        );
        _dsScanHistory = await mediaRes.json();
      } else {
        _dsScanHistory = { folders: {} };
      }
    } catch (err) {
      console.warn('[DS] Could not load scan history:', err);
      _dsScanHistory = { folders: {} };
    }
    return _dsScanHistory;
  }

  async function _dsSaveHistory() {
    if (!_dsScanHistory) return;
    try {
      const body = JSON.stringify(_dsScanHistory);
      if (_dsHistoryFileId) {
        // PATCH existing file
        await _dsApiFetch(
          `https://www.googleapis.com/upload/drive/v3/files/${_dsHistoryFileId}?uploadType=media`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
        );
      } else {
        // POST new file in appDataFolder
        const meta  = JSON.stringify({ name: DS_HISTORY_FILE, parents: ['appDataFolder'] });
        const blob  = new Blob([
          '--boundary\r\nContent-Type: application/json\r\n\r\n', meta,
          '\r\n--boundary\r\nContent-Type: application/json\r\n\r\n', body,
          '\r\n--boundary--',
        ]);
        const res = await _dsApiFetch(
          `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
          { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=boundary' }, body: blob }
        );
        const created = await res.json();
        _dsHistoryFileId = created.id;
      }
    } catch (err) {
      console.warn('[DS] Could not save scan history:', err);
    }
  }

  /* Mark a set of folder IDs as scanned in history. */
  async function _dsRecordScanned(folderIdSet, nameMap) {
    const hist = await _dsLoadHistory();
    const now  = new Date().toISOString();
    for (const id of folderIdSet) {
      hist.folders[id] = { name: nameMap[id] || '', scannedAt: now };
    }
    await _dsSaveHistory();
  }

  /* Return Set of previously-scanned folder IDs. */
  async function _dsGetScannedIds() {
    const hist = await _dsLoadHistory();
    return new Set(Object.keys(hist.folders || {}));
  }

  /* ── Session management ─────────────────────────────────── */

  async function _openDeepScan() {
    UI.showView('deep-scan');
    await _dsLoadSession();
    _dsRenderAll();
    // Auto-open artists tab if hash says so
    if (location.hash === '#deep-scan-artists') {
      _dsSwitchTab('artists');
      location.hash = '';
    }
  }

  async function _dsLoadSession() {
    const saved = await DB.getState('deepScanSession').catch(() => null);
    if (saved && typeof saved === 'object') {
      _dsSession = saved;
      // Back-compat: ensure new fields exist
      if (!_dsSession.selectedFolderId)   _dsSession.selectedFolderId   = CONFIG.ROOT_FOLDER_ID;
      if (!_dsSession.selectedFolderName) _dsSession.selectedFolderName = CONFIG.ROOT_FOLDER_NAME;
      if (!_dsSession.completedList)      _dsSession.completedList      = {};
      if (!_dsSession.rescanMode)         _dsSession.rescanMode         = 'skip';
    } else {
      _dsSession = {
        status:             'idle',
        startedAt:          null,
        selectedFolderId:   CONFIG.ROOT_FOLDER_ID,
        selectedFolderName: CONFIG.ROOT_FOLDER_NAME,
        rescanMode:         'skip',
        scannedFolders:     0,
        totalFolders:       0,
        visited:            [],
        folders:            {},   // needs-attention entries
        completedList:      {},   // folderId → {id,name,path,count}
        log:                [],
      };
    }
  }

  async function _dsSaveSession() {
    await DB.setState('deepScanSession', _dsSession).catch(() => {});
    const el = document.getElementById('ds-autosave');
    if (el) {
      const t = new Date();
      el.textContent = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    }
  }

  /* Full render from session state. */
  function _dsRenderAll() {
    // Folder name
    const nameEl = document.getElementById('ds-folder-name');
    if (nameEl) nameEl.textContent = _dsSession.selectedFolderName || CONFIG.ROOT_FOLDER_NAME;

    _dsUpdateControls();
    _dsUpdateProgress();
    _dsUpdateCounters();
    _dsRestoreLog();

    // Re-render list for current mode
    if (_dsListMode === 'attn') {
      _dsRenderAttentionList();
    } else {
      _dsRenderCompletedList();
    }
  }

  /* ── Log strip ──────────────────────────────────────────── */

  /* Keep at most 3 visible lines in the strip (newest at bottom). */
  function _dsLogLine(msg, cls = '') {
    const strip = document.getElementById('ds-log');
    if (strip) {
      // Remove placeholder
      const ph = strip.querySelector('.ds-log-placeholder');
      if (ph) ph.remove();

      const div = document.createElement('div');
      div.className = 'ds-log-entry' + (cls ? ' ' + cls : '');
      div.textContent = msg;
      strip.appendChild(div);

      // Keep only last 3
      while (strip.children.length > 3) strip.removeChild(strip.firstChild);
    }
    if (!_dsSession.log) _dsSession.log = [];
    _dsSession.log.push(msg);
    if (_dsSession.log.length > 300) _dsSession.log = _dsSession.log.slice(-300);
  }

  function _dsRestoreLog() {
    const strip = document.getElementById('ds-log');
    if (!strip) return;
    strip.innerHTML = '';
    const lines = (_dsSession.log || []).slice(-3);
    if (lines.length === 0) {
      strip.innerHTML = '<div class="ds-log-entry ds-log-placeholder">Inicia un escaneo para ver el registro aquí…</div>';
      return;
    }
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = 'ds-log-entry';
      div.textContent = line;
      strip.appendChild(div);
    }
  }

  /* ── Controls + LED ─────────────────────────────────────── */

  function _dsUpdateLED() {
    const led = document.getElementById('ds-led');
    if (!led) return;
    led.classList.remove('ds-led--active', 'ds-led--paused');
    if (_dsRunning && !_dsPaused) led.classList.add('ds-led--active');
    else if (_dsPaused)           led.classList.add('ds-led--paused');
    // else: no class = red solid (idle/stopped)
  }

  function _dsUpdateControls() {
    const startBtn = document.getElementById('btn-ds-start');
    const pauseBtn = document.getElementById('btn-ds-pause');
    const stopBtn  = document.getElementById('btn-ds-stop');
    const statusEl = document.getElementById('ds-status-text');
    if (!startBtn || !_dsSession) return;

    const running = _dsRunning && !_dsPaused;
    const paused  = _dsRunning &&  _dsPaused;
    const done    = !_dsRunning && _dsSession.status === 'done';

    const iconPlay    = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    const iconRestart = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;
    if (done)         { startBtn.innerHTML = iconRestart + ' Reiniciar'; startBtn.disabled = false; }
    else if (paused)  { startBtn.innerHTML = iconPlay    + ' Reanudar';  startBtn.disabled = false; }
    else if (running) { startBtn.innerHTML = iconPlay    + ' Escaneando…'; startBtn.disabled = true; }
    else              { startBtn.innerHTML = iconPlay    + ' Iniciar';   startBtn.disabled = false; }

    pauseBtn.disabled = !running;
    stopBtn.disabled  = !_dsRunning;

    if (statusEl) {
      if (done)          statusEl.textContent = `Completado · ${_dsSession.scannedFolders} carpetas`;
      else if (paused)   statusEl.textContent = 'En pausa';
      else if (running)  statusEl.textContent = `Escaneando… (${_dsSession.scannedFolders})`;
      else if (_dsSession.status === 'stopped')
                         statusEl.textContent = `Detenido · ${_dsSession.scannedFolders} carpetas`;
      else if (_dsSession.scannedFolders > 0)
                         statusEl.textContent = `${_dsSession.scannedFolders} carpetas escaneadas`;
      else               statusEl.textContent = 'Listo';
    }

    _dsUpdateLED();
  }

  /* ── Counters ───────────────────────────────────────────── */

  function _dsUpdateCounters(queueLen = null, startMs = null) {
    if (!_dsSession) return;

    const attnCount  = Object.values(_dsSession.folders || {})
      .filter(f => f.status !== 'ignored' && !f.attended).length;
    const doneCount  = Object.keys(_dsSession.completedList || {}).length;
    const remaining  = queueLen !== null ? queueLen : (
      _dsSession.totalFolders > _dsSession.scannedFolders
        ? _dsSession.totalFolders - _dsSession.scannedFolders
        : null
    );

    _dsSetCounter('ds-cnt-scanned',   _dsSession.scannedFolders || 0);
    _dsSetCounter('ds-cnt-complete',  doneCount);
    _dsSetCounter('ds-cnt-attention', attnCount);
    _dsSetCounter('ds-cnt-remaining', remaining !== null ? remaining : '—');

    // ETA
    let eta = '—';
    if (startMs && _dsRunning && remaining > 0 && _dsSession.scannedFolders > 0) {
      const elapsed = Date.now() - startMs;
      const perFolder = elapsed / _dsSession.scannedFolders;
      const secsLeft  = Math.round((perFolder * remaining) / 1000);
      if (secsLeft < 60)       eta = `${secsLeft}s`;
      else if (secsLeft < 3600) eta = `${Math.ceil(secsLeft/60)}m`;
      else                     eta = `${Math.floor(secsLeft/3600)}h${Math.ceil((secsLeft%3600)/60)}m`;
    }
    _dsSetCounter('ds-cnt-eta', eta);

    // Badges in toggle bar
    const attnBadge = document.getElementById('ds-attn-badge');
    const doneBadge = document.getElementById('ds-done-badge');
    if (attnBadge) attnBadge.textContent = attnCount;
    if (doneBadge) doneBadge.textContent = doneCount;
  }

  function _dsSetCounter(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ── Progress bar ───────────────────────────────────────── */

  function _dsUpdateProgress() {
    const fill = document.getElementById('ds-prog-fill');
    if (!fill || !_dsSession) return;
    const total = _dsSession.totalFolders || 0;
    const done  = _dsSession.scannedFolders || 0;
    fill.style.width = total > 0 ? Math.min(100, (done / total) * 100) + '%' : '0%';
  }

  /* ── Folder picker ──────────────────────────────────────── */

  // State for the folder browser modal
  let _dsModalPath   = [];  // [{id, name}] breadcrumb
  let _dsModalSel    = null; // currently highlighted {id, name}

  async function _dsOpenFolderBrowser() {
    const modal = document.getElementById('ds-folder-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    _dsModalPath = [{ id: CONFIG.ROOT_FOLDER_ID, name: CONFIG.ROOT_FOLDER_NAME }];
    _dsModalSel  = null;
    _dsUpdateModalSelectBtn();
    await _dsLoadModalFolder(CONFIG.ROOT_FOLDER_ID);
  }

  function _dsCloseModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
  }

  function _dsUpdateModalSelectBtn() {
    const btn = document.getElementById('btn-ds-modal-select');
    if (btn) btn.disabled = !_dsModalSel;
  }

  function _dsRenderModalBreadcrumb() {
    const bc = document.getElementById('ds-modal-breadcrumb');
    if (!bc) return;
    bc.innerHTML = _dsModalPath.map((crumb, i) => {
      if (i === _dsModalPath.length - 1) {
        return `<span style="color:var(--text-primary);font-weight:500">${_escHtml(crumb.name)}</span>`;
      }
      return `<span class="ds-modal-crumb" data-idx="${i}">${_escHtml(crumb.name)}</span><span class="ds-modal-crumb-sep"> › </span>`;
    }).join('');

    bc.querySelectorAll('.ds-modal-crumb').forEach(el => {
      el.addEventListener('click', async () => {
        const idx = parseInt(el.dataset.idx, 10);
        _dsModalPath = _dsModalPath.slice(0, idx + 1);
        _dsModalSel  = null;
        _dsUpdateModalSelectBtn();
        await _dsLoadModalFolder(_dsModalPath[_dsModalPath.length - 1].id);
      });
    });
  }

  async function _dsLoadModalFolder(folderId) {
    const listEl = document.getElementById('ds-modal-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="ds-attention-empty">Cargando…</div>';
    _dsRenderModalBreadcrumb();

    try {
      const page = await Drive.listFolderScan(folderId);
      listEl.innerHTML = '';

      if (page.folders.length === 0) {
        listEl.innerHTML = '<div class="ds-attention-empty">Sin subcarpetas</div>';
        return;
      }

      for (const folder of page.folders) {
        const item = document.createElement('div');
        item.className = 'ds-modal-folder-item';
        if (_dsModalSel?.id === folder.id) item.classList.add('ds-modal-folder-selected');
        item.dataset.folderId   = folder.id;
        item.dataset.folderName = folder.name;
        item.innerHTML = `
          <svg class="ds-modal-folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(folder.name)}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color:var(--text-disabled);flex-shrink:0"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>`;

        // Single click = select this folder
        item.addEventListener('click', () => {
          listEl.querySelectorAll('.ds-modal-folder-selected').forEach(el => el.classList.remove('ds-modal-folder-selected'));
          item.classList.add('ds-modal-folder-selected');
          _dsModalSel = { id: folder.id, name: folder.name };
          _dsUpdateModalSelectBtn();
        });

        // Double-click = navigate into
        item.addEventListener('dblclick', async () => {
          _dsModalPath.push({ id: folder.id, name: folder.name });
          _dsModalSel = null;
          _dsUpdateModalSelectBtn();
          await _dsLoadModalFolder(folder.id);
        });

        // Arrow button = navigate into
        item.querySelector('svg:last-child').addEventListener('click', async (e) => {
          e.stopPropagation();
          _dsModalPath.push({ id: folder.id, name: folder.name });
          _dsModalSel = { id: folder.id, name: folder.name };
          _dsUpdateModalSelectBtn();
          await _dsLoadModalFolder(folder.id);
        });

        listEl.appendChild(item);
      }
    } catch (err) {
      listEl.innerHTML = `<div class="ds-attention-empty">Error: ${_escHtml(err?.message || err)}</div>`;
    }
  }

  /* Called when user clicks "Seleccionar esta carpeta" */
  async function _dsConfirmFolderSelect() {
    if (!_dsModalSel) return;
    const { id, name } = _dsModalSel;

    // Build full path label from breadcrumb
    const fullPath = [..._dsModalPath.map(c => c.name), name].join(' › ');

    _dsCloseModal('ds-folder-modal');

    // Update session
    _dsSession.selectedFolderId   = id;
    _dsSession.selectedFolderName = fullPath;
    const nameEl = document.getElementById('ds-folder-name');
    if (nameEl) nameEl.textContent = fullPath;

    // Check if this folder (or its ancestors) was previously scanned
    await _dsCheckRescan(id, fullPath);
  }

  /* Check scan history and possibly show the rescan dialog. */
  async function _dsCheckRescan(folderId, folderLabel) {
    try {
      const scannedIds = await _dsGetScannedIds();
      // Count how many already-scanned IDs are in or equal to the selected folder
      // We check the selected folder itself and rely on session.visited for children
      const isScanned = scannedIds.has(folderId);
      // Count previously-scanned folders that are descendants (approximate)
      const prevCount = [...scannedIds].filter(id => id === folderId).length +
                        (isScanned ? 1 : 0);

      if (isScanned) {
        // Show rescan dialog
        const descEl = document.getElementById('ds-rescan-desc');
        if (descEl) {
          descEl.textContent = `"${folderLabel}" fue escaneada anteriormente. ¿Qué deseas hacer?`;
        }
        // Reset radio to skip
        const radio = document.querySelector('input[name="ds-rescan-mode"][value="skip"]');
        if (radio) radio.checked = true;

        const dialog = document.getElementById('ds-rescan-dialog');
        if (dialog) dialog.style.display = 'flex';
      }
      // If not scanned: just ready to scan normally, no dialog needed
    } catch (err) {
      console.warn('[DS] rescan check failed:', err);
    }
  }

  /* ── Start / Pause / Stop ──────────────────────────────── */

  async function _startDeepScan() {
    if (!_dsSession) await _dsLoadSession();

    // Resume from pause
    if (_dsRunning && _dsPaused) {
      _dsPaused = false;
      _dsUpdateControls();
      _dsLogLine('▶ Reanudando…', 'info');
      return;
    }
    if (_dsRunning && !_dsPaused) return;

    // Restart if done
    if (_dsSession.status === 'done') {
      _dsSession.startedAt      = new Date().toISOString();
      _dsSession.status         = 'running';
      _dsSession.scannedFolders = 0;
      _dsSession.totalFolders   = 0;
      _dsSession.visited        = [];
      _dsSession.completedList  = {};
      _dsSession.log            = [];
      _dsRestoreLog();
      _dsRenderAttentionList();
      _dsLogLine('Iniciando nuevo escaneo…', 'info');
    } else {
      if (!_dsSession.startedAt) _dsSession.startedAt = new Date().toISOString();
      _dsSession.status = 'running';
      if ((_dsSession.visited || []).length > 0) {
        _dsLogLine(`▶ Continuando (${_dsSession.visited.length} ya visitadas)…`, 'info');
      } else {
        _dsLogLine(`Iniciando escaneo en "${_dsSession.selectedFolderName}"…`, 'info');
      }
    }

    _dsRunning  = true;
    _dsPaused   = false;
    _dsStopFlag = false;
    _dsUpdateControls();
    await _dsSaveSession();

    _runDeepScan().catch(err => {
      console.error('[DeepScan] Error:', err);
      _dsLogLine('⚠ Error: ' + (err?.message || err), 'warn');
      _dsRunning = false;
      _dsUpdateControls();
    });
  }

  function _pauseDeepScan() {
    if (!_dsRunning || _dsPaused) return;
    _dsPaused = true;
    _dsUpdateControls();
    _dsLogLine('⏸ Pausado.', 'info');
    _dsSaveSession().catch(() => {});
  }

  function _stopDeepScan() {
    if (!_dsRunning) return;
    _dsStopFlag = true;
    _dsPaused   = false;
    _dsLogLine('⏹ Deteniendo…', 'info');
    _dsUpdateControls();
  }

  /* ── BFS scan loop ─────────────────────────────────────── */

  async function _runDeepScan() {
    const visitedSet   = new Set(_dsSession.visited || []);
    const nameMap      = {};   // folderId → name (for history recording)
    const newlyScanned = new Set();

    // Determine which folder IDs to skip (history-based)
    let skipIds = new Set();
    if (_dsSession.rescanMode === 'skip') {
      skipIds = await _dsGetScannedIds().catch(() => new Set());
    }

    const startFolderId   = _dsSession.selectedFolderId   || CONFIG.ROOT_FOLDER_ID;
    const startFolderName = _dsSession.selectedFolderName || CONFIG.ROOT_FOLDER_NAME;

    const queue = [{ id: startFolderId, name: startFolderName.split(' › ').pop(), path: startFolderName }];
    let discovered = 1;
    const startMs  = Date.now();

    while (queue.length > 0) {
      // Pause spin
      while (_dsPaused && !_dsStopFlag) await new Promise(r => setTimeout(r, 200));
      if (_dsStopFlag) break;

      const { id, name, path } = queue.shift();
      if (visitedSet.has(id)) continue;
      visitedSet.add(id);
      nameMap[id] = name;

      // Skip if already in history and mode is 'skip'
      if (skipIds.has(id)) {
        _dsSession.scannedFolders++;
        _dsLogLine(`↷ Omitida (ya escaneada): ${path}`);
        _dsSession.visited = [...visitedSet];
        _dsUpdateProgress();
        _dsUpdateCounters(queue.length, startMs);
        await new Promise(r => setTimeout(r, 10));
        continue;
      }

      // List contents
      let page;
      try {
        page = await Drive.listFolderScan(id);
      } catch (err) {
        if (err instanceof Drive.AuthError || err?.name === 'AuthError') {
          _dsLogLine('⚠ Sin autenticación — deteniendo.', 'warn');
          _dsStopFlag = true;
          break;
        }
        _dsLogLine(`⚠ Error en "${name}": ${err?.message || err}`, 'warn');
        continue;
      }

      // Enqueue subfolders
      for (const f of page.folders) {
        if (!visitedSet.has(f.id)) {
          const childPath = path + ' › ' + f.name;
          queue.push({ id: f.id, name: f.name, path: childPath });
          discovered++;
        }
      }

      _dsSession.scannedFolders++;
      _dsSession.totalFolders = Math.max(_dsSession.totalFolders || 0, discovered + queue.length);
      _dsSession.visited = [...visitedSet];
      newlyScanned.add(id);
      _dsUpdateProgress();
      _dsUpdateCounters(queue.length, startMs);

      if (page.audioFiles.length === 0) {
        await new Promise(r => setTimeout(r, 20));
        continue;
      }

      // Skip folders with too many files (compilations / mega-folders)
      if (page.audioFiles.length > 40) {
        _dsLogLine(`↷ Ignorada (${page.audioFiles.length} arch. > 40): ${path}`);
        _dsUpdateCounters(queue.length, startMs);
        await new Promise(r => setTimeout(r, 10));
        continue;
      }

      // ── Run full recognition pipeline — identical to manual Album Rescan ──
      _dsUpdateCounters(queue.length, startMs);

      // 1. Purge orphans (same as onAlbumRescan)
      const liveIds = page.audioFiles.map(f => f.id);
      await DB.purgeOrphans(id, liveIds).catch(() => {});

      // 2. Clear enrichment for ALL files + reset folder cover cache (same as onAlbumRescan)
      await Promise.all(page.audioFiles.map(async f => {
        await DB.clearEnrichment(f.id).catch(() => {});
        if (typeof Meta !== 'undefined') Meta.revoke(f.id);
      }));
      _folderCoverCache.delete(id);

      // 3. Log each file about to be processed
      for (const f of page.audioFiles) {
        _dsLogLine(`⟳ ${cleanTitle(f.name)}`);
      }

      // 4. Run all recognition passes with the full file array (same as onAlbumRescan)
      try {
        await _prefetchAndApplyFolderCovers(id, page.audioFiles, true);
      } catch (err) {
        _dsLogLine(`⚠ Pipeline error en "${name}": ${err?.message || err}`, 'warn');
      }

      // Pause / stop check after pipeline (can take several seconds)
      while (_dsPaused && !_dsStopFlag) await new Promise(r => setTimeout(r, 200));
      if (_dsStopFlag) break;

      // 5. Evaluate completeness post-enrichment — log each file result
      const attnSongs = [];
      for (const f of page.audioFiles) {
        const meta = await DB.getMeta(f.id).catch(() => null);
        const missingArtist = !meta?.artist;
        const missingAlbum  = !meta?.album;
        const missingYear   = !meta?.year;
        const displayTitle  = meta?.displayName || cleanTitle(f.name);
        if (missingArtist || missingAlbum || missingYear) {
          const missing = [
            missingArtist ? 'artista' : '',
            missingAlbum  ? 'álbum'   : '',
            missingYear   ? 'año'     : '',
          ].filter(Boolean).join(', ');
          _dsLogLine(`  ⚠ ${displayTitle}  (sin: ${missing})`);
          attnSongs.push({
            id: f.id, name: f.name, displayName: displayTitle,
            artist: meta?.artist || '', album: meta?.album || '',
            year: meta?.year || '', track: meta?.track || '',
            mimeType: f.mimeType || '',
            missingArtist, missingAlbum, missingYear,
          });
        } else {
          _dsLogLine(`  ✓ ${displayTitle}`);
        }
      }

      const needsAttn = attnSongs.length > 0;
      _dsLogLine(`${needsAttn ? '⚠' : '✓'} ${path}  (${page.audioFiles.length} arch.${needsAttn ? ', ' + attnSongs.length + ' sin meta' : ''})`);

      if (needsAttn) {
        const existing = _dsSession.folders[id];
        _dsSession.folders[id] = {
          id, name, path, songs: attnSongs,
          status:   existing?.status   || 'needs_attention',
          attended: existing?.attended || false,
        };
        if (_dsListMode === 'attn') _dsAddOrUpdateFolderRow(id);
      } else if (page.audioFiles.length > 0) {
        _dsSession.completedList[id] = { id, name, path, count: page.audioFiles.length };
        if (_dsListMode === 'done') _dsAddOrUpdateFolderRow(id);
      }

      _dsUpdateCounters(queue.length, startMs);

      if (_dsSession.scannedFolders % 5 === 0) await _dsSaveSession();
      await new Promise(r => setTimeout(r, 20));
    }

    // Finished
    _dsRunning = false;
    _dsPaused  = false;

    if (_dsStopFlag) {
      _dsStopFlag = false;
      _dsSession.status = 'stopped';
      _dsLogLine('⏹ Detenido — progreso guardado.', 'info');
    } else {
      _dsSession.status = 'done';
      const attnCount = Object.values(_dsSession.folders)
        .filter(f => !f.attended && f.status !== 'ignored').length;
      _dsLogLine(attnCount > 0
        ? `✅ Listo · ${_dsSession.scannedFolders} carpetas, ${attnCount} sin metadatos`
        : `✅ Listo · ${_dsSession.scannedFolders} carpetas — todo completo`, 'ok');

      // Record newly-scanned folders in Drive history
      _dsRecordScanned(newlyScanned, nameMap).catch(() => {});
      // Sync enriched metadata across devices (background, debounced)
      if (typeof Sync !== 'undefined') Sync.push('metadata');
      // Run Last.fm thumb pass so library covers are fresh
      _lfmThumbLibrary().catch(() => {});
    }

    await _dsSaveSession();
    _dsUpdateControls();
    _dsUpdateProgress();
    _dsUpdateCounters();
  }

  /* ── List rendering ─────────────────────────────────────── */

  function _dsRenderAttentionList() {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    const folders = Object.values(_dsSession?.folders || {})
      .filter(f => f.status !== 'ignored' || true);   // show all (including ignored)
    list.innerHTML = '';
    if (folders.length === 0) {
      list.innerHTML = '<div class="ds-attention-empty">Sin carpetas para mostrar aún.</div>';
      return;
    }
    for (const folder of folders) list.appendChild(_dsBuildFolderRow(folder));
  }

  function _dsRenderCompletedList() {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    const folders = Object.values(_dsSession?.completedList || {});
    list.innerHTML = '';
    if (folders.length === 0) {
      list.innerHTML = '<div class="ds-attention-empty">Ninguna carpeta completamente etiquetada aún.</div>';
      return;
    }
    for (const folder of folders) {
      const row = document.createElement('div');
      row.className = 'ds-folder-row';
      const pathParts = folder.path.split(' › ');
      const leaf      = pathParts.pop();
      const parentStr = pathParts.length ? pathParts.join(' › ') + ' › ' : '';
      row.innerHTML = `
        <div class="ds-folder-header" style="cursor:default">
          <div class="ds-status-dot green"></div>
          <div class="ds-folder-path">
            <span class="ds-folder-parent">${_escHtml(parentStr)}</span><span class="ds-folder-leaf">${_escHtml(leaf)}</span>
          </div>
          <span style="font-size:10px;color:var(--text-disabled);flex-shrink:0">${folder.count} arch.</span>
        </div>`;
      list.appendChild(row);
    }
  }

  function _dsAddOrUpdateFolderRow(folderId) {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    const empty = list.querySelector('.ds-attention-empty');
    if (empty) empty.remove();

    if (_dsListMode === 'attn') {
      const folder = _dsSession.folders[folderId];
      if (!folder) return;
      const existing = list.querySelector(`[data-folder-id="${CSS.escape(folderId)}"]`);
      if (existing) {
        const dot = existing.querySelector('.ds-status-dot');
        if (dot) dot.className = 'ds-status-dot ' + _dsDotClass(folder);
      } else {
        list.appendChild(_dsBuildFolderRow(folder));
      }
    } else {
      const folder = _dsSession.completedList?.[folderId];
      if (!folder) return;
      const existing = list.querySelector(`[data-folder-id="${CSS.escape(folderId)}"]`);
      if (!existing) {
        const row = document.createElement('div');
        row.className = 'ds-folder-row';
        row.dataset.folderId = folderId;
        const pathParts = folder.path.split(' › ');
        const leaf      = pathParts.pop();
        const parentStr = pathParts.length ? pathParts.join(' › ') + ' › ' : '';
        row.innerHTML = `
          <div class="ds-folder-header" style="cursor:default">
            <div class="ds-status-dot green"></div>
            <div class="ds-folder-path">
              <span class="ds-folder-parent">${_escHtml(parentStr)}</span><span class="ds-folder-leaf">${_escHtml(leaf)}</span>
            </div>
            <span style="font-size:10px;color:var(--text-disabled);flex-shrink:0">${folder.count} arch.</span>
          </div>`;
        list.appendChild(row);
      }
    }
  }

  function _dsDotClass(folder) {
    if (folder.status === 'ignored') return 'red';
    if (folder.attended)             return 'green';
    return 'gray';
  }

  /* ── Build folder row (for needs-attention list) ─────────── */

  function _dsBuildFolderRow(folder) {
    const dotCls  = _dsDotClass(folder);
    const ignored = folder.status === 'ignored';
    const pathParts = folder.path.split(' › ');
    const leaf      = pathParts.pop();
    const parentStr = pathParts.length ? pathParts.join(' › ') + ' › ' : '';

    const row = document.createElement('div');
    row.className = 'ds-folder-row' + (ignored ? ' ds-ignored' : '');
    row.dataset.folderId = folder.id;

    row.innerHTML = `
      <div class="ds-folder-header">
        <div class="ds-status-dot ${dotCls}"></div>
        <div class="ds-folder-path">
          <span class="ds-folder-parent">${_escHtml(parentStr)}</span><span class="ds-folder-leaf">${_escHtml(leaf)}</span>
        </div>
        <button class="ds-ignore-btn" title="${ignored ? 'Designorar' : 'Ignorar'}">${ignored ? '↩' : '✕'}</button>
        <svg class="ds-chevron" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
      </div>
      <div class="ds-folder-detail">
        ${_dsBuildTable(folder)}
        <div class="ds-table-actions">
          <button class="ds-apply-all-btn">Aplicar fila 1 a todas</button>
          <button class="ds-save-btn">Guardar</button>
        </div>
      </div>`;

    row.querySelector('.ds-folder-header').addEventListener('click', (e) => {
      if (e.target.closest('.ds-ignore-btn')) return;
      row.classList.toggle('ds-open');
    });
    row.querySelector('.ds-ignore-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _dsToggleIgnore(folder.id, row);
    });
    row.querySelector('.ds-apply-all-btn').addEventListener('click', () => _dsApplyRow1(row, folder.id));
    row.querySelector('.ds-save-btn').addEventListener('click', () => _dsSaveFolderEdits(row, folder.id));

    return row;
  }

  function _dsBuildTable(folder) {
    const rows = folder.songs.map(song => {
      const mA  = song.missingArtist ? ' missing' : '';
      const mAl = song.missingAlbum  ? ' missing' : '';
      const mY  = song.missingYear   ? ' missing' : '';
      return `<tr data-song-id="${_escHtml(song.id)}">
        <td class="ds-table-filename" title="${_escHtml(song.name)}">${_escHtml(song.displayName || cleanTitle(song.name))}</td>
        <td><input class="ds-cell-input${mA}"  data-field="artist" value="${_escHtml(song.artist)}"  placeholder="Artista"></td>
        <td><input class="ds-cell-input${mAl}" data-field="album"  value="${_escHtml(song.album)}"   placeholder="Álbum"></td>
        <td><input class="ds-cell-input${mY}"  data-field="year"   value="${_escHtml(song.year)}"    placeholder="Año" style="max-width:55px"></td>
        <td><input class="ds-cell-input"       data-field="track"  value="${_escHtml(song.track)}"   placeholder="#" style="max-width:40px"></td>
      </tr>`;
    }).join('');
    return `<table class="ds-table"><thead><tr>
      <th style="width:28%">Canción</th><th style="width:25%">Artista</th>
      <th style="width:25%">Álbum</th><th style="width:11%">Año</th><th style="width:11%">Pista</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function _escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  async function _dsToggleIgnore(folderId, rowEl) {
    const folder = _dsSession.folders[folderId];
    if (!folder) return;
    folder.status   = folder.status === 'ignored' ? 'needs_attention' : 'ignored';
    folder.attended = false;
    const ignored   = folder.status === 'ignored';
    rowEl.classList.toggle('ds-ignored', ignored);
    const dot    = rowEl.querySelector('.ds-status-dot');
    if (dot) dot.className = 'ds-status-dot ' + _dsDotClass(folder);
    const ignBtn = rowEl.querySelector('.ds-ignore-btn');
    if (ignBtn) { ignBtn.textContent = ignored ? '↩' : '✕'; ignBtn.title = ignored ? 'Designorar' : 'Ignorar'; }
    _dsUpdateCounters();
    await _dsSaveSession();
  }

  function _dsApplyRow1(rowEl) {
    const rows = rowEl.querySelectorAll('.ds-table tbody tr');
    if (rows.length < 2) return;
    const first  = rows[0];
    const artist = first.querySelector('[data-field="artist"]')?.value || '';
    const album  = first.querySelector('[data-field="album"]')?.value  || '';
    const year   = first.querySelector('[data-field="year"]')?.value   || '';
    for (let i = 1; i < rows.length; i++) {
      const aIn = rows[i].querySelector('[data-field="artist"]');
      const lIn = rows[i].querySelector('[data-field="album"]');
      const yIn = rows[i].querySelector('[data-field="year"]');
      if (aIn) { aIn.value = artist; aIn.classList.remove('missing'); }
      if (lIn) { lIn.value = album;  lIn.classList.remove('missing'); }
      if (yIn) { yIn.value = year;   yIn.classList.remove('missing'); }
    }
  }

  async function _dsSaveFolderEdits(rowEl, folderId) {
    const folder  = _dsSession.folders[folderId];
    if (!folder) return;
    const saveBtn = rowEl.querySelector('.ds-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Guardando…'; }
    try {
      const tableRows = rowEl.querySelectorAll('.ds-table tbody tr');
      let saved = 0;
      for (const tr of tableRows) {
        const songId = tr.dataset.songId;
        if (!songId) continue;
        const artist = tr.querySelector('[data-field="artist"]')?.value?.trim() || '';
        const album  = tr.querySelector('[data-field="album"]')?.value?.trim()  || '';
        const year   = tr.querySelector('[data-field="year"]')?.value?.trim()   || '';
        const track  = tr.querySelector('[data-field="track"]')?.value?.trim()  || '';
        const patch  = {};
        if (artist) patch.artist = artist;
        if (album)  patch.album  = album;
        if (year)   patch.year   = year;
        if (track)  patch.track  = track;
        if (Object.keys(patch).length > 0) {
          await DB.setMeta(songId, patch);
          saved++;
          if (artist) tr.querySelector('[data-field="artist"]')?.classList.remove('missing');
          if (album)  tr.querySelector('[data-field="album"]')?.classList.remove('missing');
          if (year)   tr.querySelector('[data-field="year"]')?.classList.remove('missing');
        }
      }
      folder.attended = true;
      folder.status   = 'needs_attention';
      const dot = rowEl.querySelector('.ds-status-dot');
      if (dot) dot.className = 'ds-status-dot green';
      rowEl.classList.remove('ds-ignored');
      _dsUpdateCounters();
      await _dsSaveSession();
      if (typeof Sync !== 'undefined') Sync.push('metadata');
      if (saveBtn) { saveBtn.textContent = '✓ Guardado'; setTimeout(() => { if(saveBtn){saveBtn.disabled=false;saveBtn.textContent='Guardar';} }, 1800); }
      UI.showToast(`${saved} canciones actualizadas`);
    } catch (err) {
      console.error('[DeepScan] Save error:', err);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Guardar'; }
      UI.showToast('Error al guardar', 'error');
    }
  }

  /* ── Tab switching ──────────────────────────────────────── */

  function _dsSwitchTab(tab) {
    document.querySelectorAll('.ds-tab').forEach(b => b.classList.toggle('active', b.dataset.dsTab === tab));
    document.querySelectorAll('.ds-tab-content').forEach(el => el.classList.toggle('active', el.id === 'ds-tab-' + tab));
    if (tab === 'artists' && !_dsArtistsLoaded) {
      _dsLoadArtists();
    }
  }

  /* ── Artistas tab ───────────────────────────────────────── */

  async function _dsLoadArtists() {
    _dsArtistsLoaded = true;
    const grid = document.getElementById('ds-artists-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="ds-attention-empty" style="grid-column:1/-1">Cargando artistas…</div>';

    try {
      // Extract unique artists from metadata
      const all = await DB.getAllMeta().catch(() => []);
      const artistMap = new Map(); // lowercase key → display name
      for (const m of all) {
        if (!m.artist) continue;
        const key = m.artist.trim().toLowerCase();
        if (!artistMap.has(key)) artistMap.set(key, m.artist.trim());
      }

      if (artistMap.size === 0) {
        grid.innerHTML = '<div class="ds-attention-empty" style="grid-column:1/-1">No hay artistas en la biblioteca aún.</div>';
        return;
      }

      // Build combined photo map:
      //   1. Auto-fetched via Last.fm / TheAudioDB (stored under 'artistImages')
      //   2. Manually set by user in this tool (stored under 'ds_artistPhotos')
      //   Manual entries override auto-fetched ones.
      const autoPhotos   = (await DB.getState('artistImages').catch(() => null))    || {};
      const manualPhotos = (await DB.getState('ds_artistPhotos').catch(() => null)) || {};
      // Merge: manual takes priority; skip null/undefined auto entries
      const photoMap = {};
      for (const [key] of artistMap) {
        const manual = manualPhotos[key];
        const auto   = autoPhotos[key];
        if (manual)      photoMap[key] = manual;
        else if (auto)   photoMap[key] = auto;
        // else: no photo
      }

      const artists = [...artistMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      _dsRenderArtists(artists, photoMap);
    } catch (err) {
      console.error('[DS Artists]', err);
      if (grid) grid.innerHTML = '<div class="ds-attention-empty" style="grid-column:1/-1">Error al cargar artistas.</div>';
    }
  }

  function _dsRenderArtists(artists, photoMap) {
    const grid = document.getElementById('ds-artists-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const withPhoto  = artists.filter(([k]) => photoMap[k]);
    const withoutPhoto = artists.filter(([k]) => !photoMap[k]);

    // Update counters
    _dsSetCounter('ds-art-con',   withPhoto.length);
    _dsSetCounter('ds-art-sin',   withoutPhoto.length);
    _dsSetCounter('ds-art-total', artists.length);

    const filtered = _dsOnlyNoPhoto ? withoutPhoto : artists;

    if (filtered.length === 0) {
      grid.innerHTML = '<div class="ds-attention-empty" style="grid-column:1/-1">Todos los artistas tienen foto.</div>';
      return;
    }

    for (const [key, name] of filtered) {
      const url = photoMap[key] || '';
      const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase();

      const card = document.createElement('div');
      card.className = 'ds-artist-card';
      card.dataset.artistKey = key;
      // Avatar: show image if available, always keep initials as fallback
      const avatarInner = url
        ? `<img src="${_escHtml(url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span style="display:none">${_escHtml(initials)}</span>`
        : `<span>${_escHtml(initials)}</span>`;

      card.innerHTML = `
        <div class="ds-artist-avatar">${avatarInner}</div>
        <span class="ds-artist-name" title="${_escHtml(name)}">${_escHtml(name)}</span>
        <div class="ds-artist-url-row">
          <input class="ds-artist-url-input" type="url" placeholder="URL de foto…" value="${_escHtml(url)}">
          <button class="ds-artist-save-btn">Guardar</button>
        </div>`;

      // Save
      card.querySelector('.ds-artist-save-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const newUrl = card.querySelector('.ds-artist-url-input').value.trim();
        const btn    = card.querySelector('.ds-artist-save-btn');
        btn.disabled = true;
        try {
          // Save to manual overrides (ds_artistPhotos)
          const manual = await DB.getState('ds_artistPhotos').catch(() => ({})) || {};
          if (newUrl) { manual[key] = newUrl; } else { delete manual[key]; }
          await DB.setState('ds_artistPhotos', manual);

          // Also write into artistImages so the Library tab picks it up immediately
          const auto = await DB.getState('artistImages').catch(() => ({})) || {};
          if (newUrl) { auto[key] = newUrl; } else if (key in auto) { auto[key] = null; }
          await DB.setState('artistImages', auto);

          // Update avatar immediately
          const avatar = card.querySelector('.ds-artist-avatar');
          if (avatar) {
            avatar.innerHTML = newUrl
              ? `<img src="${_escHtml(newUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span style="display:none">${_escHtml(initials)}</span>`
              : `<span>${_escHtml(initials)}</span>`;
          }

          // Recount by checking which cards have a visible img src
          const allCards  = [...grid.querySelectorAll('.ds-artist-card')];
          const withPhoto = allCards.filter(c => {
            const img = c.querySelector('.ds-artist-avatar img');
            return img && img.src && img.style.display !== 'none';
          }).length;
          const total = allCards.length;
          _dsSetCounter('ds-art-con',   withPhoto);
          _dsSetCounter('ds-art-sin',   total - withPhoto);
          _dsSetCounter('ds-art-total', total);

          UI.showToast(newUrl ? 'Foto guardada' : 'Foto eliminada');
        } catch (err) {
          console.error('[DS] Save artist photo error:', err);
          UI.showToast('Error al guardar', 'error');
        }
        btn.disabled = false;
      });

      grid.appendChild(card);
    }
  }

  /**
   * Iterates all songs in the DB and runs MusicBrainz lookup for those missing
   * text metadata (artist, album, year, track). Runs sequentially at 1 req/sec.
   * Designed to run once per session in the background after _scanLibraryBackground.
   */
  async function _mbEnrichLibrary() {
    if (typeof MusicBrainz === 'undefined') return;

    const all = await DB.getAllMeta().catch(() => []);
    const candidates = all.filter(m => {
      if (!m.id) return false;
      if (m.mbTried) return false;
      const title = m.displayName || m.name || '';
      if (!title) return false;
      return !m.artist || !m.album || !m.year || !m.track;
    });

    if (candidates.length === 0) return;
    console.log(`[MusicBrainz] Library enrichment: ${candidates.length} songs to process…`);

    let enriched = 0;
    for (const m of candidates) {
      // Abort if user navigated away from library or lost auth
      if (!Auth.getValidToken()) break;

      try {
        const title  = m.displayName || m.name || '';
        const artist = m.artist || '';
        const album  = m.album  || '';

        const result = await MusicBrainz.lookup(m.id, title, artist, album);
        DB.setMeta(m.id, { mbTried: true }).catch(() => {});
        if (!result) continue;

        const patch = {};
        // _mbEnrichLibrary runs standalone (no ID3 pass after it), so keep guards
        // to avoid overwriting ID3-sourced values already in DB.
        if (result.track       && !m.track)  patch.track        = result.track;
        if (result.artist      && !m.artist) patch.artist       = result.artist;
        if (result.album       && !m.album)  patch.album        = result.album;
        if (result.year        && !m.year)   patch.year         = result.year;
        if (result.releaseMbid)              patch.mbReleaseMbid = result.releaseMbid;

        const textFields = Object.keys(patch).filter(k => k !== 'mbReleaseMbid');
        if (textFields.length === 0 && !patch.mbReleaseMbid) continue;

        await DB.setMeta(m.id, patch);
        enriched++;

        // Patch visible DOM text if the song is currently displayed
        if (textFields.some(k => ['artist','album','year'].includes(k))) {
          _patchMetaText(m.id, {
            title:  null,
            artist: patch.artist || m.artist || null,
            album:  patch.album  || m.album  || null,
            year:   patch.year   || m.year   || null,
          });
        }
      } catch (_) { /* non-fatal — continue to next song */ }
    }

    if (enriched > 0) {
      console.log(`[MusicBrainz] Library enrichment complete: ${enriched} songs enriched.`);
      // Refresh album/artist grid if not inside a drill-down
      if (!_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
      }
    }

    // After MB enrichment, fetch Last.fm thumbnails for albums still without a cover URL.
    // This ensures album cards show images even for albums MB didn't find,
    // and provides syncable external URLs so other devices can display the covers too.
    _lfmThumbLibrary().catch(() => {});
  }

  /**
   * Background Last.fm thumbnail enrichment for the Library.
   * Runs after _mbEnrichLibrary. For each album folder that has artist+album
   * metadata but no thumbnailUrl, fetches a cover URL from Last.fm and stores
   * it so the album grid can show the image without the user entering each album.
   * Also triggers a metadata sync push so the URLs reach other devices.
   *
   * De-duplication:
   *   • In-memory: Lastfm module caches by "artist::album" → 1 request per unique album
   *   • Cross-session: once thumbnailUrl is in DB, song is excluded from candidates
   */
  // Max Last.fm album lookups per session (avoids flooding the API on first run).
  // Albums already tried (lfmThumbTried=true in DB) are skipped regardless of this cap.
  const LFM_THUMB_SESSION_CAP = 80;
  let _lfmThumbRunning = false; // guard: only one instance at a time

  async function _lfmThumbLibrary() {
    if (typeof Lastfm === 'undefined') return;
    if (_lfmThumbRunning) return; // already in progress — skip silently
    _lfmThumbRunning = true;

    try {
      const all = await DB.getAllMeta().catch(() => []);

      // Build one entry per folder: pick the most-common artist+album for the lookup.
      // Skip folders where:
      //   • any song already has thumbnailUrl (cover already resolved), OR
      //   • any song has lfmThumbTried=true (already attempted this session or previously)
      const folderData = new Map();
      for (const m of all) {
        if (!m.folderId || !m.artist || !m.album) continue;
        if (!folderData.has(m.folderId)) {
          folderData.set(m.folderId, {
            artistCounts: new Map(), albumCounts: new Map(),
            songIds: [], skip: false, repId: null,
          });
        }
        const f = folderData.get(m.folderId);
        if (f.skip) continue;
        if (m.thumbnailUrl || m.lfmThumbTried) { f.skip = true; continue; }
        f.artistCounts.set(m.artist, (f.artistCounts.get(m.artist) || 0) + 1);
        f.albumCounts.set(m.album,   (f.albumCounts.get(m.album)   || 0) + 1);
        f.songIds.push(m.id);
        if (!f.repId) f.repId = m.id;
      }

      const _top = map => map.size > 0
        ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : null;

      const candidates = [];
      for (const [, f] of folderData) {
        if (f.skip || f.songIds.length === 0) continue;
        const artist = _top(f.artistCounts);
        const album  = _top(f.albumCounts);
        if (artist && album) candidates.push({ artist, album, songIds: f.songIds, repId: f.repId });
      }

      if (candidates.length === 0) return;
      const toTry = candidates.slice(0, LFM_THUMB_SESSION_CAP);
      console.log(`[LastFm] Thumbnail enrichment: ${toTry.length} albums to try…`);

      let fetched = 0;
      for (const { artist, album, songIds, repId } of toTry) {
        if (!Auth.getValidToken()) break;
        try {
          const url = await Lastfm.fetchCover(artist, album);
          if (repId) DB.setMeta(repId, { lfmThumbTried: true }).catch(() => {});
          if (!url) continue;
          await Promise.all(songIds.map(id =>
            DB.setMeta(id, { thumbnailUrl: url }).catch(() => {})
          ));
          fetched++;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 150));
      }

      if (fetched > 0) {
        console.log(`[LastFm] Thumbnail enrichment: covers found for ${fetched} albums.`);
        if (typeof Sync !== 'undefined') Sync.push('metadata');
        if (!_libInDetail) {
          if (_currentLibTab === 'albums')  _loadAlbums();
          if (_currentLibTab === 'artists') _loadArtists();
        }
      }
    } finally {
      _lfmThumbRunning = false; // always release the lock, even on error
    }
  }

  /**
   * Infer and persist album metadata for a batch of audio files in the same folder.
   * @returns {number} count of files patched
   */
  async function _inferAlbumMeta(albumName, artistName, audioFiles, imageFiles) {
    // ── Find the best cover for this folder ─────────────────
    let coverUrl = null;

    // 1. Prefer a cover/folder/artwork image file in the folder
    const COVER_RE = /^(cover|folder|artwork|front|album)\./i;
    const IMAGE_EXT = /\.(jpg|jpeg|png|webp)$/i;
    const coverFile = imageFiles.find(f => COVER_RE.test(f.name) && IMAGE_EXT.test(f.name))
                   || imageFiles.find(f => IMAGE_EXT.test(f.name));
    if (coverFile?.thumbnailLink) coverUrl = coverFile.thumbnailLink;

    // 2. Most common thumbnailLink among audio files
    //    (happens when Drive generates artwork from embedded ID3 album art)
    if (!coverUrl) {
      const thumbs = audioFiles.map(f => f.thumbnailUrl).filter(Boolean);
      if (thumbs.length > 0) {
        const freq = new Map();
        for (const t of thumbs) freq.set(t, (freq.get(t) || 0) + 1);
        const best = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best) coverUrl = best[0];
      }
    }

    // 3. Fall back to any thumbnailUrl already stored in DB for songs in this folder
    if (!coverUrl) {
      for (const f of audioFiles) {
        const m = await DB.getMeta(f.id).catch(() => null);
        if (m?.thumbnailUrl) { coverUrl = m.thumbnailUrl; break; }
      }
    }

    // ── Determine artist label ───────────────────────────────
    // Only use parentName as artist if it's not the root folder
    const inferredArtist = (artistName && artistName !== CONFIG.ROOT_FOLDER_NAME)
      ? artistName
      : '';

    // ── Patch DB for each file ───────────────────────────────
    let count = 0;
    for (const file of audioFiles) {
      const existing = await DB.getMeta(file.id).catch(() => null);

      const patch = {};
      // Never overwrite values that were already enriched (ID3 / Last.fm / AudD)
      if (!existing?.album  && albumName)       patch.album       = albumName;
      if (!existing?.artist && inferredArtist)  patch.artist      = inferredArtist;
      if (!existing?.thumbnailUrl && coverUrl)  patch.thumbnailUrl = coverUrl;

      // Always ensure basic file info is present so the song is playable from Library
      if (!existing?.name)        patch.name        = file.name;
      if (!existing?.displayName) patch.displayName = file.displayName || cleanTitle(file.name);
      if (!existing?.folderId)    patch.folderId    = file.parents?.[0] || null;
      // Persist mimeType so format badge works without re-scanning Drive
      if (!existing?.mimeType && file.mimeType) patch.mimeType = file.mimeType;

      if (Object.keys(patch).length > 0) {
        await DB.setMeta(file.id, { id: file.id, ...patch });
        count++;
      }

      // Keep item in the in-memory cache so it's clickable from Library
      _cacheItem({
        ...file,
        folderId:    file.parents?.[0] || null,
        artist:      (existing?.artist || patch.artist || ''),
        album:       (existing?.album  || patch.album  || ''),
        thumbnailUrl:(existing?.thumbnailUrl || patch.thumbnailUrl || null),
      });
    }

    // NOTE: Sync.push('metadata') is NOT called here.
    // _inferAlbumMeta is called in a loop (BFS scan, rescan) and pushing per-folder
    // would saturate the debounce queue, causing one full metadata write per folder.
    // Callers (_scanLibraryBackground, _fullLibraryRefresh) issue a single push after
    // the entire loop completes.
    return count;
  }

  /**
   * Propagate enriched album metadata to sibling songs in the same folder.
   * Called after _onBlobReady FINALIZE when a song is identified by ID3/Last.fm/AudD.
   * Only patches DB entries that are missing the field — never overwrites enriched values.
   *
   * @param {DriveItem} item  - the identified song (has .parents[0] = folderId)
   * @param {Object}    meta  - enriched metadata object (album, artist, year, coverUrl)
   */
  async function _propagateAlbumMeta(item, meta) {
    const folderId = item.parents?.[0];
    if (!folderId) return;

    const album    = meta.album    || null;
    const artist   = meta.artist   || null;
    const year     = meta.year     || null;
    const coverUrl = meta.coverUrl || null;
    if (!album && !artist && !year && !coverUrl) return;

    try {
      const all = await DB.getAllMeta();
      let updated = 0;

      for (const m of all) {
        if (!m.id || m.id === item.id) continue;
        if (m.folderId !== folderId)   continue;    // only siblings in same folder

        const patch = {};
        if (album    && !m.album)        patch.album        = album;
        if (artist   && !m.artist)       patch.artist       = artist;
        if (year     && !m.year)         patch.year         = year;
        if (coverUrl && !m.thumbnailUrl) patch.thumbnailUrl = coverUrl;
        if (Object.keys(patch).length === 0) continue;

        await DB.setMeta(m.id, patch);
        updated++;
      }

      // Refresh the active library tab so updated album data shows immediately.
      // Skip if the user is inside a detail view — the list re-renders on back-navigation.
      if (updated > 0 && !_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
      }

      // Propagation writes artist/album/year to siblings — sync to Drive for cross-device
      if (updated > 0 && typeof Sync !== 'undefined') Sync.push('metadata');
    } catch (err) {
      console.warn('[App] _propagateAlbumMeta error:', err);
    }
  }

  /**
   * Aggregate all metadata into artists map.
   * Groups by artist name, counts albums and songs.
   */
  async function _loadArtists() {
    if (_libInDetail) return; // don't replace a drill-down view
    try {
      const all = await DB.getAllMeta();
      const artistMap = new Map();
      all.forEach(m => {
        // Strip collaborators after ';' — e.g. "3 Doors Down;Josh Freese" → "3 Doors Down"
        const name = (m.artist || '').split(';')[0].trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (!artistMap.has(key)) {
          artistMap.set(key, { name, songCount: 0, albumSet: new Set() });
        }
        const a = artistMap.get(key);
        a.songCount++;
        const album = (m.album || '').trim();
        if (album) a.albumSet.add(album.toLowerCase());
      });

      // Load persisted artist images (stored from previous TheAudioDB enrichment)
      const storedImages = (await DB.getState('artistImages').catch(() => null)) || {};

      const artists = Array.from(artistMap.values())
        .map(a => ({
          name:       a.name,
          songCount:  a.songCount,
          albumCount: a.albumSet.size || 1,
          imageUrl:   storedImages[a.name.toLowerCase()] || null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      UI.renderArtists(artists);
      _setLibTabCount('artists', artists.length);

      // Re-apply any active search filter (persisted from before a drill-down)
      const q = document.getElementById('lib-search-input')?.value || '';
      if (q) _onLibSearch(q);

      // Fetch missing artist photos in background (non-blocking)
      _enrichArtistImages(artists, storedImages).catch(() => {});
    } catch (err) {
      console.error('[App] Load artists error:', err);
    }
  }

  /* ── Artist image enrichment ─────────────────────────────── */

  let _artistImgRunning = false;

  /**
   * For each artist not yet in storedImages, fetch a photo from TheAudioDB.
   * Updates the DOM avatar in real-time as images arrive.
   * Results are persisted to DB so they load instantly on next session.
   *
   * @param {Object[]} artists      — current artist list
   * @param {Object}   storedImages — { artistNameLower: url|null } already in DB
   */
  async function _enrichArtistImages(artists, storedImages) {
    if (typeof Lastfm?.fetchArtistImage !== 'function') return;
    if (_artistImgRunning) return;
    _artistImgRunning = true;

    try {
      // Only fetch artists with no stored result (undefined = never tried;
      // null = tried before and no image found — skip to save quota)
      const toFetch = artists.filter(a => !(a.name.toLowerCase() in storedImages));
      if (toFetch.length === 0) return;

      console.log(`[Artists] Fetching images for ${toFetch.length} artists…`);
      const updates = { ...storedImages };
      let fetched = 0;

      for (const artist of toFetch) {
        if (!Auth.getValidToken()) break;
        // Stop if the user navigated away from the artist grid
        if (_libInDetail || _currentLibTab !== 'artists') break;

        const key = artist.name.toLowerCase();
        const url = await Lastfm.fetchArtistImage(artist.name);
        updates[key] = url; // null stored so we don't retry next session

        if (url) {
          // Update the avatar DOM immediately — no full re-render needed
          document.querySelectorAll('.lib-artist-avatar[data-artist-key]').forEach(el => {
            if (el.dataset.artistKey === key) {
              el.style.background = '';
              el.style.color = '';
              el.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
            }
          });
          fetched++;

          // Persist every 5 successful fetches so partial progress survives reload
          if (fetched % 5 === 0) DB.setState('artistImages', updates).catch(() => {});
        }

        await new Promise(r => setTimeout(r, 500)); // 500ms — polite to TheAudioDB
      }

      // Final persist
      if (toFetch.length > 0) await DB.setState('artistImages', updates).catch(() => {});
      if (fetched > 0) console.log(`[Artists] ${fetched} artist images loaded.`);
    } finally {
      _artistImgRunning = false;
    }
  }

  /**
   * Aggregate all metadata into albums map.
   * Groups by album name (+ artist), counts songs, picks a cover.
   */
  /**
   * Update the count badge on a library tab.
   * @param {'albums'|'artists'|'playlists'|'fav'} tab
   * @param {number} count
   */
  function _setLibTabCount(tab, count) {
    const el = document.getElementById(`lib-count-${tab}`);
    if (!el) return;
    el.textContent = count > 0 ? count : '';
  }

  /**
   * Maps a MIME type (or filename) to a short format badge label.
   * Falls back to uppercase extension if MIME is unknown.
   * @param {string} mimeType
   * @param {string} [filename]
   * @returns {string|null}
   */
  function _formatLabel(mimeType, filename) {
    const MIME_MAP = {
      'audio/mpeg':    'MP3', 'audio/mp3':       'MP3',
      'audio/flac':    'FLAC','audio/x-flac':    'FLAC',
      'audio/ogg':     'OGG', 'audio/vorbis':    'OGG',
      'audio/opus':    'OPUS',
      'audio/aac':     'AAC',
      'audio/mp4':     'AAC', 'audio/m4a':       'AAC', 'audio/x-m4a': 'AAC',
      'audio/wav':     'WAV', 'audio/x-wav':     'WAV',
      'audio/x-ms-wma':'WMA', 'audio/wma':       'WMA',
    };
    if (mimeType) {
      const base = mimeType.split(';')[0].trim().toLowerCase();
      if (MIME_MAP[base]) return MIME_MAP[base];
    }
    // Fallback: derive from filename extension
    if (filename) {
      const ext = filename.split('.').pop().toLowerCase();
      const EXT_MAP = { mp3:'MP3', flac:'FLAC', ogg:'OGG', opus:'OPUS', aac:'AAC', m4a:'AAC', wav:'WAV', wma:'WMA' };
      if (EXT_MAP[ext]) return EXT_MAP[ext];
    }
    return null;
  }

  async function _loadAlbums() {
    if (_libInDetail) return; // don't replace a drill-down view
    try {
      const all = await DB.getAllMeta();

      // Total songs per folder (includes untagged — used for accurate song count)
      const folderSongCount = new Map();
      all.forEach(m => { if (m.folderId) folderSongCount.set(m.folderId, (folderSongCount.get(m.folderId) || 0) + 1); });

      // ── Group by folderId first: one folder = one album ───────────────────────
      // Songs with different album tags but the same folder are merged (majority name wins).
      // Songs in different folders are always separate entries even if they share a name.
      const folderMap = new Map(); // folderId → accumulator

      all.forEach(m => {
        const album  = (m.album  || '').trim();
        const artist = (m.artist || '').split(';')[0].trim(); // strip collaborators after ';'
        if (!album || !m.folderId) return; // skip untagged or folder-less songs
        if (!folderMap.has(m.folderId)) {
          folderMap.set(m.folderId, {
            folderId:     m.folderId,
            albumCounts:  new Map(),
            artistCounts: new Map(),
            yearCounts:   new Map(),
            formatCounts: new Map(),
            coverUrl:     null,  // first thumbnailUrl found (external, synced — preferred)
            blobId:       null,  // first song id with coverBlob (deferred — only used as fallback)
            blobData:     null,  // the coverBlob itself
            taggedCount:  0,
          });
        }
        const f = folderMap.get(m.folderId);
        f.taggedCount++;
        f.albumCounts.set(album,  (f.albumCounts.get(album)  || 0) + 1);
        if (artist) f.artistCounts.set(artist, (f.artistCounts.get(artist) || 0) + 1);
        if (m.year) f.yearCounts.set(m.year,   (f.yearCounts.get(m.year)   || 0) + 1);
        // Track dominant audio format (mimeType → short label)
        const fmt = _formatLabel(m.mimeType, m.name);
        if (fmt) f.formatCounts.set(fmt, (f.formatCounts.get(fmt) || 0) + 1);
        // Cover priority: thumbnailUrl (external, synced) > coverBlob (embedded, local).
        // thumbnailUrl comes from MB/CAA/Last.fm and is authoritative after rescan.
        // We must NOT stop at the first coverBlob — a later song may have thumbnailUrl.
        if (!f.coverUrl && m.thumbnailUrl) f.coverUrl = m.thumbnailUrl;
        // Blob is a fallback: store the first one found, created lazily only if no external URL.
        if (!f.blobId && m.coverBlob) { f.blobId = m.id; f.blobData = m.coverBlob; }
      });

      const _top = map => map.size > 0
        ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : null;

      const albums = Array.from(folderMap.values())
        .map(f => {
          const name      = _top(f.albumCounts);
          const artist    = _top(f.artistCounts) || '';
          const year      = _top(f.yearCounts);
          const format    = _top(f.formatCounts) || null;
          const songCount = Math.max(f.taggedCount, folderSongCount.get(f.folderId) || 0);
          // Use external URL if available; only fall back to blob if nothing else
          const coverUrl  = f.coverUrl
            || (f.blobId && f.blobData && typeof Meta !== 'undefined'
                ? Meta.injectCover(f.blobId, f.blobData)
                : null);
          return { name, artist, songCount, coverUrl, year, format, folderId: f.folderId };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      UI.renderLibraryAlbums(albums);
      _setLibTabCount('albums', albums.length);
      // Re-apply any active search filter (persisted from before a drill-down)
      const q = document.getElementById('lib-search-input')?.value || '';
      if (q) _onLibSearch(q);
    } catch (err) {
      console.error('[App] Load albums error:', err);
    }
  }

  /**
   * Show albums for a given artist (drill-down from artist grid).
   */
  async function onArtistClick(artist) {
    try {
      const all = await DB.getAllMeta();
      const artistKey = artist.name.toLowerCase();

      const folderSongCount = new Map();
      all.forEach(m => { if (m.folderId) folderSongCount.set(m.folderId, (folderSongCount.get(m.folderId) || 0) + 1); });

      // Group by folderId — same rule as _loadAlbums, but scoped to this artist
      const folderMap = new Map();
      all.forEach(m => {
        if ((m.artist || '').split(';')[0].trim().toLowerCase() !== artistKey) return;
        const album = (m.album || '').trim();
        if (!album || !m.folderId) return;
        if (!folderMap.has(m.folderId)) {
          folderMap.set(m.folderId, {
            folderId:     m.folderId,
            albumCounts:  new Map(),
            yearCounts:   new Map(),
            formatCounts: new Map(),
            coverUrl:     null,
            hasBlobCover: false,
            taggedCount:  0,
          });
        }
        const f = folderMap.get(m.folderId);
        f.taggedCount++;
        f.albumCounts.set(album, (f.albumCounts.get(album) || 0) + 1);
        if (m.year) f.yearCounts.set(m.year, (f.yearCounts.get(m.year) || 0) + 1);
        const fmt = _formatLabel(m.mimeType, m.name);
        if (fmt) f.formatCounts.set(fmt, (f.formatCounts.get(fmt) || 0) + 1);
        if (!f.hasBlobCover) {
          if (m.coverBlob && typeof Meta !== 'undefined') {
            const url = Meta.injectCover(m.id, m.coverBlob);
            if (url) { f.coverUrl = url; f.hasBlobCover = true; }
          } else if (m.thumbnailUrl) {
            f.coverUrl = m.thumbnailUrl;
          }
        }
      });

      const _top = map => map.size > 0
        ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : null;

      const albums = Array.from(folderMap.values())
        .map(f => {
          const name      = _top(f.albumCounts);
          const year      = _top(f.yearCounts);
          const format    = _top(f.formatCounts) || null;
          const songCount = Math.max(f.taggedCount, folderSongCount.get(f.folderId) || 0);
          return { name, artist: artist.name, songCount, coverUrl: f.coverUrl, year, format, folderId: f.folderId };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      _libInDetail = true;
      UI.renderLibraryArtistDetail(artist, albums);
      UI.setLibSearchPlaceholder(`Buscar álbum de ${artist.name}…`);
      const q = document.getElementById('lib-search-input')?.value || '';
      if (q) _onLibSearch(q);
    } catch (err) {
      console.error('[App] onArtistClick error:', err);
    }
  }

  /**
   * Show songs for a given album (drill-down from album grid or artist detail).
   */
  async function onAlbumClick(album, fromArtist) {
    try {
      const all = await DB.getAllMeta();

      // When the album object carries a folderId (always the case after the new
      // folder-first grouping), use the folder as the canonical source of truth.
      // This guarantees that two albums with the same name in different folders
      // are always kept separate and show exactly the right tracks.
      let songs;
      if (album.folderId) {
        songs = all.filter(m => m.folderId === album.folderId);
      } else {
        // Fallback for album objects without folderId (e.g. from old cached data)
        const albumKey  = album.name.toLowerCase();
        const artistKey = (album.artist || '').toLowerCase();
        const tagged = all.filter(m => {
          const mAlbum  = (m.album  || '').trim().toLowerCase();
          const mArtist = (m.artist || '').trim().toLowerCase();
          const matchAlbum  = mAlbum === albumKey || (albumKey === '(sin álbum)' && !mAlbum);
          const matchArtist = !artistKey || mArtist === artistKey;
          return matchAlbum && matchArtist;
        });
        const folderIds = new Set(tagged.map(m => m.folderId).filter(Boolean));
        const taggedIds = new Set(tagged.map(m => m.id));
        const extra = folderIds.size > 0
          ? all.filter(m => m.folderId && folderIds.has(m.folderId) && !taggedIds.has(m.id))
          : [];
        songs = [...tagged, ...extra];
      }

      const toMap = m => ({
        id:           m.id,
        name:         m.name         || m.id,
        displayName:  m.displayName  || m.name || m.id,
        artist:       m.artist       || '',
        album:        m.album        || '',
        year:         m.year         || '',
        track:        m.track        || '',
        thumbnailUrl: m.thumbnailUrl || m.coverUrl || null,
        folderId:     m.folderId     || null,
      });

      // Sort: by track number (ID3, e.g. "3" or "3/12"), then by name
      const sorted = songs.map(toMap).sort((a, b) => {
        const ta = parseInt(a.track, 10);
        const tb = parseInt(b.track, 10);
        if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
        if (!isNaN(ta)) return -1;
        if (!isNaN(tb)) return  1;
        return (a.displayName || a.name).localeCompare(b.displayName || b.name);
      });

      // Resolve covers
      const enriched = await Promise.all(sorted.map(async s => {
        const url = await _resolveCoverUrl(s.id, s.thumbnailUrl);
        return url ? { ...s, thumbnailUrl: url } : s;
      }));

      const backTarget = fromArtist ? 'artist' : 'albums';
      _libInDetail = true;
      UI.renderLibraryAlbumDetail(album, enriched, backTarget, fromArtist || null);
      UI.setLibSearchPlaceholder(`Buscar en ${album.name}…`);

      // Background cover + metadata enrichment for songs in this album.
      // Uses the same multi-pass pipeline as the browse folder view:
      // DB → ID3 blob parse → Last.fm → folder cover.jpg
      // _updateRowThumbnail now targets both .song-row and .top-list-item rows.
      if (enriched.length > 0 && Auth.getValidToken()) {
        const folderId = enriched.find(s => s.folderId)?.folderId || null;
        _prefetchAndApplyFolderCovers(folderId, enriched).catch(() => {});
      }
    } catch (err) {
      console.error('[App] onAlbumClick error:', err);
    }
  }

  /** Called from the "Nueva playlist" button rendered inside the Playlists tab. */
  async function _onNewPlaylist() {
    const name = prompt(UI.t('prompt_playlist_name'), UI.t('prompt_playlist_default'));
    if (!name || !name.trim()) return;
    await DB.createPlaylist(name.trim());
    UI.showToast(`"${name.trim()}" — ${UI.t('toast_pl_created')}`);
    _loadPlaylists();
    Sync.push('playlists');
  }

  async function onPlaylistClick(pl) {
    try {
      // Load full playlist from DB to get fresh songIds
      const fullPl = await DB.getPlaylist(pl.id).catch(() => pl);
      const songIds = (fullPl || pl).songIds || [];
      if (songIds.length === 0) {
        UI.renderPlaylistDetail([], pl.name);
        return;
      }
      // Fetch cached metadata and resolve cover URL for each song
      const songs = (await Promise.all(
        songIds.map(async id => {
          const m = await DB.getMeta(id).catch(() => null);
          if (!m) return null;
          // Resolve cover via the same chain used by favorites: DB coverBlob → Meta cache
          const thumbnailUrl = await _resolveCoverUrl(id, m.thumbnailUrl);
          // _playlistId lets the context menu offer "Remove from playlist"
          return { id, ...m, thumbnailUrl, _playlistId: (fullPl || pl).id };
        })
      )).filter(Boolean);
      UI.renderPlaylistDetail(songs, pl.name);
      // Drive fallback: fetch thumbnailLink for songs still without cover after local passes
      _driveThumbFallback(
        songs.filter(s => !s.thumbnailUrl),
        _songRowHasCover,
        _updateSongRowThumb
      ).catch(() => {});
    } catch (err) {
      console.error('[App] onPlaylistClick error:', err);
      UI.showToast(UI.t('toast_playlist_error'), 'error');
    }
  }

  /* ── Playlist actions (from sidebar context menu) ───────── */

  async function _getPlaylistSongs(pl) {
    const fullPl = await DB.getPlaylist(pl.id).catch(() => pl);
    const songIds = (fullPl || pl).songIds || [];
    return songIds.map(id => _itemCache.get(id) || { id }).filter(Boolean);
  }

  async function onPlaylistPlay(pl) {
    try {
      const songs = await _getPlaylistSongs(pl);
      if (songs.length === 0) { UI.showToast(UI.t('toast_playlist_empty'), 'error'); return; }
      _resetRadio(); // playlist = curated queue, no radio expansion
      Player.setQueue(songs, 0);
    } catch (err) { UI.showToast(UI.t('toast_playlist_play_error'), 'error'); }
  }

  async function onPlaylistQueue(pl, mode) {
    try {
      const songs = await _getPlaylistSongs(pl);
      if (songs.length === 0) { UI.showToast(UI.t('toast_playlist_empty'), 'error'); return; }
      if (mode === 'next') Player.insertNext(songs);
      else                 Player.appendToQueue(songs);
      UI.showToast(mode === 'next' ? UI.t('play_next') : UI.t('play_after'));
    } catch (err) { UI.showToast(UI.t('toast_folder_error'), 'error'); }
  }

  async function onRenamePlaylist(pl) {
    const newName = prompt(UI.t('prompt_rename_playlist'), pl.name);
    if (!newName || newName.trim() === pl.name) return;
    await DB.updatePlaylist(pl.id, { name: newName.trim() });
    UI.showToast(`"${newName.trim()}" — ${UI.t('ctx_rename').toLowerCase()}`);
    _loadPlaylists();
    Sync.push('playlists');
  }

  async function onDeletePlaylist(pl) {
    if (!confirm(`${UI.t('confirm_delete_playlist')} "${pl.name}"?`)) return;
    await DB.deletePlaylist(pl.id);
    UI.showToast(`"${pl.name}" — ${UI.t('ctx_delete').toLowerCase()}`);
    _loadPlaylists();
    Sync.push('playlists');
    // If this playlist was showing in detail pane, clear it
    const container = document.getElementById('lib-detail-content');
    if (container) container.innerHTML = '';
  }

  /**
   * Remove a single song from a playlist (called from song context menu).
   * @param {string} songId
   * @param {string} playlistId
   */
  async function onRemoveFromPlaylist(songId, playlistId) {
    try {
      await DB.removeFromPlaylist(playlistId, songId);
      UI.showToast(UI.t('toast_removed_pl'));
      // Refresh detail pane with updated song list
      const pl = await DB.getPlaylist(playlistId).catch(() => null);
      if (pl) onPlaylistClick(pl);
      // Refresh sidebar covers (song count may have changed)
      _loadPlaylists();
    } catch (err) {
      UI.showToast(UI.t('toast_pl_remove_error'), 'error');
    }
  }

  /* ── Queue panel actions ─────────────────────────────────── */

  /**
   * Jump to a specific queue position (called from queue panel item click).
   * @param {number} queueIndex
   */
  function onQueueItemClick(queueIndex) {
    Player.jumpTo(queueIndex);
    // Stay on queue panel so user can see the new current track highlighted
    const { queue, index } = Player.getQueue();
    UI.renderQueuePanel(queue, index);
    _prefetchQueueCovers(queue).catch(() => {});
  }

  /**
   * Remove a track from the queue (called from queue panel × button).
   * @param {number} queueIndex
   */
  function onQueueItemRemove(queueIndex) {
    Player.removeFromQueue(queueIndex);
    // renderQueuePanel will be called via _onQueueChange → already handles it
  }

  /* ── Mini-player events ──────────────────────────────────── */

  function onMiniPlayerClick(e) {
    // Prevent click-through when buttons are tapped
    if (e.target.closest('button')) return;
    const track = Player.getCurrentTrack();
    if (!track) return;
    // Open expanded player — enrich with cached ID3 metadata if available
    UI.updateExpandedPlayer(_enrichTrack(track), Player.isPlaying());
    const dur = Player.getDuration();
    const cur = Player.getCurrentTime?.() || 0;
    UI.updateExpandedPlayerProgress(cur, dur);
    UI.setExpandedPlayerVisible(true);
  }

  function _closeExpandedPlayer() {
    UI.setExpandedPlayerVisible(false);
  }

  /* ── Lyrics helpers ─────────────────────────────────────────
   * Opens the lyrics panel, fetches/shows lyrics for the current
   * track. Lyrics are prefetched after all recognition passes, so
   * most of the time the result is already in cache.
   */
  function _openLyricsView() {
    const expanded = document.getElementById('player-expanded');
    if (!expanded) return;
    expanded.classList.remove('showing-queue');
    expanded.classList.add('showing-lyrics');
    _loadLyricsForCurrentTrack();
  }

  function _closeLyricsView() {
    const expanded = document.getElementById('player-expanded');
    if (expanded) expanded.classList.remove('showing-lyrics');
  }

  async function _loadLyricsForCurrentTrack() {
    const lyricsContent = document.getElementById('lyrics-content');
    if (!lyricsContent) return;

    const track = Player.getCurrentTrack();
    if (!track) {
      lyricsContent.innerHTML = `<div class="lyrics-status">${UI.t('lyrics_not_found')}</div>`;
      return;
    }

    // Resolve artist + title from in-memory meta cache, then DB
    const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(track.id) : null;
    const dbMeta = await DB.getMeta(track.id).catch(() => null);
    const artist = inMem?.artist || dbMeta?.artist || '';
    const title  = inMem?.title  || dbMeta?.displayName || track.displayName || track.name || '';

    if (!artist || !title) {
      lyricsContent.innerHTML = `<div class="lyrics-status">${UI.t('lyrics_not_found')}</div>`;
      return;
    }

    if (typeof Lyrics === 'undefined') {
      lyricsContent.innerHTML = `<div class="lyrics-status">${UI.t('lyrics_not_found')}</div>`;
      return;
    }

    // Check if already cached (prefetch may have completed)
    const cached = Lyrics.getCached(artist, title);
    if (cached !== undefined) {
      _renderLyricsContent(lyricsContent, cached, track.id);
      return;
    }

    // Show loading state, then fetch
    lyricsContent.innerHTML = `<div class="lyrics-status">${UI.t('lyrics_loading')}</div>`;
    const lyrics = await Lyrics.fetch(artist, title).catch(() => null);

    // Guard: track may have changed while fetching
    if (Player.getCurrentTrack()?.id !== track.id) return;
    _renderLyricsContent(lyricsContent, lyrics, track.id);
  }

  function _renderLyricsContent(container, lyrics) {
    if (!lyrics) {
      container.innerHTML = `<div class="lyrics-status">${UI.t('lyrics_not_found')}</div>`;
      return;
    }
    container.innerHTML = '';
    const div = document.createElement('div');
    div.textContent = lyrics;
    container.appendChild(div);
  }

  /**
   * Navigate Browse to the folder containing the currently playing track.
   */
  async function goToCurrentTrackFolder() {
    const track = Player.getCurrentTrack();
    if (!track) return;

    try {
      // Source 1: item cache (items browsed from Drive, have parents[])
      const cached   = _resolveItemById(track.id);
      let folderId   = cached?.parents?.[0]
                    || track?.parents?.[0]
                    || track?.folderId;

      // Source 2: ask Drive directly for this file's parent (always works)
      if (!folderId) {
        const fileInfo = await Drive.getFileInfo(track.id);
        folderId = fileInfo?.parents?.[0];
      }

      if (!folderId) { UI.showToast(UI.t('toast_no_folder')); return; }

      const folder = await Drive.getFileInfo(folderId);
      _breadcrumb  = [];
      _openFolder({ id: folder.id, name: folder.name });

      // On mobile the player is a full-screen overlay — close it so Browse is visible
      UI.setExpandedPlayerVisible(false);
    } catch (err) {
      UI.showToast(UI.t('toast_folder_open_error'), 'error');
    }
  }

  /* ── Folder play (from context menu "Reproducir") ────────── */

  /**
   * Play a folder immediately — fetches all playable songs and sets queue.
   * Different from onFolderClick() which navigates into the folder.
   */
  async function onFolderPlay(folder) {
    try {
      const { files } = await Drive.listFolderAll(folder.id);
      const playable  = files.filter(f => f.isPlayable);
      if (playable.length === 0) {
        UI.showToast(UI.t('toast_folder_no_songs'), 'error');
        return;
      }
      _resetRadio(); // folder play = full queue, no radio
      playable.forEach(f => _cacheItem(f));
      Player.setQueue(playable, 0);
      UI.showToast(`▶ ${folder.name} · ${playable.length} ${UI.t('songs').toLowerCase()}`);
    } catch (err) {
      UI.showToast(UI.t('toast_folder_error'), 'error');
      console.error('[App] onFolderPlay error:', err);
    }
  }

  /* ── Browse sort ─────────────────────────────────────────── */

  const SORT_LABELS = { name_asc: 'A–Z', name_desc: 'Z–A', size_desc: 'Tamaño' };
  let _sortMode = 'name_asc';
  let _sortDropdownOpen = false;

  /** Sort folders and files arrays in-place according to _sortMode. */
  function _sortItems(folders, files) {
    const cmp = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    const cmpDesc = (a, b) => cmp(b, a);
    const bySize = (a, b) => ((parseInt(b.size) || 0) - (parseInt(a.size) || 0));

    if (_sortMode === 'name_asc') {
      folders.sort(cmp);
      files.sort(cmp);
    } else if (_sortMode === 'name_desc') {
      folders.sort(cmpDesc);
      files.sort(cmpDesc);
    } else if (_sortMode === 'size_desc') {
      folders.sort(cmp); // folders always A-Z
      files.sort(bySize);
    }
  }

  /** Update the sort button label and active state in the dropdown. */
  function _updateSortUI() {
    const label = document.getElementById('sort-label');
    if (label) label.textContent = SORT_LABELS[_sortMode] || _sortMode;
    document.querySelectorAll('.sort-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === _sortMode);
    });
  }

  function _toggleSortDropdown(e) {
    e.stopPropagation();
    const dd = document.getElementById('sort-dropdown');
    const chevron = document.getElementById('sort-chevron');
    if (!dd) return;
    _sortDropdownOpen = !_sortDropdownOpen;
    dd.style.display = _sortDropdownOpen ? 'block' : 'none';
    if (chevron) chevron.style.transform = _sortDropdownOpen ? 'rotate(180deg)' : '';
    _updateSortUI();
  }

  function _closeSortDropdown() {
    const dd = document.getElementById('sort-dropdown');
    const chevron = document.getElementById('sort-chevron');
    if (dd) dd.style.display = 'none';
    if (chevron) chevron.style.transform = '';
    _sortDropdownOpen = false;
  }

  function _selectSortMode(mode) {
    _sortMode = mode;
    _updateSortUI();
    _closeSortDropdown();
    // Re-render current folder with new sort
    const currentFolder = _breadcrumb[_breadcrumb.length - 1];
    if (currentFolder) _openFolder(currentFolder, false);
  }

  /* ── Nav tab click ───────────────────────────────────────── */

  function onNavClick(viewId) {
    // On mobile, close the expanded player so the mini-player is visible again
    if (!window.matchMedia('(min-width: 768px)').matches) {
      UI.setExpandedPlayerVisible(false);
    }
    UI.showView(viewId);
    if (viewId !== 'search') UI.updateSearchChipCounts(null); // clear chip counts when leaving search
    if (viewId === 'home')    _loadHomeData();
    if (viewId === 'library') _setLibTab(_currentLibTab || 'albums');
    if (viewId === 'history') _loadHistory();
    if (viewId === 'settings') {
      _buildEQSliders();
      _applyEQPreset(_currentPreset || 'flat');
      _loadCustomPresets();
    }
    if (viewId === 'browse') {
      if (_breadcrumb.length === 0) {
        _breadcrumb = [{ id: _rootFolderId, name: CONFIG.ROOT_FOLDER_NAME }];
        _openFolder({ id: _rootFolderId, name: CONFIG.ROOT_FOLDER_NAME }, false);
      }
    }
  }

  /**
   * Navigate Browse to the folder containing the currently playing track.
   * Sets breadcrumb to [Mi Drive → folder].
   * @returns {Promise<boolean>} true if navigated, false if no track/folder
   */
  async function _openCurrentTrackFolder() {
    const track = Player.getCurrentTrack();
    const folderId = track?.parents?.[0] || track?.folderId;
    if (!folderId) return false;

    try {
      const folder = await Drive.getFileInfo(folderId);
      _breadcrumb = [
        { id: _rootFolderId, name: CONFIG.ROOT_FOLDER_NAME },
        { id: folder.id, name: folder.name },
      ];
      await _openFolder(folder, false);
      return true;
    } catch (err) {
      console.warn('[App] Could not navigate to track folder:', err);
      return false;
    }
  }

  /* ── Settings actions ────────────────────────────────────── */

  function onLogout() {
    if (confirm(UI.t('confirm_logout'))) {
      Auth.logout();
    }
  }

  function onLanguageChange(lang) {
    UI.setLanguage(lang);
    localStorage.setItem('savart_lang', lang);
    // Sync both lang toggles (sidebar + settings)
    document.querySelectorAll('.lang-btn, [data-lang]').forEach(el => {
      el.classList.toggle('active', el.dataset.lang === lang);
    });
  }

  async function onClearCache() {
    await DB.clearCache();
    UI.showToast(UI.t('toast_cache_cleared'), 'success');
    _refreshCacheBar();
  }

  async function _refreshCacheBar() {
    try {
      const bytes      = await DB.getCacheSize();
      const limitBytes = (await DB.getState('cacheLimit')) || CONFIG.CACHE_LIMIT_DEFAULT;
      const pct        = Math.min(100, (bytes / limitBytes) * 100);
      const label      = document.getElementById('cache-size-label');
      const fill       = document.getElementById('cache-bar-fill');
      if (label) label.textContent = `${formatBytes(bytes)} / ${formatBytes(limitBytes)}`;
      if (fill)  fill.style.width  = `${pct}%`;
      // Sync the select to the saved limit value
      const sel = document.getElementById('select-cache-limit');
      if (sel) {
        // Find closest option
        const closest = [...sel.options].reduce((prev, opt) =>
          Math.abs(parseInt(opt.value) - limitBytes) < Math.abs(parseInt(prev.value) - limitBytes)
          ? opt : prev
        );
        sel.value = closest.value;
      }
    } catch (_) {}
  }

  /* ── Sleep timer ─────────────────────────────────────────── */
  let _sleepTimerId  = null;
  let _lastSleepMins = null;   // remember last chosen duration for toggle-on restore

  function _setTimerStatus(text) {
    ['sleep-timer-status', 'overlay-timer-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    });
  }

  function _setSleepTimerToggle(on) {
    const toggle = document.getElementById('sleep-timer-toggle');
    if (toggle) toggle.classList.toggle('on', on);
  }

  function _setSleepTimer(mins) {
    if (_sleepTimerId) { clearTimeout(_sleepTimerId); _sleepTimerId = null; }

    if (mins === 'off' || !mins) {
      _setTimerStatus('');
      _setSleepTimerToggle(false);
      document.querySelectorAll('.sleep-pill').forEach(p => p.classList.remove('active'));
      return;
    }
    if (mins === 'custom') {
      const val = parseInt(prompt(UI.t('prompt_sleep_mins'), '45'), 10);
      if (!isNaN(val) && val > 0) _setSleepTimer(val);
      return;
    }
    const ms = parseInt(mins, 10) * 60 * 1000;
    _lastSleepMins = mins;
    _setSleepTimerToggle(true);
    _sleepTimerId = setTimeout(() => {
      Player.pause();
      UI.showToast(UI.t('toast_sleep_stopped'), 'default');
      _setTimerStatus('');
      _setSleepTimerToggle(false);
      document.querySelectorAll('.sleep-pill').forEach(p => p.classList.remove('active'));
    }, ms);
    _setTimerStatus(`${mins} min activo`);
  }

  /* ── EQ screen ───────────────────────────────────────────── */

  // Factory EQ presets (gains for 12 bands: 32-63-125-250-500-1k-2k-4k-8k-12k-16k-20k)
  const EQ_PRESETS = {
    flat:      [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],
    rock:      [+5, +4, +2,  0, -2, -3, -2,  0, +2, +4, +5, +3],
    pop:       [-1,  0, +1, +3, +4, +4, +3, +1,  0, -1, -1, -1],
    jazz:      [+4, +3, +1,  0,  0, -2, -2,  0, +1, +3, +4, +4],
    classical: [+5, +4, +3, +2,  0,  0,  0, +2, +3, +4, +4, +5],
    bass:      [+6, +5, +4, +2,  0,  0,  0,  0,  0,  0,  0,  0],
    vocal:     [-3, -2,  0, +2, +4, +4, +4, +2,  0, -1, -2, -3],
  };

  let _currentPreset    = 'flat';
  let _customPresets    = [];  // loaded from DB

  function _buildEQSliders() {
    const container = document.getElementById('eq-sliders');
    if (!container) return;
    container.innerHTML = '';

    CONFIG.EQ_BANDS.forEach((freq, i) => {
      const label = freq >= 1000 ? `${freq/1000}kHz` : `${freq}Hz`;
      const band  = document.createElement('div');
      band.className = 'eq-band';
      band.innerHTML = `
        <div class="eq-band-val" id="eq-val-${i}">0</div>
        <input type="range" class="eq-band-slider" min="-12" max="12" value="0" step="1"
               id="eq-slider-${i}" data-band="${i}">
        <div class="eq-band-label">${label}</div>
      `;
      container.appendChild(band);

      band.querySelector('input').addEventListener('input', (e) => {
        const gain = parseInt(e.target.value, 10);
        Player.setEQBand(i, gain);
        document.getElementById(`eq-val-${i}`).textContent = gain > 0 ? `+${gain}` : `${gain}`;
        _currentPreset = null;
        document.querySelectorAll('.eq-preset-chip').forEach(c => c.classList.remove('active'));
        _drawEQCurve();
        _saveSettings();
      });
    });

    // Sync disabled state with current toggle position
    const eqOn = document.getElementById('eq-toggle')?.classList.contains('on');
    container.classList.toggle('eq-off', !eqOn);
    document.getElementById('screen-eq')?.classList.toggle('eq-controls-off', !eqOn);
  }

  function _applyEQPreset(preset) {
    const gains = EQ_PRESETS[preset];
    if (!gains) return;
    _currentPreset = preset;
    Player.setEQGains(gains);
    gains.forEach((g, i) => {
      const slider = document.getElementById(`eq-slider-${i}`);
      const valEl  = document.getElementById(`eq-val-${i}`);
      if (slider) slider.value = g;
      if (valEl)  valEl.textContent = g > 0 ? `+${g}` : `${g}`;
    });
    document.querySelectorAll('.eq-preset-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.preset === preset);
    });
    _drawEQCurve();
    _saveSettings();
  }

  function _drawEQCurve() {
    const svg = document.getElementById('eq-curve-svg');
    if (!svg) return;
    const gains = Player.getEQGains();
    const W = 900, H = 80, n = gains.length;

    const pts = gains.map((g, i) => ({
      x: (i / (n - 1)) * W,
      y: H / 2 - (g / 12) * (H / 2 - 6),
    }));

    // Catmull-Rom → cubic Bezier (smooth curve through all points)
    let line = `M${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[0];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || pts[pts.length - 1];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      line += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x},${p2.y}`;
    }

    const fill = `${line} L${W},${H} L0,${H} Z`;

    svg.innerHTML = `
      <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4A88F5" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#4A88F5" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${fill}" fill="url(#cg)" stroke="none"/>
      <path d="${line}" fill="none" stroke="#4A88F5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  }

  function _loadCustomPresets() {
    try {
      _customPresets = JSON.parse(localStorage.getItem('savart_eq_presets') || '[]');
    } catch (_) { _customPresets = []; }
    _renderCustomPresets();
  }

  function _saveCustomPreset(name) {
    const gains = Player.getEQGains();
    const preset = { id: Date.now(), name, gains, savedAt: new Date().toLocaleDateString() };
    _customPresets.push(preset);
    localStorage.setItem('savart_eq_presets', JSON.stringify(_customPresets));
    _renderCustomPresets();
    _saveSettings();
  }

  function _deleteCustomPreset(id) {
    _customPresets = _customPresets.filter(p => p.id !== id);
    localStorage.setItem('savart_eq_presets', JSON.stringify(_customPresets));
    _renderCustomPresets();
    _saveSettings();
  }

  function _renderCustomPresets() {
    const list = document.getElementById('eq-custom-list');
    if (!list) return;

    // Keep the "new" card at end
    list.innerHTML = '';

    _customPresets.forEach(preset => {
      const card = document.createElement('div');
      card.className = 'eq-custom-card';
      card.innerHTML = `
        <svg class="eq-custom-sparkline" viewBox="0 0 120 24">
          <path d="${_gainsToSparkline(preset.gains)}"
            fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="eq-custom-name">${UI.escHtml(preset.name)}</div>
        <div class="eq-custom-date">${preset.savedAt}</div>
        <div class="eq-custom-actions">
          <button class="eq-custom-btn" data-action="load" data-id="${preset.id}">Cargar</button>
          <button class="eq-custom-btn" data-action="del"  data-id="${preset.id}" style="max-width:28px;color:var(--error)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      `;
      card.querySelector('[data-action="load"]').addEventListener('click', () => {
        Player.setEQGains(preset.gains);
        preset.gains.forEach((g, i) => {
          const s = document.getElementById(`eq-slider-${i}`);
          const v = document.getElementById(`eq-val-${i}`);
          if (s) s.value = g;
          if (v) v.textContent = g > 0 ? `+${g}` : `${g}`;
        });
        document.querySelectorAll('.eq-preset-chip').forEach(c => c.classList.remove('active'));
        _drawEQCurve();
        UI.showToast(`Preset "${preset.name}" cargado`);
      });
      card.querySelector('[data-action="del"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _deleteCustomPreset(preset.id);
      });
      list.appendChild(card);
    });

  }

  function _gainsToSparkline(gains) {
    const W = 120, H = 24, n = gains.length;
    const pts = gains.map((g, i) => ({
      x: (i / (n - 1)) * W,
      y: H / 2 - (g / 12) * (H / 2 - 2),
    }));
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[0];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || pts[pts.length - 1];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x},${p2.y}`;
    }
    return d;
  }

  /* ── Ctrl sheet helpers ──────────────────────────────────── */

  /**
   * Open a ctrl-sheet overlay and sync its controls from the settings values.
   * @param {'overlay-speed'|'overlay-timer'} id
   */
  function _openCtrlSheet(id) {
    if (id === 'overlay-speed') {
      const tVal    = document.getElementById('tempo-slider')?.value ?? 100;
      const tSlider = document.getElementById('overlay-tempo-slider');
      const tValEl  = document.getElementById('overlay-tempo-val');
      if (tSlider) tSlider.value = tVal;
      if (tValEl)  tValEl.textContent = (parseFloat(tVal) / 100).toFixed(2) + '×';
    }

    // Timer: pills already synced via shared .sleep-pill querySelectorAll
    document.getElementById(id)?.classList.add('visible');
  }

  function _closeCtrlSheet(id) {
    document.getElementById(id)?.classList.remove('visible');
  }

  /* ── Event binding ───────────────────────────────────────── */

  /**
   * Called every time the app becomes visible again (tab focus, phone unlock, etc).
   * Fires a single Drive API call to check the ROOT folder's modifiedTime.
   * If Drive reports a change more recent than our last scan, we reset _libScanDone
   * so the background scan triggers automatically next time Biblioteca opens.
   * The user sees new/removed content within seconds of opening the library tab —
   * no manual refresh needed, and no expensive full scan runs eagerly on wake.
   */
  async function _onAppForeground() {
    if (document.hidden) return;            // fired on hide — ignore
    if (!Auth.getValidToken()) return;      // not signed in

    try {
      const modTime = await Drive.getFolderModifiedTime(CONFIG.ROOT_FOLDER_ID);
      if (!modTime) return;

      const driveMs  = new Date(modTime).getTime();
      const scanMs   = _lastLibScanAt ? new Date(_lastLibScanAt).getTime() : 0;

      if (driveMs > scanMs) {
        console.log('[App] Drive root changed since last scan — will rescan on next library open');
        _libScanDone = false; // background scan will run when user opens Biblioteca
      }
    } catch {
      // Network error or auth issue — silently ignore, don't disrupt user
    }
  }

  function _bindEvents() {
    // Login button
    document.getElementById('btn-login')?.addEventListener('click', () => {
      Auth.requestToken();
    });

    // Token banner renewal button
    document.getElementById('btn-renew-token')?.addEventListener('click', () => {
      Auth.requestToken();
    });

    // Nav tabs (mobile bottom nav + desktop sidebar)
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.addEventListener('click', () => onNavClick(el.dataset.nav));
    });

    // Mini-player mobile controls
    document.querySelector('.btn-prev-mini')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.prev();
    });
    document.querySelector('.btn-play-mini')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.togglePlayPause();
    });
    document.querySelector('.btn-next-mini')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.next();
    });

    // Mini-player desktop controls (5 buttons)
    document.querySelector('.btn-prev-mini-desk')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.prev();
    });
    document.querySelector('.btn-play-mini-desk')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.togglePlayPause();
    });
    document.querySelector('.btn-next-mini-desk')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.next();
    });
    document.querySelector('.mini-skip-prev')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.seekTo(0);
    });
    document.querySelector('.mini-skip-next')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.next();
    });

    // Mini-player volume
    document.getElementById('mini-volume-slider')?.addEventListener('input', (e) => {
      e.stopPropagation();
      const vol = parseInt(e.target.value) / 100;
      Player.setVolume?.(vol);
    });

    // Browse sort button → toggle dropdown
    document.getElementById('btn-browse-sort')?.addEventListener('click', _toggleSortDropdown);

    // Browse rescan button → force re-enrichment of current folder
    document.getElementById('btn-browse-rescan')?.addEventListener('click', onBrowseRescan);

    // Sort option clicks
    document.getElementById('sort-dropdown')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.sort-option');
      if (btn?.dataset.mode) _selectSortMode(btn.dataset.mode);
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (_sortDropdownOpen && !e.target.closest('#sort-wrap')) _closeSortDropdown();
    });

    // Mini-player expand
    document.getElementById('mini-player')?.addEventListener('click', onMiniPlayerClick);

    // Expanded player: close button (mobile)
    document.getElementById('btn-pexp-close')?.addEventListener('click', _closeExpandedPlayer);

    // Expanded player: "Mostrar álbum" → navigate Browse to current track's folder
    document.getElementById('btn-pexp-show-album')?.addEventListener('click', goToCurrentTrackFolder);

    // Expanded player: playback controls
    document.getElementById('btn-pexp-prev')?.addEventListener('click', () => Player.prev());
    document.getElementById('btn-pexp-next')?.addEventListener('click', () => Player.next());
    document.getElementById('btn-pexp-play')?.addEventListener('click', () => Player.togglePlayPause());
    document.getElementById('btn-pexp-shuffle')?.addEventListener('click', (e) => {
      const isOn = Player.toggleShuffle();
      e.currentTarget.classList.toggle('active', isOn);
      UI.showToast(isOn ? 'Aleatorio activado' : 'Aleatorio desactivado');
    });
    document.getElementById('btn-pexp-repeat')?.addEventListener('click', (e) => {
      const mode = Player.cycleRepeat();
      const btn  = e.currentTarget;
      btn.classList.toggle('active', mode !== 'off');
      // Update aria-label and title to reflect current mode
      const labels = { off: 'Sin repetición', all: 'Repetir todo', one: 'Repetir esta canción' };
      btn.setAttribute('aria-label', labels[mode]);
      btn.setAttribute('title', labels[mode]);
      // Show '1' overlay for repeat-one mode
      let badge = btn.querySelector('.repeat-one-badge');
      if (mode === 'one') {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'repeat-one-badge';
          badge.textContent = '1';
          btn.appendChild(badge);
        }
      } else {
        badge?.remove();
      }
    });

    // Expanded player: progress seek
    document.getElementById('pexp-progress-track')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct  = (e.clientX - rect.left) / rect.width;
      Player.seekTo(pct * Player.getDuration());
    });

    // Expanded player: show thumb on hover
    document.getElementById('pexp-progress-track')?.addEventListener('mouseenter', () => {
      document.querySelector('.pexp-thumb')?.style && (document.querySelector('.pexp-thumb').style.opacity = '1');
    });
    document.getElementById('pexp-progress-track')?.addEventListener('mouseleave', () => {
      document.querySelector('.pexp-thumb')?.style && (document.querySelector('.pexp-thumb').style.opacity = '0');
    });

    // Expanded player: favorite
    document.getElementById('btn-pexp-fav')?.addEventListener('click', async () => {
      const track = Player.getCurrentTrack();
      if (!track) return;
      await onToggleStar(track); // onToggleStar calls UI.setHeartActive internally
    });

    // Expanded player: EQ button → navigate to settings (EQ always inline there)
    document.getElementById('btn-pexp-eq-open')?.addEventListener('click', () => {
      UI.setExpandedPlayerVisible(false);
      onNavClick('settings');
    });

    // Expanded player: Speed (Tempo) → overlay on mobile, settings on desktop
    document.getElementById('btn-pexp-speed')?.addEventListener('click', () => {
      if (window.matchMedia('(min-width: 768px)').matches) {
        _closeExpandedPlayer(); onNavClick('settings');
      } else {
        _openCtrlSheet('overlay-speed');
      }
    });

    // Expanded player: Timer → overlay on mobile, settings on desktop
    document.getElementById('btn-pexp-timer')?.addEventListener('click', () => {
      if (window.matchMedia('(min-width: 768px)').matches) {
        _closeExpandedPlayer(); onNavClick('settings');
      } else {
        _openCtrlSheet('overlay-timer');
      }
    });

    // Ctrl sheet close buttons + backdrop
    document.querySelectorAll('.ctrl-sheet').forEach(sheet => {
      sheet.querySelector('.ctrl-sheet-backdrop')?.addEventListener('click', () => {
        sheet.classList.remove('visible');
      });
      sheet.querySelector('.ctrl-sheet-close-btn')?.addEventListener('click', () => {
        sheet.classList.remove('visible');
      });
    });

    // Overlay tempo slider (inside overlay-speed)
    document.getElementById('overlay-tempo-slider')?.addEventListener('input', (e) => {
      const rate = parseFloat(e.target.value) / 100;
      Player.setTempo(rate);
      const display = rate.toFixed(2) + '×';
      const valEl = document.getElementById('overlay-tempo-val');
      if (valEl) valEl.textContent = display;
      // Keep settings slider in sync
      const s = document.getElementById('tempo-slider');
      if (s) s.value = e.target.value;
      const sv = document.getElementById('tempo-val');
      if (sv) sv.textContent = display;
      _saveSettings();
    });

    // Expanded player: ⋮ more options → context menu for current track
    document.getElementById('btn-pexp-more')?.addEventListener('click', (e) => {
      const track = Player.getCurrentTrack();
      if (!track) return;
      UI.showContextMenu(e, 'song', track);
    });

    // Expanded player: Cola button → open queue panel
    document.getElementById('btn-pexp-queue')?.addEventListener('click', () => {
      const { queue, index } = Player.getQueue();
      UI.renderQueuePanel(queue, index);
      UI.showQueuePanel(true);
      _prefetchQueueCovers(queue).catch(() => {});
    });

    // Queue panel: back button → return to now playing
    document.getElementById('btn-queue-back')?.addEventListener('click', () => {
      UI.showQueuePanel(false);
    });

    // Lyrics panel: open/close
    document.getElementById('btn-pexp-lyrics')?.addEventListener('click', _openLyricsView);
    document.getElementById('btn-lyrics-back')?.addEventListener('click', _closeLyricsView);

    // Mini-player desktop: Cola button → open queue panel
    document.getElementById('btn-mini-queue')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const { queue, index } = Player.getQueue();
      UI.renderQueuePanel(queue, index);
      UI.showQueuePanel(true);
      _prefetchQueueCovers(queue).catch(() => {});
      // On mobile, also open expanded player if not already visible
      if (!UI.isExpandedPlayerVisible()) UI.setExpandedPlayerVisible(true);
    });

    // Mini-player desktop progress seek
    document.getElementById('mini-progress-track')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct  = (e.clientX - rect.left) / rect.width;
      Player.seekTo(pct * Player.getDuration());
    });

    // Mini-player desktop: star
    document.getElementById('btn-mini-star')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = Player.getCurrentTrack();
      if (track) onToggleStar(track);
    });

    // Settings: full library refresh (scan all Drive, purge orphans)
    document.getElementById('btn-library-refresh')?.addEventListener('click', _fullLibraryRefresh);

    // Settings: open deep scan tool
    document.getElementById('btn-open-deep-scan')?.addEventListener('click', _openDeepScan);

    // Deep Scan: back button
    document.getElementById('btn-ds-back')?.addEventListener('click', () => onNavClick('settings'));

    // Deep Scan: playback controls
    document.getElementById('btn-ds-start')?.addEventListener('click', _startDeepScan);
    document.getElementById('btn-ds-pause')?.addEventListener('click', _pauseDeepScan);
    document.getElementById('btn-ds-stop')?.addEventListener('click',  _stopDeepScan);

    // Deep Scan: open in new tab
    document.getElementById('btn-ds-new-tab')?.addEventListener('click', () => {
      const url = location.href.split('#')[0] + '#deep-scan';
      window.open(url, '_blank');
    });

    // Deep Scan: folder picker
    document.getElementById('btn-ds-change-folder')?.addEventListener('click', _dsOpenFolderBrowser);
    document.getElementById('btn-ds-modal-close')?.addEventListener('click',   () => _dsCloseModal('ds-folder-modal'));
    document.getElementById('ds-folder-modal-backdrop')?.addEventListener('click', () => _dsCloseModal('ds-folder-modal'));
    document.getElementById('btn-ds-modal-select')?.addEventListener('click',  _dsConfirmFolderSelect);

    // Deep Scan: rescan dialog
    document.getElementById('ds-rescan-backdrop')?.addEventListener('click', () => _dsCloseModal('ds-rescan-dialog'));
    document.getElementById('btn-ds-rescan-cancel')?.addEventListener('click', () => _dsCloseModal('ds-rescan-dialog'));
    document.getElementById('btn-ds-rescan-confirm')?.addEventListener('click', () => {
      const checked = document.querySelector('input[name="ds-rescan-mode"]:checked');
      if (_dsSession) _dsSession.rescanMode = checked?.value || 'skip';
      _dsCloseModal('ds-rescan-dialog');
    });

    // Deep Scan: tab switching
    document.querySelectorAll('.ds-tab').forEach(btn => {
      btn.addEventListener('click', () => _dsSwitchTab(btn.dataset.dsTab));
    });

    // Deep Scan: list toggle (Sin datos / Completas)
    document.getElementById('btn-ds-show-attn')?.addEventListener('click', () => {
      if (_dsListMode === 'attn') return;
      _dsListMode = 'attn';
      document.getElementById('btn-ds-show-attn')?.classList.add('active');
      document.getElementById('btn-ds-show-done')?.classList.remove('active');
      _dsRenderAttentionList();
    });
    document.getElementById('btn-ds-show-done')?.addEventListener('click', () => {
      if (_dsListMode === 'done') return;
      _dsListMode = 'done';
      document.getElementById('btn-ds-show-done')?.classList.add('active');
      document.getElementById('btn-ds-show-attn')?.classList.remove('active');
      _dsRenderCompletedList();
    });
    // "Mostrar" button under Completas counter
    document.getElementById('btn-ds-show-complete')?.addEventListener('click', () => {
      if (_dsListMode !== 'done') {
        _dsListMode = 'done';
        document.getElementById('btn-ds-show-done')?.classList.add('active');
        document.getElementById('btn-ds-show-attn')?.classList.remove('active');
        _dsRenderCompletedList();
      }
    });

    // Deep Scan: artistas "Solo sin foto" toggle
    document.getElementById('ds-toggle-no-photo')?.addEventListener('click', async () => {
      _dsOnlyNoPhoto = !_dsOnlyNoPhoto;
      document.getElementById('ds-toggle-no-photo')?.classList.toggle('active', _dsOnlyNoPhoto);
      // Re-render
      const all = await DB.getAllMeta().catch(() => []);
      const artistMap = new Map();
      for (const m of all) {
        if (!m.artist) continue;
        const key = m.artist.trim().toLowerCase();
        if (!artistMap.has(key)) artistMap.set(key, m.artist.trim());
      }
      const photoMap = await DB.getState('ds_artistPhotos').catch(() => ({})) || {};
      _dsRenderArtists([...artistMap.entries()].sort((a,b) => a[0].localeCompare(b[0])), photoMap);
    });

    // (Deep scan auto-open is handled in _onTokenReady after auth completes)

    // Settings logout
    document.getElementById('btn-logout')?.addEventListener('click', onLogout);

    // Settings language toggle (both lang-btn and data-lang)
    document.querySelectorAll('.lang-btn, [data-lang]').forEach(el => {
      el.addEventListener('click', () => onLanguageChange(el.dataset.lang));
    });

    // Settings clear cache
    document.getElementById('btn-clear-cache')?.addEventListener('click', onClearCache);

    // Cache limit selector
    document.getElementById('select-cache-limit')?.addEventListener('change', async (e) => {
      const bytes = parseInt(e.target.value, 10);
      if (!bytes) return;
      await DB.setState('cacheLimit', bytes);
      _refreshCacheBar();
      UI.showToast(`Límite de caché: ${formatBytes(bytes)}`, 'success');
    });

    // Tempo slider
    document.getElementById('tempo-slider')?.addEventListener('input', (e) => {
      const rate = parseFloat(e.target.value) / 100;
      Player.setTempo(rate);
      document.getElementById('tempo-val').textContent = rate.toFixed(2) + '×';
      _saveSettings();
    });

    // Step buttons (±) next to sliders
    document.querySelectorAll('.step-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const dir      = parseInt(btn.dataset.dir, 10);
        const slider   = document.getElementById(targetId);
        if (!slider) return;
        const step = parseFloat(slider.step) || 1;
        const newVal = Math.min(
          parseFloat(slider.max),
          Math.max(parseFloat(slider.min), parseFloat(slider.value) + dir * step)
        );
        slider.value = newVal;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    // Sleep timer pills
    document.querySelectorAll('.sleep-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.sleep-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        _setSleepTimer(pill.dataset.mins);
      });
    });

    // Sleep timer toggle (settings desktop)
    document.getElementById('sleep-timer-toggle')?.addEventListener('click', (e) => {
      const isNowOn = e.currentTarget.classList.toggle('on');
      if (!isNowOn) {
        // Turn off: cancel timer, clear pill selection
        if (_sleepTimerId) { clearTimeout(_sleepTimerId); _sleepTimerId = null; }
        _setTimerStatus('');
        document.querySelectorAll('.sleep-pill').forEach(p => p.classList.remove('active'));
      } else {
        // Turn on: restore last chosen duration, or wait for user to pick a pill
        if (_lastSleepMins) {
          _setSleepTimer(_lastSleepMins);
          document.querySelectorAll('.sleep-pill').forEach(p => {
            p.classList.toggle('active', p.dataset.mins === String(_lastSleepMins));
          });
        } else {
          // No duration chosen yet — revert toggle, user must pick a pill first
          e.currentTarget.classList.remove('on');
        }
      }
    });

    // EQ close button (kept for any legacy reference — no-op now that EQ is always inline)
    document.getElementById('btn-eq-close')?.addEventListener('click', () => {
      onNavClick('settings'); // just stay in settings
    });

    // EQ toggle on/off — bypasses EQ nodes and disables controls
    let _eqBypassedGains = null;

    function _applyEQToggleState(isOn) {
      document.getElementById('eq-sliders')?.classList.toggle('eq-off', !isOn);
      document.getElementById('screen-eq')?.classList.toggle('eq-controls-off', !isOn);
    }

    document.getElementById('eq-toggle')?.addEventListener('click', (e) => {
      const isOn = e.currentTarget.classList.toggle('on');
      _applyEQToggleState(isOn);
      if (!isOn) {
        _eqBypassedGains = Player.getEQGains();
        Player.setEQGains(new Array(12).fill(0));
      } else {
        if (_eqBypassedGains) {
          Player.setEQGains(_eqBypassedGains);
          _eqBypassedGains = null;
        }
      }
      _saveSettings();
    });

    // EQ reset
    document.getElementById('btn-eq-reset')?.addEventListener('click', () => {
      Player.resetEQ();
      _applyEQPreset('flat'); // _applyEQPreset already calls _saveSettings
    });

    // EQ factory preset chips
    document.querySelectorAll('.eq-preset-chip').forEach(chip => {
      chip.addEventListener('click', () => _applyEQPreset(chip.dataset.preset));
    });

    // EQ save custom preset
    document.getElementById('btn-eq-save')?.addEventListener('click', () => {
      const name = prompt(UI.t('prompt_eq_preset_name'), UI.t('prompt_eq_preset_default'));
      if (name) _saveCustomPreset(name.trim() || UI.t('prompt_eq_preset_default'));
    });

    // Settings: text size picker
    document.querySelectorAll('.text-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.text-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const sizes = { small: '12px', normal: '13px', large: '15px' };
        document.body.style.fontSize = sizes[btn.dataset.size] || '13px';
        localStorage.setItem('savart_textsize', btn.dataset.size);
      });
    });

    // Browse: back button — never navigates above MSK (CONFIG.ROOT_FOLDER_ID)
    document.getElementById('btn-browse-back')?.addEventListener('click', async () => {
      const currentFolder = _breadcrumb[_breadcrumb.length - 1];
      if (!currentFolder) return;

      // Already at root — nowhere to go up
      if (currentFolder.id === _rootFolderId) return;

      // If we navigated here manually, the previous breadcrumb entry is the real parent
      if (_breadcrumb.length > 1) {
        const parent = _breadcrumb[_breadcrumb.length - 2];
        _breadcrumb = _breadcrumb.slice(0, -1);
        _openFolder(parent, false);
        return;
      }

      // Single entry in breadcrumb (opened directly from Recents/Home/Search):
      // Ask Drive for the actual parent — but clamp to MSK root.
      const btn = document.getElementById('btn-browse-back');
      if (btn) btn.disabled = true;
      try {
        const info     = await Drive.getFileInfo(currentFolder.id);
        const parentId = info.parents?.[0];

        // If parent is MSK, above MSK, or unknown → land at MSK
        if (!parentId || parentId === _rootFolderId || parentId === 'root') {
          _breadcrumb = [{ id: _rootFolderId, name: CONFIG.ROOT_FOLDER_NAME }];
          _openFolder({ id: _rootFolderId, name: CONFIG.ROOT_FOLDER_NAME }, false);
        } else {
          // Navigate to parent only if it's within the MSK subtree
          // (we can't easily verify ancestry, so we trust Drive hierarchy)
          const parentInfo = await Drive.getFileInfo(parentId);
          _breadcrumb = [{ id: parentInfo.id, name: parentInfo.name }];
          _openFolder(parentInfo, false);
        }
      } catch (err) {
        UI.showToast(UI.t('toast_back_error'), 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // Keyboard: Escape — close queue panel first, then expanded player
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (UI.isQueuePanelVisible()) {
          UI.showQueuePanel(false);
        } else if (UI.isExpandedPlayerVisible()) {
          _closeExpandedPlayer();
        }
      }
    });

    // Library: tab clicks
    document.querySelectorAll('#lib-sidebar .lib-tab').forEach(el => {
      el.addEventListener('click', () => _setLibTab(el.dataset.tab));
    });

    // Library: search input
    document.getElementById('lib-search-input')?.addEventListener('input', e => {
      _onLibSearch(e.target.value);
    });

    // Refresh cache bar when settings is opened
    document.querySelectorAll('[data-nav="settings"]').forEach(el => {
      el.addEventListener('click', _refreshCacheBar);
    });

    // ── Detect Drive changes when app returns to foreground ───
    // On visibilitychange (tab/app comes back from background), do a single
    // lightweight Drive call to check if ROOT_FOLDER modifiedTime has advanced
    // past our last scan. If yes, reset _libScanDone so the next time the user
    // opens Biblioteca the BFS scan runs automatically and picks up new folders.
    document.addEventListener('visibilitychange', _onAppForeground);
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return {
    boot,
    // Called by UI event handlers
    onHomeCardClick,
    onPlaylistHomeCardClick,
    onPlaylistDetailPlay,
    onFolderClick,
    onGoToFolder,
    onFolderPlay,
    onBreadcrumbClick,
    onSongClick,
    // Context menu actions
    onToggleStar,
    onTogglePin,
    onFolderQueue,
    onShowPlaylistPicker,
    onAddToPlaylist,
    onCreateAndAddPlaylist,
    onRemoveFromHistory,
    onRemoveFromHistoryItem,
    // Nav
    onNavClick,
    // Settings
    onLogout,
    onLanguageChange,
    onClearCache,
    // Queue panel
    onQueueItemClick,
    onQueueItemRemove,
    // Internal (exposed for UI / inline scripts)
    _cacheItem,
    _resolveItemById,
    _doSearch,
    _loadStarred,
    _loadPlaylists,
    _loadArtists,
    _loadAlbums,
    _setLibTab,
    _libGoBack,
    _onNewPlaylist,
    _scanLibraryBackground,
    onArtistClick,
    onAlbumClick,
    onAlbumRescan,
    onBrowseRescan,
    onPlaylistClick,
    onPlaylistPlay,
    onPlaylistQueue,
    onRenamePlaylist,
    onDeletePlaylist,
    onRemoveFromPlaylist,
    // Deep Scan
    _openDeepScan,
    _startDeepScan,
    _pauseDeepScan,
    _stopDeepScan,
    _dsOpenFolderBrowser,
    _dsLoadArtists,
  };
})();

/* ── Auto-boot when DOM is ready ──────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', App.boot);
} else {
  App.boot();
}
