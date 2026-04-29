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
  let _breadcrumb    = [];    // [{ id, name }] from root to current
  let _rootFolderId  = 'root';

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
      if (view === 'library') { _loadPlaylists(); _loadStarred(); }
      // Start live 3-second polling (Last-Write-Wins)
      Sync.startLiveSync(_onSyncDataChanged);
    }).catch(() => {});
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
      _loadPlaylists();
      _loadStarred();
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
            const apUpdate = {};
            if (result.coverUrl) apUpdate.s_cover  = result.coverUrl;
            if (result.title)    apUpdate.s_title  = result.title;
            if (result.artist)   apUpdate.s_artist = result.artist;
            if (result.album)    apUpdate.s_album  = result.album;
            if (Object.keys(apUpdate).length > 0) Drive.setAppProperties(item.id, apUpdate).catch(() => {});
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
          Drive.setAppProperties(item.id, { s_cover: lfmUrl }).catch(() => {});
        }
      }

      // 2b. Last.fm by track (track.getInfo — works with artist+title alone)
      if (!meta.coverUrl && typeof Lastfm !== 'undefined' && meta.artist && (meta.title || item.displayName)) {
        const trackTitle = meta.title || item.displayName;
        const lfmUrl = await Lastfm.fetchCoverByTrack(meta.artist, trackTitle);
        if (lfmUrl) {
          meta.coverUrl = lfmUrl;
          DB.setMeta(item.id, { thumbnailUrl: lfmUrl }).catch(() => {});
          Drive.setAppProperties(item.id, { s_cover: lfmUrl }).catch(() => {});
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
        if (Object.keys(_persist).length > 0) DB.setMeta(item.id, _persist).catch(() => {});
      }

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
   * Background cover art loader for a folder view.
   *
   * Pass 1 — in-memory Meta cache (instant, songs played this session).
   * Pass 2 — IndexedDB cached blobs (parallel parse, 3 workers).
   * Pass 3 — folder cover.jpg fallback for anything still missing.
   *
   * @param {string}      folderId
   * @param {DriveItem[]} files
   */
  async function _prefetchAndApplyFolderCovers(folderId, files) {
    if (!files || files.length === 0) return;

    // ── Pass 0: Drive appProperties + IndexedDB (instant, no network) ─────
    // Priority order:
    //   0a. appProperties.s_cover — synced from another device via Drive API
    //   0b. coverBlob  — embedded ID3 art saved as binary (highest quality, no expiry)
    //   0c. coverUrl / thumbnailUrl — external URL from a previous session
    await Promise.allSettled(files.map(async file => {
      try {
        // 0a. Drive appProperties (populated by listFolder — cross-device sync)
        const ap = file.appProperties;
        if (ap?.s_cover) {
          _updateRowThumbnail(file.id, ap.s_cover);
          // Mirror to local DB so home/recents picks it up without Drive API
          const save = { thumbnailUrl: ap.s_cover };
          if (ap.s_title)  save.displayName = ap.s_title;
          if (ap.s_artist) save.artist      = ap.s_artist;
          if (ap.s_album)  save.album       = ap.s_album;
          DB.setMeta(file.id, save).catch(() => {});
          return;  // no need to check DB
        }

        // 0b/0c. IndexedDB
        const dbMeta = await DB.getMeta(file.id);
        if (!dbMeta) return;

        if (dbMeta.coverBlob && typeof Meta !== 'undefined') {
          const url = Meta.injectCover(file.id, dbMeta.coverBlob);
          if (url) { _updateRowThumbnail(file.id, url); return; }
        }

        const persistedUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
        if (persistedUrl) _updateRowThumbnail(file.id, persistedUrl);
      } catch (_) {}
    }));

    // ── Pass 1: instant — use in-memory Meta cache ────────────
    files.forEach(file => {
      const meta = (typeof Meta !== 'undefined') ? Meta.getCached(file.id) : null;
      if (meta?.coverUrl) _updateRowThumbnail(file.id, meta.coverUrl);
    });

    // ── Pass 2: read cached blobs from IndexedDB, parse ID3 ───
    // Only files whose row still has no img (no cover yet)
    const needCover = files.filter(file => !_rowHasCover(file.id));
    if (needCover.length > 0 && typeof Meta !== 'undefined') {
      const CONCURRENCY = 3;
      const queue = [...needCover];

      async function worker() {
        while (queue.length > 0) {
          const file = queue.shift();
          try {
            // Try cached blob first (free), then fall back to 1MB range request
            let blob = await DB.getCachedBlob(file.id);
            if (!blob) blob = await Drive.downloadFileHead(file.id);
            if (!blob) continue;
            const meta = await Meta.parse(file.id, blob);
            if (meta?.coverUrl) {
              _updateRowThumbnail(file.id, meta.coverUrl);
              // Persist cover blob for future sessions (no re-parse needed)
              if (meta.coverBlob) DB.setMeta(file.id, { coverBlob: meta.coverBlob }).catch(() => {});
              if (Player.getCurrentTrack()?.id === file.id) _applyMeta(file, meta);
            }
          } catch (_) { /* non-fatal */ }
        }
      }

      await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () => worker())
      );
    }

    // ── Pass 3: folder cover.jpg fallback (only when a real folderId is given) ──
    // Skipped for search results (folderId=null) since files come from different folders.
    const stillNeed = files.filter(file => !_rowHasCover(file.id));
    if (stillNeed.length > 0 && folderId) {
      const folderCover = await _getFolderCover(folderId);
      if (folderCover) {
        stillNeed.forEach(file => _updateRowThumbnail(file.id, folderCover));
      }
    }

    // ── Pass 4: Last.fm cover lookup for files still missing art ──────────────
    // Uses artist + album from ID3 cache (populated in Pass 2) or DB metadata.
    // Queries are deduped by Lastfm._cache, so same album is only fetched once.
    if (typeof Lastfm === 'undefined') return;
    const lfmNeed = files.filter(file => !_rowHasCover(file.id));
    if (lfmNeed.length === 0) return;

    await Promise.allSettled(lfmNeed.map(async file => {
      try {
        // Prefer in-memory Meta cache (populated by Pass 2 ID3 parse)
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(file.id) : null;
        const artist = inMem?.artist || (await DB.getMeta(file.id))?.artist || '';
        const album  = inMem?.album  || (await DB.getMeta(file.id))?.album  || '';
        if (!artist || !album) return;

        const url = await Lastfm.fetchCover(artist, album);
        if (!url) return;

        _updateRowThumbnail(file.id, url);
        // Persist locally for next session
        DB.setMeta(file.id, { thumbnailUrl: url }).catch(() => {});
        // Sync to Drive appProperties for cross-device use
        Drive.setAppProperties(file.id, { s_cover: url }).catch(() => {});
      } catch (_) { /* non-fatal */ }
    }));

    // ── Pass 5: AudD.io audio fingerprinting ──────────────────────────────────
    // Last resort for files that have no cover AND no ID3 artist/album.
    // Identifies song from audio content, fills title/artist/album/cover.
    // Sequential (not parallel) to respect rate limits.
    // Uses auddTried flag in DB to avoid burning quota re-trying unrecognized files.
    if (typeof Audd === 'undefined') return;
    const auddCandidates = files.filter(file => !_rowHasCover(file.id));
    if (auddCandidates.length === 0) return;

    const auddLimit = Math.min(auddCandidates.length, CONFIG.AUDD_MAX_PER_FOLDER || 5);
    for (let i = 0; i < auddLimit; i++) {
      const file = auddCandidates[i];
      try {
        // Skip if already tried (success or "not found" — not network errors)
        const dbMeta = await DB.getMeta(file.id);
        if (dbMeta?.auddTried) continue;

        // Download first 1MB — enough for audio fingerprinting
        const blob = await Drive.downloadFileHead(file.id, 1024 * 1024);
        if (!blob) continue;

        let result = null;
        try {
          result = await Audd.identify(blob);
        } catch (_) {
          // Network / API error — do NOT mark as tried, allow retry next time
          continue;
        }

        // Mark tried regardless of whether a match was found
        // (avoids re-querying songs AudD.io genuinely doesn't know)
        await DB.setMeta(file.id, { auddTried: true });

        if (!result) continue;  // not found

        // Apply cover to the visible row
        if (result.coverUrl) _updateRowThumbnail(file.id, result.coverUrl);

        // Persist all identified fields locally
        const update = { auddTried: true };
        if (result.title)    update.displayName = result.title;
        if (result.artist)   update.artist      = result.artist;
        if (result.album)    update.album       = result.album;
        if (result.coverUrl) update.thumbnailUrl = result.coverUrl;
        DB.setMeta(file.id, update).catch(() => {});

        // Sync to Drive appProperties for cross-device use
        const apUpdate = {};
        if (result.coverUrl) apUpdate.s_cover  = result.coverUrl;
        if (result.title)    apUpdate.s_title  = result.title;
        if (result.artist)   apUpdate.s_artist = result.artist;
        if (result.album)    apUpdate.s_album  = result.album;
        if (Object.keys(apUpdate).length > 0) Drive.setAppProperties(file.id, apUpdate).catch(() => {});

        console.log(`[Audd] ✓ ${result.artist} — ${result.title}`);
      } catch (_) { /* non-fatal */ }
    }
  }

  /**
   * Returns true if the song row already has a cover image set.
   * @param {string} fileId
   */
  function _rowHasCover(fileId) {
    const row = document.querySelector(`.song-row[data-id="${CSS.escape(fileId)}"]`);
    const img = row?.querySelector('.song-thumb img');
    return !!(img && img.src && !img.src.endsWith(window.location.href));
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

    // Update all visible thumbnail surfaces with the resolved cover
    if (meta.coverUrl) {
      _updateRowThumbnail(item.id, meta.coverUrl);
      _updateHomeCardThumbnail(item.id, meta.coverUrl);
      _updateTopListThumb(item.id, meta.coverUrl);
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
   * @param {string} fileId
   * @param {string} coverUrl — object URL from Meta.parse
   */
  function _updateRowThumbnail(fileId, coverUrl) {
    const row   = document.querySelector(`.song-row[data-id="${CSS.escape(fileId)}"]`);
    if (!row) return;
    const thumb = row.querySelector('.song-thumb');
    if (!thumb) return;
    // If the row already shows a cover image, keep it — never replace an existing
    // cover with a different one. The onerror handler already swaps broken imgs
    // back to a placeholder div, so this guard is safe against revoked blob URLs.
    if (thumb.querySelector('img')) return;
    thumb.innerHTML = `<img src="${coverUrl}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.parentNode.innerHTML='<div class=\\'thumb-placeholder\\'></div>'">`;
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
          if (url) { _updateTopListThumb(item.id, url); return; }
        }
        // External URL persisted from Last.fm / AudD.io in a previous session
        const persistedUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
        if (persistedUrl && !persistedUrl.startsWith('blob:')) {
          _updateTopListThumb(item.id, persistedUrl);
        }
      } catch (_) {}
    }));

    // Pass 1: in-memory Meta cache (instant)
    items.forEach(item => {
      const meta = Meta.getCached(item.id);
      if (meta?.coverUrl) _updateTopListThumb(item.id, meta.coverUrl);
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
            _updateTopListThumb(item.id, meta.coverUrl);
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

  function _updateTopListThumb(fileId, coverUrl) {
    // Find the top-list-item for this fileId via a data attribute we'll add
    const el = document.querySelector(`.top-list-item[data-id="${CSS.escape(fileId)}"]`);
    if (!el) return;
    const thumb = el.querySelector('.top-list-thumb');
    if (!thumb) return;
    const img = thumb.querySelector('img');
    if (img) {
      img.src = coverUrl;
    } else {
      thumb.innerHTML = `<img src="${coverUrl}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">`;
    }
  }

  /* ── DOM helpers for song rows (Favorites / Playlist detail) ── */

  /** Returns true if the .song-row for this id already shows a cover <img>. */
  function _songRowHasCover(fileId) {
    const row = document.querySelector(`.song-row[data-id="${CSS.escape(fileId)}"]`);
    return !!(row && row.querySelector('.song-thumb img'));
  }

  /** Inject (or replace) a cover image inside the .song-thumb of a .song-row. */
  function _updateSongRowThumb(fileId, url) {
    const row = document.querySelector(`.song-row[data-id="${CSS.escape(fileId)}"]`);
    if (!row) return;
    const thumb = row.querySelector('.song-thumb');
    if (!thumb) return;
    const img = thumb.querySelector('img');
    if (img) {
      img.src = url;
    } else {
      // Remove placeholder icon if present
      const ph = thumb.querySelector('.thumb-placeholder');
      if (ph) ph.remove();
      const newImg = document.createElement('img');
      newImg.src  = url;
      newImg.alt  = '';
      newImg.setAttribute('loading', 'lazy');
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
    _loadPlaylists();
    _loadStarred();
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
      // Enrich with in-memory Meta cache (covers + artist from current session)
      const items = raw.map(item => {
        const meta = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
        if (!meta) return item;
        return {
          ...item,
          displayName:  meta.title   || item.displayName,
          artist:       meta.artist  || item.artist,
          thumbnailUrl: meta.coverUrl || item.thumbnailUrl,
        };
      });
      UI.renderHistory(items);
      // Async: apply covers from DB coverBlobs (same two-pass pipeline as top-played)
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

      // ── Top-played / history meta line ─────────────────────────
      // Reconstruct the same "artist — album · year" format used by _buildTopPlayedItem
      const metaLine = [artist, [album, year].filter(Boolean).join(' · ')].filter(Boolean).join(' — ');
      document.querySelectorAll(`.top-list-item[data-id="${eid}"]`).forEach(el => {
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
    // 1. Stored web URL (non-blob, persisted from Drive thumbnailLink — rare for audio)
    if (storedUrl && !storedUrl.startsWith('blob:')) return storedUrl;
    // 2. In-memory Meta cache: song was parsed this session (fastest, no DB needed)
    const inMem = (typeof Meta !== 'undefined') ? Meta.getCached(id) : null;
    if (inMem?.coverUrl) return inMem.coverUrl;
    // 3. Persisted coverBlob in DB (saved after browse or playback)
    const meta = await DB.getMeta(id).catch(() => null);
    if (meta?.coverBlob) {
      const url = Meta.injectCover(id, meta.coverBlob);
      if (url) return url;
    }
    // 4. Drive thumbnail from item cache (always null for audio files)
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
      // Drive fallback: fetch thumbnailLink for songs still without cover after local passes
      _driveThumbFallback(
        enriched.filter(s => !s.thumbnailUrl),
        _songRowHasCover,
        _updateSongRowThumb
      ).catch(() => {});
    } catch (err) {
      console.error('[App] Load starred error:', err);
    }
  }

  async function _loadArtists() {
    // Artists are derived from starred songs' artist tags
    try {
      const starred  = await DB.getStarred();
      const artistMap = new Map();
      starred.forEach(song => {
        if (song.artist) {
          const key = song.artist.trim().toLowerCase();
          if (!artistMap.has(key)) {
            artistMap.set(key, { id: key, name: song.artist, songCount: 0 });
          }
          artistMap.get(key).songCount++;
        }
      });
      const artists = Array.from(artistMap.values()).sort((a, b) => a.name.localeCompare(b.name));
      UI.renderArtists(artists);
    } catch (err) {
      console.error('[App] Load artists error:', err);
    }
  }

  function onArtistClick(artist) {
    UI.showToast(`Artista: ${artist.name}`); // TODO: open artist view
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
    if (viewId === 'library') { _loadPlaylists(); _loadStarred(); }
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

    // Library: new playlist
    document.getElementById('btn-new-playlist')?.addEventListener('click', async () => {
      const name = prompt(UI.t('prompt_playlist_name'), UI.t('prompt_playlist_default'));
      if (name) {
        await DB.createPlaylist(name.trim());
        UI.showToast(`"${name}" — ${UI.t('toast_pl_created')}`);
        // Refresh playlist list
        _loadPlaylists();
      }
    });

    // Refresh cache bar when settings is opened
    document.querySelectorAll('[data-nav="settings"]').forEach(el => {
      el.addEventListener('click', _refreshCacheBar);
    });
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
    onArtistClick,
    onPlaylistClick,
    onPlaylistPlay,
    onPlaylistQueue,
    onRenamePlaylist,
    onDeletePlaylist,
    onRemoveFromPlaylist,
  };
})();

/* ── Auto-boot when DOM is ready ──────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', App.boot);
} else {
  App.boot();
}
