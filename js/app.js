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
  const _browseScrollMap = new Map(); // folderId → scrollTop, restored on Back

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

  /* ── Home-data debounce ──────────────────────────────────── */
  // _loadHomeData is called from many places (sync events, track start, boot).
  // Debouncing prevents rapid successive calls from causing multiple full re-renders
  // of the home screen (which resets scroll position and causes visible flicker).
  let _loadHomeDebounceTimer = null;
  const _LOAD_HOME_DEBOUNCE_MS = 350;

  /* ── Soft-scan session guard ─────────────────────────────── */
  // IDs already soft-scanned in THIS session (cleared on page reload / new session).
  // Prevents scanning the same item repeatedly when _loadHomeData is called multiple
  // times per session (sync updates, tab focus, etc.) while still ensuring a fresh
  // scan on every new app launch — satisfying the "siempre deben hacer soft scan
  // al iniciar" requirement without unbounded network usage.
  const _sessionScannedIds = new Set();

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

    // Show the active SW version in Settings (automatic, no manual sync needed)
    const verLabel = document.getElementById('app-version-label');
    if (verLabel && 'serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        const sw = reg.active;
        if (sw) {
          const mc = new MessageChannel();
          mc.port1.onmessage = (e) => {
            if (e.data?.version) {
              verLabel.textContent = `Savart SW v${e.data.version}`;
            }
          };
          sw.postMessage({ type: 'GET_VERSION' }, [mc.port2]);
        }
      }).catch(() => {});
    }

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
      onTrackChange:   _onTrackChange,
      onPlayPause:     _onPlayPause,
      onProgress:      _onProgress,
      onQueueChange:   _onQueueChange,
      onError:         _onPlayerError,
      onBlobReady:     _onBlobReady,
      onBeforePlay:    _preScanBeforePlay,  // blocks audio until soft scan completes
      onDurationReady: _onDurationReady,    // fires on loadedmetadata with accurate duration
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
   * Intercept the Android/browser back button to navigate within the app
   * instead of exiting. Works in both browser tab and standalone PWA mode.
   *
   * Strategy: keep a "floor" entry + one "current" entry in the history stack.
   * Every popstate = user pressed back → _handleBack() decides what to dismiss/go back to,
   * then re-pushes a new entry so the stack never empties below the floor.
   */
  function _initBackGuard() {
    // Seed the stack with a floor entry plus TWO buffer entries.
    // Two buffers means a single back-press can never reach the floor, even
    // with the slight timing gap between the popstate event and our re-push.
    history.replaceState({ savart: 'base' }, '');
    history.pushState({ savart: 'step' }, '');
    history.pushState({ savart: 'step' }, '');   // extra buffer

    window.addEventListener('popstate', () => {
      _handleBack();
      // Replenish two buffer entries after every pop so the stack never drains,
      // even when the user taps back rapidly multiple times in a row.
      history.pushState({ savart: 'step' }, '');
      history.pushState({ savart: 'step' }, '');
    });
  }

  /**
   * Handle a back-button press. Dismisses overlays and navigates up the
   * stack in order of visual "depth" (most-modal first).
   */
  function _handleBack() {
    // 1. Context menu open?
    const ctxMenu = document.getElementById('context-menu');
    if (ctxMenu?.classList.contains('visible')) {
      if (typeof UI !== 'undefined') UI.hideContextMenu?.();
      return;
    }

    // 2. Expanded player visible on mobile?
    if (typeof UI !== 'undefined' && UI.isExpandedPlayerVisible?.() &&
        !window.matchMedia('(min-width: 768px)').matches) {
      // 2a. Queue open → close queue first, stay in expanded player (now-playing)
      if (UI.isQueuePanelVisible?.()) {
        UI.showQueuePanel(false);
        return;
      }
      // 2b. Otherwise collapse the expanded player entirely
      UI.setExpandedPlayerVisible(false);
      return;
    }

    // 3. Library drill-down (artist or album detail)?
    if (typeof UI !== 'undefined' && UI.getCurrentView() === 'library' && _libInDetail) {
      // Go back to whichever parent tab triggered the detail
      _libGoBack(_currentLibTab === 'artists' ? 'artists' : 'albums');
      return;
    }

    // 4. Browse search active?
    const searchInp = document.getElementById('search-input');
    if (searchInp?.value) {
      searchInp.value = '';
      document.getElementById('btn-search-clear')?.click();
      return;
    }

    // 5. Inside a subfolder in Browse?
    if (typeof UI !== 'undefined' && UI.getCurrentView() === 'browse' && _breadcrumb.length > 0) {
      if (_breadcrumb.length === 1) {
        // At top-level folder → go to root
        _breadcrumb = [];
        UI.renderBreadcrumb([]);
        _openFolder({ id: _rootFolderId, name: 'Drive' }, false).catch(() => {});
      } else {
        const parent = _breadcrumb[_breadcrumb.length - 2];
        onBreadcrumbClick(parent, _breadcrumb.length - 2);
      }
      return;
    }

    // 6. On any view other than Home → go Home
    if (typeof UI !== 'undefined' && UI.getCurrentView() !== 'home') {
      onNavClick('home');
      return;
    }

    // 7. Already on Home — nothing to do (prevents exit, stack refill handles it)
  }

  /* ── Auth events ─────────────────────────────────────────── */

  function _onTokenReady() {
    // One-time migration: reset all durationSec values that may have been saved
    // with a wrong value (v < 3.2.0 bug: stale audio.duration from previous track).
    // Setting to 0 is equivalent to "not set" since all checks use durationSec > 0.
    const _durMigKey = 'savart_dur_migration_v320';
    if (!localStorage.getItem(_durMigKey)) {
      localStorage.setItem(_durMigKey, '1');
      DB.getAllMeta().then(all => {
        const withDur = all.filter(m => m.durationSec > 0);
        console.log(`[Migration] Resetting durationSec for ${withDur.length} records (v3.2.0 fix)`);
        Promise.all(withDur.map(m =>
          DB.setMeta(m.id, { durationSec: 0 }).catch(() => {})
        )).catch(() => {});
      }).catch(() => {});
    }

    // If silent re-auth completed, clean up reconnecting UI before transition
    const reconnecting = document.getElementById('login-reconnecting');
    if (reconnecting) reconnecting.style.display = 'none';

    // Show the "loading from cloud" toast while Drive data syncs.
    // Start hidden in HTML so it never flashes during login; show it here
    // explicitly with a fade-in and enforce a minimum display of 1.2 s so
    // it's always visible on mobile (where Sync.init may resolve very fast).
    const bootToast = document.getElementById('boot-toast');
    const _bootShowTime = Date.now();
    if (bootToast) {
      bootToast.style.display = 'flex';
      requestAnimationFrame(() => { bootToast.style.opacity = '1'; });
    }
    // Show DB size (total origin storage) as a small reference label in the boot toast
    (async () => {
      try {
        let mb;
        if (navigator.storage?.estimate) {
          const est = await navigator.storage.estimate();
          mb = ((est.usage || 0) / 1024 / 1024).toFixed(1);
        } else {
          mb = ((await DB.getCacheSize()) / 1024 / 1024).toFixed(1);
        }
        const sizeEl = document.getElementById('boot-db-size');
        if (sizeEl) sizeEl.textContent = '(' + mb + ' MB)';
      } catch (_) {}
    })();

    const _hideBootToast = () => {
      if (!bootToast) return;
      const elapsed = Date.now() - _bootShowTime;
      const delay   = Math.max(0, 1200 - elapsed);
      setTimeout(() => {
        bootToast.classList.add('hidden');
        setTimeout(() => { if (bootToast.parentNode) bootToast.remove(); }, 400);
      }, delay);
    };

    UI.hideTokenBanner();
    UI.showView('home');
    _restoreHomeCacheSync(); // Paint localStorage snapshot instantly (zero DB round-trips)
    _loadHomeData();         // Then overwrite with fresh DB data (stale-while-revalidate)
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

    // Populate collection cache early so context menus on home/player/browse
    // correctly show "Ir a la colección" without requiring a library visit first.
    _refreshCollectionCache().catch(() => {});

    // Fast path: read home snapshot from Drive (~1 API call, ~300 ms).
    // Re-renders home with cross-device state before the full init() merge finishes.
    Sync.readHome().then(data => {
      if (data) _loadHomeData();
    }).catch(() => {});

    // Full sync in background — merges all types, pushes merged state back.
    // When complete, refresh UI so any data that wasn't in the home snapshot appears.
    const _bootBarFill = document.querySelector('.boot-toast-bar-fill');
    const _onBootProgress = (pct) => {
      if (_bootBarFill) _bootBarFill.style.width = pct + '%';
    };
    Sync.init({ onProgress: _onBootProgress }).then(() => {
      _restoreSettings();
      _loadHomeData();
      const view = UI.getCurrentView();
      if (view === 'library') _setLibTab(_currentLibTab || 'albums');
      // Start live 3-second polling (Last-Write-Wins)
      Sync.startLiveSync(_onSyncDataChanged);
    }).catch(() => {}).finally(() => {
      _hideBootToast();
      // Boot ID3 refresh — 5 s after sync completes (or fails).
      // Revokes stale blob: URLs and creates fresh session URLs for every home item
      // whose cover is embedded in the ID3 tags, so they never show blank on startup.
      setTimeout(() => _bootId3Refresh().catch(() => {}), 5000);
    });

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

    const needsHome = types.some(t => ['recents', 'pinned', 'playcounts', 'favorites', 'playlists', 'home'].includes(t));
    // Debounce: live sync fires every 3 s — collapse rapid refreshes into one render
    if (needsHome) _loadHomeData({ debounce: true });

    // When recents or a home snapshot arrive from another device, scan any items
    // that came without a cover (embedded ID3 art can't be synced — only the blob
    // URL or 'id3' sentinel, both session-only). 1 s delay lets _applyRemote DB
    // writes and _loadHomeData() finish before we check what needs scanning.
    if (types.some(t => t === 'recents' || t === 'home')) {
      setTimeout(() => _scanIncomingRecents().catch(() => {}), 1000);
    }

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
      _loadHomeData({ debounce: true });
    }

    if (view === 'history' && types.includes('history')) _loadHistory();

    // When history arrives from another device, scan items that came without a cover.
    // Runs regardless of which screen is active — same pattern as _scanIncomingRecents.
    if (types.includes('history')) {
      setTimeout(() => _scanIncomingHistory().catch(() => {}), 1000);
    }

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
    // Initial sync display — uses in-memory Meta cache (may still show filename
    // if this track has never been parsed in this session). The DB read below
    // will immediately correct it with the enriched/manual values.
    const enriched = _enrichTrack(track);
    UI.updateMiniPlayer(enriched, true);
    UI.updateExpandedPlayer(enriched, true);
    UI.setActiveSongRow(track?.id);
    document.title = track ? `${enriched.displayName} — Savart` : 'Savart';

    // Keep the queue panel in sync: re-render + scroll to the now-playing item.
    // _onQueueChange only fires on structural queue edits (add/remove/reorder),
    // not on natural track advancement — so we refresh it here instead.
    if (UI.isQueuePanelVisible?.()) {
      const { queue } = Player.getQueue();
      UI.renderQueuePanel(queue, index);
      _prefetchQueueCovers(queue).catch(() => {});
    }

    UI.setHeartActive(false); // reset while loading

    if (!track?.id) return;

    const safeThumb = (() => {
      const u = track.thumbnailUrl || track.thumbnailLink || null;
      // Filter out both stale blob: URLs (session-only) and the 'id3' sentinel
      // (not a real URL — just a marker meaning "use coverBlob from DB").
      if (!u || u === 'id3' || u.startsWith('blob:')) return track.thumbnailLink || null;
      return u;
    })();

    // Single DB read — DB is the authoritative source for display names, artist, etc.
    // Enriched values (MusicBrainz rescan, manual edits) live only in the DB;
    // the in-memory Meta cache only stores raw ID3 tags parsed during this session.
    // This read patches the Meta cache and immediately re-renders the player UI
    // so the correct names appear without waiting for the blob to be parsed.
    DB.getMeta(track.id).catch(() => null).then(dbMeta => {
      const stillCurrent = Player.getCurrentTrack()?.id === track.id;

      // Heart button
      if (stillCurrent) UI.setHeartActive(!!dbMeta?.starred);

      const bestName   = dbMeta?.displayName || track.displayName || track.name || '';
      const bestArtist = dbMeta?.artist      || track.artist      || '';
      const bestAlbum  = dbMeta?.album       || track.albumName   || '';
      const bestYear   = dbMeta?.year        || track.year        || '';
      const _dbThumb   = dbMeta?.thumbnailUrl;
      let   bestThumb  = (_dbThumb && _dbThumb !== 'id3' && !_dbThumb.startsWith('blob:'))
                         ? _dbThumb : safeThumb;

      // If the track has an embedded cover stored locally, inject it into the Meta
      // cache right now — the player cover shows immediately without waiting for
      // the full blob download and _onBlobReady to fire.
      if (dbMeta?.coverBlob && typeof Meta !== 'undefined') {
        const _injected = Meta.injectCover(track.id, dbMeta.coverBlob);
        if (_injected) bestThumb = _injected;
      }

      // Patch the Meta cache with DB values so subsequent _enrichTrack() calls
      // (e.g. _onPlayPause, queue navigation) return the correct enriched names.
      // Guard coverUrl — never write the 'id3' sentinel into the cache as a real URL.
      if (typeof Meta !== 'undefined') {
        Meta.forcePatch(track.id, {
          title:    bestName   || undefined,
          artist:   bestArtist || undefined,
          album:    bestAlbum  || undefined,
          year:     bestYear   || undefined,
          coverUrl: (bestThumb && bestThumb !== 'id3') ? bestThumb : undefined,
        });
      }

      // Re-render player with DB-correct names
      if (stillCurrent) {
        const dbEnriched = {
          ...enriched,
          displayName:  bestName,
          artist:       bestArtist,
          albumName:    bestAlbum,
          year:         bestYear,
          thumbnailUrl: bestThumb || enriched.thumbnailUrl,
        };
        UI.updateMiniPlayer(dbEnriched, Player.isPlaying());
        UI.updateExpandedPlayer(dbEnriched, Player.isPlaying());
        if (bestName) document.title = `${bestName} — Savart`;
      }

      // Save to recents so Home shows it in "Canciones recientes"
      // Use null for thumbnailUrl when the cover is an ephemeral Object URL (blob:)
      // or the 'id3' sentinel — both are invalid across sessions.
      const _recentThumb = (bestThumb && !bestThumb.startsWith('blob:') && bestThumb !== 'id3')
        ? bestThumb : null;
      const recentData = {
        id:           track.id,
        name:         track.name,
        displayName:  bestName,
        type:         'song',
        artist:       bestArtist,
        thumbnailUrl: _recentThumb,
        thumbnailLink: track.thumbnailLink || null,
        folderId:     track.parents?.[0]  || track.folderId || null,
      };
      DB.addRecent(recentData).then(() => {
        Sync.push('recents');
        // Debounce: track-start fires very close to sync events — collapse into one render
        if (UI.getCurrentView() === 'home') _loadHomeData({ debounce: true });
      }).catch(() => {});

      // Add to playback history
      DB.addToHistory({
        id:          track.id,
        name:        track.name,
        displayName: bestName,
        artist:      bestArtist,
        thumbnailUrl: bestThumb,
        folderId:    track.parents?.[0] || track.folderId || null,
      }).then(() => Sync.push('history')).catch(() => {});

      // Persist display fields to metadata store so topPlayed can show them.
      // Only write non-empty values to avoid overwriting enriched fields with blanks.
      const _metaUpdate = { name: track.name, folderId: recentData.folderId };
      if (bestName)   _metaUpdate.displayName  = bestName;
      if (bestThumb)  _metaUpdate.thumbnailUrl = bestThumb;
      if (bestArtist) _metaUpdate.artist       = bestArtist;
      DB.setMeta(track.id, _metaUpdate).catch(() => {});

      // ── Proactive early cover fetch ────────────────────────────────────────────
      // If there's no cover yet but we have artist metadata, query Last.fm in the
      // background WITHOUT waiting for the blob to download.  This makes covers
      // appear faster on slow connections and for songs with no local blob cache.
      // _onBlobReady may later find a better (ID3-embedded) cover — that is fine,
      // it will overwrite this one via the protected isId3 path.
      const _hasManual = (dbMeta?.manualAt || 0) > 0;
      if (!bestThumb && !_hasManual && bestArtist && (bestAlbum || bestName)) {
        (async () => {
          try {
            const stillCurrent = () => Player.getCurrentTrack()?.id === track.id;
            let earlyUrl = null;

            if (typeof Lastfm !== 'undefined') {
              if (bestAlbum) {
                earlyUrl = await Lastfm.fetchCover(bestArtist, bestAlbum).catch(() => null);
              }
              if (!earlyUrl) {
                earlyUrl = await Lastfm.fetchCoverByTrack(bestArtist, bestName || track.name).catch(() => null);
              }
            }

            if (earlyUrl) {
              // Persist so _loadHomeData and future sessions pick it up
              DB.setMeta(track.id, { thumbnailUrl: earlyUrl }).catch(() => {});
              Meta.forcePatch(track.id, { coverUrl: earlyUrl });

              // Patch all visible surfaces (home cards, rows, queue) immediately
              _updateHomeCardThumbnail(track.id, earlyUrl);
              _updateRowThumbnail(track.id, earlyUrl, false);
              _updateQueueItemCover(track.id, earlyUrl);

              // Update player if track is still current
              if (stillCurrent()) {
                const cur = Player.getCurrentTrack();
                const e2  = _enrichTrack(cur);
                UI.updateMiniPlayer(e2, Player.isPlaying());
                if (UI.isExpandedPlayerVisible()) UI.updateExpandedPlayer(e2, Player.isPlaying());
              }

              // If home is visible, refresh it so recents card shows the cover
              if (UI.getCurrentView() === 'home') _loadHomeData().catch(() => {});
            }
          } catch (_) { /* non-fatal — _onBlobReady will try again */ }
        })();
      }
    });

    // Schedule sync for play counts (incremented by player.js after audio starts)
    setTimeout(() => Sync.push('playcounts'), 3000);
  }

  function _onPlayPause(isPlaying) {
    // Cancel loading spinner the moment audio actually starts playing
    if (isPlaying) _cancelLoadingSpinner();
    const track = Player.getCurrentTrack();
    const enriched = _enrichTrack(track);
    UI.updateMiniPlayer(enriched, isPlaying);
    UI.updateExpandedPlayer(enriched, isPlaying);
    // Re-mark active row — renderHome (and other renders) create fresh DOM nodes
    // that lose the .active class; re-applying here keeps EQ bars visible.
    UI.setActiveSongRow(track?.id ?? null);
  }

  // Track which song ID has already had its duration persisted this session
  // so we don't write to DB on every timeupdate tick.
  // _onDurationReady: fires once per track via the player's loadedmetadata event.
  // audio.duration is accurate here. DB save happens in _playCurrentTrack (player.js)
  // as part of the same setMeta write — no separate DB call needed here.
  function _onDurationReady(track, durationSec) {
    if (!(durationSec > 0)) return;
    UI.updateBrowseSongDuration(track.id, durationSec);
    UI.updateLibrarySongDuration(track.id, durationSec);
    // Sync durationSec to other devices. Debounce is 2000ms — the DB write in
    // player.js _playCurrentTrack (which happens after play() resolves, ~100ms after
    // loadedmetadata) will have committed well before the sync push reads from DB.
    if (typeof Sync !== 'undefined') Sync.push('metadata');
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
    // Meta cache is patched with DB values by _onTrackChange (via Meta.forcePatch),
    // so meta.title / meta.artist reflect the enriched/manual DB names, not just
    // raw ID3 tags. Prefer cache over track.* (which may be the original filename).
    return {
      ...track,
      displayName:   (meta?.title)    || track.displayName  || track.name,
      artist:        (meta?.artist)   || track.artist        || '',
      albumName:     (meta?.album)    || track.albumName    || '',
      year:          (meta?.year)     || track.year          || '',
      thumbnailUrl:  (meta?.coverUrl) || (track.thumbnailUrl === 'id3' ? null : track.thumbnailUrl) || null,
      bitrate:       meta?.bitrate      ?? track.bitrate      ?? null,
      sampleRate:    meta?.sampleRate   ?? track.sampleRate   ?? null,
      bitsPerSample: meta?.bitsPerSample ?? track.bitsPerSample ?? null,
      size:          _blobSizeCache.get(track.id) ?? track.size ?? 0,
    };
  }

  /**
   * Propagate a manual DB write to every in-memory layer so the miniplayer
   * and expanded player reflect the change immediately — no track reload needed.
   *
   * This is the single chokepoint that keeps Drive DB (IndexedDB) as the
   * source of truth: any time we write metadata to DB, we call this so
   * live UI state stays consistent.
   *
   * Field name mapping:
   *   DB/patch field  →  Meta cache field  →  Player queue field
   *   artist          →  artist            →  artist
   *   album           →  album             →  albumName
   *   year            →  year              →  year
   *   thumbnailUrl    →  coverUrl          →  thumbnailUrl
   *
   * @param {string[]} editedIds  — file IDs whose DB records were updated
   * @param {Object}   dbPatch    — same patch object used in DB.setMeta calls
   */
  function _liveMetaUpdate(editedIds, dbPatch) {
    if (!editedIds?.length || !dbPatch) return;

    // Build Meta-cache-compatible patch (ID3 field names)
    const metaPatch = {};
    if (dbPatch.artist)       metaPatch.artist   = dbPatch.artist;
    if (dbPatch.album)        metaPatch.album    = dbPatch.album;
    if (dbPatch.year)         metaPatch.year     = dbPatch.year;
    if (dbPatch.thumbnailUrl) metaPatch.coverUrl = dbPatch.thumbnailUrl;
    if (dbPatch.displayName)  metaPatch.title    = dbPatch.displayName; // Meta cache uses 'title'

    // Build Player-queue-compatible patch (DriveItem field names)
    const queuePatch = {};
    if (dbPatch.artist)       queuePatch.artist       = dbPatch.artist;
    if (dbPatch.album)        queuePatch.albumName    = dbPatch.album;
    if (dbPatch.year)         queuePatch.year         = dbPatch.year;
    if (dbPatch.thumbnailUrl) queuePatch.thumbnailUrl = dbPatch.thumbnailUrl;
    if (dbPatch.displayName)  queuePatch.displayName  = dbPatch.displayName;

    const hasMeta  = Object.keys(metaPatch).length  > 0;
    const hasQueue = Object.keys(queuePatch).length > 0;
    if (!hasMeta && !hasQueue) return;

    let currentAffected = false;
    for (const id of editedIds) {
      if (hasMeta)  Meta.forcePatch(id, metaPatch);
      if (hasQueue && Player.patchQueueItem(id, queuePatch)) {
        currentAffected = true;
      }
      // Also patch _itemCache so future queue builds (from album/search clicks) use
      // the updated metadata instead of stale Drive API fields (e.g. thumbnailLink).
      if (hasQueue) {
        const cached = _itemCache.get(id);
        if (cached) _itemCache.set(id, { ...cached, ...queuePatch });
      }
    }

    // Patch all visible surfaces (home cards, queue rows, library rows) for every
    // edited ID — these are keyed by song ID so they update regardless of playback state.
    const coverUrl = dbPatch.thumbnailUrl && !dbPatch.thumbnailUrl.startsWith('blob:') && dbPatch.thumbnailUrl !== 'id3'
      ? dbPatch.thumbnailUrl : null;
    for (const id of editedIds) {
      if (coverUrl)           _updateHomeCardThumbnail(id, coverUrl);
      if (coverUrl)           _updateRowThumbnail(id, coverUrl, false);
      if (coverUrl)           _updateQueueItemCover(id, coverUrl);
      if (dbPatch.displayName || dbPatch.artist || dbPatch.album || dbPatch.year) {
        _patchMetaText(id, {
          title:  dbPatch.displayName || null,
          artist: dbPatch.artist      || null,
          album:  dbPatch.album       || null,
          year:   dbPatch.year        || null,
        });
      }
    }

    // If the currently-playing track was edited, refresh the player UI
    // directly (no blob reload, no side-effect callbacks).
    if (currentAffected) {
      const current = Player.getCurrentTrack();
      if (current) {
        const enriched = _enrichTrack(current);
        UI.updateMiniPlayer(enriched, Player.isPlaying());
        if (UI.isExpandedPlayerVisible()) {
          UI.updateExpandedPlayer(enriched, Player.isPlaying());
        }
      }
    }
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
      // Normalizes to NFC (stable unicode composition) + lowercase + strip
      // punctuation, but intentionally PRESERVES accents so that "Maná" and
      // "Mana" remain distinct strings and don't cross-contaminate each other.
      //
      // Song files: matched by cached artist tag only (never by filename).
      //   "Oye Mi Amor.mp3" does NOT match artist "Maná" by name — only
      //   its ID3 artist field does. This prevents false positives like a
      //   song titled "Homenaje a Maná" appearing in a Maná radio.
      //
      // Folders: matched when the artist name appears as a full token inside
      //   the folder name (e.g. "Maná - Discography" ✓, "Ramana" ✗).
      const _normStr = s => (s || '')
        .normalize('NFC')                         // stable composition (é = é)
        .toLowerCase()
        .replace(/['''""".,/#!$%^&*;:{}=`~()[\]]/g, ' ')
        .replace(/\s+/g, ' ').trim();

      const _normArtist = _normStr(artist);

      // Folder name contains the artist as a whole token (word-boundary check).
      // "Maná"            → "Maná - Greatest Hits" ✓  "Ramana" ✗
      // "Christian Nodal" → "Christian Nodal Disco" ✓  "Christian Castro" ✗
      const _folderMatchesArtist = folderName => {
        const n = _normStr(folderName);
        if (n === _normArtist) return true;
        // Split on typical separators and check if any segment is the artist
        const tokens = n.split(/[\s\-–—|,]+/).filter(Boolean);
        // Also allow "ArtistName " at start or " ArtistName" anywhere
        return n.startsWith(_normArtist + ' ') ||
               n.startsWith(_normArtist + '-') ||
               n.includes(' ' + _normArtist + ' ') ||
               n.includes(' ' + _normArtist) ||
               tokens.join(' ').startsWith(_normArtist) ||
               tokens.join(' ') === _normArtist;
      };

      // Returns the known artist for a file (Meta in-memory cache → item cache).
      // Returns null if we have no artist info for this file yet.
      const _cachedArtistFor = f => {
        const meta = (typeof Meta !== 'undefined') ? Meta.getCached(f.id) : null;
        if (meta?.artist) return meta.artist;
        const cached = _itemCache.get(f.id);
        return cached?.artist || f.artist || null;
      };

      // Exact artist match (accent-sensitive, case-insensitive).
      const _artistMatches = a => _normStr(a) === _normArtist;

      const candidates = [];
      const seen       = new Set();

      const _collect = (f) => {
        if (!seen.has(f.id) && !blocked.has(f.id) && isPlayable(f.mimeType)) {
          seen.add(f.id);
          candidates.push(f);
        }
      };

      // Direct audio files: accept ONLY if the cached artist tag matches.
      // Never match by filename — a song title may mention another artist's name.
      results.files.forEach(f => {
        if (!isPlayable(f.mimeType)) return;
        const a = _cachedArtistFor(f);
        if (a && _artistMatches(a)) _collect(f);
        // If no artist in cache we cannot verify → skip (strict mode).
      });

      // ── Step 2: expand artist-named folders (max 3) ───────────
      // Only expand folders whose name genuinely matches the artist.
      // Accent-sensitive: "Mana" folder won't open for "Maná" radio.
      const artistFolders = results.folders.filter(f => _folderMatchesArtist(f.name)).slice(0, 3);
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
      let meta = await Meta.parse(item.id, blob);

      // If the cache returned a result with no cover (e.g. soft scan parsed a 1MB head
      // that didn't reach the APIC frame) and we now have a larger blob (the full audio
      // file), force a fresh full-file parse so covers embedded beyond 1MB are found.
      // This is the primary fix for large embedded cover art (>1MB APIC frames).
      if (!meta.coverUrl && !meta.coverBlob && blob.size > 1024 * 1024) {
        const fullMeta = await Meta.parse(item.id, blob, true).catch(() => null);
        if (fullMeta?.coverUrl) meta = fullMeta;
      }

      // Fallback: try DB coverBlob (e.g. stored by a previous session's _onBlobReady).
      if (!meta.coverUrl) {
        const dbCover = await DB.getMeta(item.id).catch(() => null);
        if (dbCover?.coverBlob) {
          const injected = Meta.injectCover(item.id, dbCover.coverBlob);
          if (injected) meta = { ...meta, coverUrl: injected };
        }
      }

      // Cache blob.size so _enrichTrack can always provide it
      if (blob.size > 0) {
        _blobSizeCache.set(item.id, blob.size);
        item = { ...item, size: blob.size };
      }

      // Read DB meta first — needed to guard against overwriting manual edits
      const dbMeta = await DB.getMeta(item.id).catch(() => null);
      const playManual = (dbMeta?.manualAt || 0) > 0;

      // Persist embedded cover blob immediately — playlists/favorites can use it
      // across sessions without re-parsing the file.
      // Skip if the user has manually set a custom cover (manualAt > 0).
      // Also stamp thumbnailUrl:'id3' so the list row uses the fresh blob
      // instead of a stale Google Drive CDN thumbnail.
      if (meta?.coverBlob && !playManual) {
        DB.setMeta(item.id, { coverBlob: meta.coverBlob, thumbnailUrl: 'id3' }).catch(() => {});
        if (meta.coverUrl) UI.updateBrowseSongThumb?.(item.id, meta.coverUrl);
      }

      // Priority soft scan: stamp softScannedAt immediately so the sequential
      // _softScanFolder skips this file (it was already fully parsed while playing).
      // Also write whatever ID3 text we have now, and update the browse row cover+text.
      if (!dbMeta?.softScannedAt && !playManual) {
        const _spPatch = { softScannedAt: Date.now() };
        if (meta.title)  _spPatch.displayName    = meta.title;
        if (meta.artist) { _spPatch.artist = meta.artist; _spPatch.artistInferred = false; }
        if (meta.album)  _spPatch.album           = meta.album;
        if (meta.year)   _spPatch.year            = meta.year;
        DB.setMeta(item.id, _spPatch).catch(() => {});
        // If this song's folder is currently open in Browse, refresh the row right now
        const _spParent = item.parents?.[0];
        if (_spParent && _browseFolderId === _spParent) {
          const _spArtist  = meta.artist || dbMeta?.artist       || null;
          const _spAlbum   = meta.album  || dbMeta?.album        || null;
          const _spDisplay = meta.title  || dbMeta?.displayName  || null;
          UI.updateBrowseSongMeta(item.id, _spArtist, _spAlbum, _spDisplay);
          if (meta.coverUrl) _updateRowThumbnail(item.id, meta.coverUrl, !!meta.coverBlob);
        }
      }

      /* ── PASS 1 — IDENTIFICATION ──────────────────────────────
         Goal: assemble the best possible artist / title / album
         from every local source. AudD runs here if anything is
         still missing — its output feeds Pass 2 (Last.fm / Lyrics).
         Cover is NOT the goal here; only identity metadata.
      ─────────────────────────────────────────────────────────── */

      // 1a. DB — data persisted from a previous session
      // (AudD artist/title/album stored earlier, or cached thumbnailUrl)
      if (dbMeta) {
        // title/displayName: safe to restore unconditionally — was never propagated.
        if (!meta.title && dbMeta.displayName) meta.title = dbMeta.displayName;

        // artist/album: only restore from DB when there is evidence these values came
        // from this song specifically (ID3 parse stored coverBlob, AudD identified it,
        // or the user set them manually).  Without such evidence the DB value may be
        // a contaminated entry written by the old _propagateAlbumMeta behaviour —
        // treating it as correct would cause Last.fm to return another song's cover.
        const _dbMetaTrusted = !!(dbMeta.coverBlob || dbMeta.auddTried || (dbMeta.manualAt || 0) > 0);
        if (!meta.artist && dbMeta.artist && _dbMetaTrusted) meta.artist = dbMeta.artist;
        if (!meta.album  && dbMeta.album  && _dbMetaTrusted) meta.album  = dbMeta.album;

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
            // Persist everything AudD found.
            // thumbnailUrl: only write when the user has NOT manually set a cover
            // (playManual = manualAt > 0).  AudD is auto-enrichment — it must never
            // overwrite a deliberate manual choice, even when the user edited only
            // artist/title and left the cover intact.
            const update = { auddTried: true };
            if (result.title)                   update.displayName  = result.title;
            if (result.artist)                  update.artist       = result.artist;
            if (result.album)                   update.album        = result.album;
            if (result.coverUrl && !playManual) update.thumbnailUrl = result.coverUrl;
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
      if (!meta.coverUrl && !playManual && typeof Lastfm !== 'undefined' && meta.artist && meta.album) {
        const lfmUrl = await Lastfm.fetchCover(meta.artist, meta.album);
        if (lfmUrl) {
          meta.coverUrl = lfmUrl;
          DB.setMeta(item.id, { thumbnailUrl: lfmUrl }).catch(() => {});
        }
      }

      // 2b. Last.fm by track (track.getInfo — works with artist+title alone)
      if (!meta.coverUrl && !playManual && typeof Lastfm !== 'undefined' && meta.artist && (meta.title || item.displayName)) {
        const trackTitle = meta.title || item.displayName;
        const lfmUrl = await Lastfm.fetchCoverByTrack(meta.artist, trackTitle);
        if (lfmUrl) {
          meta.coverUrl = lfmUrl;
          DB.setMeta(item.id, { thumbnailUrl: lfmUrl }).catch(() => {});
        }
      }

      // 2c. Folder cover — generic fallback shared by all songs in the folder.
      // Track this separately so _propagateAlbumMeta only shares the folder-level
      // art (not the track-specific ID3/Last.fm cover) with sibling songs.
      let _folderCoverForSiblings = null;
      if (!meta.coverUrl) {
        const folderId = item.parents?.[0];
        if (folderId) {
          meta.coverUrl = await _getFolderCover(folderId);
          _folderCoverForSiblings = meta.coverUrl; // safe to propagate — shared by whole folder
        }
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

      // Propagate album text + folder-level cover to sibling songs in the same folder.
      // Track-specific covers (ID3, Last.fm, AudD) are intentionally NOT propagated —
      // each song discovers its own cover through the prefetch pipelines.
      _propagateAlbumMeta(item, meta, _folderCoverForSiblings).catch(() => {});

      _applyMeta(item, meta);

      // If home is currently visible and any enrichment happened (cover OR text),
      // reload home data so recents cards always reflect the latest values.
      // _applyMeta already patched the DOM in-place; _loadHomeData keeps the
      // data model consistent so subsequent re-renders (live sync) are correct too.
      if ((meta.artist || meta.title || meta.coverUrl) && UI.getCurrentView() === 'home') {
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
   * Pass 3  — Discogs                  (cover art + album/year via release database)
   *             sequential 1 req/s; respects manual edits (manualAt guard)
   * Pass 4  — ID3 blob parse [normal / cover-only force]
   *             normal: fills what MB missed + embedded cover
   *             force:  only songs without a cover (pre-2 covered the rest)
   * Pass 5  — Cover Art Archive (CAA)  (MusicBrainz cover for songs without embedded art)
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

    // ── Pass 0b: ID3 blob priority — force mode only ──────────────────────────
    // Before any network pass runs in force mode, inject persisted coverBlobs into
    // the Meta in-memory cache and stamp thumbnailUrl:'id3' in DB. This ensures:
    //   (a) DOM rows immediately show the correct embedded cover (not stale external URL)
    //   (b) Meta.getCached is populated → _enrichTrack uses blob URL for the player
    //   (c) thumbnailUrl:'id3' is written to DB → correct behaviour in future sessions
    // This pass must run before the force pre-pass so Meta.getCached already has
    // coverUrl when Meta.parse() is called (which would otherwise hit the cache and
    // skip a fresh parse, losing the chance to stamp 'id3').
    if (force && typeof Meta !== 'undefined') {
      await Promise.allSettled(files.map(async file => {
        try {
          const m = await DB.getMeta(file.id).catch(() => null);
          if (!m?.coverBlob) return;
          if ((m.manualAt || 0) > 0) return; // respect manual cover
          const url = Meta.injectCover(file.id, m.coverBlob);
          if (url) {
            _updateRowThumbnail(file.id, url, true);
            if (m.thumbnailUrl !== 'id3') {
              DB.setMeta(file.id, { thumbnailUrl: 'id3' }).catch(() => {});
            }
          }
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
            const apDbMeta  = await DB.getMeta(file.id).catch(() => null);
            const apManual  = (apDbMeta?.manualAt || 0) > 0;
            if (!apManual) {
              // Sync cover from Drive appProperties only when user hasn't set a custom cover
              _updateRowThumbnail(file.id, ap.s_cover);
              const save = { thumbnailUrl: ap.s_cover };
              if (ap.s_title)  save.displayName = ap.s_title;
              if (ap.s_artist) save.artist       = ap.s_artist;
              if (ap.s_album)  save.album        = ap.s_album;
              if (ap.s_year)   save.year         = ap.s_year;
              DB.setMeta(file.id, save).catch(() => {});
            }
            return;
          }
          const dbMeta = await DB.getMeta(file.id);
          if (!dbMeta) return;
          // Manual-edit guard: if the user explicitly set a cover URL (manualAt > 0),
          // that choice always wins over the embedded blob.  Without this guard the
          // blob path (isId3=true) would silently overwrite the manual URL every time
          // the folder is opened, causing the cover to revert on every session start.
          const _manualUrl = ((dbMeta.manualAt || 0) > 0)
            && dbMeta.thumbnailUrl
            && !dbMeta.thumbnailUrl.startsWith('blob:')
            && dbMeta.thumbnailUrl !== 'id3'
            ? dbMeta.thumbnailUrl : null;
          if (_manualUrl) {
            _updateRowThumbnail(file.id, _manualUrl);
            return;
          }
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
    // Only fills rows that have no cover yet — never replaces a cover that the
    // initial DB pass already loaded (which may be a user's manually-set cover).
    files.forEach(file => {
      if (_rowHasCover(file.id)) return; // already has a cover — don't overwrite
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
            // Respect manual edits: if the user has manually set these fields
            // (manualAt > 0), ID3 tags from the audio file must NOT overwrite them.
            // The user explicitly chose different values — trust that decision.
            const existingForForce = await DB.getMeta(file.id).catch(() => null);
            const isManuallyEdited = (existingForForce?.manualAt || 0) > 0;
            if (meta.title  && !isManuallyEdited) textPatch.displayName = meta.title;
            if (meta.artist && !isManuallyEdited) textPatch.artist = meta.artist;
            if (meta.album  && !isManuallyEdited) textPatch.album  = meta.album;
            if (meta.year   && !isManuallyEdited) textPatch.year   = meta.year;
            if (meta.track)  textPatch.track = meta.track; // track# is safe to always update
            if (Object.keys(textPatch).length > 0) {
              await DB.setMeta(file.id, textPatch).catch(() => {});
              _patchMetaText(file.id, {
                title:  meta.title  || null,
                artist: meta.artist || null,
                album:  meta.album  || null,
                year:   meta.year   || null,
              });
            }
            if (meta.coverUrl && !isManuallyEdited) {
              _updateRowThumbnail(file.id, meta.coverUrl, true);
              if (meta.coverBlob) {
                // Stamp thumbnailUrl:'id3' alongside coverBlob so future sessions
                // and _enrichTrack know to prefer the embedded art over any external URL.
                DB.setMeta(file.id, { coverBlob: meta.coverBlob, thumbnailUrl: 'id3' }).catch(() => {});
              }
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
    // ID3 (Pass 4) only fills fields MB left empty. AudD (Pass 7) fills what ID3 also missed.
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
        if (_browseRescanAbort || _albumRescanAbort || _libRescanAbort) break; // abort check
        try {
          const result = await MusicBrainz.lookup(file.id, title, artist, album);
          DB.setMeta(file.id, { mbTried: true }).catch(() => {});
          if (!result) continue;

          const patch = {};
          // MB is the canonical metadata source and normally wins for artist/album/year.
          // Exception: if the user manually edited these fields (manualAt > 0), their
          // choice takes priority over what MB found — the file tags may be wrong/missing.
          const mbManualGuard = (m.manualAt || 0) > 0;
          if (result.track   && !m.track)               patch.track         = result.track;
          if (result.artist  && !mbManualGuard)          patch.artist        = result.artist;
          if (result.album   && !mbManualGuard)          patch.album         = result.album;
          if (result.year    && !mbManualGuard)          patch.year          = result.year;
          if (result.releaseMbid)                        patch.mbReleaseMbid = result.releaseMbid;

          if (Object.keys(patch).filter(k => k !== 'mbReleaseMbid').length > 0 || patch.mbReleaseMbid) {
            // Derive a stable CAA cover URL from the MBID and store locally.
            // Never overwrite a manually set cover (manualAt > 0 = user took ownership).
            if (patch.mbReleaseMbid && !m.thumbnailUrl && !mbManualGuard) {
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

    // ── Pass 3: Discogs — cover art + metadata enrichment ─────────────────────
    // Runs after MusicBrainz so MB text context (artist, album) is available to
    // build a precise Discogs query. Fills covers for files MB/CAA didn't match,
    // and backfills album/year gaps.
    // Sequential at 1 req/s (Discogs unauthenticated rate limit is 25/min).
    if (typeof Discogs !== 'undefined') {
      for (const file of files) {
        if (_browseRescanAbort || _albumRescanAbort || _libRescanAbort) break; // abort check
        try {
          const m = await DB.getMeta(file.id).catch(() => null);
          // Never overwrite a manually set cover
          if ((m?.manualAt || 0) > 0) continue;
          // In normal mode only process files that still lack a cover
          const needsCover = !_rowHasCover(file.id);
          if (!force && !needsCover) continue;

          const artist = m?.artist || '';
          const title  = m?.displayName || m?.name || file.name || '';
          const album  = m?.album  || '';
          if (!artist && !title) continue;

          const result = await Discogs.lookup(file.id, artist, title, album);
          if (!result) continue;

          const patch = {};
          if (result.year   && !m?.year)  patch.year  = result.year;
          if (result.album  && !m?.album) patch.album = result.album;
          // Apply cover: in force mode also update songs that lack a persisted URL
          const wantsCover = needsCover || (force && !m?.thumbnailUrl);
          if (result.coverUrl && wantsCover) {
            patch.thumbnailUrl = result.coverUrl;
            _updateRowThumbnail(file.id, result.coverUrl);
          }
          if (Object.keys(patch).length > 0) {
            await DB.setMeta(file.id, patch).catch(() => {});
            if (patch.album || patch.year) {
              _patchMetaText(file.id, {
                title:  null,
                artist: m?.artist  || null,
                album:  patch.album || m?.album || null,
                year:   patch.year  || m?.year  || null,
              });
            }
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    // ── Pass 4: ID3 blob parse — text + embedded cover ────────────────────────
    // In force mode: ID3 pre-pass already ran before MB with full overwrite rights.
    //   Pass 4 here only handles songs that failed the pre-pass (no cached blob, no cover yet).
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
            // Respect manual edits (manualAt > 0): never overwrite user-renamed fields with ID3.
            const existingMeta = await DB.getMeta(file.id).catch(() => null);
            const isManual = (existingMeta?.manualAt || 0) > 0;
            const textPatch = {};
            if (meta.title  && !isManual)              textPatch.displayName = meta.title;
            if (meta.artist && !existingMeta?.artist)  textPatch.artist      = meta.artist;
            if (meta.album  && !existingMeta?.album)   textPatch.album       = meta.album;
            if (meta.year   && !existingMeta?.year)    textPatch.year        = meta.year;
            if (meta.track  && !existingMeta?.track)   textPatch.track       = meta.track;
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
            // But respect manual edits: if user set a custom cover (manualAt > 0), never overwrite.
            if (meta.coverUrl && !isManual) {
              _updateRowThumbnail(file.id, meta.coverUrl, true);
              if (meta.coverBlob) DB.setMeta(file.id, { coverBlob: meta.coverBlob }).catch(() => {});
            }

            if (Player.getCurrentTrack()?.id === file.id) _applyMeta(file, meta);
          } catch (_) { /* non-fatal */ }
        }
      }
      await Promise.allSettled(Array.from({ length: CONCURRENCY }, () => id3Worker()));
    }

    // ── Pass 5: Cover Art Archive (MusicBrainz) ───────────────────────────────
    // For songs still without an embedded ID3 cover but with a MB release ID.
    // CAA URL: https://coverartarchive.org/release/{mbid}/front-250
    if (_browseRescanAbort || _albumRescanAbort || _libRescanAbort) return; // abort check
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
            // Never overwrite a manually set cover
            if ((m.manualAt || 0) > 0) return;
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

    // ── Pass 6: Last.fm cover lookup ──────────────────────────────────────────
    // Deduped by artist+album inside Lastfm module, so one request per album.
    //
    // Runs in two modes:
    //   • Normal: only for songs without a cover in DOM (primary goal = display cover).
    //   • Force:  also for songs WITH a DOM cover (coverBlob / folder cover.jpg) that
    //             have NO thumbnailUrl in DB. Goal = persist an external URL so other
    //             devices (which don't have the local blob) can show the album thumbnail.
    if (typeof Lastfm === 'undefined') return;
    if (_browseRescanAbort || _albumRescanAbort || _libRescanAbort) return; // abort check
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
        // Never overwrite a manually set cover
        if ((dbM?.manualAt || 0) > 0) return;

        // Determine artist/album from trusted sources only.
        // Prefer in-memory parse (reliable — from this session's ID3 extraction).
        // DB values are only trusted when there's evidence the song was individually
        // identified: own ID3 blob stored (coverBlob), AudD ran on it, or manual edit.
        // DB artist/album from old _propagateAlbumMeta runs (now fixed) is untrusted
        // and would cause cover bleeding — skip those songs rather than store wrong art.
        const inMemArtist = inMem?.artist || '';
        const inMemAlbum  = inMem?.album  || '';
        const dbTrusted   = !!(dbM?.coverBlob || dbM?.auddTried || (dbM?.manualAt || 0) > 0);
        const artist      = inMemArtist || (dbTrusted ? (dbM?.artist || '') : '');
        const album       = inMemAlbum  || (dbTrusted ? (dbM?.album  || '') : '');
        if (!artist || !album) return;

        const url = await Lastfm.fetchCover(artist, album);
        if (!url) return;
        if (updateDom) _updateRowThumbnail(file.id, url);
        // Don't overwrite DB with Last.fm URL if the song already has ID3 embedded art —
        // coverBlob is the authoritative local source; thumbnailUrl:'id3' is stamped in Pass 7.5.
        const lfmDbCheck = await DB.getMeta(file.id).catch(() => null);
        if (!lfmDbCheck?.coverBlob) DB.setMeta(file.id, { thumbnailUrl: url }).catch(() => {});
      } catch (_) { /* non-fatal */ }
    }));

    // ── Pass 7: AudD.io audio fingerprinting ──────────────────────────────────
    // Last resort: identifies songs with no metadata at all from their audio content.
    // Limited per folder open to conserve daily quota (CONFIG.AUDD_MAX_PER_FOLDER).
    if (typeof Audd === 'undefined') return;
    if (_browseRescanAbort || _albumRescanAbort || _libRescanAbort) return; // abort check
    const auddCandidates = files.filter(file => !_rowHasCover(file.id));
    if (auddCandidates.length === 0) return;
    const auddLimit = Math.min(auddCandidates.length, CONFIG.AUDD_MAX_PER_FOLDER || 5);
    for (let i = 0; i < auddLimit; i++) {
      if (_browseRescanAbort || _albumRescanAbort || _libRescanAbort) break; // abort check
      const file = auddCandidates[i];
      try {
        const dbMeta = await DB.getMeta(file.id);
        if (dbMeta?.auddTried) continue;
        const auddManual = (dbMeta?.manualAt || 0) > 0;
        const blob = await Drive.downloadFileHead(file.id, 1024 * 1024);
        if (!blob) continue;
        let result = null;
        try { result = await Audd.identify(blob); }
        catch (_) { continue; } // network error — allow retry next session
        await DB.setMeta(file.id, { auddTried: true });
        if (!result) continue;
        if (result.coverUrl && !auddManual) _updateRowThumbnail(file.id, result.coverUrl);
        const update = { auddTried: true };
        if (result.title    && !auddManual) update.displayName  = result.title;
        if (result.artist   && !auddManual) update.artist       = result.artist;
        if (result.album    && !auddManual) update.album        = result.album;
        if (result.coverUrl && !auddManual) update.thumbnailUrl = result.coverUrl;
        DB.setMeta(file.id, update).catch(() => {});
        console.log(`[Audd] ✓ ${result.artist} — ${result.title}`);
      } catch (_) { /* non-fatal */ }
    }

    // ── Pass 7.5: Final ID3 guarantee ─────────────────────────────────────────
    // All external services have been tried. For any song still showing no cover:
    // (a) coverBlob already in DB but DOM was never updated → show it + stamp.
    // (b) No coverBlob anywhere → download file head, extract embedded art, save both
    //     coverBlob and thumbnailUrl:'id3' so it survives future sessions and syncs.
    // This is the authoritative last resort — runs regardless of which passes failed.
    if (typeof Meta !== 'undefined') {
      const uncoveredNow = files.filter(f => !_rowHasCover(f.id));
      if (uncoveredNow.length > 0) {
        const CONCURRENCY_ID3FB = 3;
        const id3FbQueue = [...uncoveredNow];
        async function id3FallbackWorker() {
          while (id3FbQueue.length > 0) {
            const file = id3FbQueue.shift();
            if (_browseRescanAbort || _albumRescanAbort || _libRescanAbort) return;
            try {
              const m = await DB.getMeta(file.id).catch(() => null);
              if ((m?.manualAt || 0) > 0) continue;
              if (m?.coverBlob) {
                // Case (a): blob already saved — just show it and stamp
                const url = Meta.injectCover(file.id, m.coverBlob);
                if (url) {
                  _updateRowThumbnail(file.id, url, true);
                  if (!_isStableCoverUrl(m?.thumbnailUrl) && m?.thumbnailUrl !== 'id3')
                    DB.setMeta(file.id, { thumbnailUrl: 'id3' }).catch(() => {});
                }
                continue;
              }
              // Case (b): no blob — try extracting from audio file
              let blob = await DB.getCachedBlob(file.id);
              if (!blob) blob = await Drive.downloadFileHead(file.id);
              if (!blob) continue;
              const meta = await Meta.parse(file.id, blob);
              if (!meta?.coverBlob) continue; // genuinely no embedded art
              await DB.setMeta(file.id, { coverBlob: meta.coverBlob, thumbnailUrl: 'id3' }).catch(() => {});
              if (meta.coverUrl) _updateRowThumbnail(file.id, meta.coverUrl, true);
            } catch (_) {}
          }
        }
        await Promise.allSettled(Array.from({ length: CONCURRENCY_ID3FB }, () => id3FallbackWorker()));
      }
    }

    // ── Pass 8: Stamp ID3-cover sentinel ──────────────────────────────────────
    // For songs that ended up with a coverBlob (ID3 embedded art) but NO external
    // thumbnailUrl, write thumbnailUrl:'id3' as a cross-device signal.
    // Other devices receiving this sentinel will extract the cover from the audio
    // file's embedded tags rather than showing no cover at all.
    await Promise.allSettled(files.map(async file => {
      try {
        const m = await DB.getMeta(file.id);
        if (!m?.coverBlob)             return; // no local blob — nothing to signal
        if ((m.manualAt || 0) > 0)     return; // user-edited, leave alone
        if (m.thumbnailUrl === 'id3')  return; // already stamped
        if (_isStableCoverUrl(m.thumbnailUrl)) return; // has real external URL
        await DB.setMeta(file.id, { thumbnailUrl: 'id3' });
      } catch (_) {}
    }));

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

    // Update or create the entity-year row.
    // After a rescan, always show the green dot; never show the manual dot
    // (resetToVirgin already wiped manualAt for all songs).
    // Build the inner HTML so dots + year coexist without clobbering each other.
    {
      const yearParts = [
        '<span class="album-rescan-dot"></span>',
        topYear ? `(${topYear})` : '',
      ].filter(Boolean).join(' ');

      let yearEl = container.querySelector('.lib-detail-entity-year');
      if (!yearEl) {
        yearEl = document.createElement('div');
        yearEl.className = 'lib-detail-entity-year';
        nameEl.parentNode.insertBefore(yearEl, nameEl);
      }
      yearEl.innerHTML = yearParts;
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
        // Insert surgically to preserve any .rescan-wave-overlay child
        const newImg = document.createElement('img');
        newImg.src = coverUrl;
        newImg.alt = '';
        newImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)';
        if (existing) {
          existing.replaceWith(newImg);
        } else {
          artEl.querySelector('svg')?.remove();
          const overlay = artEl.querySelector('.rescan-wave-overlay');
          overlay ? artEl.insertBefore(newImg, overlay) : artEl.appendChild(newImg);
        }
      }
    }

    // Show the green dot in the back-row legend (album or collection detail).
    // Hide the manual dot — rescan cleared manualAt for all songs.
    const legendRescan = container.querySelector('.album-detail-legend-rescan, .col-detail-legend-rescan');
    const legendManual = container.querySelector('.album-detail-legend-manual, .col-detail-legend-manual');
    if (legendRescan) legendRescan.style.display = '';
    if (legendManual) legendManual.style.display = 'none';
  }

  /**
   * Force a full re-enrichment of an album's songs, ignoring the mbTried flag.
   * Called from the Rescan button in the album detail view.
   *
   * If any songs have manual edits (manualAt > 0), shows a warning dialog before
   * proceeding. On confirm, manual overrides are cleared so the enrichment pipeline
   * can fully overwrite them. This is the "album-level" rescan — it warns first.
   *
   * @param {Object[]} songs   — song objects currently rendered
   * @param {string}   folderId
   */
  async function onAlbumRescan(songs, folderId) {
    if (_albumRescanRunning) return; // second call while running — ignored (UI handles abort via stopAlbumRescan)
    if (!songs || songs.length === 0) return;

    // ── Check for manual edits and warn before proceeding ──────────────────
    const manualFiles = await _getManualFiles(songs);
    if (manualFiles.length > 0) {
      const n    = manualFiles.length;
      const noun = n === 1 ? UI.t('lbl_song') : UI.t('lbl_songs');
      const warn = n === 1 ? UI.t('rescan_manual_warn_single') : UI.t('rescan_manual_warn');
      const confirmed = await _showRescanDialog(`${n} ${noun} ${warn}`);
      if (!confirmed) return;
      // Note: resetToVirgin below already clears manualAt — no separate clear needed
    }

    _albumRescanRunning = true;
    _albumRescanAbort   = false;
    if (folderId) _setRescanOverlay(folderId, true);

    try {
      UI.showToast(UI.t('toast_rescan_start'));

      // ── Purge orphans: remove DB records for files no longer in Drive ──
      if (folderId) {
        const liveIds = songs.map(s => s.id);
        const pruned  = await DB.purgeOrphans(folderId, liveIds).catch(() => 0);
        if (pruned > 0) console.log(`[App] Purged ${pruned} orphan(s) from folder ${folderId}`);
      }

      if (_albumRescanAbort) { UI.showToast(UI.t('toast_rescan_stopped')); return; }

      // Virgin reset: wipe all enrichment AND manual data — only stars/playCount survive.
      await Promise.all(songs.map(async s => {
        await DB.resetToVirgin(s.id).catch(() => {});
        if (typeof Meta !== 'undefined') Meta.revoke(s.id);
      }));
      if (folderId) _folderCoverCache.delete(folderId);

      await _prefetchAndApplyFolderCovers(folderId, songs, true); // force=true — honours _albumRescanAbort internally

      if (_albumRescanAbort) { UI.showToast(UI.t('toast_rescan_stopped')); return; }

      await _patchAlbumDetailHeader(songs);
      // Mark folder as rescanned BEFORE pushHot so the dot syncs in the hot delta
      if (folderId) {
        await DB.setMeta(folderId, { rescannedAt: Date.now() }).catch(() => {});
        _stampRescanDot(folderId); // show green dot on library card immediately
      }
      if (typeof Sync !== 'undefined') {
        const hotItems = folderId ? [...songs, { id: folderId }] : songs;
        Sync.pushHot(hotItems).catch(() => {});
        Sync.push('metadata');
      }
      _lfmThumbLibrary().catch(() => {});
      UI.showToast(UI.t('toast_rescan_done'));
    } finally {
      _albumRescanRunning = false;
      _albumRescanAbort   = false;
      if (folderId) _setRescanOverlay(folderId, false);
    }
  }

  /** Abort a running album/collection detail rescan. Called from the UI stop button. */
  function stopAlbumRescan() {
    if (_albumRescanRunning) _albumRescanAbort = true;
  }

  /* ── Manual-data helpers for rescan flows ───────────────────
     Before any forced rescan, check if any songs have manual
     edits; if so, warn and clear them so the guard passes.
     ────────────────────────────────────────────────────────── */

  /**
   * Returns the subset of files that have manualAt > 0 in IndexedDB.
   * @param {Object[]} files
   * @returns {Promise<Object[]>}
   */
  async function _getManualFiles(files) {
    const results = await Promise.all(files.map(async f => {
      const m = await DB.getMeta(f.id).catch(() => null);
      return (m?.manualAt || 0) > 0 ? f : null;
    }));
    return results.filter(Boolean);
  }

  /**
   * Clear manual-ownership data (manualAt, coverBlob, displayName) for files
   * that have manualAt > 0. Called after the user confirms they want a full reset.
   * @param {Object[]} files
   */
  async function _clearManualForFiles(files) {
    await Promise.all(files.map(f => DB.clearManualOverrides(f.id).catch(() => {})));
  }

  /**
   * After rendering folder rows, async-patch each row with the green rescan dot
   * and/or blue manual-edits dot based on DB state.
   * Uses a single getAllMeta() call to avoid N round-trips for large folder lists.
   * @param {Object[]} folders  — array of folder objects with .id
   */
  /**
   * After the album/collection grid is painted, fetch ID3 cover blobs one by one
   * and inject them into cards that have no URL-based cover.
   * This keeps the initial render fast — blobs are loaded on demand rather than
   * being pulled into memory with getAllMeta().
   *
   * @param {Object[]} items  — album or collection objects with { folderId, blobId?, coverUrl?, mosaicUrls? }
   */
  async function _patchGridBlobCovers(items) {
    const grid = document.querySelector('#lib-detail-content .lib-album-grid');
    if (!grid || typeof Meta === 'undefined') return;
    for (const item of items) {
      const blobId = item.blobId;
      if (!blobId) continue;
      try {
        const meta = await DB.getMeta(blobId);
        if (!meta?.coverBlob) continue;
        const url = Meta.injectCover(blobId, meta.coverBlob);
        if (!url) continue;
        // Find the card by folderId data attribute
        const card  = Array.from(grid.querySelectorAll('.home-card'))
          .find(c => c.dataset.folderId === item.folderId);
        const artEl = card?.querySelector('.home-card-art');
        if (!artEl) continue;

        if (artEl.classList.contains('home-card-art--mosaic')) {
          // Mosaic card (collections): inject blob into first cell that has no image yet.
          // The cell already has position:relative from CSS so the absolute img works.
          const firstCell = artEl.querySelector('.mosaic-cell');
          if (firstCell && !firstCell.querySelector('img')) {
            const newImg = document.createElement('img');
            newImg.src = url;
            newImg.alt = '';
            newImg.addEventListener('error', () => { newImg.style.display = 'none'; });
            firstCell.appendChild(newImg);
          }
        } else if (!artEl.querySelector('img')) {
          // Non-mosaic card (albums): replace SVG placeholder with single image
          const newImg = document.createElement('img');
          newImg.src = url;
          newImg.alt = '';
          newImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md)';
          // Remove SVG placeholder if present; leave overlay untouched
          artEl.querySelector('svg')?.remove();
          const overlay = artEl.querySelector('.rescan-wave-overlay');
          overlay ? artEl.insertBefore(newImg, overlay) : artEl.appendChild(newImg);
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  async function _patchFolderDots(folders) {
    if (!folders.length) return;
    try {
      const [all, savedCols] = await Promise.all([
        DB.getAllMeta(),
        DB.getAllCollections().catch(() => []),
      ]);
      // Rescan: folder meta records carry rescannedAt (record id === folderId)
      const rescannedIds = new Set(all.filter(m => m.rescannedAt).map(m => m.id));
      // Manual: any song with manualAt > 0, OR the collection record has manualAt > 0
      const manualFolderIds = new Set();
      for (const m of all) {
        if (m.folderId && (m.manualAt || 0) > 0) manualFolderIds.add(m.folderId);
      }
      for (const col of (savedCols || [])) {
        if ((col.manualAt || 0) > 0) manualFolderIds.add(col.id);
      }
      for (const folder of folders) {
        const row = document.querySelector(`.folder-row[data-id="${CSS.escape(folder.id)}"]`);
        if (!row) continue;
        if (rescannedIds.has(folder.id)) {
          const d = row.querySelector('.folder-rescan-dot');
          if (d) d.style.display = '';
        }
        if (manualFolderIds.has(folder.id)) {
          const d = row.querySelector('.folder-manual-dot');
          if (d) d.style.display = '';
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Lightweight movement reconciliation for a Browse folder.
   * Compares Drive's live file list against DB's stored folderId values and patches
   * any mismatches — no metadata rescan, only folderId corrections.
   * If any records changed, rebuilds the chip cache and patches visible folder chips.
   *
   * @param {string}   folderId   Drive folder ID just opened.
   * @param {Object[]} liveFiles  Files currently in this folder from Drive.listFolderAll.
   */
  async function _reconcileBrowseFolder(folderId, liveFiles) {
    const liveFileIds = liveFiles.map(f => f.id);
    const changed = await DB.reconcileFolderContents(folderId, liveFileIds);
    if (changed === 0) return; // nothing moved — skip expensive cache rebuild

    // Some folderIds changed — rebuild caches so chips reflect the new DB state.
    await _refreshCollectionCache().catch(() => {});

    // Patch chips for any subfolder rows currently visible in Browse.
    // (The current folder's own chip is rendered by its parent, not here.)
    const screen = document.getElementById('screen-browse');
    if (!screen) return;
    const colCache     = _collectionFolderIdsCache || new Set();
    const knownFolders = _allKnownFolderIdsCache;
    if (!knownFolders) return;

    screen.querySelectorAll('.folder-row[data-id]').forEach(row => {
      const id = row.dataset.id;
      const newType = knownFolders.has(id)
        ? (colCache.has(id) ? 'collection' : 'album')
        : undefined;
      UI.updateBrowseFolderChip?.(id, newType);
    });
  }

  /**
   * Show/hide the rescan dot + dot-legend items based on the current folder's state.
   * - rescan dot on rescan button: shown if folder has rescannedAt
   * - #browse-legend-rescan item: shown if folder has rescannedAt
   * - #browse-legend-manual item: shown if any song in folder has manualAt > 0
   * @param {string} folderId
   */
  async function _updateBrowseLegend(folderId) {
    const legendRescan = document.getElementById('browse-legend-rescan');
    const legendManual = document.getElementById('browse-legend-manual');
    const hide = () => {
      if (legendRescan) legendRescan.style.display = 'none';
      if (legendManual) legendManual.style.display = 'none';
    };
    if (!folderId) { hide(); return; }
    try {
      const [folderMeta, all, colRec] = await Promise.all([
        DB.getMeta(folderId),
        DB.getAllMeta(),
        DB.getCollection(folderId).catch(() => null),
      ]);
      const hasRescan = !!(folderMeta?.rescannedAt);
      // Manual: any song in this folder has manualAt, OR the collection record has manualAt
      const hasManual = all.some(m => m.folderId === folderId && (m.manualAt || 0) > 0)
                     || (colRec?.manualAt || 0) > 0;
      if (legendRescan) legendRescan.style.display = hasRescan ? '' : 'none';
      if (legendManual) legendManual.style.display = hasManual ? '' : 'none';
    } catch (_) { hide(); }
  }

  /**
   * Show the lib-rescan-dialog with a custom message.
   * Resolves true if confirmed, false if cancelled.
   * @param {string} message  — text to show in the description paragraph
   * @returns {Promise<boolean>}
   */
  function _showRescanDialog(message) {
    return new Promise(resolve => {
      const modal      = document.getElementById('lib-rescan-dialog');
      const desc       = document.getElementById('lib-rescan-desc');
      const confirmBtn = document.getElementById('btn-lib-rescan-confirm');
      const cancelBtn  = document.getElementById('btn-lib-rescan-cancel');
      const backdrop   = document.getElementById('lib-rescan-backdrop');
      if (!modal) { resolve(true); return; }

      if (desc) desc.textContent = message;
      modal.style.display = 'flex';

      const finish = (result) => {
        modal.style.display = 'none';
        confirmBtn?.removeEventListener('click', onConfirm);
        cancelBtn?.removeEventListener('click',  onCancel);
        backdrop?.removeEventListener('click',   onCancel);
        resolve(result);
      };
      const onConfirm = () => finish(true);
      const onCancel  = () => finish(false);

      confirmBtn?.addEventListener('click', onConfirm, { once: true });
      cancelBtn?.addEventListener('click',  onCancel,  { once: true });
      backdrop?.addEventListener('click',   onCancel,  { once: true });
    });
  }

  /* ── Library search-results batch rescan ─────────────────────
     Called when the user clicks the rescan button next to the
     library search bar while albums tab is active.
     ────────────────────────────────────────────────────────── */

  let _libRescanRunning        = false;
  let _libRescanAbort          = false;
  let _libRescanActiveFolderId = null;  // folderId currently being processed in _doLibRescan
  let _browseRescanRunning = false;
  let _browseRescanAbort   = false;
  let _albumRescanRunning  = false;
  let _albumRescanAbort    = false;

  /**
   * Sync the lib-rescan button state to reality:
   * - Scanning → always visible, label "Detener", amber scanning class
   * - Idle     → visible only on albums tab with a search term; plain label
   * Call this whenever tab, search text, or scan state changes.
   */
  function _syncLibRescanBtn() {
    const btn  = document.getElementById('btn-lib-rescan');
    const span = btn?.querySelector('span');
    if (!btn) return;
    if (_libRescanRunning) {
      btn.style.display = '';
      btn.classList.add('scanning');
      btn.disabled = false;
      if (span) span.textContent = UI.t('rescan_stop_btn');
    } else {
      btn.disabled = false; // always re-enable when idle (stop may have disabled it)
      btn.classList.remove('scanning');
      if (span) span.textContent = UI.t('rescan_btn');
      const q = (document.getElementById('lib-search-input')?.value || '').trim();
      btn.style.display = (_currentLibTab === 'albums' && q) ? '' : 'none';
    }
  }

  /**
   * Collect visible album folder IDs from the current search results,
   * warn if any songs have manual edits, confirm, then run the rescan.
   */
  async function onLibRescan() {
    // Second tap while running → abort
    if (_libRescanRunning) {
      _libRescanAbort = true;
      const btn  = document.getElementById('btn-lib-rescan');
      const span = btn?.querySelector('span');
      if (span) span.textContent = UI.t('rescan_stopping_btn');
      if (btn)  btn.disabled = true; // prevent rapid re-taps while draining
      return;
    }

    // If a browse rescan is running, stop that too
    if (_browseRescanRunning) {
      _browseRescanAbort = true;
      return;
    }

    // Collect folder IDs of album cards currently visible
    const cards = document.querySelectorAll(
      '#lib-detail-content .home-card[data-folder-id]'
    );
    const folderIds = [];
    for (const card of cards) {
      if (card.style.display !== 'none' && card.dataset.folderId) {
        folderIds.push(card.dataset.folderId);
      }
    }
    if (folderIds.length === 0) {
      UI.showToast(UI.t('toast_rescan_none'), 'warn');
      return;
    }

    // Build a dialog message that mentions both album count AND any manual edits
    const baseMsg   = `${folderIds.length} ${UI.t('rescan_confirm_msg')}`;
    const confirmed = await _showRescanDialog(baseMsg);
    if (!confirmed) return;

    // Set state synchronously NOW — before the fire-and-forget _doLibRescan runs.
    // This prevents any async callback (live-sync poll, _loadAlbums, etc.) that
    // might sneak in between here and _doLibRescan's own _syncLibRescanBtn() call
    // from seeing _libRescanRunning=false and resetting the button back to "Rescanear".
    _libRescanRunning = true;
    _libRescanAbort   = false;
    _syncLibRescanBtn(); // show "Detener" immediately

    _doLibRescan(folderIds);
  }

  /**
   * Show or hide the rescan-wave overlay on all three DOM surfaces for a folder:
   *  1. Album card art (.home-card-art) in the library grid
   *  2. Browse folder icon (.folder-icon) in the browse list
   *  3. Album detail header art (.lib-detail-entity-art) — only when in detail view
   *
   * @param {string}  folderId
   * @param {boolean} active   true = show overlay, false = remove it
   */
  function _setRescanOverlay(folderId, active) {
    const OVERLAY_CLASS = 'rescan-wave-overlay';
    const label = UI.t('scan_status_scanning');

    function waveHTML(showLabel) {
      return `
        <div class="rescan-wave-wrap">
          <svg class="savart-wave-svg" viewBox="0 0 120 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M0 16 C5 8,15 8,20 16 C25 24,35 24,40 16 M40 16 C45 8,55 8,60 16 C65 24,75 24,80 16 M80 16 C85 8,95 8,100 16 C105 24,115 24,120 16" stroke="#4A88F5" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
        </div>
        ${showLabel ? `<span class="rescan-wave-label">${label}</span>` : ''}`;
    }

    function applyOverlay(el, showLabel = false) {
      if (!el) return;
      el.querySelector('.' + OVERLAY_CLASS)?.remove();
      if (active) {
        const div = document.createElement('div');
        div.className = OVERLAY_CLASS;
        div.innerHTML = waveHTML(showLabel);
        el.appendChild(div);
      }
    }

    // 1. Album card art in library grid — show label
    applyOverlay(document.querySelector(
      `#lib-detail-content .home-card[data-folder-id="${CSS.escape(folderId)}"] .home-card-art`
    ), true);

    // 2. Browse folder icon — too small for label
    applyOverlay(document.querySelector(
      `.folder-row[data-id="${CSS.escape(folderId)}"] .folder-icon`
    ), false);

    // 3. Album detail header art (only if the detail pane is currently open) — no label
    if (_libInDetail) {
      applyOverlay(document.querySelector('.lib-detail-entity-art'), false);
    }
  }

  /**
   * Immediately stamp the green rescan dot on the album card in the library grid
   * for a given folderId, without waiting for a full _loadAlbums() re-render.
   * Called right after DB.setMeta(folderId, { rescannedAt }) is written.
   */
  function _stampRescanDot(folderId) {
    const card = document.querySelector(
      `#lib-detail-content .home-card[data-folder-id="${CSS.escape(folderId)}"]`
    );
    if (!card) return;
    let yearEl = card.querySelector('.home-card-year');
    if (!yearEl) {
      yearEl = document.createElement('div');
      yearEl.className = 'home-card-year';
      const art = card.querySelector('.home-card-art');
      if (art) art.after(yearEl);
      else card.insertBefore(yearEl, card.querySelector('.home-card-name') || null);
    }
    if (!yearEl.querySelector('.album-rescan-dot')) {
      const dot = document.createElement('span');
      dot.className = 'album-rescan-dot';
      yearEl.insertBefore(dot, yearEl.firstChild);
    }
  }

  /**
   * Run the full rescan pipeline sequentially for a list of folder IDs.
   * Clears manual overrides before enriching so the guard doesn't block.
   */
  async function _doLibRescan(folderIds) {
    // onLibRescan always sets _libRescanRunning=true and calls _syncLibRescanBtn() BEFORE
    // invoking us. We still set state here as a safety net if ever called directly.
    if (!_libRescanRunning) {
      _libRescanRunning = true;
      _libRescanAbort   = false;
      _syncLibRescanBtn(); // show "Detener" immediately, stay visible across tab switches
    }

    UI.showToast(`${UI.t('toast_rescan_start').replace('…', '')} (${folderIds.length})…`);

    let done    = 0;
    let aborted = false;
    for (const folderId of folderIds) {
      if (_libRescanAbort) { aborted = true; break; }
      _libRescanActiveFolderId = folderId;
      _setRescanOverlay(folderId, true);
      try {
        const page = await Drive.listFolderScan(folderId);
        const songs = page.audioFiles || [];
        if (songs.length === 0 || songs.length > 40) { done++; continue; }

        const liveIds = songs.map(s => s.id);
        await DB.purgeOrphans(folderId, liveIds).catch(() => {});

        // Virgin reset: wipe all enrichment AND manual data — only stars/playCount survive.
        await Promise.all(songs.map(async s => {
          await DB.resetToVirgin(s.id).catch(() => {});
          if (typeof Meta !== 'undefined') Meta.revoke(s.id);
        }));
        _folderCoverCache.delete(folderId);

        await _prefetchAndApplyFolderCovers(folderId, songs, true);
        await DB.setMeta(folderId, { rescannedAt: Date.now() }).catch(() => {});
        _stampRescanDot(folderId); // show green dot immediately on the card
        if (typeof Sync !== 'undefined') {
          Sync.pushHot([...songs, { id: folderId }]).catch(() => {});
        }
        done++;
      } catch (err) {
        console.warn('[LibRescan] Error on folder', folderId, err);
        done++;
      } finally {
        _libRescanActiveFolderId = null;
        _setRescanOverlay(folderId, false);
      }
    }

    _libRescanRunning = false;
    _libRescanAbort   = false;
    _syncLibRescanBtn(); // restore button label/visibility based on current tab+search

    if (aborted) {
      UI.showToast(UI.t('toast_rescan_stopped'));
    } else {
      if (typeof Sync !== 'undefined') Sync.push('metadata');
      _lfmThumbLibrary().catch(() => {});
      UI.showToast(`${UI.t('toast_rescan_done')} (${done})`);
      // Refresh albums grid so new data / covers appear immediately
      _loadAlbums();
    }
  }

  /**
   * Force a full re-enrichment of the currently open browse folder.
   * Called from the Rescan button in the browse action bar.
   *
   * If any songs have manual edits (manualAt > 0), shows a warning dialog
   * before proceeding. On confirm, manual overrides are cleared so the
   * enrichment pipeline can fully overwrite them.
   */
  async function onBrowseRescan() {
    if (!_browseFiles.length) return;

    // Second tap while running → abort
    if (_browseRescanRunning) {
      _browseRescanAbort = true;
      const btn  = document.getElementById('btn-browse-rescan');
      const span = btn?.querySelector('span');
      if (span) span.textContent = UI.t('rescan_stopping_btn');
      if (btn)  btn.disabled = true; // prevent further taps while stopping
      return;
    }

    // ── Check for manual edits and warn before proceeding ──────────────────
    const manualFiles = await _getManualFiles(_browseFiles);
    if (manualFiles.length > 0) {
      const n    = manualFiles.length;
      const noun = n === 1 ? UI.t('lbl_song') : UI.t('lbl_songs');
      const warn = n === 1 ? UI.t('rescan_manual_warn_single') : UI.t('rescan_manual_warn');
      const confirmed = await _showRescanDialog(`${n} ${noun} ${warn}`);
      if (!confirmed) return;
      // Note: resetToVirgin below already clears manualAt — no separate clear needed
    }

    _browseRescanRunning = true;
    _browseRescanAbort   = false;
    const btn  = document.getElementById('btn-browse-rescan');
    const span = btn?.querySelector('span');
    const icon = document.getElementById('browse-rescan-icon');
    // Keep button enabled so a second tap can abort; swap label to "Detener"
    if (btn)  { btn.disabled = false; btn.classList.add('scanning'); }
    if (span) span.textContent = UI.t('rescan_stop_btn');
    if (icon) icon.style.animation = 'spin 1s linear infinite';
    if (_browseFolderId) _setRescanOverlay(_browseFolderId, true);
    try {
      UI.showToast(UI.t('toast_rescan_folder'));

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

      // Virgin reset: wipe all enrichment AND manual data — only stars/playCount survive.
      await Promise.all(_browseFiles.map(async f => {
        await DB.resetToVirgin(f.id).catch(() => {});
        if (typeof Meta !== 'undefined') Meta.revoke(f.id);
      }));
      if (_browseFolderId) _folderCoverCache.delete(_browseFolderId);
      await _prefetchAndApplyFolderCovers(_browseFolderId, _browseFiles, true); // force=true

      if (_browseRescanAbort) {
        UI.showToast(UI.t('toast_rescan_stopped'));
        return;
      }

      // Mark folder as rescanned BEFORE pushHot so rescannedAt syncs in the hot delta
      if (_browseFolderId) {
        await DB.setMeta(_browseFolderId, { rescannedAt: Date.now() }).catch(() => {});
        _stampRescanDot(_browseFolderId); // show green dot on library card immediately
        _updateBrowseLegend(_browseFolderId);
      }
      if (typeof Sync !== 'undefined') {
        // Hot push: immediate small delta so Device B sees changes within 3 s
        // Include the folder record so rescannedAt dot syncs in ~3 s on other devices
        const hotItems = _browseFolderId ? [..._browseFiles, { id: _browseFolderId }] : _browseFiles;
        Sync.pushHot(hotItems).catch(() => {});
        // Full metadata push: background, for initial-setup on new devices (debounced 2 s)
        Sync.push('metadata');
      }
      _lfmThumbLibrary().catch(() => {});
      UI.showToast(UI.t('toast_rescan_done'));
      // Refresh Albums/Artists grid so the newly enriched folder appears there
      if (!_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
      }
    } finally {
      _browseRescanRunning = false;
      _browseRescanAbort   = false;
      if (_browseFolderId) _setRescanOverlay(_browseFolderId, false);
      if (btn)  { btn.disabled = false; btn.classList.remove('scanning'); }
      if (span) span.textContent = UI.t('rescan_btn');
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

    // ── Always patch all visible surfaces keyed by song ID ─────────────────────────
    // These updates target specific song cards/rows by data-id regardless of what is
    // currently playing, so they must run even if the user skipped to another track
    // while _onBlobReady was enriching this one. Skipping these was the root cause of
    // home-card covers and recents text never updating for previously-played tracks.

    if (meta.coverUrl) {
      _updateRowThumbnail(item.id, meta.coverUrl, true);
      _updateHomeCardThumbnail(item.id, meta.coverUrl, true);
      _updateTopListThumb(item.id, meta.coverUrl, true);
      // Queue panel rows are also song-id keyed — update them too
      _updateQueueItemCover(item.id, meta.coverUrl);
    }

    // Patch title/artist text in all visible surfaces (queue, home, top-played, browse).
    _patchMetaText(item.id, {
      title:  meta.title  || null,
      artist: meta.artist || null,
      album:  meta.album  || null,
      year:   meta.year   || null,
    });

    // ── Player UI — only if this is still the current track ────────────────────────
    const currentTrack = Player.getCurrentTrack();
    if (currentTrack?.id !== item.id) return;

    // Update mini-player and expanded player with cover art + richer names.
    // NOTE: _applyMeta runs from _onBlobReady which fires BEFORE _audio.src changes,
    // so Player.getDuration() still returns the previous track's duration here.
    // Duration is handled exclusively by _onDurationReady (loadedmetadata) and
    // player.js DB.setMeta (after play() resolves) — not here.
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
      durationMs:    item.durationMs || 0,
    };
    UI.updateMiniPlayer(enriched, Player.isPlaying());
    UI.updateExpandedPlayer(enriched, Player.isPlaying());
    // Refresh lock-screen / notification metadata with resolved ID3 info
    Player.updateMediaSessionArtwork(enriched);
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
    const eid = CSS.escape(fileId);

    function _applyToThumb(thumb) {
      if (!thumb) return;
      const img = thumb.querySelector('img');
      if (!isId3 && img) {
        if (img.dataset.coverSrc === 'id3') return; // ID3 is always protected
        img.src = coverUrl;
        return;
      }
      if (isId3 && img?.dataset.coverSrc === 'id3') { img.src = coverUrl; return; } // refresh session URL

      // Build img element without innerHTML — avoids wiping out the .eq-bars child
      const newImg = document.createElement('img');
      newImg.src = coverUrl;
      newImg.alt = '';
      newImg.loading = 'lazy';
      newImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit';
      if (isId3) newImg.dataset.coverSrc = 'id3';
      newImg.onerror = () => {
        // Swap broken img back to placeholder — keep .eq-bars intact
        const ph = document.createElement('div');
        ph.className = 'thumb-placeholder';
        newImg.replaceWith(ph);
      };

      // Replace placeholder or broken img; never touch .eq-bars
      const ph = thumb.querySelector('.thumb-placeholder');
      if (ph) {
        ph.replaceWith(newImg);
      } else if (img) {
        img.replaceWith(newImg);
      } else {
        // Nothing to replace — insert before eq-bars so it stays last
        const eqBars = thumb.querySelector('.eq-bars');
        eqBars ? thumb.insertBefore(newImg, eqBars) : thumb.appendChild(newImg);
      }
    }

    // Browse view (.song-row → .song-thumb)
    const browseRow = document.querySelector(`.song-row[data-id="${eid}"]`);
    if (browseRow) _applyToThumb(browseRow.querySelector('.song-thumb'));

    // Library detail view (.top-list-item → .top-list-thumb)
    const listRow = document.querySelector(`.top-list-item[data-id="${eid}"]`);
    if (listRow) _applyToThumb(listRow.querySelector('.top-list-thumb'));

    // Live-update the album card in the library grid (non-blocking DB lookup)
    DB.getMeta(fileId).then(m => {
      if (m?.folderId) _updateAlbumCardCover(m.folderId, coverUrl);
    }).catch(() => {});
  }

  /**
   * Update the album card art in the library grid immediately, without a full re-render.
   * Called from _updateRowThumbnail whenever a cover is found for any song.
   * Only replaces the art if the card is currently showing a placeholder (no image),
   * so the displayed cover is the first confirmed one — a full _loadAlbums() re-render
   * will later apply the majority-vote cover.
   */
  function _updateAlbumCardCover(folderId, coverUrl) {
    if (!folderId || !coverUrl) return;
    const card = document.querySelector(
      `#lib-detail-content .home-card[data-folder-id="${CSS.escape(folderId)}"]`
    );
    if (!card) return;
    const art = card.querySelector('.home-card-art');
    if (!art) return;
    // If this card was rendered with a manual cover (user explicitly set it via
    // "Apply to all" or the edit modal), never let enrichment callbacks overwrite it.
    // The card is re-rendered from fresh DB data on next library reload, which will
    // pick up any legitimate manual change correctly.
    if (art.dataset.manualCover) return;
    const img = art.querySelector('img');
    if (img) {
      img.src = coverUrl;
    } else {
      // No cover yet — inject surgically to preserve any .rescan-wave-overlay child
      const newImg = document.createElement('img');
      newImg.src = coverUrl;
      newImg.alt = '';
      newImg.loading = 'lazy';
      newImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md)';
      newImg.onerror = () => newImg.remove();
      art.querySelector('svg')?.remove(); // remove SVG placeholder
      const overlay = art.querySelector('.rescan-wave-overlay');
      overlay ? art.insertBefore(newImg, overlay) : art.appendChild(newImg);
    }
  }

  /**
   * Update a home card's thumbnail image (song cover art).
   * @param {string} fileId
   * @param {string} coverUrl
   */
  function _updateHomeCardThumbnail(fileId, coverUrl, isId3 = false) {
    const card = document.querySelector(`#screen-home .home-card[data-id="${CSS.escape(fileId)}"]`);
    if (!card) return;
    const art = card.querySelector('.home-card-art');
    if (!art) return;
    const img = art.querySelector('img');
    if (!isId3 && img) {
      if (img.dataset.coverSrc === 'id3') return; // ID3 is always protected
      img.src = coverUrl;
      return;
    }
    if (isId3 && img?.dataset.coverSrc === 'id3') { img.src = coverUrl; return; } // refresh session URL
    const newImg = document.createElement('img');
    newImg.src = coverUrl;
    newImg.alt = '';
    newImg.loading = 'lazy';
    newImg.style.cssText = 'width:100%;height:100%;object-fit:cover';
    if (isId3) newImg.dataset.coverSrc = 'id3';
    newImg.onerror = () => { const ph = document.createElement('div'); ph.className = 'thumb-placeholder'; newImg.replaceWith(ph); };
    const overlay = art.querySelector('.rescan-wave-overlay');
    if (img) { img.replaceWith(newImg); }
    else if (overlay) { art.insertBefore(newImg, overlay); }
    else { art.appendChild(newImg); }
  }

  /**
   * Soft-scan home/top-played/pinned items on every session start and every sync drop.
   *
   * RULES (per spec):
   *   • ALL items MUST be processed — no exceptions based on softScannedAt.
   *   • Items with manualAt OR rescannedAt → SKIP scan, but MUST read DB and
   *     apply data to DOM (mandatory "consult DB for changes").
   *   • All other items → MUST do a fresh ID3 scan every session:
   *       - Download 1 MB head (or use local cached blob)
   *       - Parse ID3 tags
   *       - REPLACE fields in DB from ID3 (not fill-only — "borrar los datos y
   *         consultar la ID3")
   *       - If ID3 has no cover, keep existing external URL (Last.fm/AudD)
   *       - Paint result on every visible surface
   *
   * Session guard (_sessionScannedIds): prevents scanning the same item twice
   * within a single app session (avoids redundant downloads when _loadHomeData
   * is called multiple times per session from sync events). Cleared on page reload.
   *
   * @param {Object[]} items — array of items with .id
   */
  async function _softScanItems(items) {
    if (!items.length || typeof Meta === 'undefined') return;

    // Pre-fetch DB meta for all items in one batch
    const metaEntries = await Promise.allSettled(
      items.map(item => DB.getMeta(item.id).catch(() => null))
    );
    const metaMap = new Map();
    items.forEach((item, i) => {
      const m = metaEntries[i].status === 'fulfilled' ? metaEntries[i].value : null;
      metaMap.set(item.id, m);
    });

    const toScan   = [];  // needs fresh ID3 scan this session
    const toApply  = [];  // has rescannedAt/manualAt — skip scan, just apply DB to DOM
    const toPaint  = [];  // already scanned this session — just ensure cover is visible in DOM

    for (const item of items) {
      const m = metaMap.get(item.id);
      if (m?.manualAt || m?.rescannedAt) {
        toApply.push(item);                     // authoritative DB — mandatory DB read
      } else if (!_sessionScannedIds.has(item.id)) {
        _sessionScannedIds.add(item.id);        // reserve slot before async work
        toScan.push(item);
      } else {
        // Already scanned this session (e.g. home scan ran before history opened).
        // Don't re-download, but DO paint covers from DB/Meta cache into the new DOM
        // (e.g. history screen renders after home scan wrote coverBlob to DB).
        toPaint.push(item);
      }
    }

    // ── Mandatory DB-read path (rescannedAt / manualAt) ─────────────────────
    // These items have authoritative data — paint whatever's in DB to DOM now.
    toApply.forEach(item => _ensureCoverVisible(item.id, metaMap.get(item.id)));

    // ── Already-scanned path — paint cover from DB meta or in-memory cache ──
    // Priority: Meta session cache (fresh Object URL) → DB coverBlob → external URL.
    // If no cover is found anywhere AND softScannedAt was never written (scan was
    // interrupted before completing), remove the item from the session guard and
    // re-queue it for a real scan — covers must always show for embedded-art items.
    toPaint.forEach(item => {
      const m      = metaMap.get(item.id);
      const cached = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
      if (cached?.coverUrl || m?.coverBlob) {
        // Cover available — paint all visible surfaces now
        _ensureCoverVisible(item.id, m);
      } else if (!m?.softScannedAt) {
        // Guard was set but scan never completed (interrupted / network error before DB write).
        // Remove from session guard so it joins toScan and gets a proper retry.
        _sessionScannedIds.delete(item.id);
        toScan.push(item);
      } else {
        // Scan completed (softScannedAt set), confirmed no embedded cover — apply any
        // external URL from DB (Last.fm / AudD) or leave placeholder; no re-download.
        _ensureCoverVisible(item.id, m);
      }
    });

    // ── ID3 scan path ────────────────────────────────────────────────────────
    if (!toScan.length || typeof Drive === 'undefined' || !Auth.isAuthenticated()) {
      if (typeof Sync !== 'undefined' && toApply.length) Sync.push('recents');
      return;
    }

    const queue = [...toScan];
    async function worker() {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          // Fresh DB read — manualAt / rescannedAt may have been written AFTER
          // metaMap was built (race condition: user edited while _softScanItems was
          // already running, or "Apply to All" fired during a concurrent scan).
          // Using a stale metaMap snapshot for bulkWriteMeta would silently clear
          // manualAt AND thumbnailUrl from the record (existing has neither, patch
          // writes thumbnailUrl:null → the manual URL is permanently lost).
          const freshMeta = await DB.getMeta(item.id).catch(() => null);

          // Secondary guard: item became protected since we built metaMap.
          // Skip the scan entirely — just paint whatever is already in DB.
          if ((freshMeta?.manualAt || 0) > 0 || (freshMeta?.rescannedAt || 0) > 0) {
            _ensureCoverVisible(item.id, freshMeta);
            continue;
          }

          // Use fresh DB data as existing baseline (beats stale metaMap snapshot)
          const existing = freshMeta || metaMap.get(item.id) || null;

          // Prefer local cached blob (free, full file — best quality).
          // Fall back to a 1MB head download (enough for most embedded cover art).
          let blob = await DB.getCachedBlob(item.id).catch(() => null);
          const blobIsFullFile = !!blob;  // cached = full audio file, not a head slice
          if (!blob) blob = await Drive.downloadFileHead(item.id, 1024 * 1024).catch(() => null);

          if (!blob) {
            // Network failure — release session slot so next sync/load can retry
            _sessionScannedIds.delete(item.id);
            continue;
          }

          // ── ID3 tag-size check ─────────────────────────────────────────────────
          // If the full ID3 tag extends beyond the 1 MB we downloaded, the APIC
          // (cover art) frame may be truncated — the parser will hit the frame
          // boundary guard and skip it, so no cover is found even though the file
          // has embedded art.  Read the 10-byte ID3 header, decode the synchsafe
          // tag-size field, and fetch exactly that many bytes if necessary.
          // Only runs when we don't already have the full file in cache.
          if (!blobIsFullFile && blob.size >= 10) {
            try {
              const hdr = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
              if (hdr[0] === 0x49 && hdr[1] === 0x44 && hdr[2] === 0x33) { // 'ID3'
                const tagSize = ((hdr[6] & 0x7f) << 21) | ((hdr[7] & 0x7f) << 14)
                              | ((hdr[8] & 0x7f) << 7)  |  (hdr[9] & 0x7f);
                const needed  = 10 + tagSize;
                if (needed > blob.size) {
                  console.log(`[SoftScan] ID3 tag is ${needed} bytes, fetching full tag for ${item.id}`);
                  const bigger = await Drive.downloadFileHead(item.id, needed + 1024).catch(() => null);
                  if (bigger) blob = bigger;
                }
              }
            } catch (_) { /* non-fatal — continue with whatever blob we have */ }
          }

          // Always revoke any stale/partial Meta cache entry (e.g. a minimal
          // {coverUrl} set by Meta.injectCover in Pass 0) before parsing.
          // Without this, Meta.parse returns the cached stub instead of doing a
          // real ID3 parse, so title/artist/coverBlob all come back null.
          Meta.revoke(item.id);

          // Always force=true so we get a real parse with all fields including
          // coverBlob — never rely on a stale cache hit.
          const meta = await Meta.parse(item.id, blob, true).catch(() => null);

          // REPLACE patch — ID3 is the source of truth for these fields.
          // FULL REPLACE from ID3 — clear existing data, apply only what the file says.
          // Soft scan is strictly ID3-only: no Last.fm, no AudD, no Drive thumbnail.
          // If the file has no title → displayName = null.
          // If the file has no cover → coverBlob = null, thumbnailUrl = null.
          // Guard: if meta === null the parse itself failed (corrupted header, network
          // glitch after download, etc.) — in that case we do NOT wipe existing data,
          // only stamp softScannedAt so we don't retry endlessly.
          const patch = { softScannedAt: Date.now() };
          if (meta !== null) {
            patch.displayName    = meta.title  || null;
            patch.artist         = meta.artist || null;
            patch.artistInferred = !meta.artist;
            patch.album          = meta.album  || null;
            patch.year           = meta.year   || null;
            patch.coverBlob      = meta.coverBlob || null;
            patch.thumbnailUrl   = meta.coverBlob ? 'id3' : null;
            patch.coverUrl       = null; // clear stale external URL (Last.fm/AudD)
            // Duration: only from TLEN ID3 frame or FLAC STREAMINFO (reliable).
            if (meta.durationSec > 0) patch.durationSec = meta.durationSec;
          }

          // Use bulkWriteMeta (direct put, no null-stripping) so null fields
          // actually clear stale external URLs — same strategy as _softScanFolder.
          // Spread existing first so we keep playCount/starred/etc., then patch
          // overwrites with fresh ID3 data (including explicit nulls).
          await DB.bulkWriteMeta([{ ...existing, id: item.id, ...patch }]);

          // Resolve cover URL for DOM update
          const coverUrl = meta?.coverUrl
            || (meta?.coverBlob ? Meta.injectCover(item.id, meta.coverBlob) : null)
            || null;

          // Paint cover + text on every visible surface
          if (coverUrl) {
            _updateHomeCardThumbnail(item.id, coverUrl, true);
            _updateTopListThumb(item.id, coverUrl, true);
            _updatePinnedItemCover(item.id, coverUrl, true);
            _updateRowThumbnail(item.id, coverUrl, true);
            Player.patchQueueItem?.(item.id, { thumbnailUrl: coverUrl });
          }
          if (meta?.title) {
            _updateHomeCardName(item.id, meta.title);
            _updateTopListName(item.id, meta.title);
          }

          // Live-update text in any open detail panel (library / browse)
          if (meta !== null) {
            const livePatch = {};
            if (patch.displayName) livePatch.displayName = patch.displayName;
            if (patch.artist)      livePatch.artist      = patch.artist;
            if (patch.album)       livePatch.album       = patch.album;
            if (patch.year)        livePatch.year        = patch.year;
            if (Object.keys(livePatch).length) _liveMetaUpdate([item.id], livePatch);
          }

          // Paint duration in the browse row (if it's currently visible)
          if (patch.durationSec && typeof UI !== 'undefined') {
            UI.updateBrowseSongDuration(item.id, patch.durationSec);
          }

          console.log(`[SoftScan] ${item.id}: done — artist=${patch.artist ?? '—'}, cover=${!!patch.coverBlob}`);
        } catch (err) {
          _sessionScannedIds.delete(item.id); // allow retry on next sync/load
          console.warn('[SoftScan] error:', item.id, err?.message);
        }
      }
    }
    // 2 parallel workers — head downloads are ~1 MB each
    await Promise.allSettled([worker(), worker()]);

    // Re-push recents so other devices get the enriched metadata immediately,
    // without waiting for Device A to open the home screen.
    if (typeof Sync !== 'undefined') Sync.push('recents');
  }

  /**
   * Scan recently-synced items that arrived from another device without a cover.
   * Called 1 s after a live-sync 'recents' or 'home' event so the DB writes
   * have settled and _loadHomeData() has already re-rendered the list.
   *
   * Two paths per item:
   *  • coverBlob already in DB  → instant: revoke + injectCover + paint (no network)
   *  • no cover at all          → soft-scan via _softScanItems (1 MB head download)
   *
   * Items already handled this session (_sessionScannedIds) are skipped to avoid
   * redundant downloads.
   */
  async function _scanIncomingRecents() {
    if (typeof Meta === 'undefined' || !Auth.isAuthenticated()) return;

    const recents = await DB.getRecents(20).catch(() => []);
    const songs   = recents.filter(r => r.type === 'song');
    if (!songs.length) return;

    const metaResults = await Promise.allSettled(
      songs.map(s => DB.getMeta(s.id).catch(() => null))
    );

    const toScan = [];

    songs.forEach((s, i) => {
      const m       = metaResults[i].status === 'fulfilled' ? metaResults[i].value : null;
      const hasBlob = !!m?.coverBlob;
      const hasUrl  = !!(m?.thumbnailUrl && m.thumbnailUrl !== 'id3'
                          && !m.thumbnailUrl.startsWith('blob:'));

      if (hasBlob) {
        // Blob in DB — just refresh the session URL (free, no network)
        Meta.revoke(s.id);
        const url = Meta.injectCover(s.id, m.coverBlob);
        if (url) {
          _updateHomeCardThumbnail(s.id, url, true);
          _updateTopListThumb(s.id, url, true);
          _updateRowThumbnail(s.id, url, true);
        }
      } else if (!hasUrl && !_sessionScannedIds.has(s.id)) {
        // No cover anywhere and not yet scanned → queue for ID3 download
        toScan.push(s);
      }
    });

    if (toScan.length && typeof Drive !== 'undefined') {
      console.log(`[SyncScan] ${toScan.length} incoming recent(s) need cover scan`);
      toScan.forEach(s => _sessionScannedIds.delete(s.id)); // ensure _softScanItems processes them
      await _softScanItems(toScan);
    }
  }

  /**
   * Scan history items that arrived from another device without a cover.
   * Called 1 s after a live-sync 'history' event so DB writes have settled.
   *
   * Two paths per item:
   *  • coverBlob already in DB  → instant: revoke + injectCover + paint (no network)
   *  • no cover at all          → soft-scan via _softScanItems (1 MB head download)
   *
   * Items already handled this session (_sessionScannedIds) are skipped.
   */
  async function _scanIncomingHistory() {
    if (typeof Meta === 'undefined' || !Auth.isAuthenticated()) return;

    const raw    = await DB.getHistory(50).catch(() => []);
    const songs  = raw.filter(r => r.type === 'song' || !r.type); // history entries are always songs
    if (!songs.length) return;

    const metaResults = await Promise.allSettled(
      songs.map(s => DB.getMeta(s.id).catch(() => null))
    );

    const toScan = [];

    songs.forEach((s, i) => {
      const m       = metaResults[i].status === 'fulfilled' ? metaResults[i].value : null;
      const hasBlob = !!m?.coverBlob;
      const hasUrl  = !!(m?.thumbnailUrl && m.thumbnailUrl !== 'id3'
                          && !m.thumbnailUrl.startsWith('blob:'));

      if (hasBlob) {
        // Blob in DB — refresh session URL for free (no network)
        Meta.revoke(s.id);
        const url = Meta.injectCover(s.id, m.coverBlob);
        if (url) {
          _updateTopListThumb(s.id, url, true);   // history + top-played share this class
          _updateHomeCardThumbnail(s.id, url, true);
          _updateRowThumbnail(s.id, url, true);
        }
      } else if (!hasUrl && !_sessionScannedIds.has(s.id)) {
        // No cover anywhere and not yet scanned this session → queue for ID3 download
        toScan.push(s);
      }
    });

    if (toScan.length && typeof Drive !== 'undefined') {
      console.log(`[HistScan] ${toScan.length} history item(s) need cover scan`);
      toScan.forEach(s => _sessionScannedIds.delete(s.id)); // ensure _softScanItems processes them
      await _softScanItems(toScan);
    }
  }

  /**
   * Boot-time ID3 refresh for all home items that carry embedded covers.
   * Runs once per session, ~5 s after auth, so the DB/sync cycle has settled
   * and every surface (pinned, recents, topPlayed, history, queue) receives a
   * fresh blob: URL for embedded art.
   *
   * Two paths:
   *  • coverBlob already in DB   → instant (no network): revoke stale session URL,
   *    call Meta.injectCover, paint every visible surface.
   *  • thumbnailUrl === 'id3' but no blob in DB → re-scan (downloads 1 MB head,
   *    parses ID3, writes coverBlob, paints DOM).
   */
  async function _bootId3Refresh() {
    if (typeof Meta === 'undefined') return;

    // ── Collect all home items ──────────────────────────────────────────
    const [pinnedItems, recents, topPlayedRaw, historyItems] = await Promise.all([
      DB.getPinnedFolders().catch(() => []),
      DB.getRecents(50).catch(() => []),
      DB.getTopPlayed(50).catch(() => []),
      DB.getHistory(CONFIG.HISTORY_MAX).catch(() => []),
    ]);
    const queueItems = (typeof Player !== 'undefined')
      ? (Player.getQueue?.()?.queue || []) : [];

    const all = [
      ...pinnedItems.filter(p => !p.isFolder && p.type !== 'folder'),
      ...recents.filter(r => r.type === 'song'),
      ...topPlayedRaw,
      ...historyItems,
      ...queueItems,
    ];

    // ── Deduplicate ─────────────────────────────────────────────────────
    const seen   = new Set();
    const unique = all.filter(item => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    if (!unique.length) return;

    // ── Bulk-fetch DB meta ──────────────────────────────────────────────
    const metaResults = await Promise.allSettled(
      unique.map(item => DB.getMeta(item.id).catch(() => null))
    );

    const withBlob  = []; // coverBlob in DB  → instant refresh, no network
    const needsScan = []; // thumbnailUrl='id3' but no blob, OR previously scanned with no
                          // cover found (softScannedAt set, coverBlob null) — may have been
                          // missed due to large APIC frame exceeding the old 1MB head limit.

    unique.forEach((item, i) => {
      const m = metaResults[i].status === 'fulfilled' ? metaResults[i].value : null;
      if (m?.coverBlob) {
        withBlob.push({ item, dbMeta: m });
      } else if (m?.thumbnailUrl === 'id3') {
        // Sentinel set but blob missing (e.g. different device synced the flag without the blob)
        needsScan.push(item);
      } else if (m?.softScannedAt && !m?.thumbnailUrl && !m?.coverUrl) {
        // Was scanned before but no cover was stored. The APIC frame may have extended
        // beyond the 1MB head that was downloaded at scan time. Re-scan with the new
        // tag-size-aware logic (which extends the download if needed).
        needsScan.push(item);
      }
    });

    if (!withBlob.length && !needsScan.length) return;
    console.log(`[BootId3] ${withBlob.length} instant blob refresh + ${needsScan.length} to re-scan`);

    // ── Fast path: blob in DB → revoke stale URL + fresh inject + paint ─
    // Batches of 8 (CPU-only: URL.createObjectURL — no I/O)
    const FAST_BATCH = 8;
    for (let i = 0; i < withBlob.length; i += FAST_BATCH) {
      await Promise.all(withBlob.slice(i, i + FAST_BATCH).map(async ({ item, dbMeta }) => {
        try {
          Meta.revoke(item.id);                                    // clear stale blob: URL
          const url = Meta.injectCover(item.id, dbMeta.coverBlob);
          if (!url) return;
          _updateHomeCardThumbnail(item.id, url, true);
          _updateTopListThumb(item.id, url, true);
          _updatePinnedItemCover(item.id, url, true);
          _updateRowThumbnail(item.id, url, true);
          Player.patchQueueItem?.(item.id, { thumbnailUrl: url });
        } catch (_) {}
      }));
      await new Promise(r => setTimeout(r, 0)); // yield to keep UI responsive
    }

    // ── Slow path: id3 sentinel but no blob → soft-scan (head download) ─
    if (needsScan.length && typeof Drive !== 'undefined' && Auth.isAuthenticated()) {
      // Clear session guard so _softScanItems re-downloads and re-parses these
      needsScan.forEach(item => _sessionScannedIds.delete(item.id));
      await _softScanItems(needsScan);
    }
  }

  /**
   * Background cover prefetch for Home song cards.
   * Pass 0: DB persisted covers (instant).
   * Pass 1: Meta in-memory cache (instant).
   * Pass 2: Soft scan via _softScanItems (all unscanned items, with Drive fallback).
   * Pass 3: Drive thumbnail API for songs still without cover.
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
          if (url) { _updateHomeCardThumbnail(song.id, url, true); return; }
        }
        // External URL persisted from Last.fm / AudD.io in a previous session.
        // Filter out blob: (session-only) and 'id3' sentinel (no real URL).
        const persistedUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
        if (persistedUrl && !persistedUrl.startsWith('blob:') && persistedUrl !== 'id3') {
          _updateHomeCardThumbnail(song.id, persistedUrl);
        }
      } catch (_) {}
    }));

    // Pass 1: in-memory Meta cache (current session — instant, no DB call)
    songs.forEach(song => {
      const meta = Meta.getCached(song.id);
      if (meta?.coverUrl) _updateHomeCardThumbnail(song.id, meta.coverUrl, true);
    });

    // Pass 2: soft scan — download ID3 header for every song not yet scanned on this
    // device (regardless of whether it already has a cover from Pass 0/1 — we want
    // softScannedAt stamped and all metadata fields populated).
    await _softScanItems(songs);

    // Pass 3: Drive API thumbnail fallback for songs still without cover after scan
    await _driveThumbFallback(songs, _homeCardHasCover, _updateHomeCardThumbnail);
  }

  /**
   * Background cover prefetch for Top Played list items.
   * Pass 0: DB persisted covers. Pass 1: in-memory cache.
   * Pass 2: soft scan via _softScanItems (all unscanned items).
   * Pass 3: Drive thumbnail API fallback.
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
        if (persistedUrl && !persistedUrl.startsWith('blob:') && persistedUrl !== 'id3') {
          _updateTopListThumb(item.id, persistedUrl);
        }
      } catch (_) {}
    }));

    // Pass 1: in-memory Meta cache (always ID3)
    items.forEach(item => {
      const meta = Meta.getCached(item.id);
      if (meta?.coverUrl) _updateTopListThumb(item.id, meta.coverUrl, true);
    });

    // Pass 2: soft scan — same logic as home: scan all items not yet scanned on this device
    await _softScanItems(items);

    // Pass 3: Drive API fallback — songs still without cover after scan
    await _driveThumbFallback(items, _topListHasCover, _updateTopListThumb);
  }

  function _topListHasCover(fileId) {
    const el = document.querySelector(`.top-list-item[data-id="${CSS.escape(fileId)}"]`);
    if (!el) return false;
    const img = el.querySelector('.top-list-thumb img');
    if (!img) return false;
    if (img.style.display === 'none') return false;  // onerror hid the img → broken URL
    const rawSrc = img.getAttribute('src');
    if (!rawSrc || rawSrc === 'id3') return false;
    return true;
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
      return;
    }
    if (isId3 && img?.dataset.coverSrc === 'id3') { img.src = coverUrl; return; } // refresh session URL

    // Build img element without innerHTML — avoids wiping out the .eq-bars child
    const newImg = document.createElement('img');
    newImg.src = coverUrl;
    newImg.alt = '';
    newImg.loading = 'lazy';
    newImg.style.cssText = 'width:100%;height:100%;object-fit:cover';
    if (isId3) newImg.dataset.coverSrc = 'id3';
    newImg.onerror = () => {
      const ph = document.createElement('div');
      ph.className = 'thumb-placeholder';
      newImg.replaceWith(ph);
    };

    const ph = thumb.querySelector('.thumb-placeholder');
    if (ph) {
      ph.replaceWith(newImg);
    } else if (img) {
      img.replaceWith(newImg);
    } else {
      // Insert before .eq-bars so the overlay stays on top
      const eqBars = thumb.querySelector('.eq-bars');
      eqBars ? thumb.insertBefore(newImg, eqBars) : thumb.appendChild(newImg);
    }
  }

  /* ── DOM helpers for song rows (Favorites / Playlist detail) ── */

  /** Returns true if the .song-row for this id already shows a VALID cover <img>. */
  function _songRowHasCover(fileId) {
    const row = document.querySelector(`.song-row[data-id="${CSS.escape(fileId)}"]`);
    if (!row) return false;
    const img = row.querySelector('.song-thumb img');
    if (!img) return false;
    if (img.style.display === 'none') return false;  // onerror hid the img → broken URL
    const rawSrc = img.getAttribute('src');
    if (!rawSrc || rawSrc === 'id3') return false;
    return true;
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
      img.src = url; // refresh session URL — same embedded cover, new blob: URL
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

  /** Returns true if the home-card for this id already shows a VALID cover <img>.
   *  Returns false for broken placeholders (src='id3' sentinel or failed loads). */
  function _homeCardHasCover(fileId) {
    const card = document.querySelector(`#screen-home .home-card[data-id="${CSS.escape(fileId)}"]`);
    if (!card) return false;
    const img = card.querySelector('.home-card-art img');
    if (!img) return false;
    if (img.style.display === 'none') return false;  // onerror hid the img → broken URL
    // getAttribute('src') is the raw value — 'id3' sentinel set during enrichment
    // means the card has a broken placeholder, not a real cover.
    const rawSrc = img.getAttribute('src');
    if (!rawSrc || rawSrc === 'id3') return false;
    return true;
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
          const dtMeta   = await DB.getMeta(item.id).catch(() => null);
          const dtManual = (dtMeta?.manualAt || 0) > 0;

          // ── Pass A: download ID3 header → parse embedded cover art ──────
          // Skip if already soft-scanned (we know there's no embedded art → avoid
          // redundant 1 MB download; song without cover falls through to Pass B).
          if (!dtManual && !dtMeta?.softScannedAt && typeof Meta !== 'undefined') {
            const headBlob = await Drive.downloadFileHead(item.id, 1024 * 1024).catch(() => null);
            if (headBlob) {
              const meta = await Meta.parse(item.id, headBlob).catch(() => null);

              // Build enrichment patch — only fill fields not already in DB so we
              // never overwrite data that a more authoritative pass already set.
              const patch = { softScannedAt: Date.now() };
              if (meta) {
                if (meta.title  && !dtMeta?.displayName) patch.displayName = meta.title;
                if (meta.artist && !dtMeta?.artist)      { patch.artist = meta.artist; patch.artistInferred = false; }
                if (meta.album  && !dtMeta?.album)       patch.album  = meta.album;
                if (meta.year   && !dtMeta?.year)        patch.year   = meta.year;
                if (meta.coverBlob && !dtMeta?.coverBlob) {
                  patch.coverBlob    = meta.coverBlob;
                  patch.thumbnailUrl = 'id3';
                }
              }
              DB.setMeta(item.id, { id: item.id, ...patch }).catch(() => {});

              if (meta?.coverUrl) {
                updateFn(item.id, meta.coverUrl, true);
                // Update name labels in every visible home surface
                if (meta.title) {
                  _updateHomeCardName(item.id, meta.title);
                  _updateTopListName(item.id, meta.title);
                }
                continue; // got cover — skip Pass B
              }
            } else {
              // Download failed — still mark as attempted so we don't retry every load
              DB.setMeta(item.id, { id: item.id, softScannedAt: Date.now() }).catch(() => {});
            }
          }

          // ── Pass B: Drive file metadata thumbnailLink (rarely set for audio) ──
          if (!dtManual) {
            const info = await Drive.getFileInfo(item.id).catch(() => null);
            const url  = info?.thumbnailUrl || null;
            if (url) {
              updateFn(item.id, url);
              DB.setMeta(item.id, { thumbnailUrl: url }).catch(() => {});
            }
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

  /* ── Home cache (localStorage) ──────────────────────────────
     Stale-while-revalidate: paint the last known home data
     instantly on startup, then overwrite with fresh DB data.
  ─────────────────────────────────────────────────────────── */

  const _HOME_CACHE_KEY = 'savart_home_v1';
  const _HOME_CACHE_TTL = 30 * 24 * 3600 * 1000; // 30 days

  function _saveHomeCache({ pinned, recents, topPlayed, playlists }) {
    try {
      // Strip blob:// URLs — they are session-only object URLs that become
      // invalid after the page reloads and cannot be persisted.
      const stripBlob = url => (url && !url.startsWith('blob:')) ? url : undefined;
      const cleanItem = item => {
        const c = { ...item };
        if (c.thumbnailUrl) c.thumbnailUrl = stripBlob(c.thumbnailUrl);
        if (c.coverUrl)     c.coverUrl     = stripBlob(c.coverUrl);
        return c;
      };
      const payload = {
        pinned:    (pinned    || []).slice(0, 20).map(cleanItem),
        recents:   (recents   || []).slice(0, 20).map(cleanItem),
        topPlayed: (topPlayed || []).slice(0, 20).map(cleanItem),
        playlists: (playlists || []).slice(0, 12).map(pl => ({
          ...pl,
          resolvedCovers: (pl.resolvedCovers || []).filter(u => !u.startsWith('blob:')),
        })),
        savedAt: Date.now(),
      };
      localStorage.setItem(_HOME_CACHE_KEY, JSON.stringify(payload));
    } catch (_) { /* ignore quota errors */ }
  }

  function _restoreHomeCacheSync() {
    try {
      const raw = localStorage.getItem(_HOME_CACHE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || (Date.now() - (data.savedAt || 0)) > _HOME_CACHE_TTL) return;
      UI.renderHome({
        pinned:    data.pinned    || [],
        recents:   data.recents   || [],
        topPlayed: data.topPlayed || [],
        playlists: data.playlists || [],
      });
      // Re-mark active row after fresh DOM nodes are created
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
    } catch (_) { /* ignore parse/missing errors */ }
  }

  /* ── Home ────────────────────────────────────────────────── */

  async function _loadHomeData({ debounce = false } = {}) {
    // Debounce: when called rapidly (sync events, track-start, etc.) collapse into
    // a single render to avoid flicker and scroll-position resets on the home screen.
    // Bypass debounce for the very first render (home is still empty — instant paint).
    const homeHasContent = !!document.querySelector('#screen-home .home-section');
    if (debounce && homeHasContent) {
      clearTimeout(_loadHomeDebounceTimer);
      return new Promise(resolve => {
        _loadHomeDebounceTimer = setTimeout(() => _loadHomeData().then(resolve).catch(resolve), _LOAD_HOME_DEBOUNCE_MS);
      });
    }
    try {
      const [pinned, recents, topPlayedRaw, rawPlaylists] = await Promise.all([
        DB.getPinnedFolders(),
        DB.getRecents(20),
        DB.getTopPlayed(20),
        DB.getPlaylists(),
      ]);

      // Load metadata store records for all song recents AND topPlayed items.
      // Using a unified map keyed by file ID so both sections get fresh DB values —
      // topPlayed items not in recents would otherwise be enriched with stale data.
      const songIdsSet = new Set([
        ...recents.filter(r => r.type === 'song').map(r => r.id),
        ...topPlayedRaw.map(t => t.id),
      ]);
      const songIdsList   = [...songIdsSet];
      const metaRecords   = await Promise.all(songIdsList.map(id => DB.getMeta(id).catch(() => null)));
      const metaMap       = new Map();
      songIdsList.forEach((id, i) => { if (metaRecords[i]) metaMap.set(id, metaRecords[i]); });

      // Enrich pinned songs with artist, displayName, thumbnailUrl from metadata store
      // (togglePin only saves id/name/displayName/type/thumbnailUrl — no artist)
      const pinnedSongs = pinned.filter(p => p.type !== 'folder' && !p.isFolder);
      const pinnedMetaRecords = await Promise.all(
        pinnedSongs.map(p => DB.getMeta(p.id).catch(() => null))
      );
      const pinnedMetaMap = new Map();
      pinnedSongs.forEach((p, i) => { if (pinnedMetaRecords[i]) pinnedMetaMap.set(p.id, pinnedMetaRecords[i]); });

      const _pick = (...vals) => vals.find(v => v && String(v).trim() !== '') || '';
      // Only use persisted URLs that are NOT stale blob: URLs from a previous session,
      // and NOT the 'id3' sentinel (used to mark songs with embedded ID3 art — the actual
      // blob URL is recreated at session start via Meta.injectCover).
      // blob: URLs are session-scoped object URLs — they become invalid after page reload.
      // In-memory coverUrls (inMem.coverUrl) are always fresh within the current session.
      const _safeUrl = u => (u && !u.startsWith('blob:') && u !== 'id3') ? u : null;

      // Helper: stamp folderType on an item using the collection cache.
      // Called at enrichment time so context menus always have the correct label
      // regardless of when _collectionFolderIdsCache was populated.
      const _stampFolderType = (item, dbMeta) => {
        if (item.folderType) return item.folderType; // already set (e.g. folder rows)
        const fid = dbMeta?.folderId || item.folderId || item.parents?.[0] || null;
        if (!fid) return undefined;
        return isFolderCollection(fid) ? 'collection' : 'album';
      };

      // Helper: resolve a cover URL for enrichment — injects blob into Meta cache
      // synchronously (URL.createObjectURL is sync) so the FIRST render already
      // has the cover, without waiting for _prefetchHomeCovers Pass 0.
      const _resolveCoverUrl = (id, dbMeta, inMem, ...fallbacks) => {
        if (dbMeta?.coverBlob) {
          return inMem?.coverUrl
            || (typeof Meta !== 'undefined' ? Meta.injectCover(id, dbMeta.coverBlob) : null)
            || null;
        }
        return _pick(...fallbacks);
      };

      const enrichedPinned = pinned.map(p => {
        if (p.type === 'folder' || p.isFolder) return p;
        const dbMeta = pinnedMetaMap.get(p.id);
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(p.id) : null;
        return {
          ...p,
          displayName:  _pick(dbMeta?.displayName, dbMeta?.name, inMem?.title,   p.displayName,  p.name),
          artist:       _pick(dbMeta?.artist,       inMem?.artist,  p.artist),
          thumbnailUrl: _resolveCoverUrl(p.id, dbMeta, inMem, _safeUrl(dbMeta?.thumbnailUrl), _safeUrl(dbMeta?.coverUrl), inMem?.coverUrl, _safeUrl(p.thumbnailUrl), _safeUrl(p.thumbnailLink)),
          folderId:     dbMeta?.folderId || p.folderId || null,
          folderType:   _stampFolderType(p, dbMeta),
        };
      });

      // Enrich recents songs with metadata store data (fixes bare/empty-name records)
      const enrichedRecents = recents.map(r => {
        if (r.type !== 'song') return r;
        const dbMeta = metaMap.get(r.id);
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(r.id) : null;
        return {
          ...r,
          displayName:  _pick(dbMeta?.displayName, dbMeta?.name, inMem?.title,   r.displayName,  r.name),
          name:         _pick(dbMeta?.name,          r.name),
          thumbnailUrl: _resolveCoverUrl(r.id, dbMeta, inMem, _safeUrl(dbMeta?.thumbnailUrl), _safeUrl(dbMeta?.coverUrl), inMem?.coverUrl, _safeUrl(r.thumbnailUrl), _safeUrl(r.thumbnailLink)),
          artist:       _pick(dbMeta?.artist,        inMem?.artist,   r.artist),
          folderId:     dbMeta?.folderId || r.folderId || null,
          folderType:   _stampFolderType(r, dbMeta),
        };
      });

      // Enrich topPlayed with recents + metadata store + in-memory Meta cache
      const recentMap = new Map(enrichedRecents.map(r => [r.id, r]));
      const topPlayed = topPlayedRaw.map(item => {
        const r      = recentMap.get(item.id);
        const dbMeta = metaMap.get(item.id);
        const inMem  = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
        return {
          ...item,
          displayName:  _pick(dbMeta?.displayName,  dbMeta?.name,     inMem?.title,    item.displayName,  r?.displayName, r?.name, item.name),
          name:         _pick(dbMeta?.name,          item.name,        r?.name),
          thumbnailUrl: _resolveCoverUrl(item.id, dbMeta, inMem, _safeUrl(dbMeta?.thumbnailUrl), _safeUrl(dbMeta?.coverUrl), inMem?.coverUrl, _safeUrl(item.thumbnailUrl), _safeUrl(item.coverUrl), _safeUrl(r?.thumbnailUrl), _safeUrl(r?.thumbnailLink)),
          artist:       _pick(dbMeta?.artist,        inMem?.artist,    item.artist,     r?.artist),
          albumName:    _pick(dbMeta?.album,         inMem?.album,     item.albumName,  item.album,         r?.albumName),
          year:         _pick(dbMeta?.year,          inMem?.year,      item.year,       r?.year),
          folderId:     dbMeta?.folderId || item.folderId || r?.folderId || null,
          folderType:   _stampFolderType(item, dbMeta),
        };
      });

      // Resolve covers for recent playlists (first 4 unique usable URLs per playlist).
      // Priority per song: in-memory blob (session) → DB coverBlob inject → DB external URL.
      const _isUsableExt = u => u && u !== 'id3' && !u.startsWith('blob:')
        && !(u.includes('googleapis.com') && !u.includes('googleusercontent.com'));
      const enrichedPlaylists = await Promise.all(
        rawPlaylists.slice(0, 12).map(async pl => {
          const covers = [];
          const seen   = new Set();
          for (const sid of (pl.songIds || []).slice(0, 24)) {
            if (covers.length >= 4) break;
            // 1. In-memory Meta cache — blob: from this session is valid
            const inMem = (typeof Meta !== 'undefined') ? Meta.getCached(sid) : null;
            let url = inMem?.coverUrl || null;
            // 2. DB coverBlob → inject object URL (valid for this session)
            if (!url) {
              try {
                const dbM = await DB.getMeta(sid);
                if (dbM?.coverBlob && typeof Meta !== 'undefined') {
                  url = Meta.injectCover(sid, dbM.coverBlob) || null;
                }
                // 3. DB external URL
                if (!url) {
                  const ext = dbM?.thumbnailUrl || dbM?.coverUrl || null;
                  url = _isUsableExt(ext) ? ext : null;
                }
              } catch (_) {}
            }
            if (!url || seen.has(url)) continue;
            seen.add(url);
            covers.push(url);
          }
          return { ...pl, resolvedCovers: covers };
        })
      );

      UI.renderHome({ pinned: enrichedPinned, recents: enrichedRecents, topPlayed, playlists: enrichedPlaylists });
      // Re-mark the active row after renderHome creates fresh DOM nodes
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);

      // Persist home data to localStorage so the next startup can paint instantly
      // before the DB is ready (stale-while-revalidate).
      _saveHomeCache({ pinned: enrichedPinned, recents: enrichedRecents, topPlayed, playlists: enrichedPlaylists });

      // Async: load cover art for song cards and top-played in the background
      _prefetchHomeCovers(enrichedRecents).catch(() => {});
      _prefetchTopPlayedCovers(topPlayed).catch(() => {});
      _prefetchPinnedCovers(enrichedPinned).catch(() => {});
      _prefetchHomePlaylists(enrichedPlaylists).catch(() => {});

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
    // Mark detail as open immediately so _loadPlaylists (async) won't
    // overwrite the detail pane once it finishes its DB queries.
    _libInDetail        = true;
    _libDetailRestoreFn = () => onPlaylistClick(pl);
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

  async function _openFolder(folder, appendToBreadcrumb = true, scrollToId = null) {
    UI.showView('browse');

    // Save current scroll position before leaving this folder (forward navigation).
    // On back navigation (appendToBreadcrumb = false) we restore it after render.
    if (appendToBreadcrumb && _browseFolderId) {
      const browseScreen = document.getElementById('screen-browse');
      if (browseScreen) _browseScrollMap.set(_browseFolderId, browseScreen.scrollTop);
    }

    // If the browse search is active (user navigated from search results),
    // clear it so the folder contents are not hidden behind #search-results.
    const searchInp = document.getElementById('search-input');
    if (searchInp?.value) {
      searchInp.value = '';
      const browseScreen  = document.getElementById('screen-browse');
      const searchResults = document.getElementById('search-results');
      const browseList    = document.querySelector('#screen-browse .item-list:not(#search-results)');
      const filters       = document.querySelector('.browse-search-filters');
      const clearBtn      = document.getElementById('btn-search-clear');
      if (browseScreen)  browseScreen.classList.remove('search-active');
      if (searchResults) { searchResults.style.display = 'none'; searchResults.innerHTML = ''; }
      if (browseList)    browseList.style.display    = '';
      if (filters)       filters.style.display       = 'none';
      if (clearBtn)      clearBtn.style.display      = 'none';
      UI.updateSearchChipCounts?.(null);
    }

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

      // Tag each sub-folder as 'album' or 'collection' for the browse chip.
      // Always refresh from DB so chips reflect the current state (e.g. after
      // the user moves files in Drive and rescans — or between sessions).
      await _refreshCollectionCache().catch(() => {});
      const colCache      = _collectionFolderIdsCache || new Set();
      const knownFolders  = _allKnownFolderIdsCache;   // null only if refresh threw
      result.folders.forEach(f => {
        // Only show a chip when this folder actually has songs in the DB.
        // Folders that only contain other folders get no chip.
        if (knownFolders && knownFolders.has(f.id)) {
          f.folderType = colCache.has(f.id) ? 'collection' : 'album';
          f.songCount  = _folderSongCountCache?.get(f.id) || 0;
        }
        // else: leave f.folderType undefined → no chip rendered
      });

      // Enrich files with DB metadata (artist, album, displayName) so Browse rows
      // show artist · album from the first render, not just filename + size.
      // Runs in parallel for speed; silently skips files not yet in DB.
      if (result.files.length > 0) {
        const dbMetas = await Promise.allSettled(result.files.map(f => DB.getMeta(f.id)));
        dbMetas.forEach((res, i) => {
          const m = (res.status === 'fulfilled') ? res.value : null;
          const f = result.files[i];
          if (m) {
            if (m.artist)      f.artist      = m.artist;
            if (m.album)       f.album       = m.album;
            if (m.displayName) f.displayName = m.displayName;
            // Also pick up persisted thumbnailUrl/coverBlob so _buildSongRow shows cover
            if (!f.thumbnailUrl && m.thumbnailUrl && m.thumbnailUrl !== 'id3') {
              f.thumbnailUrl = m.thumbnailUrl;
            }
            // Prefer exact DB value
            if (m.durationSec > 0) f.durationSec = m.durationSec;
          }
          // durationMs from Drive API is unreliable for audio — do not persist it as durationSec.
          // Real duration is captured from the audio element when the song plays (_onProgress).
        });
      }

      const activeSong = Player.getCurrentTrack();
      UI.renderFolderContents(result.folders, result.files, activeSong?.id);
      UI.setActiveSongRow(activeSong?.id ?? null);

      // Scroll to and highlight a specific song (e.g. from "Go to Drive Folder")
      if (scrollToId) {
        requestAnimationFrame(() => {
          const screen = document.getElementById('screen-browse');
          const row = screen?.querySelector(`.song-row[data-id="${CSS.escape(scrollToId)}"]`);
          if (row) {
            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
            row.classList.add('goto-highlight');
            setTimeout(() => row.classList.remove('goto-highlight'), 2000);
          }
        });
      }

      // Restore scroll position when navigating back (appendToBreadcrumb = false)
      if (!appendToBreadcrumb) {
        const savedScroll = _browseScrollMap.get(folder.id);
        if (savedScroll != null) {
          const browseScreen = document.getElementById('screen-browse');
          if (browseScreen) {
            requestAnimationFrame(() => { browseScreen.scrollTop = savedScroll; });
          }
        }
      }

      if (result.folders.length > 0) _patchFolderDots(result.folders).catch(() => {});

      // Re-stamp rescan wave overlay on any visible folder icon if a rescan is running
      if (_browseRescanRunning && _browseFolderId) _setRescanOverlay(_browseFolderId, true);
      if (_libRescanActiveFolderId) _setRescanOverlay(_libRescanActiveFolderId, true);

      // Lightweight movement reconciliation (fire-and-forget):
      // Detects files moved in Drive (folderId mismatch) without a full rescan.
      // If any records changed, rebuild the chip cache and patch visible folder rows.
      _reconcileBrowseFolder(folder.id, result.files).catch(() => {});

      // Update item count badge — include album/collection chip for current folder.
      // Priority: (1) folder.folderType from parent view, (2) files present = leaf folder.
      const total = result.folders.length + result.files.length;
      const countEl = document.getElementById('browse-item-count');
      if (countEl) {
        countEl.textContent = '';
        // curType uses only already-computed variables — zero extra DB cost
        const curType = folder.folderType
          || (result.files.length > 0 || knownFolders?.has(folder.id)
              ? (colCache.has(folder.id) ? 'collection' : 'album')
              : null);
        if (curType) {
          const chip = document.createElement('span');
          chip.className = curType === 'collection'
            ? 'folder-type-chip folder-type-chip--collection'
            : 'folder-type-chip folder-type-chip--album';
          chip.textContent = curType === 'collection' ? UI.t('lbl_collection') : UI.t('lbl_album_chip');
          countEl.appendChild(chip);
        }
        if (total > 0) {
          countEl.appendChild(document.createTextNode(
            `${total} ${total === 1 ? UI.t('lbl_item') : UI.t('lbl_items')}`
          ));
        }
      }

      // Track current browse folder for rescan
      _browseFolderId = folder.id;
      _browseFiles    = result.files;
      // Update the rescan dot: show green if this folder was previously scanned
      _updateBrowseLegend(folder.id);

      // Persist folder name in meta so _loadCollections can use the Drive name
      // without an extra API call.  We never overwrite a name the user typed.
      DB.getMeta(folder.id).then(existing => {
        if (!existing?.name) {
          DB.setMeta(folder.id, { id: folder.id, name: folder.name }).catch(() => {});
        }
      }).catch(() => {});

      // Cache all items for queue resolution
      result.files.forEach(f => _cacheItem(f));

      // Prefetch folder cover art and apply to all song rows (fire-and-forget)
      _prefetchAndApplyFolderCovers(folder.id, result.files);

      // Soft scan: lightweight ID3-only enrichment for folders not yet rescanned.
      // Runs in background — no UI blocking, no MusicBrainz/Last.fm/AudD calls.
      _softScanFolder(folder.id, result.files).catch(() => {});

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
    // On mobile, collapse the expanded player so Browse is visible
    if (!window.matchMedia('(min-width: 768px)').matches) {
      UI.setExpandedPlayerVisible(false);
    }
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
        _openFolder({ id: folder.id, name: folder.name }, true, item.id);
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
   *
   * @param {DriveItem}   clickedSong   — the song that was tapped
   * @param {DriveItem[]|null} contextSongs — when provided (e.g. album detail view),
   *   the full ordered list of songs that should become the queue. The clicked song
   *   becomes the starting position and radio refill activates when ≤ 2 remain.
   */
  function onSongClick(clickedSong, contextSongs = null) {
    if (UI.getCurrentView() === 'browse') {
      const searchTerm = document.getElementById('search-input')?.value.trim();

      if (searchTerm) {
        // Search is active: build queue from the search results so the clicked song
        // actually plays and Prev/Next cycles through the other results.
        // Do NOT use .item-list here — those are the folder items behind the results,
        // and the clicked song may not exist in that folder at all.
        const resultsEl = document.getElementById('search-results');
        const rows      = Array.from(resultsEl?.querySelectorAll('.song-row:not(.wma)') || []);
        const allSongs  = rows.map(r => _resolveItemById(r.dataset.id)).filter(Boolean);

        _resetRadio();
        if (allSongs.length > 0) {
          const startIdx = allSongs.findIndex(s => s.id === clickedSong.id);
          Player.setQueue(allSongs, startIdx >= 0 ? startIdx : 0);
        } else {
          // Fallback: radio mode from the single clicked song
          _radioModeActive = true;
          _radioQueuedIds  = new Set([clickedSong.id]);
          _radioArtist     = _guessArtistFromItem(clickedSong) || null;
          Player.setQueue([clickedSong], 0);
        }

      } else {
        // No search active: build queue from the full folder list so Prev/Next follows
        // the complete folder order (same behaviour as before).
        const sourceEl = document.querySelector('#screen-browse .item-list');
        const rows     = Array.from(sourceEl?.querySelectorAll('.song-row:not(.wma)') || []);
        const ids      = rows.map(r => r.dataset.id);
        const allSongs = ids.map(id => _resolveItemById(id)).filter(Boolean);

        _resetRadio();
        if (allSongs.length > 0) {
          const startIdx = allSongs.findIndex(s => s.id === clickedSong.id);
          Player.setQueue(allSongs, startIdx >= 0 ? startIdx : 0);
        } else {
          _radioModeActive = true;
          _radioQueuedIds  = new Set([clickedSong.id]);
          Player.setQueue([clickedSong], 0);
        }
      }

    } else if (contextSongs?.length > 0) {
      // Album detail (or any view that passes the full context list):
      // queue = whole album in order, radio kicks in when ≤ 2 songs remain.
      _resetRadio();
      _radioModeActive = true;
      // Pre-seed all album IDs so radio never re-adds them as new results
      _radioQueuedIds  = new Set(contextSongs.map(s => s.id));
      // Pre-seed artist so radio can start searching without waiting for AudD
      _radioArtist     = _guessArtistFromItem(clickedSong) || null;
      const startIdx   = contextSongs.findIndex(s => s.id === clickedSong.id);
      Player.setQueue(contextSongs, startIdx >= 0 ? startIdx : 0);

    } else {
      // Search, History, Home, single-song Library clicks: one song → radio fills the rest
      _resetRadio();
      _radioModeActive = true;
      _radioQueuedIds  = new Set([clickedSong.id]);
      _radioArtist     = _guessArtistFromItem(clickedSong) || null;
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
  function _cacheItem(item, skipDbPersist = false) {
    _itemCache.set(item.id, item);
    // Persist Drive thumbnailLink to DB so playlists/favorites can show covers across sessions.
    // Skip if the user has manually set a custom cover (manualAt > 0) — we must not overwrite it.
    // skipDbPersist = true when the caller (e.g. _softScanFolder) just wrote a definitive DB
    // record via bulkWriteMeta and must not have it overwritten by this async DB.setMeta.
    if (skipDbPersist) return;
    const thumb = item.thumbnailLink || item.thumbnailUrl;
    if (thumb && !thumb.startsWith('blob:')) {
      DB.getMeta(item.id).then(m => {
        if (!((m?.manualAt || 0) > 0)) {
          DB.setMeta(item.id, { thumbnailUrl: thumb }).catch(() => {});
        }
      }).catch(() => {});
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
    const label = item.type === 'folder' || item.isFolder ? UI.t('item_type_folder') : UI.t('item_type_song');
    UI.showToast(`${label} ${isNowPinned ? UI.t('toast_pinned') : UI.t('toast_unpinned')}`, 'default');
    _loadHomeData();
    Sync.push('pinned');
  }

  async function onRemoveFromTopPlayed(item) {
    // Set hiddenFromTopPlayed so sync can't restore it via Math.max on playCount.
    // playCount is zeroed so legacy getTopPlayed callers also exclude it.
    await DB.setMeta(item.id, { playCount: 0, hiddenFromTopPlayed: true }).catch(() => {});
    UI.showToast(UI.t('toast_removed_top_played'));
    _loadHomeData();
    if (typeof Sync !== 'undefined') Sync.push('playcounts'); // propagate hide to other devices
  }

  async function onRemoveFromHistory(item) {
    await DB.removeRecent(item.id).catch(() => {});
    UI.showToast(UI.t('toast_removed_history'));
    _loadHomeData();
    Sync.push('recents'); // propagate tombstone to other devices
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

      const _safeUrl = u => (u && !u.startsWith('blob:') && u !== 'id3') ? u : null;

      const items = raw.map((item, i) => {
        const dbMeta  = metaRecords[i];
        const inMem   = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
        // Inject coverBlob into Meta cache synchronously so the first render
        // already shows the embedded cover — same pattern as _loadHomeData 3.4.8
        let coverUrl = inMem?.coverUrl || null;
        if (!coverUrl && dbMeta?.coverBlob && typeof Meta !== 'undefined') {
          coverUrl = Meta.injectCover(item.id, dbMeta.coverBlob) || null;
        }
        if (!coverUrl) {
          coverUrl = _pick(_safeUrl(dbMeta?.thumbnailUrl), _safeUrl(dbMeta?.coverUrl), _safeUrl(item.thumbnailUrl)) || null;
        }
        return {
          ...item,
          // dbMeta (metadata store) reflects the latest rescan result — always
          // prefer it over item.displayName which was snapshot-saved at play time
          // and may be a stale filename from before the rescan ran.
          displayName:  _pick(inMem?.title,    dbMeta?.displayName, item.displayName,  item.name, dbMeta?.name),
          artist:       _pick(inMem?.artist,   dbMeta?.artist,      item.artist),
          albumName:    _pick(inMem?.album,     dbMeta?.album,       item.albumName),
          thumbnailUrl: coverUrl,
        };
      });

      UI.renderHistory(items);
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
      // Async: soft scan + Drive fallback for items without cover yet
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
      if (item._isAlbum && item._album) {
        // Album bulk-add: resolve all songs then add each one
        const songs = await _resolveAlbumSongs(item._album);
        await Promise.all(songs.map(s => DB.addToPlaylist(playlistId, s.id)));
        UI.showToast(`${songs.length} ${UI.t('songs').toLowerCase()} → "${pl?.name || 'playlist'}"`);
      } else {
        await DB.addToPlaylist(playlistId, item.id);
        await _saveItemMeta(item);
        UI.showToast(`${UI.t('toast_added_to_pl')} "${pl?.name || 'playlist'}"`);
      }
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
      if (item._isAlbum && item._album) {
        const songs = await _resolveAlbumSongs(item._album);
        await Promise.all(songs.map(s => DB.addToPlaylist(pl.id, s.id)));
      } else {
        await DB.addToPlaylist(pl.id, item.id);
        await _saveItemMeta(item);
      }
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
      // AND semantics: every query word must fuzzy-match at least one filename word.
      // Without this gate, "los bukis" would accept "De Los Angeles" because
      // "los"→1.0 and "bukis"→0 average to 0.5 ≥ MIN_SCORE.
      if (best < 0.3) return 0;
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

    container.innerHTML = `<div class="empty-state"><p>${UI.t('searching')}</p></div>`;
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
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
      // Prefetch covers (same pipeline as Browse)
      if (result.files?.length) {
        _prefetchAndApplyFolderCovers(null, result.files).catch(() => {});
      }
    } catch (err) {
      console.error('[App] Search error:', err);
      if (err.name === 'AuthError') { UI.showTokenBanner(); return; }
      container.innerHTML = `<div class="empty-state"><p>${UI.t('search_error')}</p></div>`;
    }
  }

  /* ── Library ─────────────────────────────────────────────── */

  // ── Meta suggestions cache (artist/album autocomplete) ───────────────────────
  let _metaSuggestionsCache   = null;
  let _metaSuggestionsCacheTs = 0;

  /**
   * Return deduplicated, sorted lists of artist and album names from the
   * metadata store.  Results are cached for 30 s to avoid repeated DB scans.
   * @returns {Promise<{artists: string[], albums: string[]}>}
   */
  async function getMetaSuggestions() {
    const now = Date.now();
    if (_metaSuggestionsCache && now - _metaSuggestionsCacheTs < 30_000) {
      return _metaSuggestionsCache;
    }
    const all     = await DB.getAllMetaLight().catch(() => []);
    const artists = [...new Set(all.map(m => m.artist).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const albums  = [...new Set(all.map(m => m.album).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    _metaSuggestionsCache   = { artists, albums };
    _metaSuggestionsCacheTs = now;
    return _metaSuggestionsCache;
  }

  /** Invalidate suggestions cache (call after bulk metadata writes). */
  function _invalidateSuggestionsCache() { _metaSuggestionsCache = null; }

  let _currentLibTab  = 'albums'; // persists tab across sync refreshes
  let _libInDetail    = false;       // true while showing an artist/album drill-down
  let _libDetailRestoreFn = null;    // restores detail view when user nav Home → Library
  let _libScrollBeforeDetail = 0;    // .lib-detail scrollTop saved before drill-down
  const _libDetailPane = () => document.querySelector('#screen-library .lib-detail');

  /**
   * Restore .lib-detail scrollTop after re-rendering a paginated list.
   * Synchronously pre-renders extra pages (artists / albums) until the
   * content is tall enough to reach savedScroll, then sets scrollTop.
   */
  function _restoreLibScroll(savedScroll) {
    if (savedScroll <= 0) return;
    const libPane = _libDetailPane();
    if (!libPane) return;

    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Pre-render pages until the pane is scrollable to savedScroll
      let safety = 0;
      while (
        libPane.scrollHeight - libPane.clientHeight < savedScroll - 4 &&
        safety++ < 60
      ) {
        const sentinel = libPane.querySelector('.lib-scroll-sentinel');
        if (!sentinel) break;
        sentinel.remove();
        if (_currentLibTab === 'artists') _renderArtistPage(false);
        else if (_currentLibTab === 'albums') _renderAlbumPage(false);
        else break;
      }
      libPane.scrollTop = savedScroll;
    }));
  }

  /** Reset .lib-detail to top when entering any drill-down view. */
  function _scrollDetailToTop() {
    const libPane = _libDetailPane();
    if (libPane) requestAnimationFrame(() => { libPane.scrollTop = 0; });
  }

  // ── Library pagination ────────────────────────────────────
  const LIB_PAGE_SIZE     = 40;
  let _libAllArtists      = [];   // full sorted list (source of truth)
  let _libAllAlbums       = [];
  let _libArtistOffset    = 0;    // how many cards already rendered
  let _libAlbumOffset     = 0;
  let _libArtistObserver  = null; // IntersectionObserver for sentinel
  let _libAlbumObserver   = null;
  let _libSearchDebounce  = null; // timer for search input debounce

  const LIB_TAB_PLACEHOLDERS = {
    favorites:   'Buscar en Favoritos…',
    artists:     'Buscar artista…',
    albums:      'Buscar álbum…',
    collections: 'Buscar colección…',
    playlists:   'Buscar playlist…',
  };

  /**
   * Switch the active library tab: update DOM active state,
   * update search placeholder and load the tab's data.
   */
  function _setLibSearchBarVisible(visible) {
    const wrap = document.querySelector('.lib-search-wrap');
    if (wrap) wrap.style.display = visible ? '' : 'none';
  }

  function _setLibTab(tab, skipLoad = false) {
    _currentLibTab = tab;
    _libInDetail        = false; // leaving any drill-down view
    _libDetailRestoreFn = null;  // explicit tab switch — no restore needed

    // Disconnect any active pagination observers when switching tabs
    _libArtistObserver?.disconnect(); _libArtistObserver = null;
    _libAlbumObserver?.disconnect();  _libAlbumObserver  = null;
    clearTimeout(_libSearchDebounce);

    // Show search bar (hidden while inside a drill-down)
    _setLibSearchBarVisible(true);

    // Active state on tab items
    document.querySelectorAll('#lib-sidebar .lib-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });

    // Persist search text across tab switches — loaders re-apply it automatically.
    // Sync rescan button state — keeps it visible if a scan is currently running.
    _syncLibRescanBtn();

    // Update placeholder
    UI.setLibSearchPlaceholder(LIB_TAB_PLACEHOLDERS[tab] || 'Buscar…');

    // Load data (skipLoad = true when the caller will immediately drill into a detail
    // view, e.g. onGoToAlbum — skipping the list render avoids a visible flash)
    if (!skipLoad) {
      if (tab === 'favorites')   _loadStarred();
      if (tab === 'artists')     _loadArtists();
      if (tab === 'albums')      _loadAlbums();
      if (tab === 'collections') _loadCollections();
      if (tab === 'playlists')   _loadPlaylists();
    }
  }

  /**
   * Navigate back to a parent list tab WITHOUT clearing the search input.
   * Used by all back-buttons inside drill-down views (album detail, artist detail).
   * After re-rendering the list, re-applies whatever is currently in the search bar.
   */
  function _libGoBack(tab) {
    _currentLibTab      = tab;
    _libInDetail        = false;
    _libDetailRestoreFn = null;  // user pressed Back — no restore needed

    // Restore search bar
    _setLibSearchBarVisible(true);

    document.querySelectorAll('#lib-sidebar .lib-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });

    // Update placeholder but leave the search input text intact
    UI.setLibSearchPlaceholder(LIB_TAB_PLACEHOLDERS[tab] || 'Buscar…');

    // Reload data — each loader re-applies the current search filter after render
    if (tab === 'artists') {
      const savedScroll = _libScrollBeforeDetail;
      _loadArtists().then(() => _restoreLibScroll(savedScroll)).catch(() => {});
    }
    if (tab === 'albums') {
      const savedScroll = _libScrollBeforeDetail;
      _loadAlbums().then(() => _restoreLibScroll(savedScroll)).catch(() => {});
    }
    if (tab === 'collections') {
      const savedScroll = _libScrollBeforeDetail;
      _loadCollections().then(() => _restoreLibScroll(savedScroll)).catch(() => {});
    }
    if (tab === 'playlists')   _loadPlaylists();
  }

  /** Filter visible items in #lib-detail-content by search text. */
  function _onLibSearch(query) {
    if (_libInDetail) return;
    // Re-render the active tab from offset 0 with the new query applied
    if (_currentLibTab === 'artists')  _renderArtistPage(true);
    if (_currentLibTab === 'albums')   _renderAlbumPage(true);
    // DOM-based filter for tabs that render all items at once
    if (_currentLibTab === 'favorites' || _currentLibTab === 'playlists' || _currentLibTab === 'collections') _domFilterLibItems();
  }

  /**
   * Show/hide rendered items in the active library pane based on the current
   * search input. Reads dataset.searchKey (pre-normalized with norm()) on each item.
   * Used for Favorites and Playlists tabs where all items are rendered upfront.
   */
  function _domFilterLibItems() {
    const q = norm((document.getElementById('lib-search-input')?.value || '').trim());
    // Playlists use #lib-pl-list-pane; Favorites use #lib-detail-content
    const pane = document.getElementById('lib-pl-list-pane')
              || document.getElementById('lib-detail-content');
    if (!pane) return;
    pane.querySelectorAll('[data-search-key]').forEach(el => {
      el.style.display = (!q || el.dataset.searchKey.includes(q)) ? '' : 'none';
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
      // If a playlist detail is already open (e.g. navigated from a pinned card),
      // don't overwrite the detail pane — just update the count badge.
      if (_libInDetail && _currentLibTab === 'playlists') {
        _setLibTabCount('playlists', enriched.length);
        _prefetchPlaylistCovers(enriched).catch(() => {});
        return;
      }
      UI.renderPlaylists(enriched);
      _setLibTabCount('playlists', enriched.length);
      _domFilterLibItems();
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
            blob = await Drive.downloadFileHead(sid, 1024 * 1024).catch(() => null);
          }
          if (!blob) continue;

          const meta = await Meta.parse(sid, blob);
          if (!meta) continue;
          // Write full enrichment (not just coverBlob) — benefits all home surfaces
          const sm = await DB.getMeta(sid).catch(() => null);
          if (!((sm?.manualAt || 0) > 0)) {
            const patch = { softScannedAt: Date.now() };
            if (meta.title  && !sm?.displayName) patch.displayName = meta.title;
            if (meta.artist && !sm?.artist)      { patch.artist = meta.artist; patch.artistInferred = false; }
            if (meta.album  && !sm?.album)       patch.album  = meta.album;
            if (meta.year   && !sm?.year)        patch.year   = meta.year;
            if (meta.coverBlob && !sm?.coverBlob) {
              patch.coverBlob    = meta.coverBlob;
              patch.thumbnailUrl = 'id3';
            }
            DB.setMeta(sid, { id: sid, ...patch }).catch(() => {});
          }
          if (meta.coverUrl) {
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
    if (!songs.length) return;

    const _pinnedHasCover = id => {
      const art = document.querySelector(`.pinned-card-art[data-id="${CSS.escape(id)}"]`);
      return !!(art && art.querySelector('.pinned-art-img'));
    };

    // Pass 0: DB persisted covers — blob first, then external URL — all in parallel
    await Promise.allSettled(songs.map(async item => {
      try {
        const dbMeta = await DB.getMeta(item.id);
        if (!dbMeta) return;
        if (dbMeta.coverBlob) {
          const url = Meta.injectCover(item.id, dbMeta.coverBlob);
          if (url) { _updatePinnedItemCover(item.id, url, true); return; }
        }
        // External URL (Last.fm / MusicBrainz / AudD) — valid across sessions
        const extUrl = dbMeta.coverUrl || dbMeta.thumbnailUrl;
        if (extUrl && !extUrl.startsWith('blob:') && extUrl !== 'id3') {
          _updatePinnedItemCover(item.id, extUrl);
        }
      } catch (_) { /* non-fatal */ }
    }));

    // Pass 1: in-memory Meta cache (covers resolved this session — always fresh)
    songs.forEach(item => {
      const inMem = Meta.getCached(item.id);
      if (inMem?.coverUrl) _updatePinnedItemCover(item.id, inMem.coverUrl, true);
    });

    // Pass 2: soft scan — all pinned songs not yet scanned on this device
    await _softScanItems(songs);

    // Pass 3: Drive API fallback — songs still without cover after scan
    await _driveThumbFallback(songs, _pinnedHasCover, _updatePinnedItemCover);
  }

  /**
   * Background cover prefetch for Home playlist cards (the 2×2 mosaic grid).
   *
   * For each playlist on the home screen:
   *   Pass 0 — read covers already in DB / in-memory cache (free, no network)
   *   Pass 1 — for songs still without a cover and not yet scanned locally,
   *             delegate to _softScanItems (download 1 MB head → parse ID3)
   *   After each playlist: rebuild the mosaic in-place via UI.updatePlaylistHomeCardCovers
   *
   * Only 4 songs per playlist are examined (we need at most 4 tiles for the mosaic).
   * Playlists that already have 4 resolved covers from _loadHomeData are skipped.
   *
   * @param {Object[]} playlists — enrichedPlaylists array from _loadHomeData
   */
  async function _prefetchHomePlaylists(playlists) {
    if (!playlists.length || typeof Meta === 'undefined') return;

    // External URLs that work in <img> without auth token
    const _isUsableExt = url =>
      url && url !== 'id3' && !url.startsWith('blob:') &&
      !(url.includes('googleapis.com') && !url.includes('googleusercontent.com'));

    // Resolve one cover for a single song id. Priority:
    //   1. In-memory Meta cache (blob: from current session — always valid)
    //   2. DB coverBlob → inject into Meta → blob: URL (valid this session)
    //   3. DB external URL (googleusercontent.com, Last.fm, etc.)
    // Returns null if nothing found.
    const _resolveOne = async (sid) => {
      const inMem = Meta.getCached(sid);
      if (inMem?.coverUrl) return inMem.coverUrl; // blob: or ext — both valid in session

      const dbM = await DB.getMeta(sid).catch(() => null);
      if (!dbM) return null;

      if (dbM.coverBlob) {
        const injected = Meta.injectCover(sid, dbM.coverBlob);
        if (injected) return injected; // blob: URL — valid this session
      }

      const extUrl = dbM.thumbnailUrl || dbM.coverUrl || null;
      return _isUsableExt(extUrl) ? extUrl : null;
    };

    for (const pl of playlists) {
      try {
        const songIds = (pl.songIds || []).slice(0, 24);
        if (!songIds.length) continue;

        const covers = [];
        const seen   = new Set();
        const toScan = []; // songs with no cover at all — may need soft scan

        for (const sid of songIds) {
          if (covers.length >= 4 && toScan.length === 0) break;

          const url = await _resolveOne(sid);
          if (url && !seen.has(url)) {
            seen.add(url);
            if (covers.length < 4) covers.push(url);
            continue;
          }

          // No cover found — queue for soft scan if never scanned on this device
          if (covers.length < 4) {
            const dbM = await DB.getMeta(sid).catch(() => null);
            if (dbM && !dbM.softScannedAt && !dbM.rescannedAt && !dbM.manualAt) {
              toScan.push({ id: sid });
            }
          }
        }

        // Pass 1: soft-scan songs with no cover, then re-resolve
        if (toScan.length > 0) {
          await _softScanItems(toScan);
          for (const item of toScan) {
            if (covers.length >= 4) break;
            const url = await _resolveOne(item.id);
            if (url && !seen.has(url)) { seen.add(url); covers.push(url); }
          }
        }

        // Update mosaic only if we found something new
        const existing = pl.resolvedCovers || [];
        const changed  = covers.length > existing.length ||
                         covers.some((u, i) => u !== existing[i]);
        if (covers.length > 0 && changed && typeof UI !== 'undefined') {
          UI.updatePlaylistHomeCardCovers(pl.id, covers);
        }
      } catch (_) { /* non-fatal — next playlist */ }
    }
  }

  /** Patch the cover art of a pinned card for a given song id. */
  function _updatePinnedItemCover(id, url, isId3 = false) {
    const art = document.querySelector(`.pinned-card-art[data-id="${CSS.escape(id)}"]`);
    if (!art) return;
    const img = art.querySelector('.pinned-art-img');
    if (!isId3 && img) {
      if (img.dataset.coverSrc === 'id3') return; // ID3 is always protected
      img.src = url;
    } else if (isId3 && img?.dataset.coverSrc === 'id3') {
      img.src = url; // refresh session URL — same embedded cover, new blob: URL
    } else {
      const newImg = document.createElement('img');
      newImg.className = 'pinned-art-img';
      newImg.alt = '';
      newImg.src = url;
      if (isId3) newImg.dataset.coverSrc = 'id3';
      newImg.onerror = () => newImg.remove();
      if (img) { img.replaceWith(newImg); }
      else { art.insertBefore(newImg, art.firstChild); }
    }
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
  /**
   * Downloads an external cover URL and persists it as coverBlob in IndexedDB.
   * Called fire-and-forget so it never blocks the UI.
   * Skips if: already has a blob, URL is a blob/data URI, or no network.
   * @param {string} id   — track/file ID
   * @param {string} url  — external image URL (Last.fm, MusicBrainz, manual, etc.)
   * @param {boolean} [force=false] — overwrite existing coverBlob (use on manual edits)
   */
  async function _cacheExternalCover(id, url, force = false) {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    // 'id3' sentinel — extract the cover from the audio file's embedded ID3 tags.
    // Used when a rescan found an ID3 cover but no external URL; the sentinel is synced
    // so other devices know to extract from the embedded art rather than fetching nothing.
    if (url === 'id3') {
      if (typeof Meta === 'undefined') return;
      const m = await DB.getMeta(id).catch(() => null);
      if (!force && m?.coverBlob) return; // already cached locally
      try {
        let blob = await DB.getCachedBlob(id);
        if (!blob) blob = await Drive.downloadFileHead(id, 256 * 1024);
        if (!blob) return;
        const meta = await Meta.parse(id, blob);
        if (meta?.coverBlob) await DB.setMeta(id, { coverBlob: meta.coverBlob });
      } catch (_) {}
      return;
    }
    // Most external image CDNs do not send Access-Control-Allow-Origin headers,
    // so fetch() is CORS-blocked even though <img src> loads them fine.
    // Only attempt blob-caching for same-origin URLs or explicitly CORS-safe APIs.
    // Known CORS-blocked: lh3.googleusercontent.com (Drive), i.discogs.com,
    //   lastfm.freetls.fastly.net, staticflickr.com, and most image CDNs.
    try {
      const _u = new URL(url);
      if (_u.origin !== window.location.origin) return; // cross-origin → use as <img src>, don't fetch
    } catch (_) { return; } // malformed URL — skip
    try {
      if (!force) {
        const m = await DB.getMeta(id).catch(() => null);
        if (m?.coverBlob) return; // already cached locally
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const blob = await res.blob();
      if (!blob || !blob.type.startsWith('image/') || blob.size < 500) return;
      await DB.setMeta(id, { coverBlob: blob });
    } catch (_) { /* network error / timeout — silent */ }
  }

  async function _resolveCoverUrl(id, storedUrl) {
    // Read DB meta once — reused for manualAt check, blob, and URL fallback.
    const dbMeta = await DB.getMeta(id).catch(() => null);

    // ── Manual cover lock ─────────────────────────────────────────────────────
    // If the user explicitly set a cover (manualAt > 0), that URL wins over
    // everything — including ID3 in-memory cache and persisted coverBlob.
    // This is what makes "Apply to all" actually stick.
    if ((dbMeta?.manualAt || 0) > 0) {
      const manualUrl = dbMeta?.thumbnailUrl;
      if (manualUrl && manualUrl !== 'id3' && !manualUrl.startsWith('blob:')) {
        _cacheExternalCover(id, manualUrl).catch(() => {});
        return manualUrl;
      }
    }

    // Priority for non-manual songs: ID3 embedded art > external persisted URL
    // 1. In-memory Meta cache: song was parsed this session (fastest, no DB round-trip)
    const inMem = (typeof Meta !== 'undefined') ? Meta.getCached(id) : null;
    if (inMem?.coverUrl) return inMem.coverUrl;
    // 2. Persisted coverBlob in DB (ID3 embedded — wins over external URLs)
    if (dbMeta?.coverBlob && typeof Meta !== 'undefined') {
      const url = Meta.injectCover(id, dbMeta.coverBlob);
      if (url) return url;
    }
    // 3. Stored web URL (non-blob, from Last.fm / AudD / Drive thumbnailLink)
    //    'id3' is a sentinel meaning "use embedded art" — skip it as a real URL
    const ext = dbMeta?.thumbnailUrl || storedUrl || null;
    if (ext && ext !== 'id3' && !ext.startsWith('blob:')) {
      // Cache the image locally so it loads offline next time (fire-and-forget)
      _cacheExternalCover(id, ext).catch(() => {});
      return ext;
    }
    // 4. Drive thumbnail from item cache (rarely set for audio)
    const cached = _itemCache.get(id);
    const driveUrl = cached?.thumbnailLink || cached?.thumbnailUrl || null;
    if (driveUrl) _cacheExternalCover(id, driveUrl).catch(() => {});
    return driveUrl;
  }

  async function _loadStarred() {
    try {
      const starred = await DB.getStarred();
      const enriched = await Promise.all(starred.map(async song => {
        const url = await _resolveCoverUrl(song.id, song.thumbnailUrl);
        return url ? { ...song, thumbnailUrl: url } : song;
      }));
      UI.renderStarredSongs(enriched);
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
      _setLibTabCount('fav', enriched.length);
      _domFilterLibItems();
      _driveThumbFallback(
        enriched.filter(s => !s.thumbnailUrl),
        _songRowHasCover,
        _updateSongRowThumb
      ).catch(() => {});
    } catch (err) {
      console.error('[App] Load starred error:', err);
    }
  }

  /**
   * Full library refresh: BFS scan of all Drive from ROOT_FOLDER_ID, then
   * purges DB records for files that no longer exist in Drive.
   *
   * Differences from the old background scanner:
   *  - Always runs (no session guard)
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

  /**
   * Scan a specific folder subtree (BFS from the given root).
   * Like _fullLibraryRefresh but scoped — no global orphan purge.
   * Triggered from Settings via the folder picker.
   */
  async function _scanSpecificFolder(folderId, folderLabel) {
    const btn  = document.getElementById('btn-settings-folder-scan');
    const icon = btn?.querySelector('svg');
    if (btn)  btn.disabled = true;
    if (icon) icon.style.animation = 'spin 1s linear infinite';

    try {
      UI.showToast(`Escaneando ${folderLabel}…`);

      const queue   = [{ id: folderId, name: folderLabel, parentName: '' }];
      const visited = new Set();
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
          console.warn('[FolderScan] Error:', folderName, err);
          continue;
        }

        for (const f of page.folders) {
          queue.push({ id: f.id, name: f.name, parentName: folderName });
        }

        if (page.audioFiles.length >= 2) {
          await _inferAlbumMeta(folderName, parentName, page.audioFiles, page.imageFiles);
        }

        if (foldersScanned % 10 === 0) {
          UI.showToast(`Escaneando ${folderLabel}… ${foldersScanned} carpetas`);
        }

        await new Promise(r => setTimeout(r, 60));
      }

      if (typeof Sync !== 'undefined') Sync.push('metadata');

      if (!_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
      }

      UI.showToast(`✓ ${folderLabel} — ${foldersScanned} carpetas escaneadas`);
    } catch (err) {
      console.error('[FolderScan] Error:', err);
      UI.showToast(UI.t('ds_err_scan_folder') || 'Error scanning folder');
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

  let _dsRunning          = false;
  let _dsPaused           = false;
  let _dsPausedForToken   = false;  // true when auto-paused due to expired token
  let _dsStopFlag         = false;
  let _dsStopping         = false;  // true between "Stop clicked" and scan actually ending
  let _dsSession       = null;
  let _dsListMode      = 'attn';     // 'attn' | 'done' | 'skipped' | 'all'
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
    const ts   = Date.now();
    for (const id of folderIdSet) {
      hist.folders[id] = { name: nameMap[id] || '', scannedAt: now };
      // Also persist in IDB metadata so the rescan dot lights up in browse/library views
      DB.setMeta(id, { rescannedAt: ts }).catch(() => {});
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
      if (!_dsSession.skippedList)        _dsSession.skippedList        = {};
      if (!_dsSession.rescanMode)         _dsSession.rescanMode         = 'skip';
      if (!_dsSession.pendingQueue)       _dsSession.pendingQueue       = [];
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
        pendingQueue:       [],   // saved BFS queue — restored on resume
        folders:            {},   // needs-attention entries
        completedList:      {},   // folderId → {id,name,path,count}
        skippedList:        {},   // folderId → {id,name,path,count} — skipped (>40 files)
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

  /** Splits a full path string into { basename, pathPrefix } */
  function _dsSplitFolderPath(fullPath) {
    const parts = (fullPath || '').split(' › ');
    return {
      basename:   parts[parts.length - 1] || '',
      pathPrefix: parts.slice(0, -1).join(' › ')
    };
  }

  /** Updates the folder-bar name, path, and button label from session state. */
  function _dsUpdateFolderBar() {
    const full    = _dsSession.selectedFolderName || CONFIG.ROOT_FOLDER_NAME;
    const { basename, pathPrefix } = _dsSplitFolderPath(full);
    const nameEl  = document.getElementById('ds-folder-name');
    const pathEl  = document.getElementById('ds-folder-path');
    const btnLbl  = document.getElementById('ds-folder-btn-label');
    if (nameEl) nameEl.textContent = basename;
    if (pathEl) pathEl.textContent = pathPrefix;
    if (btnLbl) {
      const hasCustomFolder = _dsSession.selectedFolderId &&
                              _dsSession.selectedFolderId !== CONFIG.ROOT_FOLDER_ID;
      btnLbl.setAttribute('data-i18n', hasCustomFolder ? 'ds_change_folder_btn' : 'ds_open_folder_btn');
      btnLbl.textContent = hasCustomFolder ? UI.t('ds_change_folder_btn') : UI.t('ds_open_folder_btn');
    }
  }

  /** @deprecated kept for compat — use _dsUpdateFolderBar */
  function _dsFitFolderName() {}

  /* Full render from session state. */
  function _dsRenderAll() {
    _dsUpdateFolderBar();

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

  /* Line 1: pinned folder indicator — always visible, updated per folder.
     Lines 2-3: scrolling activity log (newest at bottom, max 2 entries). */

  /**
   * Updates the pinned (top) log line.
   * Format: "12/47  ·  Folder Name"
   * @param {string} folderName
   */
  function _dsSetPinnedFolder(folderName) {
    const strip = document.getElementById('ds-log');
    if (!strip) return;
    const ph = strip.querySelector('.ds-log-placeholder');
    if (ph) ph.remove();
    let pinned = strip.querySelector('.ds-log-pinned');
    if (!pinned) {
      pinned = document.createElement('div');
      pinned.className = 'ds-log-entry ds-log-pinned';
      strip.insertBefore(pinned, strip.firstChild);
    }
    const done  = _dsSession.scannedFolders || 0;
    const total = _dsSession.totalFolders   || 0;
    const ratio = total > 0 ? `${done + 1}/${total}` : `${done + 1}`;
    pinned.textContent = `${ratio}  ·  ${folderName}`;
  }

  /**
   * Updates (in-place) the second log line — the per-file progress line.
   * Format: "  1/12  ·  Track Name"
   * @param {string} msg
   */
  function _dsUpdateFileLine(msg) {
    const strip = document.getElementById('ds-log');
    if (!strip) return;
    let line = strip.querySelector('.ds-log-entry:not(.ds-log-pinned)');
    if (!line) {
      line = document.createElement('div');
      line.className = 'ds-log-entry';
      strip.appendChild(line);
    }
    line.textContent = msg;
  }

  /* Keep at most 1 scrolling line below the pinned folder line. */
  function _dsLogLine(msg, cls = '') {
    const strip = document.getElementById('ds-log');
    if (strip) {
      const ph = strip.querySelector('.ds-log-placeholder');
      if (ph) ph.remove();

      const div = document.createElement('div');
      div.className = 'ds-log-entry' + (cls ? ' ' + cls : '');
      div.textContent = msg;
      strip.appendChild(div);

      // Keep pinned line + at most 1 scrolling line
      const entries = [...strip.querySelectorAll('.ds-log-entry:not(.ds-log-pinned)')];
      while (entries.length > 1) {
        entries.shift().remove();
      }
    }
    if (!_dsSession.log) _dsSession.log = [];
    _dsSession.log.push(msg);
    if (_dsSession.log.length > 300) _dsSession.log = _dsSession.log.slice(-300);
  }

  function _dsRestoreLog() {
    const strip = document.getElementById('ds-log');
    if (!strip) return;
    strip.innerHTML = '';
    const allLines = _dsSession.log || [];
    if (allLines.length === 0) {
      strip.innerHTML = `<div class="ds-log-entry ds-log-placeholder">${UI.t('scan_log_empty')}</div>`;
      return;
    }
    // Restore pinned folder: find last 📁 line
    const lastFolder = [...allLines].reverse().find(l => l.startsWith('📁'));
    if (lastFolder) {
      const pinned = document.createElement('div');
      pinned.className = 'ds-log-entry ds-log-pinned';
      pinned.textContent = lastFolder;
      strip.appendChild(pinned);
    }
    // Restore last 2 non-folder scrolling lines
    const scrollLines = allLines.filter(l => !l.startsWith('📁')).slice(-2);
    for (const line of scrollLines) {
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
    const startBtn   = document.getElementById('btn-ds-start');
    const restartBtn = document.getElementById('btn-ds-restart');
    const pauseBtn   = document.getElementById('btn-ds-pause');
    const stopBtn    = document.getElementById('btn-ds-stop');
    const statusEl   = document.getElementById('ds-status-text');
    if (!startBtn || !_dsSession) return;

    const running  = _dsRunning && !_dsPaused;
    const paused   = _dsRunning &&  _dsPaused;
    const done     = !_dsRunning && _dsSession.status === 'done';
    const stopped  = !_dsRunning && _dsSession.status === 'stopped';
    const crashed  = !_dsRunning && _dsSession.status === 'running';
    // scan is "alive" in memory — controls show Pausar/Detener
    const scanning = running || paused;

    const iconPlay  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    const iconPause = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

    // ── Start button: visible only when NOT scanning ──────────
    startBtn.style.display = scanning ? 'none' : '';
    startBtn.disabled = false;
    // Label reflects what pressing it will do
    if (done)                    startBtn.innerHTML = iconPlay + ' ' + UI.t('scan_btn_start');
    else if (stopped || crashed) startBtn.innerHTML = iconPlay + ' ' + UI.t('scan_btn_start');
    else                         startBtn.innerHTML = iconPlay + ' ' + UI.t('scan_btn_start');

    // ── Pause button: visible only while scanning ─────────────
    // When paused it becomes "Continuar"; click handler toggles via _dsPaused state
    pauseBtn.style.display = scanning ? '' : 'none';
    pauseBtn.disabled = false;
    if (paused) { pauseBtn.innerHTML = iconPlay  + ' ' + UI.t('scan_btn_resume'); }
    else        { pauseBtn.innerHTML = iconPause + ' ' + UI.t('scan_btn_pause');  }

    // ── Stop button: visible only while scanning ──────────────
    const iconStop = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`;
    stopBtn.style.display = scanning ? '' : 'none';
    if (_dsStopping) {
      stopBtn.innerHTML = iconStop + ' ' + UI.t('scan_btn_stopping');
      stopBtn.classList.add('ds-stopping');
      stopBtn.disabled = true;
    } else {
      stopBtn.innerHTML = iconStop + ' ' + UI.t('scan_btn_stop');
      stopBtn.classList.remove('ds-stopping');
      stopBtn.disabled = false;
    }

    // ── Restart button: always hidden (simplified flow) ───────
    if (restartBtn) restartBtn.style.display = 'none';

    if (statusEl) {
      const n   = _dsSession.scannedFolders;
      const lbl = n === 1 ? UI.t('lbl_folder_s') : UI.t('lbl_folders_s');
      if (done)        statusEl.textContent = `${UI.t('scan_status_done')} · ${n} ${lbl}`;
      else if (paused) statusEl.textContent = UI.t('scan_status_paused');
      else if (running)statusEl.textContent = `${UI.t('scan_status_scanning')} (${n})`;
      else if (stopped)statusEl.textContent = `${UI.t('scan_status_stopped')} · ${n} ${lbl}`;
      else if (crashed)statusEl.textContent = `${UI.t('scan_status_crashed')} · ${n} ${lbl}`;
      else if (n > 0)  statusEl.textContent = `${n} ${lbl}`;
      else             statusEl.textContent = UI.t('scan_status_ready');
    }

    _dsUpdateLED();
  }

  /* ── Counters ───────────────────────────────────────────── */

  function _dsUpdateCounters(queueLen = null, startMs = null) {
    if (!_dsSession) return;

    const attnCount    = Object.values(_dsSession.folders || {})
      .filter(f => f.status !== 'ignored' && !f.attended).length;
    const doneCount    = Object.keys(_dsSession.completedList || {}).length;
    const skippedCount = Object.keys(_dsSession.skippedList   || {}).length;
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
    const attnBadge    = document.getElementById('ds-attn-badge');
    const doneBadge    = document.getElementById('ds-done-badge');
    const skippedBadge = document.getElementById('ds-skipped-badge');
    if (attnBadge)    attnBadge.textContent    = attnCount;
    if (doneBadge)    doneBadge.textContent    = doneCount;
    if (skippedBadge) skippedBadge.textContent = skippedCount;
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
  let _dsModalPath      = [];   // [{id, name}] breadcrumb
  let _dsModalSel       = null; // currently highlighted {id, name}
  let _dsFolderCallback = null; // optional override: called instead of _dsConfirmFolderSelect

  /**
   * Open the folder browser modal.
   * @param {function({id, name, fullPath}): void} [callback]
   *   If provided, called on confirm instead of the default EP handler.
   */
  async function _dsOpenFolderBrowser(callback) {
    const modal = document.getElementById('ds-folder-modal');
    if (!modal) return;
    _dsFolderCallback = (typeof callback === 'function') ? callback : null;
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
    // Always enabled — confirm falls back to deepest breadcrumb folder if nothing is highlighted
    const btn = document.getElementById('btn-ds-modal-select');
    if (btn) btn.disabled = false;
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
    listEl.innerHTML = `<div class="ds-attention-empty">${UI.t('loading')}</div>`;
    _dsRenderModalBreadcrumb();

    try {
      const page = await Drive.listFolderScan(folderId);
      listEl.innerHTML = '';

      if (page.folders.length === 0) {
        listEl.innerHTML = `<div class="ds-attention-empty">${UI.t('scan_no_subfolders')}</div>`;
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
          <span class="ds-modal-folder-name">${_escHtml(folder.name)}</span>
          <span class="ds-modal-item-count">…</span>
          <svg class="ds-modal-folder-arrow" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>`;

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
        item.querySelector('.ds-modal-folder-arrow').addEventListener('click', async (e) => {
          e.stopPropagation();
          _dsModalPath.push({ id: folder.id, name: folder.name });
          _dsModalSel = { id: folder.id, name: folder.name };
          _dsUpdateModalSelectBtn();
          await _dsLoadModalFolder(folder.id);
        });

        listEl.appendChild(item);
      }

      // Async: fetch item counts for each subfolder in batches of 4
      const _currentFolderId = folderId; // capture to bail out if user navigates away
      const folderItems = [...listEl.querySelectorAll('.ds-modal-folder-item')];
      const BATCH = 4;
      for (let i = 0; i < folderItems.length; i += BATCH) {
        if (_dsModalPath[_dsModalPath.length - 1]?.id !== _currentFolderId) break; // navigated away
        const batch = folderItems.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async (item) => {
          const id = item.dataset.folderId;
          const countEl = item.querySelector('.ds-modal-item-count');
          try {
            const sub = await Drive.listFolderScan(id);
            const nAudio   = sub.audioFiles.length;
            const nFolders = sub.folders.length;
            if (!countEl) return;
            if (nAudio > 0 && nFolders > 0) {
              countEl.textContent = `${nAudio} ${UI.t('lbl_songs')} · ${nFolders} sub`;
            } else if (nAudio > 0) {
              countEl.textContent = `${nAudio} ${UI.t('lbl_songs')}`;
            } else if (nFolders > 0) {
              countEl.textContent = `${nFolders} sub`;
            } else {
              countEl.textContent = '—';
            }
          } catch (_) {
            if (countEl) countEl.textContent = '';
          }
        }));
      }
    } catch (err) {
      listEl.innerHTML = `<div class="ds-attention-empty">Error: ${_escHtml(err?.message || err)}</div>`;
    }
  }

  /* Called when user clicks "Seleccionar esta carpeta" */
  async function _dsConfirmFolderSelect() {
    // Use explicitly highlighted folder; fall back to deepest folder in the breadcrumb
    const sel = _dsModalSel || _dsModalPath[_dsModalPath.length - 1];
    if (!sel) return;
    const { id, name } = sel;

    // Build full path — avoid duplicating the name when it's already the last breadcrumb entry
    const pathNames = _dsModalPath.map(c => c.name);
    const alreadyInPath = _dsModalPath[_dsModalPath.length - 1]?.id === id;
    if (!alreadyInPath) pathNames.push(name);
    const fullPath = pathNames.join(' › ');

    _dsCloseModal('ds-folder-modal');

    // If a custom callback was set (e.g. from Settings folder scan), use it and return
    if (_dsFolderCallback) {
      const cb = _dsFolderCallback;
      _dsFolderCallback = null;
      cb({ id, name, fullPath });
      return;
    }

    // Update session
    _dsSession.selectedFolderId   = id;
    _dsSession.selectedFolderName = fullPath;
    _dsUpdateFolderBar();

    // Folder changed — reset progress so "Iniciar" always starts fresh from new folder
    _dsSession.pendingQueue   = [];
    _dsSession.visited        = [];
    _dsSession.status         = 'idle';
    _dsSession.scannedFolders = 0;
    _dsSession.totalFolders   = 0;
    _dsSession.folders        = {};
    _dsSession.completedList  = {};
    _dsSession.skippedList    = {};
    _dsSession.log            = [];
    _dsUpdateControls();
    _dsUpdateProgress();
    _dsUpdateCounters(0);
    await _dsSaveSession();

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
          descEl.textContent = (UI.t('ds_rescan_folder_prompt') || '"{name}" was previously scanned. What do you want to do?')
            .replace('{name}', folderLabel);
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

  /* ── Pre-scan folder count ─────────────────────────────── */

  /**
   * BFS through Drive from startFolderId, counting only folders that
   * contain audio files (1–40 files). Skips empty and >40 file folders.
   * Updates _dsSession.totalFolders and the status text while running.
   */
  async function _dsPrecountFolders(startFolderId) {
    const visited = new Set();
    const queue   = [startFolderId];
    let   count   = 0;
    const statusEl = document.getElementById('ds-status-text');

    while (queue.length > 0) {
      if (_dsStopFlag) break;
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      try {
        const page = await Drive.listFolderScan(id);
        for (const f of page.folders) {
          if (!visited.has(f.id)) queue.push(f.id);
        }
        // Only count leaf folders (have audio files but no subfolders)
        if (page.audioFiles.length > 0 && page.audioFiles.length <= 40 && page.folders.length === 0) {
          count++;
          _dsSession.totalFolders = count;
          if (statusEl) statusEl.textContent = `Contando… (${count})`;
        }
      } catch (_) { /* skip errors during pre-count */ }
    }
    _dsSession.totalFolders = count;
    return count;
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

    // Always start fresh from the configured folder — the only resume path is Pausar/Continuar
    _dsSession.startedAt      = new Date().toISOString();
    _dsSession.status         = 'running';
    _dsSession.scannedFolders = 0;
    _dsSession.totalFolders   = 0;
    _dsSession.visited        = [];
    _dsSession.pendingQueue   = [];
    _dsSession.folders        = {};
    _dsSession.completedList  = {};
    _dsSession.skippedList    = {};
    _dsSession.log            = [];
    _dsRestoreLog();
    _dsRenderAttentionList();
    _dsLogLine(`Iniciando escaneo en "${_dsSession.selectedFolderName || _dsSession.selectedFolderLabel || 'carpeta raíz'}"…`, 'info');

    _dsRunning  = true;
    _dsPaused   = false;
    _dsStopFlag = false;
    _dsUpdateControls();
    await _dsSaveSession();

    // Pre-count folders with audio before starting the pipeline
    const startId = _dsSession.selectedFolderId || CONFIG.ROOT_FOLDER_ID;
    _dsPrecountFolders(startId).then(() => {
      if (_dsRunning) _dsUpdateControls();
    });

    _runDeepScan().catch(err => {
      console.error('[DeepScan] Error:', err);
      _dsLogLine('⚠ Error: ' + (err?.message || err), 'warn');
      _dsRunning  = false;
      _dsStopping = false;
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
    _dsStopping = true;
    _dsLogLine('⏹ Deteniendo…', 'info');
    _dsUpdateControls();
  }

  /* Full reset: clears all progress and starts from scratch. */
  async function _restartDeepScan() {
    if (_dsRunning) return;
    _dsSession.startedAt      = new Date().toISOString();
    _dsSession.status         = 'running';
    _dsSession.scannedFolders = 0;
    _dsSession.totalFolders   = 0;
    _dsSession.visited        = [];
    _dsSession.pendingQueue   = [];
    _dsSession.folders        = {};
    _dsSession.completedList  = {};
    _dsSession.skippedList    = {};
    _dsSession.log            = [];
    _dsRestoreLog();
    _dsRenderAttentionList();
    _dsUpdateControls();
    _dsUpdateProgress();
    _dsUpdateCounters(0);
    _dsLogLine('Iniciando nuevo escaneo desde cero…', 'info');
    await _dsSaveSession();
    _dsRunning = true;
    _runDeepScan().catch(err => {
      console.error('[DeepScan] Error:', err);
      _dsLogLine('⚠ Error: ' + (err?.message || err), 'warn');
      _dsRunning  = false;
      _dsStopping = false;
      _dsUpdateControls();
    });
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

    // Restore pending queue from a previous stop, or start fresh from root
    const hasPending = Array.isArray(_dsSession.pendingQueue) && _dsSession.pendingQueue.length > 0;
    const queue = hasPending
      ? [..._dsSession.pendingQueue]
      : [{ id: startFolderId, name: startFolderName.split(' › ').pop(), path: startFolderName }];
    _dsSession.pendingQueue = [];  // consumed — clear so a fresh start doesn't re-use it

    let discovered = hasPending ? ((_dsSession.totalFolders || 0) + queue.length) : 1;
    const startMs  = Date.now();

    while (queue.length > 0) {
      // Pause spin — if paused due to token expiry, auto-resume when token is valid again
      while (_dsPaused && !_dsStopFlag) {
        await new Promise(r => setTimeout(r, 500));
        if (_dsPausedForToken && Auth.isAuthenticated()) {
          _dsPausedForToken = false;
          _dsPaused         = false;
          _dsLogLine('▶ Token renovado — continuando scan…', 'info');
          _dsUpdateControls();
        }
      }
      if (_dsStopFlag) break;

      // Proactive token check before Drive API call — pause if expired
      if (!Auth.isAuthenticated()) {
        if (!_dsPaused) {
          _dsPaused         = true;
          _dsPausedForToken = true;
          _dsLogLine('⚠ Sesión expirada — scan pausado. Renueva el token para continuar.', 'warn');
          _dsUpdateControls();
          UI.showToast('Sesión expirada — renueva para continuar el scan', 'warn');
        }
        continue; // loop back into the pause spin
      }

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
        if (err instanceof Drive.AuthError || err?.name === 'AuthError' || err?.status === 401) {
          // Token expired mid-call — put the folder back and pause until renewed
          queue.unshift({ id, name, path });
          visitedSet.delete(id);
          _dsPaused         = true;
          _dsPausedForToken = true;
          _dsLogLine('⚠ Sesión expirada — scan pausado. Renueva el token para continuar.', 'warn');
          _dsUpdateControls();
          UI.showToast('Sesión expirada — renueva para continuar el scan', 'warn');
          continue; // loop back into the pause spin
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

      _dsSession.totalFolders = Math.max(_dsSession.totalFolders || 0, discovered + queue.length);
      _dsUpdateProgress();
      _dsUpdateCounters(queue.length, startMs);

      // Folders with no audio: count & persist immediately (no pipeline to run)
      if (page.audioFiles.length === 0) {
        _dsSession.scannedFolders++;
        _dsSession.visited = [...visitedSet];
        newlyScanned.add(id);
        await new Promise(r => setTimeout(r, 20));
        continue;
      }

      // Skip folders with too many files (compilations / mega-folders)
      if (page.audioFiles.length > 40) {
        _dsLogLine(`↷ Saltada (${page.audioFiles.length} arch. > 40): ${path}`);
        _dsSession.skippedList[id] = { id, name, path, count: page.audioFiles.length, mime: page.audioFiles[0]?.mimeType || '' };
        if (_dsListMode === 'skipped' || _dsListMode === 'all') _dsAddOrUpdateFolderRow(id);
        _dsSession.scannedFolders++;
        _dsSession.visited = [...visitedSet];
        _dsUpdateCounters(queue.length, startMs);
        await new Promise(r => setTimeout(r, 10));
        continue;
      }

      // ── Run full recognition pipeline — identical to manual Album Rescan ──
      // NOTE: scannedFolders / visited are only persisted AFTER the pipeline
      // completes so that stopping mid-folder doesn't count it as done.

      // 1. Purge orphans
      const liveIds = page.audioFiles.map(f => f.id);
      await DB.purgeOrphans(id, liveIds).catch(() => {});

      // 2. Virgin reset: wipe ALL metadata (enrichment + manual) — only stars/playCount survive.
      // Deep Scan is the comprehensive power tool — runs unconditionally, no warning needed.
      await Promise.all(page.audioFiles.map(async f => {
        await DB.resetToVirgin(f.id).catch(() => {});
        if (typeof Meta !== 'undefined') Meta.revoke(f.id);
      }));
      _folderCoverCache.delete(id);

      // 3. Pin folder progress line and run recognition pass per-file (sequential)
      //    so line 2 updates as each track is processed.
      _dsSetPinnedFolder(name);
      const totalFiles = page.audioFiles.length;
      for (let fi = 0; fi < totalFiles; fi++) {
        if (_dsStopFlag) break;
        while (_dsPaused && !_dsStopFlag) await new Promise(r => setTimeout(r, 200));
        if (_dsStopFlag) break;
        const file = page.audioFiles[fi];
        _dsUpdateFileLine(`  ${fi + 1}/${totalFiles}  ·  ${cleanTitle(file.name)}`);
        try {
          await _prefetchAndApplyFolderCovers(id, [file], true);
        } catch (err) {
          _dsLogLine(`⚠ Pipeline error en "${cleanTitle(file.name)}": ${err?.message || err}`, 'warn');
        }
      }

      // Stop check immediately after pipeline — if set, this folder doesn't count
      if (_dsStopFlag) break;

      // Pause spin (folder already ran — just wait before moving on)
      while (_dsPaused && !_dsStopFlag) await new Promise(r => setTimeout(r, 200));
      if (_dsStopFlag) break;

      // 5. Collect fresh metadata for all files
      const songMetas = await Promise.all(
        page.audioFiles.map(async f => ({ f, meta: await DB.getMeta(f.id).catch(() => null) }))
      );

      // 6. Auto-detect collection + consensus auto-save
      let isAutoCollection = false;
      {
        const _top = map => map.size > 0
          ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0]
          : null;

        const artistMap = new Map();
        const albumMap  = new Map();
        const yearMap   = new Map();
        let   consensusCoverUrl = null;

        for (const { meta } of songMetas) {
          if (!meta) continue;
          if (meta.artist) artistMap.set(meta.artist, (artistMap.get(meta.artist) || 0) + 1);
          if (meta.album)  albumMap.set(meta.album,   (albumMap.get(meta.album)   || 0) + 1);
          if (meta.year)   yearMap.set(meta.year,     (yearMap.get(meta.year)     || 0) + 1);
          if (!consensusCoverUrl && (meta.coverUrl || meta.thumbnailUrl)) {
            consensusCoverUrl = meta.coverUrl || meta.thumbnailUrl || null;
          }
        }

        // Auto-identify as collection if 3+ distinct artists found
        isAutoCollection = artistMap.size > 3;
        if (isAutoCollection && !_collectionFolderIdsCache?.has(id)) {
          await DB.saveCollection(id, { forceType: 'collection', name }).catch(() => {});
          _collectionFolderIdsCache?.add(id);
          _dsLogLine(`  ↳ Colección detectada (${artistMap.size} artistas): ${name}`, 'info');
        }

        const cArtist = isAutoCollection ? null : _top(artistMap);
        const cAlbum  = isAutoCollection ? null : _top(albumMap);
        const cYear   = _top(yearMap);
        // Collections: each song keeps its own cover — don't propagate a single cover URL
        const cCover  = isAutoCollection ? null : consensusCoverUrl;

        if (cArtist || cAlbum || cYear || cCover) {
          await Promise.all(songMetas.map(async ({ f, meta }) => {
            if (!meta) return;
            const patch = {};
            if (cArtist && !meta.artist) patch.artist = cArtist;
            if (cAlbum  && !meta.album)  patch.album  = cAlbum;
            if (cYear   && !meta.year)   patch.year   = cYear;
            if (cCover  && !(meta.coverBlob || meta.coverUrl || meta.thumbnailUrl))
              patch.coverUrl = cCover;
            if (Object.keys(patch).length > 0) {
              patch.manualAt = Date.now();
              await DB.setMeta(f.id, patch).catch(() => {});
              Object.assign(meta, patch);
            }
          }));
        }
      }

      // 7. Determine cover threshold: flag folder only if ≥20% of files lack cover
      const missingCoverCount = songMetas.filter(({ meta }) =>
        !(meta?.coverBlob || meta?.coverUrl || meta?.thumbnailUrl || meta?.thumbnailLink)
      ).length;
      const folderMissingCover = missingCoverCount >= Math.ceil(page.audioFiles.length * 0.20);

      // 8. Build attention list
      const attnSongs = [];
      for (const { f, meta } of songMetas) {
        const missingArtist = !meta?.artist;
        const missingAlbum  = !meta?.album;
        const missingYear   = !meta?.year;
        const missingCover  = folderMissingCover && !(meta?.coverBlob || meta?.coverUrl || meta?.thumbnailLink);
        const displayTitle  = meta?.displayName || cleanTitle(f.name);
        if (missingArtist || missingAlbum || missingCover) {
          const missing = [
            missingArtist ? 'artista' : '',
            missingAlbum  ? 'álbum'   : '',
            missingCover  ? 'cover'   : '',
            missingYear   ? 'año'     : '',
          ].filter(Boolean).join(', ');
          _dsLogLine(`  ⚠ ${displayTitle}  (sin: ${missing})`);
          attnSongs.push({
            id: f.id, name: f.name, displayName: displayTitle,
            artist: meta?.artist || '', album: meta?.album || '',
            year: meta?.year || '', track: meta?.track || '',
            mimeType: f.mimeType || '',
            missingArtist, missingAlbum, missingYear, missingCover,
          });
        } else {
          _dsLogLine(`  ✓ ${displayTitle}`);
        }
      }

      const needsAttn = attnSongs.length > 0;
      const autoSaved = isAutoCollection && needsAttn;
      _dsLogLine(`${autoSaved ? '📁' : needsAttn ? '⚠' : '✓'} ${path}  (${page.audioFiles.length} arch.${autoSaved ? ' · colección guardada' : needsAttn ? ', ' + attnSongs.length + ' sin meta' : ''})`);

      // Collections auto-save: skip the attention list entirely.
      // Name is already in DB (saved above); user adjusts cover/name from the done list.
      if (isAutoCollection && needsAttn) {
        // Mark each song as manually resolved so pipeline/soft-scan won't reprocess them
        const now = Date.now();
        await Promise.all(songMetas.map(({ f, meta }) => {
          if (!meta) return;
          return DB.setMeta(f.id, { folderId: id, manualAt: now }).catch(() => {});
        }));
        // Remove from attention list in case a previous iteration added it
        delete _dsSession.folders[id];
      }

      if (isAutoCollection || !needsAttn) {
        _dsSession.completedList[id] = { id, name, path, count: page.audioFiles.length, mime: page.audioFiles[0]?.mimeType || '' };
        if (_dsListMode === 'done' || _dsListMode === 'all') {
          _dsAddOrUpdateFolderRow(id);
          _dsInjectCoverIntoRow(id, page.audioFiles).catch(() => {});
        }
      } else {
        const existing = _dsSession.folders[id];
        _dsSession.folders[id] = {
          id, name, path, songs: attnSongs,
          status:   existing?.status   || 'needs_attention',
          attended: existing?.attended || false,
        };
        if (_dsListMode === 'attn' || _dsListMode === 'all') {
          _dsAddOrUpdateFolderRow(id);
          _dsInjectCoverIntoRow(id, page.audioFiles).catch(() => {});
        }
      }

      // Folder fully processed — persist progress after every folder so that
      // an external interruption (app kill, phone sleep, browser close) can resume
      // from at most 1 folder back instead of up to 5.
      // We also save pendingQueue here (not only on explicit stop) so the BFS
      // position survives crashes — without it the BFS would restart from root
      // and have to re-traverse the entire tree just to skip visited folders.
      _dsSession.scannedFolders++;
      _dsSession.visited      = [...visitedSet];
      _dsSession.pendingQueue = [...queue];   // checkpoint: survive external interruption
      newlyScanned.add(id);
      _dsUpdateCounters(queue.length, startMs);

      await _dsSaveSession();
      await new Promise(r => setTimeout(r, 20));
    }

    // Finished
    _dsRunning        = false;
    _dsPaused         = false;
    _dsPausedForToken = false;

    if (_dsStopFlag) {
      _dsStopFlag = false;
      // Full reset — no queue saved. Next "Iniciar" starts fresh from the configured folder.
      _dsSession.status         = 'idle';
      _dsSession.pendingQueue   = [];
      _dsSession.visited        = [];
      _dsSession.scannedFolders = 0;
      _dsSession.totalFolders   = 0;
      _dsSession.folders        = {};
      _dsSession.completedList  = {};
      _dsSession.skippedList    = {};
      _dsLogLine('⏹ Detenido.', 'info');
    } else {
      _dsSession.pendingQueue = [];  // clean slate on normal finish
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

    // Align totalFolders so remaining counter shows 0 when done
    if (_dsSession.status === 'done') {
      _dsSession.totalFolders = _dsSession.scannedFolders;
    }

    _dsRunning  = false;
    _dsStopping = false;
    await _dsSaveSession();
    _dsUpdateControls();
    _dsUpdateProgress();
    _dsUpdateCounters(0);
  }

  /* ── List rendering ─────────────────────────────────────── */

  function _dsRenderAttentionList() {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    // Only show unresolved folders: not yet attended and not ignored
    const folders = Object.values(_dsSession?.folders || {})
      .filter(f => !f.attended && f.status !== 'ignored');
    list.innerHTML = '';
    if (folders.length === 0) {
      list.innerHTML = `<div class="ds-attention-empty">${UI.t('scan_no_folders')}</div>`;
      return;
    }
    for (const folder of folders) list.appendChild(_dsBuildFolderRow(folder));
    _dsRefreshRowCovers().catch(() => {});
  }

  function _dsRenderCompletedList() {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    // Scanner-completed (no issues found) + user-attended (fixed by hand)
    const scanDone    = Object.values(_dsSession?.completedList || {});
    const userFixed   = Object.values(_dsSession?.folders      || {}).filter(f => f.attended);
    const folders     = [...scanDone, ...userFixed];
    list.innerHTML = '';
    if (folders.length === 0) {
      list.innerHTML = `<div class="ds-attention-empty">${UI.t('scan_none_complete')}</div>`;
      return;
    }
    for (const f of scanDone)  list.appendChild(_dsBuildSimpleRow(f, 'green'));
    for (const f of userFixed) list.appendChild(_dsBuildFolderRow(f));
    _dsRefreshRowCovers().catch(() => {});
  }

  /** Build a simple (non-expandable) folder row for completed/skipped entries. */
  /** Build a simple row (completed / skipped) as a lib-detail-entity with inline edit panel. */
  function _dsBuildSimpleRow(folder, dotClass) {
    const isCollection = isFolderCollection(folder.id);
    const songCount    = folder.count || 0;
    const pathParts    = folder.path.split(' › ');
    const leaf         = pathParts[pathParts.length - 1];

    const ftKey   = isCollection ? 'collection' : 'album';
    const ftLabel = ftKey === 'collection'
      ? (UI.t('lbl_collection') || 'Colección')
      : (UI.t('lbl_album_chip') || 'Álbum');
    const ftChipCls = ftKey === 'collection' ? 'folder-type-chip--collection' : 'folder-type-chip--album';

    const mime   = folder.mime || '';
    const format = mime.includes('flac') ? 'FLAC' : mime.includes('ogg')  ? 'OGG'
                 : mime.includes('aac')  ? 'AAC'  : mime.includes('wav')  ? 'WAV'
                 : (mime.includes('mpeg') || mime.includes('mp3')) ? 'MP3' : '';
    const yearLine = [
      `<span class="folder-type-chip ${ftChipCls}">${_escHtml(ftLabel)}</span>`,
      format ? `<span class="album-format-badge">${format}</span>` : '',
    ].filter(Boolean).join(' ');

    const musicSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    const hue   = [...(folder.id || '')].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
    const albBg = `hsl(${hue},30%,28%)`;

    // Use session-stored cover (set by _dsSaveFromPanel for both albums and collections)
    const sessionCover = (folder.coverUrl && !folder.coverUrl.startsWith('blob:')) ? folder.coverUrl : '';
    const artHtml = sessionCover
      ? `<img src="${_escHtml(sessionCover)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.style.display='none'">${musicSvg}`
      : musicSvg;

    const row = document.createElement('div');
    row.className = 'ds-folder-row';
    row.dataset.folderId = folder.id;

    row.innerHTML = `
      <div class="ds-folder-entity lib-detail-entity">
        <div class="lib-detail-entity-art" style="background:${albBg};color:var(--text-secondary)">
          ${artHtml}
        </div>
        <div class="lib-detail-entity-info">
          <div class="lib-detail-entity-year">${yearLine}</div>
          <div class="lib-detail-entity-name">${_escHtml(folder.name)}</div>
          <div class="lib-detail-entity-sub">${songCount} ${UI.t('lbl_songs')}</div>
          ${pathParts.length > 1 ? `<div class="lib-detail-entity-path">${_escHtml(pathParts.slice(0, -1).join(' › '))}</div>` : ''}
        </div>
        <button class="lib-detail-entity-more" title="Opciones">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
      <div class="album-edit-panel ds-album-edit-panel${isCollection ? ' ds-mode-collection' : ''}">
        <div class="album-edit-actions">
          <div class="ds-type-switch">
            <button class="ds-type-btn ds-type-btn--album${!isCollection ? ' ds-type-btn--on' : ''}" data-type="album">${UI.t('lbl_album_chip')}</button>
            <button class="ds-type-btn ds-type-btn--col${isCollection ? ' ds-type-btn--on' : ''}" data-type="collection">${UI.t('lbl_collection')}</button>
          </div>
          <button class="ds-panel-save-btn album-edit-save-btn">${UI.t('save_btn')}</button>
        </div>
        <div class="album-edit-row ds-field-col-only">
          <label class="album-edit-label">${UI.t('lbl_col_name')}</label>
          <input class="album-edit-input" data-field="name" value="${_escHtml(folder.name)}" placeholder="${UI.t('lbl_col_name')}">
        </div>
        <div class="album-edit-row ds-field-album-only">
          <label class="album-edit-label">${UI.t('lbl_artist')}</label>
          <input class="album-edit-input" data-field="artist" value="" placeholder="${UI.t('lbl_artist')}">
        </div>
        <div class="album-edit-row ds-field-album-only">
          <label class="album-edit-label">${UI.t('lbl_album')}</label>
          <input class="album-edit-input" data-field="album" value="${_escHtml(folder.name)}" placeholder="${UI.t('lbl_album')}">
        </div>
        <div class="album-edit-row">
          <label class="album-edit-label">${UI.t('lbl_year')}</label>
          <input class="album-edit-input" data-field="year" value="" placeholder="${UI.t('lbl_year_ph')}">
        </div>
        <div class="album-edit-row">
          <label class="album-edit-label">${UI.t('lbl_cover_url')}</label>
          <div class="ds-cover-input-wrap">
            <input class="album-edit-input" data-field="coverUrl" value="" placeholder="https://…" style="flex:1;min-width:0">
            <button class="ds-apply-cover-btn ds-field-col-only" title="${UI.t('ds_apply_cover_btn')}">${UI.t('ds_apply_cover_btn')}</button>
          </div>
        </div>
        <div class="album-edit-row album-edit-row--track-btn">
          <button class="album-edit-track-btn ds-track-edit-btn">${UI.t('edit_tracks_btn')}</button>
        </div>
        <div class="ds-songs-edit-list" style="display:none"></div>
      </div>`;

    // Clicking the entity (not the ⋮) toggles the edit panel; loads meta from DB on first open
    let _panelLoaded = false;
    const entity = row.querySelector('.ds-folder-entity');
    entity.addEventListener('click', async (e) => {
      if (e.target.closest('.lib-detail-entity-more')) return;
      const panel  = row.querySelector('.album-edit-panel');
      const isOpen = panel.classList.toggle('open');
      entity.classList.toggle('album-editing', isOpen);
      if (isOpen && !_panelLoaded) {
        _panelLoaded = true;
        // Load metadata from DB (songs for this folder)
        try {
          const all   = await DB.getAllMetaLight();
          const songs = all.filter(m => m.folderId === folder.id);
          if (songs.length) {
            const artist   = songs.find(s => s.artist)?.artist || '';
            const album    = songs.find(s => s.album)?.album   || '';
            const year     = songs.find(s => s.year)?.year     || '';
            const coverSrc = (songs.find(s => s.thumbnailUrl || s.coverUrl)?.thumbnailUrl
                           || songs.find(s => s.thumbnailUrl || s.coverUrl)?.coverUrl || '')
                           .replace(/^blob:.*|(?:googleusercontent|lh\d+\.).*/, '');
            const artistIn = panel.querySelector('[data-field="artist"]');
            const albumIn  = panel.querySelector('[data-field="album"]');
            const yearIn   = panel.querySelector('[data-field="year"]');
            const coverIn  = panel.querySelector('[data-field="coverUrl"]');
            if (artistIn) artistIn.value = artist;
            if (albumIn)  albumIn.value  = album || folder.name;
            if (yearIn)   yearIn.value   = year;
            if (coverIn && !coverIn.value && coverSrc) coverIn.value = coverSrc;
            // Sync row header name with the album from DB
            const nameEl = row.querySelector('.lib-detail-entity-name');
            if (nameEl && (album || folder.name)) nameEl.textContent = album || folder.name;
            const subEl = row.querySelector('.lib-detail-entity-sub');
            if (subEl && artist) subEl.textContent = `${artist} · ${songCount} ${UI.t('lbl_songs')}`;
            // Inject cover into art cell if found
            if (coverSrc) {
              const artEl = row.querySelector('.lib-detail-entity-art');
              if (artEl && !artEl.querySelector('img')) {
                artEl.innerHTML = `<img src="${_escHtml(coverSrc)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.style.display='none'">${musicSvg}`;
              }
            }
          }
        } catch (_) {}
      }
    });

    // ⋮ context menu
    entity.querySelector('.lib-detail-entity-more').addEventListener('click', (e) => {
      e.stopPropagation();
      UI.showContextMenu(e, 'ds_folder', { id: folder.id, folderId: folder.id, name: leaf, isFolder: true });
    });

    // Type switch
    row.querySelectorAll('.ds-type-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _dsToggleFolderType(folder.id, row, btn.dataset.type);
      });
    });

    // Save button
    row.querySelector('.ds-panel-save-btn').addEventListener('click', () => _dsSaveFromPanel(row, folder.id));

    // "Apply to songs" — inject collection cover into individual song records
    row.querySelector('.ds-apply-cover-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = row.querySelector('[data-field="coverUrl"]')?.value?.trim() || '';
      _dsApplyCoverToSongs(folder.id, url, e.currentTarget);
    });

    // "Edit songs" — loads from DB since simple rows have no in-memory songs array
    row.querySelector('.ds-track-edit-btn').addEventListener('click', () =>
      _dsToggleSongsList(row, null, folder.id));

    return row;
  }

  function _dsRenderSkippedList() {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    const folders = Object.values(_dsSession?.skippedList || {});
    list.innerHTML = '';
    if (folders.length === 0) {
      list.innerHTML = `<div class="ds-attention-empty">${UI.t('scan_none_skipped')}</div>`;
      return;
    }
    for (const folder of folders) list.appendChild(_dsBuildSimpleRow(folder, 'yellow'));
    _dsRefreshRowCovers().catch(() => {});
  }

  /** Render all scanned folders: attention, completed, skipped. */
  function _dsRenderAllList() {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    list.innerHTML = '';
    const pendingFolders = Object.values(_dsSession?.folders       || {}).filter(f => !f.attended && f.status !== 'ignored');
    const fixedFolders   = Object.values(_dsSession?.folders       || {}).filter(f =>  f.attended);
    const doneFolders    = Object.values(_dsSession?.completedList || {});
    const skippedFolders = Object.values(_dsSession?.skippedList   || {});
    if (pendingFolders.length === 0 && fixedFolders.length === 0 && doneFolders.length === 0 && skippedFolders.length === 0) {
      list.innerHTML = `<div class="ds-attention-empty">${UI.t('scan_no_folders')}</div>`;
      return;
    }
    for (const f of pendingFolders) list.appendChild(_dsBuildFolderRow(f));
    for (const f of doneFolders)    list.appendChild(_dsBuildSimpleRow(f, 'green'));
    for (const f of fixedFolders)   list.appendChild(_dsBuildFolderRow(f));
    for (const f of skippedFolders) list.appendChild(_dsBuildSimpleRow(f, 'yellow'));
    _dsRefreshRowCovers().catch(() => {});
  }

  function _dsAddOrUpdateFolderRow(folderId) {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    const empty = list.querySelector('.ds-attention-empty');
    if (empty) empty.remove();

    if (_dsListMode === 'attn' || _dsListMode === 'all') {
      const folder = _dsSession.folders[folderId];
      if (folder) {
        const existing = list.querySelector(`[data-folder-id="${CSS.escape(folderId)}"]`);
        if (existing) {
          const dot = existing.querySelector('.ds-status-dot');
          if (dot) dot.className = 'ds-status-dot ' + _dsDotClass(folder);
        } else {
          list.appendChild(_dsBuildFolderRow(folder));
        }
        return; // handled
      }
    }
    if (_dsListMode === 'done' || _dsListMode === 'all') {
      const folder = _dsSession.completedList?.[folderId];
      if (folder) {
        const existing = list.querySelector(`[data-folder-id="${CSS.escape(folderId)}"]`);
        if (!existing) list.appendChild(_dsBuildSimpleRow(folder, 'green'));
      }
    }
    if (_dsListMode === 'skipped') {
      const folder = _dsSession.skippedList?.[folderId];
      if (folder) {
        const existing = list.querySelector(`[data-folder-id="${CSS.escape(folderId)}"]`);
        if (!existing) list.appendChild(_dsBuildSimpleRow(folder, 'yellow'));
      }
    }
  }

  function _dsDotClass(folder) {
    if (folder.status === 'ignored') return 'red';
    if (folder.attended)             return 'green';
    return 'gray';
  }

  /**
   * After a folder row is added to the list, automatically inject its cover art
   * from DB without requiring the user to open the row.
   * Tries each file in order until a stable cover URL or blob is found.
   */
  async function _dsInjectCoverIntoRow(folderId, audioFiles) {
    if (!audioFiles || audioFiles.length === 0) return;
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    const row = list.querySelector(`[data-folder-id="${CSS.escape(folderId)}"]`);
    if (!row) return;
    const artEl = row.querySelector('.lib-detail-entity-art');
    if (!artEl || artEl.querySelector('img')) return; // already has a cover

    const musicSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

    for (const file of audioFiles) {
      try {
        const meta = await DB.getMeta(file.id).catch(() => null);
        if (!meta) continue;
        let url = '';
        if (meta.coverBlob) {
          url = URL.createObjectURL(meta.coverBlob);
        } else {
          url = (meta.coverUrl || meta.thumbnailUrl || meta.thumbnailLink || '')
            .replace(/^blob:.*|(?:googleusercontent|lh\d+\.).*/, '');
        }
        if (url) {
          artEl.innerHTML = `<img src="${_escHtml(url)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.style.display='none'">${musicSvg}`;
          return;
        }
      } catch (_) {}
    }
  }

  /**
   * After any full list re-render (tab switch), inject covers into all visible rows.
   * Pass 1: one getAllMetaLight() call → stable URLs injected immediately.
   * Pass 2: rows still without a cover → getMeta() for blob fallback.
   */
  async function _dsRefreshRowCovers() {
    const list = document.getElementById('ds-attention-list');
    if (!list) return;
    const rows = [...list.querySelectorAll('[data-folder-id]')];
    if (!rows.length) return;

    const musicSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    const setImg = (artEl, url) => {
      artEl.innerHTML = `<img src="${_escHtml(url)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.style.display='none'">${musicSvg}`;
    };

    // Pass 1 — one light DB read; build folderId → { url, ids[], albumMap, artistMap, mime }
    const allLight = await DB.getAllMetaLight().catch(() => []);
    const folderData = new Map();
    for (const m of allLight) {
      if (!m.folderId) continue;
      if (!folderData.has(m.folderId)) folderData.set(m.folderId, { url: '', ids: [], albumMap: new Map(), artistMap: new Map(), mime: '' });
      const fd = folderData.get(m.folderId);
      fd.ids.push(m.id);
      if (!fd.url) {
        const candidate = (m.thumbnailUrl !== 'id3' ? (m.thumbnailUrl || '') : '') || m.coverUrl || '';
        const stable = candidate.replace(/^blob:.*|(?:googleusercontent|lh\d+\.).*/, '');
        if (stable) fd.url = stable;
      }
      if (m.album)  fd.albumMap.set(m.album,   (fd.albumMap.get(m.album)   || 0) + 1);
      if (m.artist) fd.artistMap.set(m.artist,  (fd.artistMap.get(m.artist) || 0) + 1);
      if (!fd.mime && m.mimeType) fd.mime = m.mimeType;
    }

    // Pass 1b — overlay collection-level coverUrls (saved via DB.saveCollection).
    // Individual songs in a collection don't carry the cover, so we must read it
    // from the collections store directly and give it priority over song-level data.
    try {
      const allCols = await DB.getAllCollections();
      for (const col of allCols) {
        if (!col?.coverUrl || col.coverUrl.startsWith('blob:')) continue;
        const stable = col.coverUrl.replace(/^blob:.*|(?:googleusercontent|lh\d+\.).*/, '');
        if (!stable) continue;
        if (!folderData.has(col.id)) folderData.set(col.id, { url: '', ids: [], albumMap: new Map(), artistMap: new Map(), mime: '' });
        folderData.get(col.id).url = stable; // collection cover takes priority
      }
    } catch (_) {}

    const _topMap = map => map.size > 0 ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0] : '';
    const _mimeToFmt = mime =>
      mime.includes('flac') ? 'FLAC' : mime.includes('ogg')  ? 'OGG'
    : mime.includes('aac')  ? 'AAC'  : mime.includes('wav')  ? 'WAV'
    : (mime.includes('mpeg') || mime.includes('mp3')) ? 'MP3' : '';

    const needsBlob = [];
    for (const row of rows) {
      const folderId = row.dataset.folderId;
      const fd = folderData.get(folderId);

      // ── Cover ──────────────────────────────────────────────
      const artEl = row.querySelector('.lib-detail-entity-art');
      if (artEl && !artEl.querySelector('img')) {
        if (fd?.url) {
          setImg(artEl, fd.url);
        } else if (fd?.ids.length) {
          needsBlob.push({ artEl, ids: fd.ids });
        }
      }

      if (!fd) continue;

      // ── Name & sub-line ────────────────────────────────────
      const album  = _topMap(fd.albumMap);
      const artist = _topMap(fd.artistMap);
      const nameEl = row.querySelector('.lib-detail-entity-name');
      if (nameEl && album && nameEl.textContent !== album) nameEl.textContent = album;
      const subEl = row.querySelector('.lib-detail-entity-sub');
      if (subEl && artist) {
        // Only patch if the artist part is missing (don't erase song count)
        if (!subEl.textContent.includes(artist)) {
          const count = fd.ids.length;
          subEl.textContent = `${artist} · ${count} ${UI.t('lbl_songs')}`;
        }
      }

      // ── Format badge ───────────────────────────────────────
      const fmt = _mimeToFmt(fd.mime);
      if (fmt) {
        const yearEl = row.querySelector('.lib-detail-entity-year');
        if (yearEl && !yearEl.querySelector('.album-format-badge')) {
          const badge = document.createElement('span');
          badge.className = 'album-format-badge';
          badge.textContent = fmt;
          yearEl.appendChild(badge);
        }
      }
    }

    // Pass 2 — blob fallback for rows still without a cover
    for (const { artEl, ids } of needsBlob) {
      if (artEl.querySelector('img')) continue;
      for (const id of ids) {
        try {
          const meta = await DB.getMeta(id).catch(() => null);
          if (!meta?.coverBlob) continue;
          setImg(artEl, URL.createObjectURL(meta.coverBlob));
          break;
        } catch (_) {}
      }
    }
  }

  /* ── Missing-data chips for folder header ───────────────── */

  function _dsMissingChips(folder) {
    const songs = folder.songs || [];
    const hasAR = songs.some(s => s.missingArtist);
    const hasAL = songs.some(s => s.missingAlbum);
    const hasCV = songs.some(s => s.missingCover);
    return [
      hasAR ? '<span class="ds-chip ds-chip--ar">AR</span>' : '',
      hasAL ? '<span class="ds-chip ds-chip--al">AL</span>' : '',
      hasCV ? '<span class="ds-chip ds-chip--cv">CV</span>' : '',
    ].join('');
  }

  /* ── Build folder row — styled as lib-detail-entity ─────── */

  function _dsBuildFolderRow(folder) {
    const ignored   = folder.status === 'ignored';
    const songs     = folder.songs || [];
    const songCount = songs.length;
    const pathParts = folder.path.split(' › ');
    const leaf      = pathParts[pathParts.length - 1];

    // Derive album-level values from song metadata in the session.
    // Use majority-vote (most frequent non-empty value) so one outlier ID3 tag
    // doesn't pollute the display — same logic as the consensus auto-save step.
    const _topVal = (key) => {
      const map = new Map();
      for (const s of songs) {
        const v = s[key];
        if (v) map.set(v, (map.get(v) || 0) + 1);
      }
      return map.size > 0 ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0] : '';
    };
    const albumName  = _topVal('album')  || folder.name;
    const artistName = _topVal('artist') || '';
    const yearVal    = _topVal('year')   || '';

    // Format badge from first song's MIME type
    const mime   = songs[0]?.mimeType || '';
    const format = mime.includes('flac')                         ? 'FLAC'
                 : mime.includes('ogg')                          ? 'OGG'
                 : mime.includes('aac')                          ? 'AAC'
                 : mime.includes('wav')                          ? 'WAV'
                 : (mime.includes('mpeg') || mime.includes('mp3')) ? 'MP3'
                 : '';

    // Folder-type chip — same two types as in Browse
    const ftKey   = isFolderCollection(folder.id) ? 'collection' : 'album';
    const ftLabel = ftKey === 'collection'
      ? (UI.t('lbl_collection') || 'Colección')
      : (UI.t('lbl_album_chip') || 'Álbum');

    // Cover from session data (stable URL only; _dsLoadCoverForRow fills it async from DB)
    const coverSrc = (songs.find(s => s.thumbnailLink || s.coverUrl)?.thumbnailLink
                   || songs.find(s => s.thumbnailLink || s.coverUrl)?.coverUrl
                   || '').replace(/^blob:.*/, '');

    const musicSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    const artHtml  = coverSrc
      ? `<img src="${_escHtml(coverSrc)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.style.display='none'">${musicSvg}`
      : musicSvg;

    const ftChipCls = ftKey === 'collection' ? 'folder-type-chip--collection' : 'folder-type-chip--album';
    const yearLine = [
      `<span class="folder-type-chip ${ftChipCls}">${_escHtml(ftLabel)}</span>`,
      yearVal ? `(${_escHtml(yearVal)})`                                       : '',
      format  ? `<span class="album-format-badge">${_escHtml(format)}</span>` : '',
    ].filter(Boolean).join(' ');

    const subLine = [
      artistName ? _escHtml(artistName) : '',
      `${songCount} ${UI.t('lbl_songs')}`,
    ].filter(Boolean).join(' · ');

    const missingChips = _dsMissingChips(folder);

    // Background colour derived from folder id (matches album card hue)
    const hue   = [...(folder.id || '')].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
    const albBg = `hsl(${hue},30%,28%)`;

    const row = document.createElement('div');
    row.className = 'ds-folder-row' + (ignored ? ' ds-ignored' : '') + (folder.attended ? ' ds-attended' : '');
    row.dataset.folderId = folder.id;

    row.innerHTML = `
      <div class="ds-folder-entity lib-detail-entity">
        <div class="lib-detail-entity-art" style="background:${albBg};color:var(--text-secondary)">
          ${artHtml}
        </div>
        <div class="lib-detail-entity-info">
          ${yearLine ? `<div class="lib-detail-entity-year">${yearLine}</div>` : ''}
          <div class="lib-detail-entity-name">${_escHtml(albumName)}</div>
          <div class="lib-detail-entity-sub">${subLine}</div>
          ${pathParts.length > 1 ? `<div class="lib-detail-entity-path">${_escHtml(pathParts.slice(0, -1).join(' › '))}</div>` : ''}
        </div>
        ${missingChips ? `<div class="ds-row-chips">${missingChips}</div>` : ''}
        <button class="lib-detail-entity-more" title="Opciones">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
      <div class="album-edit-panel ds-album-edit-panel${ftKey === 'collection' ? ' ds-mode-collection' : ''}">
        <div class="album-edit-actions">
          <button class="ds-ignore-btn album-edit-reset-id3-btn">${ignored ? '↩ Designorar' : '✕ Ignorar'}</button>
          <button class="ds-panel-save-btn album-edit-save-btn">${UI.t('save_btn')}</button>
        </div>
        <div class="album-edit-row">
          <label class="album-edit-label">${UI.t('lbl_tipo')}</label>
          <div class="ds-type-switch">
            <button class="ds-type-btn ds-type-btn--album${ftKey !== 'collection' ? ' ds-type-btn--on' : ''}" data-type="album">${UI.t('lbl_album_chip')}</button>
            <button class="ds-type-btn ds-type-btn--col${ftKey === 'collection' ? ' ds-type-btn--on' : ''}" data-type="collection">${UI.t('lbl_collection')}</button>
          </div>
        </div>
        <div class="album-edit-row ds-field-col-only">
          <label class="album-edit-label">${UI.t('lbl_col_name')}</label>
          <input class="album-edit-input" data-field="name" value="${_escHtml(albumName)}" placeholder="${UI.t('lbl_col_name')}">
        </div>
        <div class="album-edit-row ds-field-album-only">
          <label class="album-edit-label">${UI.t('lbl_artist')}</label>
          <input class="album-edit-input" data-field="artist" value="${_escHtml(artistName)}" placeholder="${UI.t('lbl_artist')}">
        </div>
        <div class="album-edit-row ds-field-album-only">
          <label class="album-edit-label">${UI.t('lbl_album')}</label>
          <input class="album-edit-input" data-field="album" value="${_escHtml(albumName)}" placeholder="${UI.t('lbl_album')}">
        </div>
        <div class="album-edit-row">
          <label class="album-edit-label">${UI.t('lbl_year')}</label>
          <input class="album-edit-input" data-field="year" value="${_escHtml(yearVal)}" placeholder="${UI.t('lbl_year_ph')}">
        </div>
        <div class="album-edit-row">
          <label class="album-edit-label">${UI.t('lbl_cover_url')}</label>
          <div class="ds-cover-input-wrap">
            <input class="album-edit-input" data-field="coverUrl" value="${_escHtml(coverSrc)}" placeholder="https://…" style="flex:1;min-width:0">
            <button class="ds-apply-cover-btn ds-field-col-only" title="${UI.t('ds_apply_cover_btn')}">${UI.t('ds_apply_cover_btn')}</button>
          </div>
        </div>
        <div class="album-edit-row album-edit-row--track-btn">
          <button class="album-edit-track-btn ds-track-edit-btn">${UI.t('edit_tracks_btn')}</button>
        </div>
        <div class="ds-songs-edit-list" style="display:none"></div>
      </div>`;

    // Clicking the entity row (but not the ⋮ button) toggles the edit panel
    const entity = row.querySelector('.ds-folder-entity');
    entity.addEventListener('click', (e) => {
      if (e.target.closest('.lib-detail-entity-more')) return;
      const panel  = row.querySelector('.album-edit-panel');
      const isOpen = panel.classList.toggle('open');
      entity.classList.toggle('album-editing', isOpen);
      if (isOpen) _dsSyncPanelFromFolder(panel, folder);
    });

    // ⋮ opens context menu
    entity.querySelector('.lib-detail-entity-more').addEventListener('click', (e) => {
      e.stopPropagation();
      UI.showContextMenu(e, 'ds_folder', { id: folder.id, folderId: folder.id, name: leaf, isFolder: true });
    });

    // Ignore button
    row.querySelector('.ds-ignore-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _dsToggleIgnore(folder.id, row);
    });

    // Type switch (Album / Collection)
    row.querySelectorAll('.ds-type-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _dsToggleFolderType(folder.id, row, btn.dataset.type);
      });
    });

    // Save button
    row.querySelector('.ds-panel-save-btn').addEventListener('click', () => _dsSaveFromPanel(row, folder.id));

    // "Apply to songs" — inject collection cover into individual song records
    row.querySelector('.ds-apply-cover-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = row.querySelector('[data-field="coverUrl"]')?.value?.trim() || '';
      _dsApplyCoverToSongs(folder.id, url, e.currentTarget);
    });

    // "Edit songs" button — always query DB so ALL folder songs appear, not just attn ones
    row.querySelector('.ds-track-edit-btn').addEventListener('click', () =>
      _dsToggleSongsList(row, null, folder.id));

    // Async: fill cover art from DB if not already in session data
    _dsLoadCoverForRow(row, folder).catch(() => {});

    return row;
  }

  /* ── Deep scan panel helpers ─────────────────────────────── */

  /** Sync panel inputs from the current in-memory folder data */
  function _dsSyncPanelFromFolder(panel, folder) {
    const songs    = folder.songs || [];
    const artist   = songs.find(s => s.artist)?.artist || '';
    const album    = songs.find(s => s.album)?.album   || folder.name;
    const year     = songs.find(s => s.year)?.year     || '';
    const coverSrc = (songs.find(s => s.thumbnailLink || s.coverUrl)?.thumbnailLink
                   || songs.find(s => s.thumbnailLink || s.coverUrl)?.coverUrl
                   || '').replace(/^blob:.*/, '');
    const nameIn   = panel.querySelector('[data-field="name"]');
    const artistIn = panel.querySelector('[data-field="artist"]');
    const albumIn  = panel.querySelector('[data-field="album"]');
    const yearIn   = panel.querySelector('[data-field="year"]');
    const coverIn  = panel.querySelector('[data-field="coverUrl"]');
    if (nameIn   && !nameIn.value)   nameIn.value   = album; // collection name = album name
    if (artistIn) artistIn.value = artist;
    if (albumIn)  albumIn.value  = album;
    if (yearIn)   yearIn.value   = year;
    if (coverIn && !coverIn.value) coverIn.value = coverSrc;
  }

  /** Save album-edit-panel inputs to every song in the folder.
   *  Works for attention rows (songs in session) AND completed/skipped rows (DB lookup). */
  async function _dsSaveFromPanel(rowEl, folderId) {
    const sessionFolder = _dsSession.folders?.[folderId]; // may be undefined for completed/skipped
    const saveBtn = rowEl.querySelector('.ds-panel-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = UI.t('saving') || 'Guardando…'; }
    const panel      = rowEl.querySelector('.album-edit-panel');
    const isColMode  = panel?.classList.contains('ds-mode-collection');
    const colName    = panel?.querySelector('[data-field="name"]')?.value?.trim()     || '';
    const artist     = panel?.querySelector('[data-field="artist"]')?.value?.trim()   || '';
    const album      = panel?.querySelector('[data-field="album"]')?.value?.trim()    || '';
    const year       = panel?.querySelector('[data-field="year"]')?.value?.trim()     || '';
    const coverUrl   = panel?.querySelector('[data-field="coverUrl"]')?.value?.trim() || '';
    try {
      // Get song list: from session (attention rows) or from DB (completed / skipped rows)
      let songs;
      if (sessionFolder?.songs?.length) {
        songs = sessionFolder.songs;
      } else {
        const all = await DB.getAllMetaLight().catch(() => []);
        songs = all.filter(m => m.folderId === folderId);
      }
      if (!songs.length) {
        UI.showToast(UI.t('ds_no_songs') || 'No songs found', 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = UI.t('save_btn') || 'Guardar'; }
        return;
      }
      // For collection mode: save collection name + cover to the collections store
      if (isColMode) {
        const colPatch = {};
        if (colName)                                    colPatch.name     = colName;
        if (coverUrl && !coverUrl.startsWith('blob:')) colPatch.coverUrl = coverUrl;
        if (Object.keys(colPatch).length) await DB.saveCollection(folderId, colPatch).catch(() => {});
      }
      let saved = 0;
      for (const song of songs) {
        const patch = { folderId, manualAt: Date.now() };
        if (!isColMode && artist)                                       patch.artist       = artist;
        if (!isColMode && album)                                        patch.album        = album;
        if (year)                                                       patch.year         = year;
        // Collections: cover is stored on the collection record, not on individual songs
        if (!isColMode && coverUrl && !coverUrl.startsWith('blob:'))    patch.thumbnailUrl = coverUrl;
        await DB.setMeta(song.id, patch);
        saved++;
        // Update in-memory session song (attention rows only)
        if (sessionFolder?.songs) {
          if (!isColMode && artist) { song.artist = artist; song.missingArtist = false; }
          if (!isColMode && album)  { song.album  = album;  song.missingAlbum  = false; }
          if (year)     { song.year    = year;     song.missingYear   = false; }
          // Collections: cover lives on the collection record only — never on individual songs
          if (!isColMode && coverUrl && !coverUrl.startsWith('blob:')) { song.thumbnailLink = coverUrl; song.missingCover = false; }
        }
        if (!isColMode && coverUrl && !coverUrl.startsWith('blob:')) _cacheExternalCover(song.id, coverUrl, true).catch(() => {});
        const livePatch = {};
        if (!isColMode && artist)                                        livePatch.artist       = artist;
        if (!isColMode && album)                                         livePatch.album        = album;
        if (year)                                                        livePatch.year         = year;
        if (!isColMode && coverUrl && !coverUrl.startsWith('blob:'))     livePatch.thumbnailUrl = coverUrl;
        if (Object.keys(livePatch).length) _liveMetaUpdate([song.id], livePatch);
      }
      // Header refresh — use colName as album display in collection mode
      const displayAlbum = isColMode ? colName : album;
      const folderRef = sessionFolder || { id: folderId, name: displayAlbum || folderId, songs, count: songs.length };
      _dsRefreshRowHeader(rowEl, folderRef, { artist: isColMode ? '' : artist, album: displayAlbum, year, coverUrl });
      // Persist cover URL in the session entry so list re-renders show it immediately
      // (both for attention folders and completed/skipped ones stored in completedList)
      if (coverUrl && !coverUrl.startsWith('blob:')) {
        if (sessionFolder) sessionFolder.coverUrl = coverUrl;
        const completedEntry = _dsSession?.completedList?.[folderId];
        if (completedEntry) completedEntry.coverUrl = coverUrl;
        const skippedEntry = _dsSession?.skippedList?.[folderId];
        if (skippedEntry) skippedEntry.coverUrl = coverUrl;
      }

      if (sessionFolder) {
        sessionFolder.attended = true;
        sessionFolder.status   = 'needs_attention';
        rowEl.classList.remove('ds-ignored');
        rowEl.classList.add('ds-attended');
        _dsUpdateCounters();
        await _dsSaveSession();
        // In attn-only mode, fade the row out and remove it — it now belongs in the done list
        if (_dsListMode === 'attn') {
          rowEl.style.transition = 'opacity 0.35s, transform 0.35s';
          rowEl.style.opacity    = '0';
          rowEl.style.transform  = 'translateX(24px)';
          setTimeout(() => {
            rowEl.remove();
            const list = document.getElementById('ds-attention-list');
            if (list && !list.querySelector('.ds-folder-row')) {
              list.innerHTML = `<div class="ds-attention-empty">${UI.t('scan_no_folders')}</div>`;
            }
          }, 380);
        }
      }
      // Persist session so cover URL survives page reload / tab switch for completed rows
      if (!sessionFolder) await _dsSaveSession().catch(() => {});
      if (typeof Sync !== 'undefined') Sync.push('metadata');
      if (_browseFolderId) _updateBrowseLegend(_browseFolderId);
      if (saveBtn) {
        saveBtn.textContent = UI.t('saved_ok') || '✓ Guardado';
        setTimeout(() => { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = UI.t('save_btn') || 'Guardar'; } }, 1800);
      }
      UI.showToast(`${saved} ${UI.t('lbl_songs_updated') || 'canciones actualizadas'}`);
    } catch (err) {
      console.error('[DeepScan] Save error:', err);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = UI.t('save_btn') || 'Guardar'; }
      UI.showToast(UI.t('toast_save_error') || 'Error guardando', 'error');
    }
  }

  /**
   * Inject a cover URL into every individual song of a collection.
   * Called from the "Apply to songs" button in the Deep Scan collection editor.
   * Mirrors the Library's "btn-collection-apply-all" logic.
   */
  async function _dsApplyCoverToSongs(folderId, coverUrl, btn) {
    if (!folderId || !coverUrl || coverUrl.startsWith('blob:')) return;
    const origText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = UI.t('ds_applying_cover') || 'Aplicando…'; }
    try {
      const all   = await DB.getAllMeta();
      const songs = all.filter(m => m.folderId === folderId);
      if (!songs.length) {
        UI.showToast(UI.t('ds_no_songs') || 'No hay canciones', 'warn');
        return;
      }
      const now = Date.now();
      for (const m of songs) {
        await DB.setMeta(m.id, { thumbnailUrl: coverUrl, manualAt: now });
        if (typeof Meta !== 'undefined') Meta.revoke?.(m.id);
        _updateRowThumbnail(m.id, coverUrl);
      }
      UI.showToast(`${songs.length} ${UI.t('lbl_songs_updated') || 'canciones actualizadas'}`);
      if (btn) {
        btn.textContent = UI.t('ds_applied_cover') || '✓ Aplicado';
        setTimeout(() => {
          if (btn) { btn.disabled = false; btn.textContent = origText; }
        }, 2000);
      }
    } catch (err) {
      console.error('[DeepScan] Apply cover error:', err);
      UI.showToast(UI.t('toast_save_error') || 'Error', 'error');
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
  }


  /** Toggle a folder between album and collection types.
   *  Updates DB, patches the in-memory cache, refreshes the chip and toggle buttons immediately. */
  async function _dsToggleFolderType(folderId, rowEl, newType) {
    try {
      if (newType === 'collection') {
        await onMoveToCollections({ folderId });
      } else {
        await onMoveToAlbums({ folderId });
      }
      const isCol = newType === 'collection';
      // Toggle button active states
      rowEl.querySelectorAll('.ds-type-btn').forEach(btn => {
        btn.classList.toggle('ds-type-btn--on', btn.dataset.type === newType);
      });
      // Switch panel field visibility
      const panel = rowEl.querySelector('.album-edit-panel');
      if (panel) panel.classList.toggle('ds-mode-collection', isCol);
      // If switching to collection, populate name field from album input (if empty)
      if (isCol && panel) {
        const nameIn  = panel.querySelector('[data-field="name"]');
        const albumIn = panel.querySelector('[data-field="album"]');
        if (nameIn && albumIn && !nameIn.value) nameIn.value = albumIn.value;
      }
      // Update the folder-type chip in the header immediately
      const yearEl = rowEl.querySelector('.lib-detail-entity-year');
      if (yearEl) {
        let chip = yearEl.querySelector('.folder-type-chip');
        if (!chip) {
          chip = document.createElement('span');
          yearEl.insertBefore(chip, yearEl.firstChild);
        }
        chip.className   = 'folder-type-chip ' + (isCol ? 'folder-type-chip--collection' : 'folder-type-chip--album');
        chip.textContent = isCol ? UI.t('lbl_collection') : UI.t('lbl_album_chip');
      }
    } catch (err) {
      console.error('[DeepScan] Type toggle error:', err);
      UI.showToast('Error cambiando tipo', 'error');
    }
  }

  /** Update the lib-detail-entity header cells after a save */
  function _dsRefreshRowHeader(rowEl, folder, { artist, album, year, coverUrl }) {
    const songs     = folder.songs || [];
    const songCount = songs.length || folder.count || 0;
    const mime      = songs[0]?.mimeType || '';
    const format    = mime.includes('flac') ? 'FLAC' : mime.includes('ogg') ? 'OGG'
                    : mime.includes('aac')  ? 'AAC'  : mime.includes('wav') ? 'WAV'
                    : (mime.includes('mpeg') || mime.includes('mp3')) ? 'MP3' : '';
    const isCol   = isFolderCollection(folder.id);
    const ftLabel = isCol ? (UI.t('lbl_collection') || 'Colección') : (UI.t('lbl_album_chip') || 'Álbum');
    const ftCls   = isCol ? 'folder-type-chip--collection' : 'folder-type-chip--album';

    const nameEl = rowEl.querySelector('.lib-detail-entity-name');
    if (nameEl && album) nameEl.textContent = album;

    const subEl = rowEl.querySelector('.lib-detail-entity-sub');
    if (subEl) {
      const chips = folder.songs?.length ? _dsMissingChips(folder) : '';
      subEl.innerHTML = [artist ? _escHtml(artist) : '', `${songCount} ${UI.t('lbl_songs')}`].filter(Boolean).join(' · ')
                      + (chips ? `&ensp;${chips}` : '');
    }

    const chipHtml = `<span class="folder-type-chip ${ftCls}">${_escHtml(ftLabel)}</span>`;
    const yearEl = rowEl.querySelector('.lib-detail-entity-year');
    if (yearEl) {
      yearEl.innerHTML = [
        chipHtml,
        year   ? `(${_escHtml(year)})`                                           : '',
        format ? `<span class="album-format-badge">${_escHtml(format)}</span>`   : '',
      ].filter(Boolean).join(' ');
    } else {
      const infoEl = rowEl.querySelector('.lib-detail-entity-info');
      if (infoEl) {
        const newYearEl = document.createElement('div');
        newYearEl.className = 'lib-detail-entity-year';
        newYearEl.innerHTML = [
          chipHtml,
          year   ? `(${_escHtml(year)})`                                         : '',
          format ? `<span class="album-format-badge">${_escHtml(format)}</span>` : '',
        ].filter(Boolean).join(' ');
        infoEl.insertBefore(newYearEl, infoEl.firstChild);
      }
    }

    const artEl = rowEl.querySelector('.lib-detail-entity-art');
    if (artEl && coverUrl && !coverUrl.startsWith('blob:')) {
      const musicSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
      artEl.innerHTML = `<img src="${_escHtml(coverUrl)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.style.display='none'">${musicSvg}`;
    }
  }

  /** Toggle the per-song rename list below the edit panel.
   *  songArr: already-loaded array (attention rows) or null → loads from DB. */
  async function _dsToggleSongsList(rowEl, songArr, folderId) {
    const listEl = rowEl.querySelector('.ds-songs-edit-list');
    const btn    = rowEl.querySelector('.ds-track-edit-btn');
    if (!listEl || !btn) return;

    const isOpen = listEl.style.display !== 'none';
    if (isOpen) {
      listEl.style.display = 'none';
      btn.textContent = UI.t('edit_tracks_btn') || '✎ Editar canciones';
      btn.classList.remove('album-edit-track-btn--active');
      return;
    }

    // Load songs if not provided
    let songs = songArr?.length ? songArr : null;
    if (!songs) {
      try {
        const all = await DB.getAllMetaLight();
        songs = all.filter(m => m.folderId === folderId);
      } catch (_) { songs = []; }
    }

    if (!songs.length) {
      UI.showToast(UI.t('ds_no_songs'), 'info');
      return;
    }

    // Sort by track number ascending (songs without track go to end)
    const sorted = [...songs].sort((a, b) => {
      const ta = parseInt(a.track, 10);
      const tb = parseInt(b.track, 10);
      if (isNaN(ta) && isNaN(tb)) return 0;
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return ta - tb;
    });

    // Detect collection mode from the panel class
    const panel      = rowEl.querySelector('.album-edit-panel');
    const isColMode  = panel?.classList.contains('ds-mode-collection');

    // Build song rows with thumbnail + track# + name (+ artist/album in collection mode)
    const _noteSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.35"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    const buildRow = (s) => {
      const name   = s.displayName || (typeof cleanTitle === 'function' ? cleanTitle(s.name || '') : (s.name || ''));
      const track  = s.track  || '';
      const artist = s.artist || '';
      const album  = s.album  || '';
      // Stable cover URL from light meta (blob injection happens async below)
      const coverUrl = (s.thumbnailUrl !== 'id3' ? (s.thumbnailUrl || '') : '')
        .replace(/^blob:.*|(?:googleusercontent|lh\d+\.).*/, '') || s.coverUrl || '';
      const el = document.createElement('div');
      el.className = 'ds-song-rename-row' + (isColMode ? ' ds-col-mode' : '');
      el.dataset.songId = s.id;
      el.innerHTML = `
        <div class="ds-song-thumb">${coverUrl ? `<img src="${_escHtml(coverUrl)}" alt="" onerror="this.style.display='none'">` : _noteSvg}</div>
        <input class="ds-track-num-input" type="number" min="1" value="${_escHtml(String(track))}" data-original="${_escHtml(String(track))}" placeholder="#">
        <input class="track-rename-input" value="${_escHtml(name)}" data-original="${_escHtml(name)}" placeholder="${UI.t('lbl_title') || 'Título'}">
        ${isColMode ? `
        <input class="ds-song-meta-input" data-meta="artist" value="${_escHtml(artist)}" data-original="${_escHtml(artist)}" placeholder="${UI.t('lbl_artist') || 'Artista'}">
        <input class="ds-song-meta-input" data-meta="album"  value="${_escHtml(album)}"  data-original="${_escHtml(album)}"  placeholder="${UI.t('lbl_album')  || 'Álbum'}">
        ` : ''}`;
      return el;
    };

    // Column header row
    listEl.innerHTML = '';
    const headerEl = document.createElement('div');
    headerEl.className = 'ds-songs-col-header' + (isColMode ? ' ds-col-mode' : '');
    headerEl.innerHTML = isColMode
      ? `<span class="ds-col-h-thumb"></span>
         <span class="ds-col-h-num">#</span>
         <span class="ds-col-h-name">${UI.t('lbl_title') || 'Título'}</span>
         <span class="ds-col-h-meta">${UI.t('lbl_artist') || 'Artista'}</span>
         <span class="ds-col-h-meta">${UI.t('lbl_album')  || 'Álbum'}</span>`
      : `<span class="ds-col-h-thumb"></span>
         <span class="ds-col-h-num">#</span>
         <span class="ds-col-h-name">${UI.t('lbl_title') || 'Título'}</span>`;
    listEl.appendChild(headerEl);
    sorted.forEach(s => listEl.appendChild(buildRow(s)));

    // Async: inject blob covers for songs that only have embedded ID3 art (no stable URL)
    sorted.forEach(async s => {
      const url = (s.thumbnailUrl !== 'id3' ? (s.thumbnailUrl || '') : '')
        .replace(/^blob:.*|(?:googleusercontent|lh\d+\.).*/, '') || s.coverUrl || '';
      if (url) return; // already shown
      try {
        const meta = await DB.getMeta(s.id).catch(() => null);
        if (!meta?.coverBlob) return;
        const blobUrl = URL.createObjectURL(meta.coverBlob);
        const thumb = listEl.querySelector(`[data-song-id="${CSS.escape(s.id)}"] .ds-song-thumb`);
        if (thumb) thumb.innerHTML = `<img src="${blobUrl}" alt="">`;
      } catch (_) {}
    });

    // Helper: re-sort rows visually by current track# values
    const _reorderRows = () => {
      const rows = [...listEl.querySelectorAll('.ds-song-rename-row')];
      rows.sort((a, b) => {
        const ta = parseInt(a.querySelector('.ds-track-num-input').value, 10);
        const tb = parseInt(b.querySelector('.ds-track-num-input').value, 10);
        if (isNaN(ta) && isNaN(tb)) return 0;
        if (isNaN(ta)) return 1;
        if (isNaN(tb)) return -1;
        return ta - tb;
      });
      rows.forEach(r => listEl.appendChild(r)); // re-append in sorted order
    };

    // Helper: resolve conflicts — if another row has same track#, cascade-bump it
    const _resolveConflicts = (changedRow) => {
      const changedNum = parseInt(changedRow.querySelector('.ds-track-num-input').value, 10);
      if (isNaN(changedNum)) return;
      const rows = [...listEl.querySelectorAll('.ds-song-rename-row')];
      // Collect occupied numbers excluding the row that just changed
      let bump = changedNum;
      const others = rows.filter(r => r !== changedRow);
      // Sort others by track# so cascade is clean
      others.sort((a, b) => parseInt(a.querySelector('.ds-track-num-input').value, 10) - parseInt(b.querySelector('.ds-track-num-input').value, 10));
      others.forEach(r => {
        const inp = r.querySelector('.ds-track-num-input');
        const n   = parseInt(inp.value, 10);
        if (n === bump) {
          bump++;
          inp.value = String(bump);
        }
      });
    };

    // Wire up track number input
    listEl.querySelectorAll('.ds-track-num-input').forEach(inp => {
      const songId = inp.closest('[data-song-id]')?.dataset.songId;
      if (!songId) return;
      const saveTrack = async () => {
        const val = inp.value.trim();
        const original = inp.dataset.original;
        if (val === original) return;
        const n = parseInt(val, 10);
        if (val !== '' && (isNaN(n) || n < 1)) { inp.value = original; return; }
        _resolveConflicts(inp.closest('.ds-song-rename-row'));
        _reorderRows();
        const patch = val === '' ? { track: '' } : { track: String(n) };
        try {
          await DB.setMeta(songId, patch);
          _liveMetaUpdate([songId], patch);
          inp.dataset.original = val;
        } catch (_) { inp.value = original; }
      };
      inp.addEventListener('blur', saveTrack);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); saveTrack().then(() => inp.blur()); }
        if (e.key === 'Escape') { inp.value = inp.dataset.original; inp.blur(); }
      });
    });

    // Wire up name input
    listEl.querySelectorAll('.track-rename-input').forEach(inp => {
      const songId = inp.closest('[data-song-id]')?.dataset.songId;
      if (!songId) return;
      const save = async () => {
        const newName  = inp.value.trim();
        const original = inp.dataset.original;
        if (!newName || newName === original) return;
        try {
          await App.onTrackRename(songId, newName);
          inp.dataset.original = newName;
        } catch (_) { inp.value = original; }
      };
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); save().then(() => inp.blur()); }
        if (e.key === 'Escape') { inp.value = inp.dataset.original; inp.blur(); }
      });
    });

    // Wire up artist / album inputs (collection mode only)
    if (isColMode) {
      listEl.querySelectorAll('.ds-song-meta-input').forEach(inp => {
        const songId = inp.closest('[data-song-id]')?.dataset.songId;
        const field  = inp.dataset.meta; // 'artist' | 'album'
        if (!songId || !field) return;
        const save = async () => {
          const val      = inp.value.trim();
          const original = inp.dataset.original;
          if (val === original) return;
          try {
            const patch = { [field]: val, manualAt: Date.now() };
            await DB.setMeta(songId, patch);
            _liveMetaUpdate([songId], patch);
            inp.dataset.original = val;
          } catch (_) { inp.value = original; }
        };
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter')  { e.preventDefault(); save().then(() => inp.blur()); }
          if (e.key === 'Escape') { inp.value = inp.dataset.original; inp.blur(); }
        });
      });
    }

    listEl.style.display = 'block';
    btn.textContent = UI.t('edit_tracks_done') || '✓ Listo';
    btn.classList.add('album-edit-track-btn--active');
  }

  /** Asynchronously load a stable cover URL from DB and inject it into the row's art cell */
  async function _dsLoadCoverForRow(rowEl, folder) {
    const artEl = rowEl.querySelector('.lib-detail-entity-art');
    if (!artEl || artEl.querySelector('img')) return; // already has cover
    for (const song of (folder.songs || [])) {
      const meta = await DB.getMeta(song.id).catch(() => null);
      if (!meta) continue;
      const cover = meta.thumbnailUrl || meta.coverUrl || '';
      if (!cover || cover.startsWith('blob:') || /googleusercontent\.com|lh\d+\./i.test(cover)) continue;
      const musicSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
      artEl.innerHTML = `<img src="${_escHtml(cover)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit" onerror="this.style.display='none'">${musicSvg}`;
      // Populate cover input and update session data
      const coverIn = rowEl.querySelector('[data-field="coverUrl"]');
      if (coverIn && !coverIn.value) coverIn.value = cover;
      song.thumbnailLink = cover;
      break;
    }
  }

  function _dsBuildTable(folder) {
    const rows = folder.songs.map(song => {
      const mA  = song.missingArtist ? ' missing' : '';
      const mAl = song.missingAlbum  ? ' missing' : '';
      const mY  = song.missingYear   ? ' missing' : '';
      const mC  = song.missingCover  ? ' missing' : '';
      // coverUrl may be a blob object URL (session-only); prefer thumbnailLink for display
      const coverVal = song.thumbnailLink || song.coverUrl || '';
      // If song has embedded blob art, show a placeholder checkmark instead of URL
      const hasBlob = !!song.coverBlob;
      const thumb = coverVal
        ? `<img src="${_escHtml(coverVal)}" class="ds-cover-thumb" onerror="this.style.display='none'">`
        : hasBlob
          ? `<span class="ds-cover-thumb ds-cover-blob" title="Cover embebido (ID3)">♪</span>`
          : `<span class="ds-cover-thumb ds-cover-empty"></span>`;
      return `<tr data-song-id="${_escHtml(song.id)}">
        <td class="ds-table-filename" title="${_escHtml(song.name)}">${_escHtml(song.displayName || cleanTitle(song.name))}</td>
        <td><input class="ds-cell-input${mA}"  data-field="artist" value="${_escHtml(song.artist)}"  placeholder="Artista"></td>
        <td><input class="ds-cell-input${mAl}" data-field="album"  value="${_escHtml(song.album)}"   placeholder="Álbum"></td>
        <td class="ds-cover-cell">
          ${thumb}
          <input class="ds-cell-input${mC}" data-field="coverUrl" value="${_escHtml(coverVal)}" placeholder="URL cover…">
        </td>
        <td><input class="ds-cell-input${mY}"  data-field="year"   value="${_escHtml(song.year)}"    placeholder="Año" style="max-width:55px"></td>
        <td><input class="ds-cell-input"       data-field="track"  value="${_escHtml(song.track)}"   placeholder="#" style="max-width:40px"></td>
      </tr>`;
    }).join('');
    return `<table class="ds-table"><thead><tr>
      <th style="width:20%">Canción</th><th style="width:18%">Artista</th>
      <th style="width:18%">Álbum</th><th style="width:28%">Cover</th>
      <th style="width:9%">Año</th><th style="width:7%">Pista</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function _escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /**
   * Returns true only for stable, cross-device-safe cover URLs that are worth
   * persisting to IndexedDB and syncing to other devices.
   *
   * Excluded (treated as unstable / session-only):
   *  • blob:   — created by the current browser session, gone on reload/other device
   *  • lh*.googleusercontent.com — Drive-generated thumbnailLink, expires in hours
   *  • *.googleapis.com thumbnails — same family of expiring Drive URLs
   *
   * Accepted: coverartarchive.org, Last.fm CDNs, AudD, any other permanent https URL.
   */
  function _isStableCoverUrl(url) {
    if (!url) return false;
    if (url.startsWith('blob:')) return false;
    if (/googleusercontent\.com|lh\d+\./i.test(url)) return false;
    return url.startsWith('https://') || url.startsWith('http://');
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
    if (ignBtn) { ignBtn.textContent = ignored ? '↩ Designorar' : '✕ Ignorar'; ignBtn.title = ignored ? 'Designorar' : 'Ignorar'; }
    _dsUpdateCounters();
    await _dsSaveSession();
  }

  function _dsApplyRow1(rowEl) {
    const rows = rowEl.querySelectorAll('.ds-table tbody tr');
    if (rows.length < 2) return;
    const first    = rows[0];
    const artist   = first.querySelector('[data-field="artist"]')?.value   || '';
    const album    = first.querySelector('[data-field="album"]')?.value    || '';
    const year     = first.querySelector('[data-field="year"]')?.value     || '';
    const coverUrl = first.querySelector('[data-field="coverUrl"]')?.value || '';
    for (let i = 1; i < rows.length; i++) {
      const aIn = rows[i].querySelector('[data-field="artist"]');
      const lIn = rows[i].querySelector('[data-field="album"]');
      const yIn = rows[i].querySelector('[data-field="year"]');
      const cIn = rows[i].querySelector('[data-field="coverUrl"]');
      if (aIn) { aIn.value = artist;   aIn.classList.remove('missing'); }
      if (lIn) { lIn.value = album;    lIn.classList.remove('missing'); }
      if (yIn) { yIn.value = year;     yIn.classList.remove('missing'); }
      if (cIn) { cIn.value = coverUrl; if (coverUrl) cIn.classList.remove('missing'); }
    }
  }

  async function _dsSaveFolderEdits(rowEl, folderId) {
    const folder  = _dsSession.folders[folderId];
    if (!folder) return;
    const saveBtn = rowEl.querySelector('.ds-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = UI.t('saving'); }
    try {
      const tableRows = rowEl.querySelectorAll('.ds-table tbody tr');
      let saved = 0;
      for (const tr of tableRows) {
        const songId = tr.dataset.songId;
        if (!songId) continue;
        const artist   = tr.querySelector('[data-field="artist"]')?.value?.trim()   || '';
        const album    = tr.querySelector('[data-field="album"]')?.value?.trim()    || '';
        const year     = tr.querySelector('[data-field="year"]')?.value?.trim()     || '';
        const track    = tr.querySelector('[data-field="track"]')?.value?.trim()    || '';
        const coverUrl = tr.querySelector('[data-field="coverUrl"]')?.value?.trim() || '';
        // Always write folderId so _loadAlbums can group this track into an album card,
        // and so the sync filter includes it (filter checks folderId || artist || album…)
        // manualAt is the LWW guard: prevents remote auto-enrichment from overwriting
        // manual edits during the 2-second push debounce window.
        const patch = { folderId, manualAt: Date.now() };
        if (artist)   patch.artist        = artist;
        if (album)    patch.album         = album;
        if (year)     patch.year          = year;
        if (track)    patch.track         = track;
        // thumbnailUrl is the stable, syncable field — thumbnailLink is the ephemeral Drive URL
        if (coverUrl && !coverUrl.startsWith('blob:')) patch.thumbnailUrl = coverUrl;
        if (Object.keys(patch).length > 0) {
          await DB.setMeta(songId, patch);
          saved++;
          if (artist)   tr.querySelector('[data-field="artist"]')?.classList.remove('missing');
          if (album)    tr.querySelector('[data-field="album"]')?.classList.remove('missing');
          if (year)     tr.querySelector('[data-field="year"]')?.classList.remove('missing');
          if (coverUrl) tr.querySelector('[data-field="coverUrl"]')?.classList.remove('missing');
          // Cache the cover as a local blob so it's available offline
          if (coverUrl && !coverUrl.startsWith('blob:')) {
            _cacheExternalCover(songId, coverUrl, true).catch(() => {});
          }

          // Update the in-memory session so re-renders show the saved values
          // (folder.songs is the source of truth for EP row rendering)
          const sessionSong = folder.songs?.find(s => s.id === songId);
          if (sessionSong) {
            if (artist)   { sessionSong.artist  = artist;   sessionSong.missingArtist = false; }
            if (album)    { sessionSong.album   = album;    sessionSong.missingAlbum  = false; }
            if (year)     { sessionSong.year    = year;     sessionSong.missingYear   = false; }
            if (track)    { sessionSong.track   = track; }
            if (coverUrl && !coverUrl.startsWith('blob:')) {
              sessionSong.thumbnailLink = coverUrl;
              sessionSong.missingCover  = false;
            }
          }

          // Propagate to Meta cache + Player queue → miniplayer updates instantly
          const livePatch = {};
          if (artist)                                livePatch.artist       = artist;
          if (album)                                 livePatch.album        = album;
          if (year)                                  livePatch.year         = year;
          if (coverUrl && !coverUrl.startsWith('blob:')) livePatch.thumbnailUrl = coverUrl;
          if (Object.keys(livePatch).length) _liveMetaUpdate([songId], livePatch);
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
      if (_browseFolderId) _updateBrowseLegend(_browseFolderId);
      if (saveBtn) { saveBtn.textContent = UI.t('saved_ok'); setTimeout(() => { if(saveBtn){saveBtn.disabled=false;saveBtn.textContent=UI.t('save_btn');} }, 1800); }
      UI.showToast(`${saved} ${UI.t('lbl_songs_updated')}`);
    } catch (err) {
      console.error('[DeepScan] Save error:', err);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = UI.t('save_btn'); }
      UI.showToast(UI.t('toast_save_error'), 'error');
    }
  }

  /* ── Tab switching ──────────────────────────────────────── */

  function _dsSwitchTab(tab) {
    document.querySelectorAll('.ds-tab').forEach(b => b.classList.toggle('active', b.dataset.dsTab === tab));
    document.querySelectorAll('.ds-tab-content').forEach(el => el.classList.toggle('active', el.id === 'ds-tab-' + tab));
    if (tab === 'artists') {
      // Reset toggle state when entering the artists tab
      _dsOnlyNoPhoto = false;
      document.getElementById('ds-toggle-no-photo')?.classList.remove('on');
      if (!_dsArtistsLoaded) _dsLoadArtists();
    }
  }

  /* ── Artistas tab ───────────────────────────────────────── */

  async function _dsLoadArtists() {
    _dsArtistsLoaded = true;
    const grid = document.getElementById('ds-artists-grid');
    if (!grid) return;
    grid.innerHTML = `<div class="ds-attention-empty" style="grid-column:1/-1">${UI.t('ds_loading_artists')}</div>`;

    try {
      // Extract unique artists from metadata.
      // When the artist field contains multiple names separated by ";" only the first is used.
      const all = await DB.getAllMeta().catch(() => []);
      const artistMap = new Map(); // lowercase key → display name (first occurrence wins)
      for (const m of all) {
        if (!m.artist) continue;
        const name = m.artist.split(';')[0].trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!artistMap.has(key)) artistMap.set(key, name);
      }

      if (artistMap.size === 0) {
        grid.innerHTML = `<div class="ds-attention-empty" style="grid-column:1/-1">${UI.t('ds_no_artists')}</div>`;
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
      if (grid) grid.innerHTML = `<div class="ds-attention-empty" style="grid-column:1/-1">${UI.t('ds_error_artists')}</div>`;
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
      grid.innerHTML = `<div class="ds-attention-empty" style="grid-column:1/-1">${UI.t('ds_all_have_photo')}</div>`;
      return;
    }

    // Wire search input (once — idempotent via data attribute)
    const searchInput = document.getElementById('ds-artists-search');
    if (searchInput && !searchInput.dataset.wired) {
      searchInput.dataset.wired = '1';
      searchInput.addEventListener('input', () => {
        const q = norm(searchInput.value);
        grid.querySelectorAll('.ds-artist-card').forEach(c => {
          c.style.display = (!q || c.dataset.artistKey.includes(q)) ? '' : 'none';
        });
        const clearBtn = document.getElementById('btn-ds-search-clear');
        if (clearBtn) clearBtn.style.display = searchInput.value ? '' : 'none';
      });
      const dsClearBtn = document.getElementById('btn-ds-search-clear');
      dsClearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        searchInput.focus();
        dsClearBtn.style.display = 'none';
        grid.querySelectorAll('.ds-artist-card').forEach(c => { c.style.display = ''; });
      });
    }
    // Clear any previous search when artists are re-rendered
    if (searchInput) { searchInput.value = ''; }
    const _dsClearBtnReset = document.getElementById('btn-ds-search-clear');
    if (_dsClearBtnReset) _dsClearBtnReset.style.display = 'none';

    for (const [key, name] of filtered) {
      const url = photoMap[key] || '';
      const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase();

      const card = document.createElement('div');
      card.className = 'ds-artist-card';
      card.dataset.artistKey = key;
      card.dataset.currentUrl = url;

      // Avatar: show image if available, always keep initials as fallback
      const avatarInner = url
        ? `<img src="${_escHtml(url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span style="display:none">${_escHtml(initials)}</span>`
        : `<span>${_escHtml(initials)}</span>`;

      const urlBtnTitle = url ? UI.t('ds_edit_artist_url') : UI.t('ds_add_artist_url');
      card.innerHTML = `
        <div class="ds-artist-avatar">${avatarInner}</div>
        <span class="ds-artist-name" title="${_escHtml(name)}">${_escHtml(name)}</span>
        <button class="ds-artist-url-btn${url ? ' has-url' : ''}" title="${_escHtml(urlBtnTitle)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
        </button>`;

      card.querySelector('.ds-artist-url-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        _dsOpenArtistUrlModal(key, name, card.dataset.currentUrl);
      });

      grid.appendChild(card);
    }
  }

  /* ── Artist URL modal ────────────────────────────────────── */

  let _dsArtistUrlKey  = null;
  let _dsArtistUrlName = null;

  function _dsOpenArtistUrlModal(key, name, currentUrl) {
    _dsArtistUrlKey  = key;
    _dsArtistUrlName = name;
    const titleEl = document.getElementById('ds-artist-url-modal-title');
    const nameEl  = document.getElementById('ds-artist-url-modal-name');
    const input   = document.getElementById('ds-artist-url-input');
    if (titleEl) titleEl.textContent = UI.t('ds_artist_url_title');
    if (nameEl)  nameEl.textContent  = name;
    if (input)   input.value         = currentUrl || '';
    document.getElementById('ds-artist-url-modal').style.display = 'flex';
    setTimeout(() => input?.select(), 60);
  }

  async function _dsSaveArtistUrl() {
    const key    = _dsArtistUrlKey;
    const name   = _dsArtistUrlName;
    if (!key) return;
    const input   = document.getElementById('ds-artist-url-input');
    const newUrl  = (input?.value || '').trim();
    const saveBtn = document.getElementById('btn-ds-artist-url-save');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const manual = await DB.getState('ds_artistPhotos').catch(() => ({})) || {};
      if (newUrl) { manual[key] = newUrl; } else { delete manual[key]; }
      await DB.setState('ds_artistPhotos', manual);

      const auto = await DB.getState('artistImages').catch(() => ({})) || {};
      if (newUrl) { auto[key] = newUrl; } else if (key in auto) { auto[key] = null; }
      await DB.setState('artistImages', auto);

      // Update the card avatar + button state in the grid
      const grid = document.getElementById('ds-artists-grid');
      const card = grid?.querySelector(`.ds-artist-card[data-artist-key="${CSS.escape(key)}"]`);
      if (card) {
        card.dataset.currentUrl = newUrl;
        const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase();
        const avatar = card.querySelector('.ds-artist-avatar');
        if (avatar) {
          avatar.innerHTML = newUrl
            ? `<img src="${_escHtml(newUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span style="display:none">${_escHtml(initials)}</span>`
            : `<span>${_escHtml(initials)}</span>`;
        }
        const urlBtn = card.querySelector('.ds-artist-url-btn');
        if (urlBtn) {
          urlBtn.classList.toggle('has-url', !!newUrl);
          urlBtn.title = newUrl ? UI.t('ds_edit_artist_url') : UI.t('ds_add_artist_url');
        }
      }

      // Recount
      const allCards = [...(grid?.querySelectorAll('.ds-artist-card') || [])];
      const withPhotoCount = allCards.filter(c => {
        const img = c.querySelector('.ds-artist-avatar img');
        return img && img.src && img.style.display !== 'none';
      }).length;
      _dsSetCounter('ds-art-con',   withPhotoCount);
      _dsSetCounter('ds-art-sin',   allCards.length - withPhotoCount);
      _dsSetCounter('ds-art-total', allCards.length);

      UI.showToast(newUrl ? UI.t('toast_photo_saved') : UI.t('toast_photo_deleted'));
      _dsCloseModal('ds-artist-url-modal');
      _dsArtistUrlKey  = null;
      _dsArtistUrlName = null;
    } catch (err) {
      console.error('[DS] Save artist photo error:', err);
      UI.showToast(UI.t('toast_save_error'), 'error');
    }
    if (saveBtn) saveBtn.disabled = false;
  }

  /**
   * Background Last.fm thumbnail enrichment for the Library.
   * For each album folder that has artist+album
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
        // Skip only when cover is already a stable persistent URL.
        // Expired Drive thumbnailLinks (lh*.googleusercontent.com) and blob: URLs
        // must not block the Last.fm retry — treat them as "no cover".
        if (_isStableCoverUrl(m.thumbnailUrl) || m.lfmThumbTried) { f.skip = true; continue; }
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
          // Only write to songs that don't have a manually-set cover
          await Promise.all(songIds.map(async id => {
            try {
              const sm = await DB.getMeta(id);
              if ((sm?.manualAt || 0) > 0) return; // respect manual cover
              if (sm?.coverBlob) return;             // respect ID3 embedded art
              await DB.setMeta(id, { thumbnailUrl: url });
            } catch (_) {}
          }));
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
      // Never overwrite values that were already enriched (ID3 / Last.fm / AudD),
      // and never overwrite fields the user manually edited (manualAt guard).
      const inferManual = (existing?.manualAt || 0) > 0;
      if (!existing?.album  && albumName      && !inferManual) patch.album  = albumName;
      // Only write inferred (folder-name) artist if there is no real artist yet.
      // Mark it so soft scan / ID3 enrichment can overwrite it with the real value.
      if (!existing?.artist && inferredArtist && !inferManual) {
        patch.artist           = inferredArtist;
        patch.artistInferred   = true;   // flag: came from folder name, not ID3/MB/Last.fm
      }
      // Only persist STABLE external URLs (MB, Last.fm, AudD, CAA…).
      // Drive thumbnailLinks (lh*.googleusercontent.com) expire in hours and are
      // worthless on other devices — storing them would block _lfmThumbLibrary from
      // ever retrying the album with a real, permanent cover URL.
      if (!existing?.thumbnailUrl && _isStableCoverUrl(coverUrl)) patch.thumbnailUrl = coverUrl;

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

    // Live-update the album card in the library while the scan is running.
    // This works even when coverUrl is an unstable Drive thumbnailLink — it
    // gives immediate visual feedback for the current session without persisting
    // the URL (stable URLs were already written to DB above and will survive reload).
    if (coverUrl && !_libInDetail && _currentLibTab === 'albums') {
      const fId = audioFiles[0]?.parents?.[0];
      if (fId) _updateAlbumCardCover(fId, coverUrl);
    }

    // NOTE: Sync.push('metadata') is NOT called here.
    // _inferAlbumMeta is called in a loop (BFS scan, rescan) and pushing per-folder
    // would saturate the debounce queue, causing one full metadata write per folder.
    // The caller (_fullLibraryRefresh) issues a single push after
    // the entire loop completes.
    return count;
  }

  /* ── Soft scan ───────────────────────────────────────────────
   * Lightweight ID3-only enrichment fired when the user opens a folder in browse.
   * Rules:
   *  • Skip if folder has rescannedAt (manual rescan already done)
   *  • Skip if any song in the folder has manualAt > 0 (manual edits present)
   *  • Only reads ID3 tags — no MusicBrainz / Last.fm / AudD calls
   *  • Only patches songs that are still missing artist, album, or cover
   *  • Runs fire-and-forget in background; yields between files to avoid blocking
   * ─────────────────────────────────────────────────────────── */

  /**
   * @param {string}   folderId
   * @param {Object[]} files  — audio file objects from Drive.listFolderAll
   */
  async function _softScanFolder(folderId, files) {
    if (!folderId || !files || files.length === 0) return;
    if (typeof Meta === 'undefined' || typeof Drive === 'undefined') return;

    try {
      // Guard 1: folder already manually rescanned
      const folderMeta = await DB.getMeta(folderId).catch(() => null);
      if (folderMeta?.rescannedAt) return;

      // Guard 2: build existing DB meta map
      const allMeta     = await DB.getAllMeta();
      const folderIdSet = new Set(files.map(f => f.id));

      // Build a quick lookup of existing DB meta for this folder's songs
      const existingMap = new Map();
      for (const m of allMeta) {
        if (folderIdSet.has(m.id)) existingMap.set(m.id, m);
      }

      // Capture the currently-playing song ID so we can move it to the front
      // of the candidates list if it's already a legitimate scan candidate.
      // We do NOT force-include it when softScannedAt is set — that would trigger
      // a redundant 1 MB download that competes with the audio stream.
      const currentTrackId = (typeof Player !== 'undefined') ? Player.getCurrentTrack()?.id : null;

      // Candidates: any file not yet soft-scanned AND not manually edited.
      // We intentionally ignore whether artist/album is already set — folder-name
      // inference (artistInferred) and stale data need to be replaced by real ID3.
      // rescannedAt = full manual rescan already done → skip (has authoritative data).
      // softScannedAt = already read real ID3 in a previous session → skip,
      //   UNLESS the record still carries a stale external cover URL that needs clearing.
      const candidates = files.filter(f => {
        const m = existingMap.get(f.id);
        if (!m) return true;                   // no data at all
        if (m.manualAt)     return false;      // user manually edited → never touch
        if (m.rescannedAt)  return false;      // full rescan done → authoritative
        if (m.softScannedAt) {
          // Previously soft-scanned but may still carry a stale external URL
          // (set before this fix landed). Re-scan to clear it.
          const hasExternalUrl =
            (m.thumbnailUrl && m.thumbnailUrl !== 'id3' && !m.thumbnailUrl.startsWith('blob:')) ||
            (m.coverUrl     && !m.coverUrl.startsWith('blob:'));
          return hasExternalUrl;              // re-scan only if stale URL present
        }
        return true;                           // anything else: scan to get real ID3
      });

      // Always scan the currently-playing song first so its metadata appears in the
      // browse row immediately — even before the rest of the folder is processed.
      if (currentTrackId) {
        const playingIdx = candidates.findIndex(f => f.id === currentTrackId);
        if (playingIdx > 0) {
          const [playing] = candidates.splice(playingIdx, 1);
          candidates.unshift(playing);
        }
      }

      if (candidates.length === 0) return;

      console.log(`[SoftScan] ${folderId}: scanning ${candidates.length} candidates`);
      let patched = 0;

      // Live artist set for real-time chip update — seed with artists already in DB
      const liveArtistSet = new Set();
      existingMap.forEach(m => { if (m.artist && !m.artistInferred) liveArtistSet.add(m.artist.split(';')[0].trim().toLowerCase()); });
      const inBrowse = () => _browseFolderId === folderId;

      for (const file of candidates) {
        // Show "Leyendo…" on this row immediately so the user sees progress one by one
        if (inBrowse()) UI.markBrowseSongScanning(file.id);

        try {
          // Fresh DB read — _onBlobReady may have written coverBlob to DB after
          // existingMap was built.  A stale map entry would make coverBlobToUse = null
          // and incorrectly clear a cover that was just stored by a concurrent parse.
          const existing = await DB.getMeta(file.id).catch(() => null) ?? existingMap.get(file.id) ?? null;

          // Secondary race-condition guard: manualAt / rescannedAt may have been written
          // to DB AFTER existingMap was built (e.g. user edited a track while the folder
          // was already open and the soft scan was in progress).  The candidates filter
          // used the stale snapshot and included this track; the fresh read above now
          // shows the true state.  Do NOT scan or overwrite — just clear the "Leyendo…"
          // indicator and apply whatever is already in DB to the DOM row.
          if ((existing?.manualAt || 0) > 0 || (existing?.rescannedAt || 0) > 0) {
            if (inBrowse()) {
              UI.updateBrowseSongMeta(file.id,
                existing?.artist      || null,
                existing?.album       || null,
                existing?.displayName || null);
              // Paint cover from DB if row doesn't have one yet
              const _rg  = document.querySelector(`#screen-browse .song-row[data-id="${CSS.escape(file.id)}"]`);
              if (_rg && !_rg.querySelector('.song-thumb img')) {
                const _mu = ((existing?.manualAt || 0) > 0)
                  && existing?.thumbnailUrl
                  && !existing.thumbnailUrl.startsWith('blob:')
                  && existing.thumbnailUrl !== 'id3'
                  ? existing.thumbnailUrl : null;
                const _cu = _mu
                  || (existing?.coverBlob && typeof Meta !== 'undefined'
                      ? Meta.injectCover(file.id, existing.coverBlob) : null)
                  || existing?.coverUrl || existing?.thumbnailUrl || null;
                if (_cu) _updateRowThumbnail(file.id, _cu, existing?.thumbnailUrl === 'id3');
              }
            }
            continue;
          }

          // Use cached blob (from prior play) or fetch just the first 256 KB
          let blob = await DB.getCachedBlob(file.id).catch(() => null);
          if (!blob) blob = await Drive.downloadFileHead(file.id, 1024 * 1024).catch(() => null);

          if (!blob) {
            if (inBrowse()) UI.updateBrowseSongMeta(file.id, existing?.artist || null, existing?.album || null, null);
            continue;
          }

          const parsed = await Meta.parse(file.id, blob).catch(() => null);

          if (!parsed) {
            if (inBrowse()) UI.updateBrowseSongMeta(file.id, existing?.artist || null, existing?.album || null, null);
            continue;
          }

          // Full ID3 reset: replace ALL metadata with what the ID3 tag says.
          // null = "not in ID3" and MUST overwrite stale inferred values, external URLs, etc.
          // Guards (manualAt / rescannedAt) were already filtered out above — these items
          // are never in the candidates list, so we never touch manually-edited songs.
          //
          // Cover: always replace, including clearing external URLs (Last.fm / AudD).
          //   • ID3 has cover  → coverBlob = blob, thumbnailUrl = 'id3', coverUrl = null
          //   • ID3 has no cover → coverBlob = null, thumbnailUrl = null, coverUrl = null
          //
          // We use DB.bulkWriteMeta (direct IndexedDB put) instead of DB.setMeta because
          // setMeta strips null values before merging — that would leave stale URLs intact.
          // By spreading existing first and then the patch, null values are stored literally
          // and overwrite the old data.
          // coverBlob priority:
          //   1. parsed.coverBlob — fresh extraction from the audio blob (best case)
          //   2. existing.coverBlob — blob already in DB from a previous full play/parse.
          //      Meta.parse returns from in-memory cache on cache-hits and strips coverBlob
          //      before caching, so parsed.coverBlob is undefined on a cache-hit even when
          //      the file does have a cover. Falling back to existing.coverBlob prevents
          //      incorrectly clearing a valid blob that was saved in a prior session.
          //   3. null — file genuinely has no embedded cover (or was never fully parsed)
          const coverBlobToUse = parsed.coverBlob ?? existing?.coverBlob ?? null;

          const patch = {
            softScannedAt:  Date.now(),
            displayName:    parsed.title  || null,
            artist:         parsed.artist || null,
            artistInferred: !parsed.artist,
            album:          parsed.album  || null,
            year:           parsed.year   || null,
            coverBlob:      coverBlobToUse,
            thumbnailUrl:   coverBlobToUse ? 'id3' : null,
            coverUrl:       null,
          };

          const newArtist  = patch.artist      ?? null;
          const newAlbum   = patch.album        ?? null;
          const newDisplay = patch.displayName  ?? null;

          // Direct put so null values actually clear existing fields in IndexedDB.
          await DB.bulkWriteMeta([{ ...(existing || {}), ...patch, id: file.id }]);
          // skipDbPersist=true: bulkWriteMeta just wrote a definitive record — _cacheItem
          // must NOT call DB.setMeta afterward (it would re-write file.thumbnailLink/thumbnailUrl
          // and undo the null we just stored).
          // thumbnailUrl is explicitly set to patch.thumbnailUrl (null or 'id3') so the
          // in-memory item reflects the authoritative post-scan state.
          _cacheItem({ ...file, folderId,
            thumbnailUrl: patch.thumbnailUrl,
            ...(newArtist  ? { artist:      newArtist  } : {}),
            ...(newAlbum   ? { album:       newAlbum   } : {}),
            ...(newDisplay ? { displayName: newDisplay } : {}),
          }, true);
          patched++;

          // Update visible Browse row immediately — title, artist · album + cover
          if (inBrowse()) {
            UI.updateBrowseSongMeta(file.id, newArtist, newAlbum, newDisplay);
            if (patch.coverBlob && typeof Meta !== 'undefined') {
              // Paint cover immediately. Meta.injectCover reuses the cached blob URL when
              // available (avoiding a duplicate createObjectURL call) or creates a new one.
              const coverUrl = Meta.injectCover(file.id, patch.coverBlob);
              if (coverUrl) _updateRowThumbnail(file.id, coverUrl, true);
            } else {
              // File has no embedded cover — clear any stale external URL from the DOM.
              // Also purge the Meta in-memory cache so _prefetchAndApplyFolderCovers
              // Pass 1 doesn't re-inject an old blob URL for this song.
              //
              // Race-condition guard: if the DOM img already carries data-cover-src='id3',
              // a concurrent _onBlobReady (or prior scan pass) confirmed this file DOES
              // have an embedded cover — our parsed.coverBlob came back null only because
              // Meta.parse returned from cache (coverBlob is always stripped from cache).
              // Don't revoke or clear in that case; the cover is still valid.
              const _eid = CSS.escape(file.id);
              const _row = document.querySelector(`#screen-browse .song-row[data-id="${_eid}"]`);
              const _img = _row?.querySelector('.song-thumb img');
              if (_img?.dataset.coverSrc !== 'id3') {
                if (typeof Meta !== 'undefined') Meta.revoke(file.id);
                if (_img) {
                  // Restore placeholder — _rowHasCover will now return false for this song
                  const _ph = document.createElement('div');
                  _ph.className = 'thumb-placeholder';
                  _img.replaceWith(_ph);
                }
              }
            }
          }

          // Update live artist set and chip in real-time
          if (newArtist) {
            liveArtistSet.add(newArtist.split(';')[0].trim().toLowerCase());
            if (inBrowse()) {
              const chipType = liveArtistSet.size > 3 ? 'collection' : 'album';
              UI.updateBrowseHeaderChip(chipType);
            }
          }

        } catch (_) {
          const fallback = existingMap.get(file.id) || null;
          if (inBrowse()) UI.updateBrowseSongMeta(file.id, fallback?.artist || null, fallback?.album || null, null);
        }

        // Yield between files — soft scan must never disrupt playback.
        // Skip the delay for the currently-playing song (already at position 0)
        // so its metadata appears in the browse row without any extra wait.
        if (file.id !== currentTrackId) {
          await new Promise(r => setTimeout(r, 50));
        }
      }

      if (patched === 0) return;
      console.log(`[SoftScan] ${folderId}: patched ${patched} file(s)`);

      // Re-apply cover thumbnails to the visible Browse rows.
      // _prefetchAndApplyFolderCovers ran before soft scan started, so any coverBlob
      // that was just extracted and saved to DB was missed. Re-run (non-force) so
      // those covers appear immediately without needing to re-enter the folder.
      if (_browseFolderId === folderId && _browseFiles.length > 0) {
        _prefetchAndApplyFolderCovers(folderId, _browseFiles, false).catch(() => {});
      }

      // Rebuild collection cache — new artist data may change classification.
      // _refreshCollectionCache now auto-refreshes the Collections tab if new IDs appear.
      await _refreshCollectionCache().catch(() => {});

      // Confirm final chip state based on authoritative cache (post-scan)
      if (inBrowse()) {
        const finalType = _collectionFolderIdsCache?.has(folderId) ? 'collection' : 'album';
        UI.updateBrowseHeaderChip(finalType);
      }

      // Refresh visible library tab if open (not in a detail view)
      if (!_libInDetail) {
        if (_currentLibTab === 'albums')  _loadAlbums();
        if (_currentLibTab === 'artists') _loadArtists();
        // Collections tab is handled by _refreshCollectionCache above when new IDs appear
      }

      // Sync new metadata to other devices
      if (typeof Sync !== 'undefined') Sync.push('metadata');
    } catch (err) {
      console.warn('[SoftScan] Error:', err);
    }
  }

  /**
   * Pre-play soft scan — called by the Player's onBeforePlay hook before audio
   * is fetched.  Blocks playback until the song has been ID3-scanned at least once,
   * so the miniplayer always shows real metadata from the very first play.
   *
   * Fast path: returns immediately if the song already has a scan stamp
   * (softScannedAt / manualAt / rescannedAt) — no extra work needed.
   *
   * Slow path: fetches the first 1 MB (or uses a cached blob), parses ID3 tags,
   * writes the result to DB, and updates the visible browse row if open.
   *
   * @param {DriveItem} item - the track that is about to play
   */
  /**
   * Inject a known cover into every currently-visible surface for a song.
   * Called from _preScanBeforePlay when a cover already exists in DB or was
   * just written — ensures home cards, browse rows and top-list rows all reflect
   * the cover without waiting for the next full _loadHomeData cycle.
   */
  function _ensureCoverVisible(fileId, dbMeta) {
    if (!dbMeta) return;
    if (dbMeta.coverBlob) {
      const url = Meta.injectCover(fileId, dbMeta.coverBlob);
      if (url) {
        _updateHomeCardThumbnail(fileId, url, true);
        _updateRowThumbnail(fileId, url, true);
        _updateTopListThumb(fileId, url, true);
      }
    } else if (dbMeta.thumbnailUrl && dbMeta.thumbnailUrl !== 'id3') {
      _updateHomeCardThumbnail(fileId, dbMeta.thumbnailUrl, false);
      _updateRowThumbnail(fileId, dbMeta.thumbnailUrl, false);
      _updateTopListThumb(fileId, dbMeta.thumbnailUrl, false);
    }
  }

  async function _preScanBeforePlay(item) {
    if (!item?.id) return;
    if (typeof Meta === 'undefined' || typeof Drive === 'undefined') return;

    try {
      const existing = await DB.getMeta(item.id).catch(() => null);

      // ── Case 1: user manually edited → never overwrite; still paint cover if present ──
      if (existing?.manualAt) {
        _ensureCoverVisible(item.id, existing);
        return;
      }

      // ── Case 2: this device already has a local cover ────────────────────────────
      // coverBlob = embedded ID3 art stored in IDB (best quality, offline-capable).
      // valid thumbnailUrl = external URL from Last.fm / AudD / Drive CDN.
      // In both cases paint every visible surface and return — no network call needed.
      // NOTE: rescannedAt is deliberately NOT a fast-path here — it is synced from
      // other devices, so a song can arrive with rescannedAt but no local coverBlob.
      const hasLocalBlob   = !!existing?.coverBlob;
      const hasLocalUrl    = !!(existing?.thumbnailUrl && existing?.thumbnailUrl !== 'id3');
      if (hasLocalBlob || hasLocalUrl) {
        _ensureCoverVisible(item.id, existing);
        return;
      }

      // ── Case 3: already soft-scanned on THIS device ──────────────────────────────
      // The soft scan only downloads a 1MB head — if the APIC frame extends beyond that
      // boundary the cover is missed. When the full audio blob is now available in cache
      // (because the user is about to play the song), we get a second chance to find it.
      if (existing?.softScannedAt) {
        if (!existing?.coverBlob) {
          // Soft scan found no cover — try the full cached blob (if available) to catch
          // large embedded cover art that exceeds the 1MB head download.
          const cachedBlob = await DB.getCachedBlob(item.id).catch(() => null);
          if (cachedBlob && cachedBlob.size > 1024 * 1024) {
            // Force re-parse of the full file (bypass cache from the 1MB soft scan).
            const fullParsed = await Meta.parse(item.id, cachedBlob, true).catch(() => null);
            if (fullParsed?.coverBlob) {
              await DB.setMeta(item.id, { coverBlob: fullParsed.coverBlob, thumbnailUrl: 'id3' }).catch(() => {});
              _ensureCoverVisible(item.id, { ...existing, coverBlob: fullParsed.coverBlob });
              console.log('[PreScan] Full-blob cover found for', item.id);
            }
          }
        } else {
          _ensureCoverVisible(item.id, existing);
        }
        return;
      }

      // ── Slow path: download and scan ─────────────────────────────────────────────
      const folderId = item.parents?.[0] || item.folderId || null;
      const inBrowse = () => _browseFolderId === folderId;

      if (inBrowse()) UI.markBrowseSongScanning(item.id);

      // Prefer full cached blob (best quality, no network).
      // Fall back to 1MB head download (standard size for ID3 tag parsing).
      let blob = await DB.getCachedBlob(item.id).catch(() => null);
      const blobIsFullFile = !!blob;
      if (!blob) blob = await Drive.downloadFileHead(item.id, 1024 * 1024).catch(() => null);

      if (!blob) {
        // Network failure — don't mark softScannedAt so we can retry next time
        if (inBrowse()) UI.updateBrowseSongMeta(item.id, existing?.artist || null, existing?.album || null, null);
        return;
      }

      // ── ID3 tag-size check (same as _softScanItems) ───────────────────────────
      if (!blobIsFullFile && blob.size >= 10) {
        try {
          const hdr = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
          if (hdr[0] === 0x49 && hdr[1] === 0x44 && hdr[2] === 0x33) {
            const tagSize = ((hdr[6] & 0x7f) << 21) | ((hdr[7] & 0x7f) << 14)
                          | ((hdr[8] & 0x7f) << 7)  |  (hdr[9] & 0x7f);
            const needed  = 10 + tagSize;
            if (needed > blob.size) {
              const bigger = await Drive.downloadFileHead(item.id, needed + 1024).catch(() => null);
              if (bigger) blob = bigger;
            }
          }
        } catch (_) {}
      }

      // If the full audio file is cached, force re-parse so we bypass any stale 1MB
      // head result that may have missed a cover extending past the 1MB boundary.
      const parsed = blobIsFullFile
        ? await Meta.parse(item.id, blob, true).catch(() => null)
        : await Meta.parse(item.id, blob).catch(() => null);

      // Mark as scanned regardless of whether we found anything
      const patch = {
        softScannedAt:  Date.now(),
        displayName:    parsed?.title  || null,
        artist:         parsed?.artist || null,
        artistInferred: !parsed?.artist,
        album:          parsed?.album  || null,
        year:           parsed?.year   || null,
      };

      if (parsed?.coverBlob && !existing?.coverBlob) {
        patch.coverBlob    = parsed.coverBlob;
        patch.thumbnailUrl = 'id3';
      }

      await DB.setMeta(item.id, { id: item.id, ...patch });
      _cacheItem({ ...item,
        ...(patch.artist      ? { artist:      patch.artist      } : {}),
        ...(patch.album       ? { album:       patch.album       } : {}),
        ...(patch.displayName ? { displayName: patch.displayName } : {}),
      });

      // Update browse row name/artist
      if (inBrowse()) {
        UI.updateBrowseSongMeta(item.id, patch.artist, patch.album, patch.displayName);
      }

      // Paint cover on EVERY visible surface (home card, browse row, top-list row)
      if (patch.coverBlob) {
        const coverUrl = Meta.injectCover(item.id, patch.coverBlob);
        if (coverUrl) {
          _updateHomeCardThumbnail(item.id, coverUrl, true);
          _updateRowThumbnail(item.id, coverUrl, true);
          _updateTopListThumb(item.id, coverUrl, true);
        }
      }

      // Re-push recents so other devices get the enriched metadata (artist, name)
      // and the cover URL if it's an external URL — even if the recent was originally
      // pushed with a null thumbnail (because the scan hadn't finished yet at addRecent time).
      // _pushRecents now cross-references the metadata store, so this push carries the
      // freshly written softScannedAt patch including any external thumbnailUrl.
      if (typeof Sync !== 'undefined') Sync.push('recents');

      console.log(`[PreScan] ${item.id}: scanned before play — artist=${patch.artist}, album=${patch.album}, cover=${!!patch.coverBlob}`);
    } catch (err) {
      console.warn('[PreScan] Error:', err);
    }
  }

  /**
   * Propagate enriched album metadata to sibling songs in the same folder.
   * Called after _onBlobReady FINALIZE when a song is identified by ID3/Last.fm/AudD.
   * Only patches DB entries that are missing the field — never overwrites enriched values.
   *
   * @param {DriveItem} item  - the identified song (has .parents[0] = folderId)
   * @param {Object}    meta  - enriched metadata object (album, artist, year, coverUrl)
   */
  async function _propagateAlbumMeta(item, meta, folderCoverUrl = null) {
    const folderId = item.parents?.[0];
    if (!folderId) return;

    // ── What we propagate and why ────────────────────────────────────────────────
    // SAFE to propagate: year and folder-level cover (cover.jpg / folder.jpg).
    //   • year is the same for every track on an album and is harmless to share.
    //   • folderCoverUrl is a folder-wide image, not tied to any single track.
    //
    // UNSAFE to propagate: artist and album text.
    //   • These come from ONE song's ID3 tags.  If that song has correct tags but
    //     another song in the same folder is from a different album (compilation,
    //     download folder, etc.), writing the first song's artist/album into the
    //     sibling's DB record causes the sibling to later query Last.fm with the
    //     wrong key — and adopt a completely different song's cover art.
    //     This is the root cause of "cover bleeding."
    //   • Each song must discover its own artist/album from its own sources
    //     (ID3 tags → AudD fingerprint → appProperties from Drive).
    // ────────────────────────────────────────────────────────────────────────────
    const year     = meta.year || null;
    // Only propagate covers that came from the shared folder image, never track-specific art.
    const coverUrl = folderCoverUrl || null;
    if (!year && !coverUrl) return;

    try {
      const all = await DB.getAllMeta();
      let updated = 0;

      for (const m of all) {
        if (!m.id || m.id === item.id) continue;
        if (m.folderId !== folderId)   continue;    // only siblings in same folder

        const patch = {};
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

      // Propagation writes year/cover to siblings — sync to Drive for cross-device
      if (updated > 0 && typeof Sync !== 'undefined') Sync.push('metadata');
    } catch (err) {
      console.warn('[App] _propagateAlbumMeta error:', err);
    }
  }

  /**
   * Aggregate all metadata into artists map.
   * Groups by artist name, counts albums and songs.
   */

  /* ── Paginated render helpers ─────────────────────────────── */

  /**
   * Render or extend the artist grid.
   * @param {boolean} reset – true = start from scratch (new data or new query)
   */
  function _renderArtistPage(reset = false) {
    if (_libInDetail) return;
    if (reset) {
      _libArtistObserver?.disconnect();
      _libArtistObserver = null;
      _libArtistOffset   = 0;
    }
    const q = norm((document.getElementById('lib-search-input')?.value || '').trim());
    const filtered = q
      ? _libAllArtists.filter(a => norm(a.name).includes(q))
      : _libAllArtists;

    const batch = filtered.slice(_libArtistOffset, _libArtistOffset + LIB_PAGE_SIZE);
    _libArtistOffset += batch.length;

    if (reset) {
      UI.renderArtists(batch);
      _setLibTabCount('artists', filtered.length);
    } else {
      UI.appendArtists(batch);
    }

    // If more items remain, attach an IntersectionObserver sentinel
    if (_libArtistOffset < filtered.length) {
      _libArtistObserver?.disconnect();
      const grid = document.querySelector('#lib-detail-content .lib-artist-grid');
      if (grid) {
        const sentinel = document.createElement('div');
        sentinel.className = 'lib-scroll-sentinel';
        grid.appendChild(sentinel);
        _libArtistObserver = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting) {
            _libArtistObserver.disconnect();
            _libArtistObserver = null;
            sentinel.remove();
            _renderArtistPage(false);
          }
        }, { rootMargin: '200px' });
        _libArtistObserver.observe(sentinel);
      }
    }
  }

  /**
   * Render or extend the album grid.
   * @param {boolean} reset – true = start from scratch (new data or new query)
   */
  function _renderAlbumPage(reset = false) {
    if (_libInDetail) return;
    if (reset) {
      _libAlbumObserver?.disconnect();
      _libAlbumObserver = null;
      _libAlbumOffset   = 0;
    }
    const q = norm((document.getElementById('lib-search-input')?.value || '').trim());
    const filtered = q
      ? _libAllAlbums.filter(a =>
          norm(a.name + ' ' + (a.artist || '')).includes(q))
      : _libAllAlbums;

    const batch = filtered.slice(_libAlbumOffset, _libAlbumOffset + LIB_PAGE_SIZE);
    _libAlbumOffset += batch.length;

    if (reset) {
      UI.renderLibraryAlbums(batch);
      _setLibTabCount('albums', filtered.length);
    } else {
      UI.appendAlbums(batch);
    }
    // Async-inject ID3 blob covers after this batch is painted
    _patchGridBlobCovers(batch).catch(() => {});

    // If more items remain, attach an IntersectionObserver sentinel
    if (_libAlbumOffset < filtered.length) {
      _libAlbumObserver?.disconnect();
      const grid = document.querySelector('#lib-detail-content .lib-album-grid');
      if (grid) {
        const sentinel = document.createElement('div');
        sentinel.className = 'lib-scroll-sentinel';
        grid.style.position = 'relative'; // ensure sentinel is visible
        grid.appendChild(sentinel);
        _libAlbumObserver = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting) {
            _libAlbumObserver.disconnect();
            _libAlbumObserver = null;
            sentinel.remove();
            _renderAlbumPage(false);
          }
        }, { rootMargin: '200px' });
        _libAlbumObserver.observe(sentinel);
      }
    }

    // Re-stamp rescan wave overlay if a lib rescan is mid-flight
    // (album cards were just re-rendered, erasing the overlay)
    if (_libRescanActiveFolderId) _setRescanOverlay(_libRescanActiveFolderId, true);

    // Show/hide batch-rescan button
    _syncLibRescanBtn();
  }

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

      // Store full list and render first page
      _libAllArtists = artists;
      _renderArtistPage(true);

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

  /* ── Collections ─────────────────────────────────────────── */

  /**
   * Cache of collection folder IDs (Set<string>).
   * null = not yet computed; populated by _loadCollections/_loadAlbums.
   * Used to tag browse folders with folderType without an extra DB round-trip.
   */
  let _collectionFolderIdsCache  = null;
  let _allKnownFolderIdsCache    = null; // Set of all folderIds that have ≥1 song in DB
  let _folderSongCountCache      = null; // Map<folderId, songCount>

  /**
   * Determine whether a folder accumulator `f` is a collection, respecting
   * the user's manual forceType override stored in the collections DB store.
   * @param {{folderId:string, artistCounts:Map}} f
   * @param {Map<string,Object>} savedColMap  — from DB.getAllCollections()
   */
  function _isCollectionFolder(f, savedColMap) {
    const saved = savedColMap?.get(f.folderId);
    if (saved?.forceType === 'album')      return false;
    if (saved?.forceType === 'collection') return true;
    return f.artistCounts.size > 3;
  }

  /**
   * Build the folder accumulator map shared by _loadAlbums and _loadCollections.
   * Also loads savedColMap (DB overrides) and returns it together with the map.
   */
  async function _buildFolderMap() {
    const [all, savedCols] = await Promise.all([
      DB.getAllMetaLight(), // strips coverBlob binaries — fast bulk load
      DB.getAllCollections().catch(() => []),
    ]);

    const savedColMap     = new Map((savedCols || []).map(c => [c.id, c]));
    const folderSongCount = new Map();
    const rescannedMap    = new Map();
    const folderNameMap   = new Map(); // folderId → Drive folder name (stored on first browse)
    const folderCoverMap  = new Map(); // folderId → manually-set album-level cover URL

    all.forEach(m => {
      if (m.folderId) folderSongCount.set(m.folderId, (folderSongCount.get(m.folderId) || 0) + 1);
      if (m.rescannedAt) rescannedMap.set(m.id, m.rescannedAt);
      // Folder meta records have no folderId (their id IS the folderId)
      if (!m.folderId && m.name) folderNameMap.set(m.id, m.name);
      // Folder-level cover URL: set via "album edit → Guardar" without "Apply to All".
      // Stored on the folder's own metadata record (id === folderId) so it doesn't
      // pollute individual songs' thumbnailUrl and is immune to soft-scan overwrites.
      if (!m.folderId && _isStableCoverUrl(m.coverUrl)) folderCoverMap.set(m.id, m.coverUrl);
    });

    const folderMap = new Map();
    all.forEach(m => {
      // Only folderId is required to group a song under a folder.
      // album is NOT required here — songs without album tags still contribute
      // to artistCounts so that forceType:'collection' and the >3-artist rule
      // work even for folders whose songs haven't been fully scanned yet.
      if (!m.folderId) return;
      const album  = (m.album  || '').trim();
      const artist = (m.artist || '').split(';')[0].trim();
      if (!folderMap.has(m.folderId)) {
        folderMap.set(m.folderId, {
          folderId:       m.folderId,
          albumCounts:    new Map(),
          artistCounts:   new Map(),
          yearCounts:     new Map(),
          formatCounts:   new Map(),
          coverUrlCounts: new Map(),
          coverUrlList:   [],
          blobId:         null, // fileId of first song with coverBlob (blob loaded on demand)
          taggedCount:    0,
          hasManual:      false,
        });
      }
      const f = folderMap.get(m.folderId);
      f.taggedCount++;
      if (album) f.albumCounts.set(album, (f.albumCounts.get(album) || 0) + 1); // only when tagged
      if (artist) f.artistCounts.set(artist, (f.artistCounts.get(artist) || 0) + 1);
      if (m.year) f.yearCounts.set(m.year,   (f.yearCounts.get(m.year)   || 0) + 1);
      const fmt = _formatLabel(m.mimeType, m.name);
      if (fmt) f.formatCounts.set(fmt, (f.formatCounts.get(fmt) || 0) + 1);
      if (_isStableCoverUrl(m.thumbnailUrl)) {
        f.coverUrlCounts.set(m.thumbnailUrl, (f.coverUrlCounts.get(m.thumbnailUrl) || 0) + 1);
        if (!f.coverUrlList.includes(m.thumbnailUrl) && f.coverUrlList.length < 4) {
          f.coverUrlList.push(m.thumbnailUrl);
        }
      }
      if (!f.blobId && m.hasCoverBlob) f.blobId = m.id; // candidate for async blob cover
      if ((m.manualAt || 0) > 0) f.hasManual = true;
    });

    return { all, folderMap, folderSongCount, rescannedMap, savedColMap, folderNameMap, folderCoverMap };
  }

  /** Rebuild the in-memory cache of collection folder IDs (fire-and-forget). */
  async function _refreshCollectionCache() {
    try {
      const { folderMap, folderSongCount, savedColMap } = await _buildFolderMap();
      const ids = new Set();
      folderMap.forEach(f => { if (_isCollectionFolder(f, savedColMap)) ids.add(f.folderId); });

      // Detect new collection IDs that weren't in the previous cache.
      // This happens when the user browses a folder and enrichment fills in
      // artist tags — the folder now qualifies as a collection but the
      // Collections tab was never told.
      const prevCache = _collectionFolderIdsCache;
      const hasNewCollections = prevCache !== null &&
        [...ids].some(id => !prevCache.has(id));

      _collectionFolderIdsCache = ids;
      _allKnownFolderIdsCache   = new Set(folderSongCount.keys());
      _folderSongCountCache     = folderSongCount;

      // Auto-refresh the Collections tab if it's currently visible and
      // new collections just appeared (without the user having to re-click the tab).
      if (hasNewCollections && _currentLibTab === 'collections' && !_libInDetail) {
        _loadCollections();
      }
    } catch (_) {}
  }

  async function _loadCollections() {
    if (_libInDetail) return;
    try {
      const { folderMap, folderSongCount, rescannedMap, savedColMap, folderNameMap } = await _buildFolderMap();
      if (_libInDetail) return; // re-check after async gap — onCollectionClick may have set this

      const _top = map => map.size > 0
        ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : null;

      const colIds     = new Set();
      const collections = [];
      folderMap.forEach((f, folderId) => {
        if (!_isCollectionFolder(f, savedColMap)) return;
        colIds.add(folderId);
        const saved   = savedColMap.get(folderId) || {};
        // Name: only use the saved name when the user explicitly edited it (manualAt > 0).
        // Default is always the Drive folder name so renames in Drive are reflected automatically.
        const name    = (saved.manualAt && saved.name)
                      ? saved.name
                      : folderNameMap.get(folderId) || _top(f.albumCounts) || folderId;
        const format  = _top(f.formatCounts) || null;
        const songCount   = Math.max(f.taggedCount, folderSongCount.get(folderId) || 0);
        const rescannedAt = rescannedMap.get(folderId) || null;
        // hasManual: true when user manually edited name/cover in the collection modal
        // OR when any song in the folder has manual edits.
        const hasManual   = !!(saved.manualAt) || f.hasManual || false;
        const manualCoverUrl = saved.coverUrl || null;
        const mosaicUrls     = f.coverUrlList.slice(0, 4);
        // blobUrl is intentionally null here — injected async after render to avoid
        // stalling the grid on megabytes of IndexedDB blob data.
        const blobId = (!manualCoverUrl && mosaicUrls.length === 0) ? (f.blobId || null) : null;
        collections.push({ folderId, name, manualCoverUrl, mosaicUrls, blobUrl: null, blobId,
          songCount, format, rescannedAt, hasManual,
          artistCount: f.artistCounts.size });
      });

      // Also include forceType:'collection' folders saved in DB that didn't appear
      // in folderMap (e.g. folder was moved via context-menu before its songs had folderId set)
      savedColMap.forEach((saved, folderId) => {
        if (saved.forceType !== 'collection') return;
        if (colIds.has(folderId)) return; // already included via folderMap
        colIds.add(folderId);
        const name         = saved.name || folderNameMap.get(folderId) || folderId;
        const songCount    = folderSongCount.get(folderId) || 0;
        const rescannedAt  = rescannedMap.get(folderId) || null;
        const hasManual    = !!(saved.manualAt);
        const manualCoverUrl = saved.coverUrl || null;
        collections.push({ folderId, name, manualCoverUrl, mosaicUrls: [], blobUrl: null,
          songCount, format: null, rescannedAt, hasManual, artistCount: 0 });
      });

      // Update global cache
      _collectionFolderIdsCache = colIds;
      _allKnownFolderIdsCache   = new Set(folderSongCount.keys());

      collections.sort((a, b) => a.name.localeCompare(b.name));
      _setLibTabCount('collections', collections.length);
      UI.renderCollections(collections);
      _domFilterLibItems();
      // Async-inject blob covers after the grid is painted (avoids pre-render stall)
      _patchGridBlobCovers(collections).catch(() => {});
    } catch (err) {
      console.error('[App] Load collections error:', err);
    }
  }

  /** Drill into a collection's detail view. */
  async function onCollectionClick(collection) {
    const libPane = _libDetailPane();
    if (libPane) _libScrollBeforeDetail = libPane.scrollTop;
    try {
      const all   = await DB.getAllMeta();
      const songs = all.filter(m => m.folderId === collection.folderId);

      // Backfill every visual field that callers (context menus, onGoToAlbum,
      // onGoToLibraryCollection) don't supply — they only pass { folderId, name }.
      const folderId  = collection.folderId;
      const folderRec = all.find(m => m.id === folderId);
      const savedCol  = await DB.getCollection(folderId).catch(() => null) || {};

      if (collection.mosaicUrls === undefined || collection.manualCoverUrl === undefined) {
        // Build mosaic from stable thumbnail URLs stored in DB (same logic as _loadCollections)
        const seenUrls  = new Set();
        const mosaicUrls = [];
        for (const m of songs) {
          if (mosaicUrls.length >= 4) break;
          if (_isStableCoverUrl(m.thumbnailUrl) && !seenUrls.has(m.thumbnailUrl)) {
            seenUrls.add(m.thumbnailUrl);
            mosaicUrls.push(m.thumbnailUrl);
          }
        }
        // Blob fallback: first song with a cover blob (for the header art)
        let blobUrl = null;
        if (mosaicUrls.length === 0 && !savedCol.coverUrl && typeof Meta !== 'undefined') {
          const withBlob = songs.find(m => m.coverBlob);
          if (withBlob) blobUrl = Meta.injectCover(withBlob.id, withBlob.coverBlob) || null;
        }

        // Count distinct artists for the subtitle
        const artistSet = new Set(songs.map(m => m.artist).filter(Boolean));

        // Compute format badge from song mimeTypes (same logic as _buildFolderMap)
        const fmtCounts = new Map();
        songs.forEach(m => {
          const fmt = _formatLabel(m.mimeType, m.name);
          if (fmt) fmtCounts.set(fmt, (fmtCounts.get(fmt) || 0) + 1);
        });
        const computedFormat = fmtCounts.size > 0
          ? [...fmtCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
          : null;

        collection = {
          ...collection,
          manualCoverUrl: savedCol.coverUrl || null,
          mosaicUrls,
          blobUrl,
          artistCount:    collection.artistCount ?? artistSet.size,
          format:         collection.format      ?? computedFormat,
          rescannedAt:    collection.rescannedAt ?? (folderRec?.rescannedAt || null),
          hasManual:      collection.hasManual   ?? (!!(savedCol.manualAt) || songs.some(m => (m.manualAt || 0) > 0)),
        };
      } else if (collection.rescannedAt === undefined || collection.hasManual === undefined) {
        // Minimal backfill when cover fields were already provided
        collection = {
          ...collection,
          rescannedAt: collection.rescannedAt ?? (folderRec?.rescannedAt || null),
          hasManual:   collection.hasManual   ?? (!!(savedCol.manualAt) || songs.some(m => (m.manualAt || 0) > 0)),
        };
      }

      const toMap = m => {
        const cached = _itemCache.get(m.id);
        const durSec = m.durationSec > 0 ? m.durationSec
                     : (cached?.durationMs > 0 ? cached.durationMs / 1000 : 0);
        return {
          id:           m.id,
          name:         m.name        || m.id,
          displayName:  m.displayName || m.name || m.id,
          artist:       m.artist      || '',
          album:        m.album       || '',
          year:         m.year        || '',
          track:        m.track       || '',
          thumbnailUrl: m.thumbnailUrl || m.coverUrl || null,
          folderId:     m.folderId    || null,
          durationSec:  durSec,
          size:         m.size        || cached?.size || 0,
        };
      };

      const sorted = songs.map(toMap).sort((a, b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name)
      );
      const enriched = await Promise.all(sorted.map(async s => {
        const url = await _resolveCoverUrl(s.id, s.thumbnailUrl);
        return url ? { ...s, thumbnailUrl: url } : s;
      }));

      _libInDetail        = true;
      _libDetailRestoreFn = () => onCollectionClick(collection);
      _setLibSearchBarVisible(false);
      UI.renderLibraryCollectionDetail(collection, enriched);
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
      _scrollDetailToTop();
      if (enriched.length > 0 && Auth.getValidToken()) {
        _prefetchAndApplyFolderCovers(collection.folderId, enriched).catch(() => {});
      }
    } catch (err) {
      console.error('[App] onCollectionClick error:', err);
    }
  }

  /** Play all songs in a collection (same mechanism as onAlbumPlay). */
  async function onCollectionPlay(collection) {
    try {
      const all   = await DB.getAllMeta();
      const songs = all.filter(m => m.folderId === collection.folderId)
        .map(m => ({ id: m.id, name: m.name, displayName: m.displayName || m.name,
          artist: m.artist || '', thumbnailUrl: m.thumbnailUrl || null, folderId: m.folderId }));
      if (songs.length) Player.setQueue(songs, 0);
    } catch (err) { console.error('[App] onCollectionPlay error:', err); }
  }

  /** Queue all songs in a collection (same mechanism as onAlbumQueue). */
  async function onCollectionQueue(collection, mode = 'end') {
    try {
      const all   = await DB.getAllMeta();
      const songs = all.filter(m => m.folderId === collection.folderId)
        .map(m => ({ id: m.id, name: m.name, displayName: m.displayName || m.name,
          artist: m.artist || '', thumbnailUrl: m.thumbnailUrl || null, folderId: m.folderId }));
      if (!songs.length) return;
      if (mode === 'next') songs.forEach(s => Player.insertNext(s));
      else                 songs.forEach(s => Player.appendToQueue(s));
    } catch (err) { console.error('[App] onCollectionQueue error:', err); }
  }

  /**
   * Force-move a folder to albums (even if it has >3 artists).
   * Saves forceType:'album', patches the in-memory cache in-place, and
   * immediately updates the browse chip without requiring a re-render.
   */
  async function onMoveToAlbums(item) {
    const folderId = item.folderId || item.id;
    if (!folderId) return;
    await DB.saveCollection(folderId, { forceType: 'album' });
    // Patch cache in-place (no full null-invalidation needed for type changes)
    _collectionFolderIdsCache?.delete(folderId);
    // Immediately update the chip in the current browse view
    UI.updateBrowseFolderChip?.(folderId, 'album');
    if (_currentLibTab === 'collections') _loadCollections();
    if (_currentLibTab === 'albums')      _loadAlbums();
    UI.showToast?.(UI.t('toast_moved_to_albums'), 'success');
  }

  /**
   * Force-move a folder to collections (even if it has ≤3 artists).
   * Saves forceType:'collection', patches the in-memory cache in-place, and
   * immediately updates the browse chip without requiring a re-render.
   */
  async function onMoveToCollections(item) {
    const folderId = item.folderId || item.id;
    if (!folderId) return;
    await DB.saveCollection(folderId, { forceType: 'collection' });
    // Patch cache in-place
    if (_collectionFolderIdsCache) _collectionFolderIdsCache.add(folderId);
    // Immediately update the chip in the current browse view
    UI.updateBrowseFolderChip?.(folderId, 'collection');
    if (_currentLibTab === 'collections') _loadCollections();
    if (_currentLibTab === 'albums')      _loadAlbums();
    UI.showToast?.(UI.t('toast_moved_to_collections'), 'success');
  }

  /** Open the collection edit modal for a given collection. */
  function _openCollectionEditModal(collection) {
    const modal  = document.getElementById('collection-edit-modal');
    const nameIn = document.getElementById('collection-edit-name');
    const covIn  = document.getElementById('collection-edit-cover');
    if (!modal || !nameIn || !covIn) return;
    nameIn.value = collection.name           || '';
    covIn.value  = collection.manualCoverUrl || '';
    modal.dataset.folderId = collection.folderId;
    modal.style.display = '';
  }

  /** Close the collection edit modal. */
  function _closeCollectionEditModal() {
    const modal = document.getElementById('collection-edit-modal');
    if (modal) { modal.style.display = 'none'; modal.dataset.folderId = ''; }
  }

  async function _loadAlbums() {
    if (_libInDetail) return; // don't replace a drill-down view
    try {
      const { folderMap, folderSongCount, rescannedMap, savedColMap, folderCoverMap } = await _buildFolderMap();

      const _top = map => map.size > 0
        ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : null;

      // Build cache while we have the data
      const colIds = new Set();
      folderMap.forEach(f => { if (_isCollectionFolder(f, savedColMap)) colIds.add(f.folderId); });
      _collectionFolderIdsCache = colIds;
      _allKnownFolderIdsCache   = new Set(folderSongCount.keys());

      const albums = Array.from(folderMap.values())
        .filter(f => !_isCollectionFolder(f, savedColMap) && f.albumCounts.size > 0) // collections excluded; require ≥1 album-tagged song for a valid album name
        .map(f => {
          const name      = _top(f.albumCounts);
          const artist    = _top(f.artistCounts) || '';
          const artists   = [...f.artistCounts.keys()].join(' ');
          const year      = _top(f.yearCounts);
          const format    = _top(f.formatCounts) || null;
          const songCount = Math.max(f.taggedCount, folderSongCount.get(f.folderId) || 0);
          // Folder-level cover takes priority: set via album-edit "Guardar" without "Apply to All".
          // Falls back to the most common external thumbnailUrl across songs.
          const coverUrl  = folderCoverMap.get(f.folderId) || _top(f.coverUrlCounts) || null;
          // blobId passed for async cover injection after render (no sync blob load here)
          const blobId    = !coverUrl ? (f.blobId || null) : null;
          const rescannedAt = rescannedMap.get(f.folderId) || null;
          return { name, artist, artists, songCount, coverUrl, year, format,
            folderId: f.folderId, rescannedAt, hasManual: f.hasManual, blobId };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      _libAllAlbums = albums;
      _renderAlbumPage(true);
    } catch (err) {
      console.error('[App] Load albums error:', err);
    }
  }

  /**
   * Show albums for a given artist (drill-down from artist grid).
   */
  async function onArtistClick(artist) {
    // Save scroll position before drilling into artist detail
    const libPane = _libDetailPane();
    if (libPane) _libScrollBeforeDetail = libPane.scrollTop;
    try {
      const all = await DB.getAllMeta();
      const artistKey = artist.name.toLowerCase();

      const folderSongCount = new Map();
      all.forEach(m => { if (m.folderId) folderSongCount.set(m.folderId, (folderSongCount.get(m.folderId) || 0) + 1); });

      // rescannedAt per folder (folder's own DB record where id === folderId)
      const rescannedMap = new Map();
      all.forEach(m => { if (m.rescannedAt) rescannedMap.set(m.id, m.rescannedAt); });

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
            hasManual:    false,
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
        if ((m.manualAt || 0) > 0) f.hasManual = true;
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
          const rescannedAt = rescannedMap.get(f.folderId) || null;
          return { name, artist: artist.name, songCount, coverUrl: f.coverUrl, year, format, folderId: f.folderId, rescannedAt, hasManual: f.hasManual };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      _libInDetail        = true;
      _libDetailRestoreFn = () => onArtistClick(artist);
      _setLibSearchBarVisible(false);
      UI.renderLibraryArtistDetail(artist, albums);
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
      _scrollDetailToTop();
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
    // Save scroll position before drilling into album detail
    const libPane = _libDetailPane();
    if (libPane) _libScrollBeforeDetail = libPane.scrollTop;
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

      const toMap = m => {
        // _itemCache holds Drive API objects (with durationMs) for any file
        // that was browsed or played in this session — use as live fallback.
        const cached = _itemCache.get(m.id);
        const durSec = m.durationSec > 0 ? m.durationSec
                     : (cached?.durationMs > 0 ? cached.durationMs / 1000 : 0);
        return {
          id:           m.id,
          name:         m.name         || m.id,
          displayName:  m.displayName  || m.name || m.id,
          artist:       m.artist       || '',
          album:        m.album        || '',
          year:         m.year         || '',
          track:        m.track        || '',
          thumbnailUrl: m.thumbnailUrl || m.coverUrl || null,
          folderId:     m.folderId     || null,
          durationSec:  durSec,
          size:         m.size         || cached?.size || 0,
        };
      };

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

      // ── Build a fresh album descriptor from the actual DB songs ──────────────
      // The `album` object from _libAllAlbums may be stale (built before the most
      // recent rescan). Reading directly from the loaded songs ensures the header
      // always shows current name / artist / year / cover, regardless of whether
      // _loadAlbums() was called after the last enrichment pass.
      const _topEntry = map => map.size > 0
        ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : null;
      const freshYearCounts   = new Map();
      const freshAlbumCounts  = new Map();
      const freshArtistCounts = new Map();
      let freshCoverUrl = null;
      for (const m of songs) {
        if (m.year)   freshYearCounts.set(m.year,   (freshYearCounts.get(m.year)   || 0) + 1);
        if (m.album)  freshAlbumCounts.set(m.album,  (freshAlbumCounts.get(m.album)  || 0) + 1);
        if (m.artist) freshArtistCounts.set(m.artist, (freshArtistCounts.get(m.artist) || 0) + 1);
        if (!freshCoverUrl && _isStableCoverUrl(m.thumbnailUrl)) freshCoverUrl = m.thumbnailUrl;
        if (!freshCoverUrl && m.coverBlob && typeof Meta !== 'undefined') {
          freshCoverUrl = Meta.injectCover(m.id, m.coverBlob) || null;
        }
      }
      // Prefer resolved cover from enriched songs (already went through _resolveCoverUrl)
      if (!freshCoverUrl) {
        for (const s of enriched) {
          if (s.thumbnailUrl) { freshCoverUrl = s.thumbnailUrl; break; }
        }
      }
      // Rescan/manual flags for dot-legend in album detail
      const _albumFolderId  = enriched.find(s => s.folderId)?.folderId || album.folderId || null;
      const _folderMetaRec  = _albumFolderId ? all.find(m => m.id === _albumFolderId) : null;
      const _albumHasManual = songs.some(s => (s.manualAt || 0) > 0);

      // Folder-level cover takes priority over any individual song cover.
      // This is set via "album edit → Guardar" (without "Apply to All") and stored
      // on the folder's own metadata record so it's immune to soft-scan overwrites.
      if (!freshCoverUrl && _isStableCoverUrl(_folderMetaRec?.coverUrl)) {
        freshCoverUrl = _folderMetaRec.coverUrl;
      }

      const freshAlbum = {
        ...album,
        name:        _topEntry(freshAlbumCounts)  || album.name     || '',
        artist:      _topEntry(freshArtistCounts) || album.artist   || '',
        year:        _topEntry(freshYearCounts)   || album.year     || null,
        coverUrl:    freshCoverUrl                || album.coverUrl || null,
        rescannedAt: _folderMetaRec?.rescannedAt  || null,
        hasManual:   _albumHasManual,
      };

      const backTarget = fromArtist ? 'artist' : 'albums';
      _libInDetail        = true;
      _libDetailRestoreFn = () => onAlbumClick(album, fromArtist);
      _setLibSearchBarVisible(false);
      UI.renderLibraryAlbumDetail(freshAlbum, enriched, backTarget, fromArtist || null);
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
      _scrollDetailToTop();

      // If a song from this album is already playing, paint its duration immediately.
      // Paint duration immediately if a song is already playing.
      // _onDurationReady already saved+painted when loadedmetadata fired,
      // but the album may have been opened after that — re-paint from the player.
      const nowPlaying = Player.getCurrentTrack();
      if (nowPlaying) {
        const dur = Player.getDuration();
        if (isFinite(dur) && dur > 0) {
          UI.updateLibrarySongDuration(nowPlaying.id, dur);
        }
      }

      // Background cover + metadata enrichment for songs in this album.
      // Uses the same multi-pass pipeline as the browse folder view:
      // DB → ID3 blob parse → Last.fm → folder cover.jpg
      // _updateRowThumbnail now targets both .song-row and .top-list-item rows.
      if (enriched.length > 0 && Auth.getValidToken()) {
        const folderId = enriched.find(s => s.folderId)?.folderId || null;
        _prefetchAndApplyFolderCovers(folderId, enriched).catch(() => {});
      }

      // Duration is captured from the audio element when each song plays (_onProgress).
      // No Drive API durationMs fallback — it is unreliable for audio files.
    } catch (err) {
      console.error('[App] onAlbumClick error:', err);
    }
  }

  /**
   * Save manual album-level edits from the detail view header.
   * Writes artist / album / year / thumbnailUrl to every track in the album.
   *
   * @param {string}   folderId — canonical folder ID for the album
   * @param {{artist:string, album:string, year:string, coverUrl:string}} patch
   * @param {string[]} [songIds] — explicit list of song IDs shown in the album view.
   *   When provided, ALL these IDs are updated regardless of their stored folderId.
   *   This is essential because some tracks may have a null or different folderId in
   *   the DB (e.g. added before Deep Scan ran), and a pure folderId filter would miss them.
   *   Falls back to folderId-only filter when songIds is not passed (legacy callers).
   */
  /**
   * @param {string}        folderId
   * @param {Object}        patch        - { artist, album, year, coverUrl }
   * @param {string[]|null} songIds      - explicit song ID list (preferred over folderId-only filter)
   * @param {Object}        options
   * @param {boolean}       [options.applyCoverToAll=false]
   *   When true, the coverUrl is also written to every song's individual thumbnailUrl.
   *   When false (default), coverUrl is stored only as a folder-level cover on the
   *   folder's own metadata record — it shows in the album header and library card
   *   but does NOT overwrite individual songs' thumbnails (important: embedded ID3
   *   covers would silently ignore an external thumbnailUrl anyway, so this separation
   *   makes the intended behaviour explicit and avoids confusing soft-scan overwrites).
   */
  async function onAlbumEdit(folderId, patch, songIds = null, options = {}) {
    if (!folderId && !songIds?.length) throw new Error('folderId or songIds required');
    const all  = await DB.getAllMeta();
    let songs;
    if (songIds?.length) {
      // Prefer the explicit ID list — covers every track currently visible in the album,
      // even those whose DB record lacks folderId.
      const idSet = new Set(songIds);
      songs = all.filter(m => idSet.has(m.id));
      // Also pick up any additional tracks in the same folder that somehow weren't in
      // the view (e.g. added mid-session) so the folder stays consistent.
      if (folderId) {
        const extra = all.filter(m => m.folderId === folderId && !idSet.has(m.id));
        songs = [...songs, ...extra];
      }
    } else {
      songs = all.filter(m => m.folderId === folderId);
    }
    if (songs.length === 0) throw new Error('No songs found for album');

    const manualAt  = Date.now();
    // Guard: reject blob: Object URLs (ephemeral) and the 'id3' sentinel (not a real URL)
    const newCoverUrl = (patch.coverUrl &&
                         !patch.coverUrl.startsWith('blob:') &&
                         patch.coverUrl !== 'id3') ? patch.coverUrl : null;

    // ── Folder-level cover (always) ───────────────────────────────────────────
    // Store coverUrl on the folder's own metadata record (id === folderId).
    // This is the "album header cover" — shown in the album detail header and
    // library grid card, immune to soft-scan overwrites on individual songs.
    if (newCoverUrl && folderId) {
      await DB.setMeta(folderId, { coverUrl: newCoverUrl, manualAt }).catch(() => {});
    }

    // ── Individual songs ──────────────────────────────────────────────────────
    for (const m of songs) {
      const update = { folderId, manualAt };
      if (patch.artist)  update.artist = patch.artist;
      if (patch.album)   update.album  = patch.album;
      if (patch.year)    update.year   = patch.year;
      // Apply thumbnailUrl to individual songs ONLY when explicitly requested.
      // Without "Apply to All": songs keep their current thumbnailUrl / embedded covers.
      if (newCoverUrl && options.applyCoverToAll) update.thumbnailUrl = newCoverUrl;
      await DB.setMeta(m.id, update);
    }

    // ── Cover caching ─────────────────────────────────────────────────────────
    if (newCoverUrl) {
      if (options.applyCoverToAll) {
        // Cache for every song (offline availability for all covers)
        for (const m of songs) {
          _cacheExternalCover(m.id, newCoverUrl, true).catch(() => {});
        }
      }
      // Always cache on the folder record itself (used for album header / grid card)
      _cacheExternalCover(folderId, newCoverUrl, true).catch(() => {});
    } else {
      // No external URL provided — for songs with embedded art, ensure thumbnailUrl:'id3'
      // is correctly stamped (it may have been corrupted by a previous save of a blob: URL).
      if (typeof Meta !== 'undefined') {
        for (const m of songs) {
          if (m.coverBlob && m.thumbnailUrl !== 'id3') {
            await DB.setMeta(m.id, { thumbnailUrl: 'id3' }).catch(() => {});
            const url = Meta.injectCover(m.id, m.coverBlob);
            if (url) {
              _updateRowThumbnail(m.id, url, true);
            }
          }
        }
      }
    }

    // ── Live update ───────────────────────────────────────────────────────────
    // Propagate text edits to in-memory caches → miniplayer reflects changes instantly.
    // Cover URL: only propagate to individual home-card/queue surfaces if applyCoverToAll,
    // since without it the home items still show their own embedded covers.
    const liveDbPatch = {};
    if (patch.artist)                         liveDbPatch.artist       = patch.artist;
    if (patch.album)                          liveDbPatch.album        = patch.album;
    if (patch.year)                           liveDbPatch.year         = patch.year;
    if (newCoverUrl && options.applyCoverToAll) liveDbPatch.thumbnailUrl = newCoverUrl;
    _liveMetaUpdate(songs.map(m => m.id), liveDbPatch);

    if (typeof Sync !== 'undefined') Sync.push('metadata');
    if (_browseFolderId) _updateBrowseLegend(_browseFolderId);
    _invalidateSuggestionsCache(); // new artist/album names now available as suggestions
    UI.showToast(`${songs.length} ${UI.t('lbl_songs_updated')}`);
  }

  /**
   * Reset a single song's metadata to its raw ID3 values.
   * Parses the file blob (from DB cache or Drive), writes ID3 fields to DB,
   * clears manualAt so future enrichment can run, and updates all live UI surfaces.
   * If the file has an embedded cover (coverBlob), stamps thumbnailUrl:'id3' so the
   * blob takes priority over any stale external URL.
   *
   * @param {string} songId
   */
  async function onSongResetId3(songId) {
    if (!songId) return;

    // Evict session cache so Meta.parse gives a truly fresh parse with coverBlob
    if (typeof Meta !== 'undefined') Meta.revoke(songId);

    let id3 = null;
    // Prefer the already-cached blob in IndexedDB (no network cost)
    let blob = await DB.getCachedBlob(songId).catch(() => null);
    // Fall back to downloading the file head from Drive
    if (!blob && typeof Drive !== 'undefined' && typeof Auth !== 'undefined' && Auth.getValidToken?.()) {
      blob = await Drive.downloadFileHead(songId).catch(() => null);
    }
    if (blob && typeof Meta !== 'undefined') {
      id3 = await Meta.parse(songId, blob).catch(() => null);
    }

    const dbMeta = await DB.getMeta(songId).catch(() => null);

    // Build DB patch — reset enrichment state, then rewrite from ID3 only.
    // Explicitly null every enrichment field so stale Last.fm / AudD values
    // don't survive the reset. auddTried/mbTried cleared so enrichment reruns
    // on next play with fresh identity data. softScannedAt cleared so soft scan
    // can re-read this song in the next folder open.
    const dbPatch = {
      manualAt:     0,
      auddTried:    false,
      mbTried:      false,
      softScannedAt: null,
      // Reset all text — overwritten below if ID3 has them
      displayName:  id3?.title  || null,
      artist:       id3?.artist || null,
      album:        id3?.album  || null,
      year:         id3?.year   || null,
    };

    const freshBlob    = id3?.coverBlob;
    const existingBlob = dbMeta?.coverBlob;
    if (freshBlob) {
      dbPatch.coverBlob    = freshBlob;
      dbPatch.thumbnailUrl = 'id3';
    } else if (existingBlob) {
      dbPatch.thumbnailUrl = 'id3'; // blob already in DB — ensure sentinel is set
    } else {
      dbPatch.thumbnailUrl = null; // no embedded art — clear stale external URL
    }

    await DB.setMeta(songId, dbPatch);

    // Live-update text fields only — thumbnailUrl:'id3' must NOT go through _liveMetaUpdate
    // (it would corrupt the Meta cache coverUrl with the literal string 'id3').
    const livePatch = {};
    if (dbPatch.displayName) livePatch.displayName = dbPatch.displayName;
    if (dbPatch.artist)      livePatch.artist      = dbPatch.artist;
    if (dbPatch.album)       livePatch.album       = dbPatch.album;
    if (dbPatch.year)        livePatch.year        = dbPatch.year;
    if (Object.keys(livePatch).length) _liveMetaUpdate([songId], livePatch);

    // Update cover in all visible surfaces
    const blobToUse = freshBlob || existingBlob;
    let coverUrl = null; // hoisted so the player-update block below can read it
    if (blobToUse && typeof Meta !== 'undefined') {
      // Meta.parse already injected coverUrl into cache if blob was freshly parsed;
      // otherwise injectCover creates the Object URL now.
      coverUrl = id3?.coverUrl;
      if (!coverUrl) coverUrl = Meta.injectCover(songId, blobToUse);
      if (coverUrl) {
        _updateRowThumbnail(songId, coverUrl, true);
        _updateHomeCardThumbnail(songId, coverUrl, true);
        Player.patchQueueItem?.(songId, { thumbnailUrl: coverUrl });
      }
    }

    // Meta.revoke() above destroyed the Object URL the player's <img> was using,
    // causing the cover to go blank immediately. If this song is still playing,
    // push the new coverUrl (or null when there is no embedded art) directly to
    // the player UI now so it never flickers blank.
    {
      const _ct = Player.getCurrentTrack?.();
      if (_ct?.id === songId) {
        const _ep = {
          ..._ct,
          ...(dbPatch.displayName ? { displayName: dbPatch.displayName } : {}),
          ...(dbPatch.artist      ? { artist:      dbPatch.artist }      : {}),
          ...(dbPatch.album       ? { albumName:   dbPatch.album }       : {}),
          ...(dbPatch.year        ? { year:        dbPatch.year }        : {}),
          thumbnailUrl: coverUrl,
        };
        UI.updateMiniPlayer?.(_ep, Player.isPlaying());
        UI.updateExpandedPlayer?.(_ep, Player.isPlaying());
      }
    }

    _invalidateSuggestionsCache();
    if (typeof Sync !== 'undefined') Sync.push('metadata');
    if (_browseFolderId) _updateBrowseLegend(_browseFolderId);
  }

  /**
   * Reset metadata of all songs in an album or collection to their raw ID3 values.
   * Mirrors onSongResetId3 exactly, but applied to every song in the album.
   * For each song: revokes session cache, downloads blob from DB cache or Drive,
   * does a fresh Meta.parse, writes all ID3 fields + cover to DB, and updates
   * every live UI surface (browse row, home card, player if currently playing).
   * Songs are processed in small batches to avoid blocking for large albums.
   *
   * @param {string}   folderId
   * @param {string[]} [songIds] — explicit list from the current album/collection view
   */
  async function onAlbumResetId3(folderId, songIds) {
    if (!folderId && !songIds?.length) throw new Error('folderId or songIds required');

    const all = await DB.getAllMeta();
    let songs;
    if (songIds?.length) {
      const idSet = new Set(songIds);
      songs = all.filter(m => idSet.has(m.id));
      if (folderId) {
        const extra = all.filter(m => m.folderId === folderId && !idSet.has(m.id));
        songs = [...songs, ...extra];
      }
    } else {
      songs = all.filter(m => m.folderId === folderId);
    }
    if (songs.length === 0) throw new Error('No songs found');

    const hasToken = typeof Auth !== 'undefined' && Auth.getValidToken?.();
    const canDrive = typeof Drive !== 'undefined' && hasToken;

    // Process songs in batches of 3 to avoid blocking on large albums
    const BATCH = 3;
    for (let i = 0; i < songs.length; i += BATCH) {
      const batch = songs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (m) => {

        // 1. Evict session cache so Meta.parse gives a truly fresh parse with coverBlob
        if (typeof Meta !== 'undefined') Meta.revoke(m.id);

        // 2. Get the raw audio blob — prefer already-cached, fall back to Drive download
        let blob = await DB.getCachedBlob(m.id).catch(() => null);
        if (!blob && canDrive) {
          blob = await Drive.downloadFileHead(m.id).catch(() => null);
        }

        // 3. Fresh ID3 parse (coverBlob is only returned by a live parse, not from Meta cache)
        let id3 = null;
        if (blob && typeof Meta !== 'undefined') {
          id3 = await Meta.parse(m.id, blob).catch(() => null);
        }

        // 4. Build DB patch — same shape as onSongResetId3
        const dbPatch = {
          manualAt:      0,
          auddTried:     false,
          mbTried:       false,
          softScannedAt: null,
          displayName:   id3?.title  || null,
          artist:        id3?.artist || null,
          album:         id3?.album  || null,
          year:          id3?.year   || null,
        };

        const freshBlob    = id3?.coverBlob;
        const existingBlob = m.coverBlob;
        if (freshBlob) {
          dbPatch.coverBlob    = freshBlob;
          dbPatch.thumbnailUrl = 'id3';
        } else if (existingBlob) {
          dbPatch.thumbnailUrl = 'id3'; // blob already in DB — ensure sentinel is set
        } else {
          dbPatch.thumbnailUrl = null; // no embedded art — clear stale external URL
        }

        await DB.setMeta(m.id, dbPatch).catch(() => {});

        // 5. Live-update text fields (thumbnailUrl:'id3' must NOT go through _liveMetaUpdate)
        const livePatch = {};
        if (dbPatch.displayName) livePatch.displayName = dbPatch.displayName;
        if (dbPatch.artist)      livePatch.artist      = dbPatch.artist;
        if (dbPatch.album)       livePatch.album       = dbPatch.album;
        if (dbPatch.year)        livePatch.year        = dbPatch.year;
        if (Object.keys(livePatch).length) _liveMetaUpdate([m.id], livePatch);

        // 6. Update cover in all visible surfaces
        const blobToUse = freshBlob || existingBlob;
        let coverUrl = null;
        if (blobToUse && typeof Meta !== 'undefined') {
          coverUrl = id3?.coverUrl;
          if (!coverUrl) coverUrl = Meta.injectCover(m.id, blobToUse);
          if (coverUrl) {
            _updateRowThumbnail(m.id, coverUrl, true);
            _updateHomeCardThumbnail(m.id, coverUrl, true);
            Player.patchQueueItem?.(m.id, { thumbnailUrl: coverUrl });
          }
        }

        // 7. If this song is currently playing, refresh mini/expanded player immediately
        const _ct = Player.getCurrentTrack?.();
        if (_ct?.id === m.id) {
          const _ep = {
            ..._ct,
            ...(dbPatch.displayName ? { displayName: dbPatch.displayName } : {}),
            ...(dbPatch.artist      ? { artist:      dbPatch.artist }      : {}),
            ...(dbPatch.album       ? { albumName:   dbPatch.album }       : {}),
            ...(dbPatch.year        ? { year:        dbPatch.year }        : {}),
            thumbnailUrl: coverUrl,
          };
          UI.updateMiniPlayer?.(_ep, Player.isPlaying());
          UI.updateExpandedPlayer?.(_ep, Player.isPlaying());
        }
      }));
    }

    _invalidateSuggestionsCache();
    if (typeof Sync !== 'undefined') Sync.push('metadata');
    if (_browseFolderId) _updateBrowseLegend(_browseFolderId);
    UI.showToast?.(`${songs.length} ${UI.t('toast_reset_id3_done')}`);
  }

  /**
   * Save individual song metadata edits (from the song-edit modal).
   * Writes all changed fields to DB, updates every in-memory layer and
   * visible UI surface immediately — no reload required.
   *
   * @param {string} songId
   * @param {{displayName?:string, artist?:string, album?:string, year?:string, coverUrl?:string}} patch
   */
  async function onSongEdit(songId, patch) {
    if (!songId) throw new Error('songId required');

    const dbPatch = { manualAt: Date.now() };
    if (patch.displayName) dbPatch.displayName  = patch.displayName;
    if (patch.artist)      dbPatch.artist       = patch.artist;
    if (patch.album)       dbPatch.album        = patch.album;
    if (patch.year)        dbPatch.year         = patch.year;

    // Cover URL — store as thumbnailUrl; also cache the blob for offline use
    const newCoverUrl = patch.coverUrl && !patch.coverUrl.startsWith('blob:')
      ? patch.coverUrl : null;
    if (newCoverUrl) {
      dbPatch.thumbnailUrl = newCoverUrl;
      _cacheExternalCover(songId, newCoverUrl, true).catch(() => {});
    }

    await DB.setMeta(songId, dbPatch);

    // Propagate to Meta cache + player queue + all visible surfaces
    _liveMetaUpdate([songId], dbPatch);

    // Also patch Meta cache title field (liveMetaUpdate uses 'displayName' → 'title')
    if (patch.displayName && typeof Meta !== 'undefined') {
      Meta.forcePatch(songId, { title: patch.displayName });
    }

    _invalidateSuggestionsCache();
    if (typeof Sync !== 'undefined') Sync.push('metadata');
    if (_browseFolderId) _updateBrowseLegend(_browseFolderId);

    // Refresh home if visible so recents/top-played cards show updated info
    if (UI.getCurrentView() === 'home') _loadHomeData().catch(() => {});
  }

  /**
   * Rename a single track's display name (from the album detail inline editor).
   * Writes to DB, patches in-memory caches, and syncs.
   * @param {string} songId
   * @param {string} newName
   */
  async function onTrackRename(songId, newName) {
    if (!songId || !newName?.trim()) return;
    const name = newName.trim();
    await DB.setMeta(songId, { displayName: name, manualAt: Date.now() });
    _liveMetaUpdate([songId], { displayName: name });
    if (typeof Sync !== 'undefined') Sync.push('metadata');
    if (_browseFolderId) _updateBrowseLegend(_browseFolderId);
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
      // Stamp last-played timestamp so the home screen keeps recent playlists first
      if (pl.id) DB.updatePlaylist(pl.id, { lastPlayedAt: Date.now() }).catch(() => {});
      if (songIds.length === 0) {
        UI.renderPlaylistDetail([], pl.name);
        UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
        if (!document.getElementById('lib-pl-two-col')) {
          _libInDetail        = true;
          _libDetailRestoreFn = () => onPlaylistClick(fullPl || pl);
        }
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
      UI.setActiveSongRow(Player.getCurrentTrack()?.id ?? null);
      // Single-pane mode (mobile): detail takes over the content area — mark as
      // drill-down so nav Home → Library restores this playlist view.
      if (!document.getElementById('lib-pl-two-col')) {
        _libInDetail        = true;
        _libDetailRestoreFn = () => onPlaylistClick(fullPl || pl);
      }
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
    // Queue open (mobile)? → close it to reveal the now-playing view
    if (UI.isQueuePanelVisible?.() && !window.matchMedia('(min-width: 768px)').matches) {
      UI.showQueuePanel(false);
      return;
    }
    // Make the player visible FIRST so _applyMarquee can measure the container width.
    // Calling updateExpandedPlayer while display:none causes clientWidth/scrollWidth = 0,
    // which breaks the marquee measurement even with rAF retries.
    UI.setExpandedPlayerVisible(true);
    const dur = Player.getDuration();
    const cur = Player.getCurrentTime?.() || 0;
    UI.updateExpandedPlayerProgress(cur, dur);
    UI.updateExpandedPlayer(_enrichTrack(track), Player.isPlaying());
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

  /* ── Album context-menu actions (Library) ───────────────── */

  /**
   * Resolve album songs from DB (by folderId), sorted by track then name.
   * @param {Object} album — { folderId, name, artist }
   * @returns {Promise<Object[]>} playable song items
   */
  async function _resolveAlbumSongs(album) {
    const all = await DB.getAllMeta();
    const songs = album.folderId
      ? all.filter(m => m.folderId === album.folderId)
      : all.filter(m => (m.album || '').toLowerCase() === (album.name || '').toLowerCase());
    return songs
      .map(m => ({
        id:          m.id,
        name:        m.name        || m.id,
        displayName: m.displayName || m.name || m.id,
        artist:      m.artist      || '',
        album:       m.album       || album.name || '',
        year:        m.year        || '',
        track:       m.track       || '',
        thumbnailUrl:m.thumbnailUrl || null,
        folderId:    m.folderId    || null,
      }))
      .sort((a, b) => {
        const ta = parseInt(a.track, 10), tb = parseInt(b.track, 10);
        if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
        if (!isNaN(ta)) return -1;
        if (!isNaN(tb)) return  1;
        return (a.displayName || a.name).localeCompare(b.displayName || b.name);
      });
  }

  /** Play all songs in an album immediately. */
  async function onAlbumPlay(album) {
    try {
      const songs = await _resolveAlbumSongs(album);
      if (!songs.length) { UI.showToast(UI.t('toast_folder_no_songs'), 'error'); return; }
      _resetRadio();
      songs.forEach(s => _cacheItem(s));
      Player.setQueue(songs, 0);
      UI.showToast(`▶ ${album.name} · ${songs.length} ${UI.t('songs').toLowerCase()}`);
    } catch (err) {
      UI.showToast(UI.t('toast_folder_error'), 'error');
    }
  }

  /** Insert/append album songs in the queue. mode = 'next' | 'end' */
  async function onAlbumQueue(album, mode) {
    try {
      const songs = await _resolveAlbumSongs(album);
      if (!songs.length) { UI.showToast(UI.t('toast_folder_no_songs'), 'error'); return; }
      songs.forEach(s => _cacheItem(s));
      if (mode === 'next') Player.insertNext(songs);
      else                 Player.appendToQueue(songs);
      UI.showToast(mode === 'next'
        ? `${songs.length} ${UI.t('songs').toLowerCase()} — ${UI.t('play_next').toLowerCase()}`
        : `${songs.length} ${UI.t('songs').toLowerCase()} — ${UI.t('play_after').toLowerCase()}`
      );
    } catch (err) {
      UI.showToast(UI.t('toast_folder_error'), 'error');
    }
  }

  /**
   * "Ir al álbum" — navigate to Library → Albums and open the album detail
   * that contains the given song. Falls back to a toast if the folder cannot
   * be resolved.
   * @param {DriveItem} song
   */
  /**
   * Navigate to the Library screen WITHOUT triggering _setLibTab(_currentLibTab),
   * which would kick off an async load of the current tab and race with the
   * tab we're about to set immediately after (albums / artists).
   */
  function _navToLibrary() {
    if (!window.matchMedia('(min-width: 768px)').matches) {
      UI.setExpandedPlayerVisible(false);
    }
    UI.showView('library');
    UI.updateSearchChipCounts(null);
  }

  async function onGoToAlbum(song) {
    // Resolve the album folder ID using the same priority chain as onGoToFolder
    let folderId = song.parents?.[0] || song.folderId;

    if (!folderId) {
      const dbMeta = await DB.getMeta(song.id).catch(() => null);
      folderId = dbMeta?.folderId;
    }

    if (!folderId) {
      try {
        const fileInfo = await Drive.getFileInfo(song.id);
        folderId = fileInfo.parents?.[0];
      } catch (_) {}
    }

    if (!folderId) {
      UI.showToast(UI.t('toast_folder_unavailable'), 'error');
      return;
    }

    // Route to Collections or Albums depending on the folder's classification.
    // skipLoad=true prevents _loadAlbums/_loadCollections from rendering the full
    // list before onAlbumClick/onCollectionClick immediately replaces it with the
    // detail view — eliminates the visible flash of all albums/collections.
    _navToLibrary();
    if (isFolderCollection(folderId)) {
      const saved = await DB.getCollection(folderId).catch(() => null);
      const meta  = (typeof Meta !== 'undefined') ? Meta.getCached(song.id) : null;
      const collectionName = saved?.name || song.album || meta?.album || '';
      _setLibTab('collections', true);
      onCollectionClick({ folderId, name: collectionName }).catch(err => console.warn('[App] onGoToAlbum→collection:', err));
    } else {
      const meta  = (typeof Meta !== 'undefined') ? Meta.getCached(song.id) : null;
      const descriptor = {
        folderId,
        name:   song.album  || meta?.album  || song.displayName || song.name || '',
        artist: song.artist || meta?.artist || '',
      };
      _setLibTab('albums', true);
      onAlbumClick(descriptor, null).catch(err => console.warn('[App] onGoToAlbum:', err));
    }
  }

  /**
   * "Go to album" from a Browse folder that is classified as an album.
   * Switches to Library → Albums and drills into the album detail.
   * @param {{ id: string, name: string }} folder  — browse folder item
   */
  async function onGoToLibraryAlbum(folder) {
    const folderId = folder.id || folder.folderId;
    if (!folderId) return;
    _navToLibrary();
    _setLibTab('albums', true); // skipLoad — go straight to detail without flashing the list
    onAlbumClick({ folderId, name: folder.name || '' }, null)
      .catch(err => console.warn('[App] onGoToLibraryAlbum:', err));
  }

  /**
   * "Go to collection" from a Browse folder that is classified as a collection.
   * Switches to Library → Collections and drills into the collection detail.
   * @param {{ id: string, name: string }} folder  — browse folder item
   */
  async function onGoToLibraryCollection(folder) {
    const folderId = folder.id || folder.folderId;
    if (!folderId) return;
    _navToLibrary();
    _setLibTab('collections', true); // skipLoad — go straight to detail
    onCollectionClick({ folderId, name: folder.name || '' })
      .catch(err => console.warn('[App] onGoToLibraryCollection:', err));
  }

  /* ── Go to Artist ───────────────────────────────────────────
   * Navigates to Library → Artists tab and drills into the artist.
   * Builds the artist object directly from DB (like _loadArtists does)
   * so it works from any context without waiting for the list to render.
   * ──────────────────────────────────────────────────────────── */

  async function onGoToArtist(song) {
    const rawArtist = (song.artist || '').split(';')[0].trim();
    if (!rawArtist) {
      _navToLibrary();
      _setLibTab('artists');
      return;
    }
    try {
      const artistKey = rawArtist.toLowerCase();
      const all = await DB.getAllMeta();
      let songCount = 0;
      const albumSet = new Set();
      for (const m of all) {
        const name = (m.artist || '').split(';')[0].trim();
        if (name.toLowerCase() === artistKey) {
          songCount++;
          const album = (m.album || '').trim();
          if (album) albumSet.add(album.toLowerCase());
        }
      }
      const storedImages = (await DB.getState('artistImages').catch(() => null)) || {};
      const artist = {
        name:       rawArtist,
        songCount:  songCount || 1,
        albumCount: albumSet.size || 1,
        imageUrl:   storedImages[artistKey] || null,
      };
      _navToLibrary();
      _setLibTab('artists', true);
      onArtistClick(artist).catch(err => console.warn('[App] onGoToArtist:', err));
    } catch (err) {
      console.warn('[App] onGoToArtist:', err);
      _navToLibrary();
      _setLibTab('artists');
    }
  }

  /* ── Artist Radio ───────────────────────────────────────────
   * Loads all songs by the artist from DB, shuffles them, and starts playing.
   * ──────────────────────────────────────────────────────────── */

  async function onArtistRadio(song) {
    const rawArtist = (song.artist || '').split(';')[0].trim();
    if (!rawArtist) {
      UI.showToast(UI.t('toast_folder_no_songs'), 'error');
      return;
    }
    try {
      const artistKey = rawArtist.toLowerCase();
      const all = await DB.getAllMeta();
      let songs = all
        .filter(m => {
          const name = (m.artist || '').split(';')[0].trim();
          return name.toLowerCase() === artistKey && m.folderId;
        })
        .map(m => ({
          id:          m.id,
          name:        m.name         || m.id,
          displayName: m.displayName  || m.name || m.id,
          artist:      m.artist       || '',
          album:       m.album        || '',
          year:        m.year         || '',
          track:       m.track        || '',
          thumbnailUrl:m.thumbnailUrl || null,
          folderId:    m.folderId     || null,
        }));

      if (songs.length === 0) {
        UI.showToast(`${rawArtist} — ${UI.t('toast_folder_no_songs').toLowerCase()}`, 'error');
        return;
      }

      // Fisher-Yates shuffle
      for (let i = songs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [songs[i], songs[j]] = [songs[j], songs[i]];
      }

      _resetRadio();
      songs.forEach(s => _cacheItem(s));
      Player.setQueue(songs, 0);
      UI.showToast(`${rawArtist} · ${songs.length} ${UI.t('songs').toLowerCase()}`);
    } catch (err) {
      console.error('[App] onArtistRadio error:', err);
      UI.showToast(UI.t('toast_folder_error'), 'error');
    }
  }

  /* ── Send to Deep Scan ──────────────────────────────────────
   * Loads a folder directly into the Deep Scan as its target.
   * If the scan is currently running or paused, shows a warning
   * dialog asking the user to confirm stopping before proceeding.
   * ──────────────────────────────────────────────────────────── */

  let _dsSendTarget = null; // folder pending confirmation

  /**
   * Public entry point — called from all folder context menus.
   * @param {{ id: string, name: string }} folder
   */
  function onSendToScan(folder) {
    if (!folder?.id) return;

    // Count unresolved attention items (not ignored, not attended)
    const attnCount = _dsSession
      ? Object.values(_dsSession.folders || {}).filter(f => f.status !== 'ignored' && !f.attended).length
      : 0;

    const titleEl   = document.getElementById('ds-send-scan-title');
    const descEl    = document.getElementById('ds-send-scan-desc');
    const confirmEl = document.getElementById('btn-ds-send-scan-confirm');

    if (_dsRunning) {
      // Scan is active (running or paused) — ask to stop first
      _dsSendTarget = folder;
      const stateKey = _dsPaused ? 'ds_send_scan_paused' : 'ds_send_scan_running';
      if (titleEl)   titleEl.textContent   = UI.t('ds_send_scan_title');
      if (descEl)    descEl.textContent    = UI.t('ds_send_scan_desc')
                                               .replace('{state}', UI.t(stateKey))
                                               .replace('{name}', folder.name);
      if (confirmEl) confirmEl.textContent = UI.t('ds_send_stop_and_send');
      document.getElementById('ds-send-scan-dialog').style.display = 'flex';

    } else if (attnCount > 0) {
      // Scan finished but has unresolved missing-data rows — warn before discarding
      _dsSendTarget = folder;
      if (titleEl)   titleEl.textContent   = UI.t('ds_send_scan_pending_title');
      if (descEl)    descEl.textContent    = UI.t('ds_send_scan_pending_desc')
                                               .replace('{count}', attnCount)
                                               .replace('{name}', folder.name);
      if (confirmEl) confirmEl.textContent = UI.t('ds_send_scan_discard_send');
      document.getElementById('ds-send-scan-dialog').style.display = 'flex';

    } else {
      _dsSendFolderToScan(folder);
    }
  }

  /** Actually loads the folder into Deep Scan and navigates there. */
  async function _dsSendFolderToScan(folder) {
    // Ensure session is loaded
    if (!_dsSession) await _dsLoadSession();

    // Stop any running scan first
    if (_dsRunning) _stopDeepScan();

    // Set target folder and reset all progress
    _dsSession.selectedFolderId   = folder.id;
    _dsSession.selectedFolderName = folder.name;
    _dsSession.pendingQueue       = [];
    _dsSession.visited            = [];
    _dsSession.status             = 'idle';
    _dsSession.scannedFolders     = 0;
    _dsSession.totalFolders       = 0;
    _dsSession.folders            = {};
    _dsSession.completedList      = {};
    _dsSession.skippedList        = {};
    _dsSession.log                = [];

    // Update the folder-bar (name, path, button label)
    _dsUpdateFolderBar?.();

    await _dsSaveSession();
    _dsUpdateControls?.();
    _dsUpdateProgress?.();
    _dsUpdateCounters?.();

    // Navigate to Deep Scan tab
    _openDeepScan();
  }

  /** Navigate Browse to the Drive folder of the album. */
  function onAlbumGoToFolder(album) {
    if (!album.folderId) return;
    onGoToFolder({ id: album.folderId, name: album.name, isFolder: true });
  }

  /**
   * Show the playlist picker for an album.
   * Uses a special _isAlbum marker so onAddToPlaylist adds ALL songs.
   */
  async function onAlbumShowPlaylistPicker(e, album) {
    try {
      const playlists = await DB.getPlaylists();
      // Pass a synthetic item with _isAlbum flag so onAddToPlaylist bulk-adds
      const item = { id: album.folderId || album.name, name: album.name, _isAlbum: true, _album: album };
      UI.showPlaylistPicker(e, item, playlists);
    } catch (err) {
      UI.showToast(UI.t('toast_pl_load_error'), 'error');
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
    UI.updateSearchChipCounts(null); // clear search chip counts on every nav
    if (viewId === 'home')    _loadHomeData();
    if (viewId === 'library') {
      if (_libDetailRestoreFn) {
        // User was inside a detail view — restore it instead of showing root list
        const restore = _libDetailRestoreFn;
        _libDetailRestoreFn = null;
        restore();
      } else {
        _setLibTab(_currentLibTab || 'albums');
      }
    }
    // When navigating away from browse, clear any active search so the
    // folder list is restored immediately when Browse is opened again.
    if (viewId !== 'browse') {
      const inp = document.getElementById('search-input');
      if (inp && inp.value) {
        inp.value = '';
        // Use the same toggle helper defined in index.html inline script
        const browseScreen  = document.getElementById('screen-browse');
        const browseList    = document.querySelector('#screen-browse .item-list:not(#search-results)');
        const searchResults = document.getElementById('search-results');
        const filters       = document.querySelector('.browse-search-filters');
        const clearBtn      = document.getElementById('btn-search-clear');
        if (browseScreen)  browseScreen.classList.remove('search-active');
        if (browseList)    browseList.style.display    = '';
        if (searchResults) { searchResults.style.display = 'none'; searchResults.innerHTML = ''; }
        if (filters)       filters.style.display       = 'none';
        if (clearBtn)      clearBtn.style.display      = 'none';
      }
    }
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
    if (viewId === 'deep-scan') _openDeepScan();
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
        UI.showToast(`"${preset.name}" ${UI.t('toast_preset_loaded')}`);
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

    // Expanded player: 3-dot button → context menu for current track
    document.getElementById('btn-pexp-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = Player.getCurrentTrack();
      if (track) UI.showContextMenu(e, 'player_song', track);
    });

    // pexp-album and mini-artist clicks intentionally removed — no navigation on name tap

    // Expanded player: playback controls
    document.getElementById('btn-pexp-prev')?.addEventListener('click', () => Player.prev());
    document.getElementById('btn-pexp-next')?.addEventListener('click', () => Player.next());
    document.getElementById('btn-pexp-play')?.addEventListener('click', () => Player.togglePlayPause());
    document.getElementById('btn-pexp-shuffle')?.addEventListener('click', (e) => {
      const isOn = Player.toggleShuffle();
      e.currentTarget.classList.toggle('active', isOn);
      UI.showToast(isOn ? UI.t('toast_shuffle_on') : UI.t('toast_shuffle_off'));
    });
    document.getElementById('btn-pexp-repeat')?.addEventListener('click', (e) => {
      const mode = Player.cycleRepeat();
      const btn  = e.currentTarget;
      btn.classList.toggle('active', mode !== 'off');
      // Update aria-label and title to reflect current mode
      const labels = { off: UI.t('repeat_off'), all: UI.t('repeat_all'), one: UI.t('repeat_one') };
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

    // Expanded player: ⋮ more options (desktop header) → same menu as mobile topbar
    document.getElementById('btn-pexp-more-hdr')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = Player.getCurrentTrack();
      if (track) UI.showContextMenu(e, 'player_song', track);
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

    // Desktop micro player: click left side (thumb/info) → close queue
    document.querySelector('#desk-micro-player .dmp-left')?.addEventListener('click', () => {
      UI.showQueuePanel(false);
    });
    // Desktop micro player: playback buttons
    document.getElementById('dmp-btn-prev')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.prev();
    });
    document.getElementById('dmp-btn-play')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.togglePlayPause();
    });
    document.getElementById('dmp-btn-next')?.addEventListener('click', (e) => {
      e.stopPropagation(); Player.next();
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

    // Settings: scan a specific folder chosen by the user
    document.getElementById('btn-settings-folder-scan')?.addEventListener('click', () => {
      _dsOpenFolderBrowser(({ id, name, fullPath }) => {
        _scanSpecificFolder(id, fullPath || name);
      });
    });

    // Settings: open deep scan tool
    document.getElementById('btn-open-deep-scan')?.addEventListener('click', _openDeepScan);

    // Deep Scan: back button
    document.getElementById('btn-ds-back')?.addEventListener('click', () => onNavClick('settings'));

    // Deep Scan: playback controls
    document.getElementById('btn-ds-start')?.addEventListener('click', _startDeepScan);
    document.getElementById('btn-ds-restart')?.addEventListener('click', _restartDeepScan);
    // Pause button toggles: Pausar ↔ Continuar depending on current _dsPaused state
    document.getElementById('btn-ds-pause')?.addEventListener('click', () => {
      if (_dsPaused) _startDeepScan(); else _pauseDeepScan();
    });
    document.getElementById('btn-ds-stop')?.addEventListener('click',  _stopDeepScan);

    // Deep Scan: open in new tab
    document.getElementById('btn-ds-new-tab')?.addEventListener('click', () => {
      const url = location.href.split('#')[0] + '#deep-scan';
      window.open(url, '_blank');
    });

    // Deep Scan: folder picker
    document.getElementById('btn-ds-change-folder')?.addEventListener('click', () => _dsOpenFolderBrowser());
    document.getElementById('btn-ds-modal-close')?.addEventListener('click',   () => _dsCloseModal('ds-folder-modal'));
    document.getElementById('ds-folder-modal-backdrop')?.addEventListener('click', () => _dsCloseModal('ds-folder-modal'));
    document.getElementById('btn-ds-modal-select')?.addEventListener('click',  _dsConfirmFolderSelect);

    // Deep Scan: artist photo URL modal
    const _closeArtistUrlModal = () => {
      _dsCloseModal('ds-artist-url-modal');
      _dsArtistUrlKey  = null;
      _dsArtistUrlName = null;
    };
    document.getElementById('ds-artist-url-backdrop')?.addEventListener('click', _closeArtistUrlModal);
    document.getElementById('btn-ds-artist-url-cancel')?.addEventListener('click', _closeArtistUrlModal);
    document.getElementById('btn-ds-artist-url-save')?.addEventListener('click', _dsSaveArtistUrl);
    document.getElementById('ds-artist-url-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _dsSaveArtistUrl();
      if (e.key === 'Escape') _closeArtistUrlModal();
    });

    // Collection edit modal
    document.getElementById('collection-edit-backdrop')?.addEventListener('click', _closeCollectionEditModal);
    document.getElementById('btn-collection-edit-cancel')?.addEventListener('click', _closeCollectionEditModal);
    document.getElementById('btn-collection-edit-save')?.addEventListener('click', async () => {
      const modal    = document.getElementById('collection-edit-modal');
      const folderId = modal?.dataset?.folderId;
      if (!folderId) return;
      const name     = document.getElementById('collection-edit-name')?.value.trim() || '';
      const coverUrl = document.getElementById('collection-edit-cover')?.value.trim() || '';
      await DB.saveCollection(folderId, { name: name || undefined, coverUrl: coverUrl || undefined });
      _closeCollectionEditModal();
      // Re-render the header inside the detail view with updated data
      if (_libInDetail && _currentLibTab === 'collections') {
        const savedCol = await DB.getCollection(folderId);
        const header   = document.getElementById('lib-collection-hdr');
        if (header && savedCol) {
          // Update name label
          const nameEl = header.querySelector('.lib-col-detail-name');
          if (nameEl && savedCol.name) nameEl.textContent = savedCol.name;
          // Update cover
          const coverEl = header.querySelector('.lib-col-detail-art');
          if (coverEl && savedCol.coverUrl) {
            coverEl.innerHTML = `<img src="${savedCol.coverUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md)">`;
          }
          // Show blue dot in back-row legend only
          // (dots are intentionally absent from the collection entity header)
          const container    = document.getElementById('lib-detail-content');
          const legendManual = container?.querySelector('.col-detail-legend-manual');
          if (legendManual) legendManual.style.display = '';
        }
      }
    });
    document.getElementById('btn-collection-apply-all')?.addEventListener('click', async () => {
      const modal    = document.getElementById('collection-edit-modal');
      const folderId = modal?.dataset?.folderId;
      const coverUrl = document.getElementById('collection-edit-cover')?.value.trim();
      if (!folderId || !coverUrl) return;

      const btn  = document.getElementById('btn-collection-apply-all');
      const orig = btn?.textContent;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }

      try {
        const all  = await DB.getAllMeta();
        let songs  = all.filter(m => m.folderId === folderId);

        // Folder not yet scanned — no meta records have folderId set.
        // Fetch the file list directly from Drive and seed minimal meta entries
        // so the cover can be stamped on each file.
        if (songs.length === 0 && typeof Drive !== 'undefined' && Auth.getValidToken()) {
          try {
            const driveResult = await Drive.listFolderAll(folderId);
            const audioFiles  = (driveResult?.files || []).filter(f =>
              f.mimeType?.startsWith('audio/') ||
              /\.(mp3|m4a|flac|ogg|wav|aac|opus)$/i.test(f.name || '')
            );
            for (const f of audioFiles) {
              await DB.setMeta(f.id, {
                id:       f.id,
                folderId: folderId,
                name:     f.name     || f.id,
                mimeType: f.mimeType || null,
              });
            }
            if (audioFiles.length > 0) {
              const refreshed = await DB.getAllMeta();
              songs = refreshed.filter(m => m.folderId === folderId);
            }
          } catch (driveErr) {
            console.warn('[App] Apply-all: Drive fallback failed', driveErr);
          }
        }

        const now = Date.now();
        for (const m of songs) {
          // Stamp manualAt so _resolveCoverUrl returns this URL over blob/ID3 cache.
          await DB.setMeta(m.id, { thumbnailUrl: coverUrl, manualAt: now });
          // Evict the in-memory Meta cache so the next resolve reads from DB.
          if (typeof Meta !== 'undefined') Meta.revoke(m.id);
          // Update the cover in the collection detail song list row immediately.
          _updateRowThumbnail(m.id, coverUrl);
        }

        // Rebuild mosaic in the collection header with the new uniform cover.
        const header = document.getElementById('lib-collection-hdr');
        const artEl  = header?.querySelector('.lib-col-detail-art');
        if (artEl) {
          artEl.innerHTML = `<img src="${_escHtml(coverUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)">`;
        }

        console.log(`[App] Applied cover to ${songs.length} songs in collection ${folderId}`);
        if (typeof Sync !== 'undefined') Sync.push('metadata');
        if (btn) { btn.textContent = `✓ ${songs.length}`; }
        setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = orig; } }, 2000);
      } catch (err) {
        console.error('[App] Apply all cover error:', err);
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    });

    // Deep Scan: send-to-scan warning dialog
    const _closeSendScanDialog = () => {
      _dsCloseModal('ds-send-scan-dialog');
      _dsSendTarget = null;
    };
    document.getElementById('ds-send-scan-backdrop')?.addEventListener('click', _closeSendScanDialog);
    document.getElementById('btn-ds-send-scan-cancel')?.addEventListener('click', _closeSendScanDialog);
    document.getElementById('btn-ds-send-scan-confirm')?.addEventListener('click', () => {
      const target = _dsSendTarget;
      _closeSendScanDialog();
      if (target) _dsSendFolderToScan(target);
    });

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
    const _dsSetListMode = (mode) => {
      _dsListMode = mode;
      document.getElementById('btn-ds-show-all')?.classList.toggle('active',     mode === 'all');
      document.getElementById('btn-ds-show-attn')?.classList.toggle('active',    mode === 'attn');
      document.getElementById('btn-ds-show-done')?.classList.toggle('active',    mode === 'done');
      document.getElementById('btn-ds-show-skipped')?.classList.toggle('active', mode === 'skipped');
      if (mode === 'all')     _dsRenderAllList();
      if (mode === 'attn')    _dsRenderAttentionList();
      if (mode === 'done')    _dsRenderCompletedList();
      if (mode === 'skipped') _dsRenderSkippedList();
    };
    document.getElementById('btn-ds-show-all')?.addEventListener('click',     () => { if (_dsListMode !== 'all')     _dsSetListMode('all');     });
    document.getElementById('btn-ds-show-attn')?.addEventListener('click',    () => { if (_dsListMode !== 'attn')    _dsSetListMode('attn');    });
    document.getElementById('btn-ds-show-done')?.addEventListener('click',    () => { if (_dsListMode !== 'done')    _dsSetListMode('done');    });
    document.getElementById('btn-ds-show-skipped')?.addEventListener('click', () => { if (_dsListMode !== 'skipped') _dsSetListMode('skipped'); });
    // "Mostrar" button under Completas counter (legacy, kept for safety)
    document.getElementById('btn-ds-show-complete')?.addEventListener('click', () => {
      if (_dsListMode !== 'done') _dsSetListMode('done');
    });

    // Deep Scan: artistas "Solo sin foto" toggle
    // Listener is on the label wrapper (not the toggle div) so the label's
    // default activation doesn't cause a second synthetic click on the div.
    document.querySelector('.ds-artists-toggle-wrap')?.addEventListener('click', async (e) => {
      e.preventDefault(); // stop label from re-dispatching click
      _dsOnlyNoPhoto = !_dsOnlyNoPhoto;
      document.getElementById('ds-toggle-no-photo')?.classList.toggle('on', _dsOnlyNoPhoto);
      // Re-render with same artist/photo data
      const all = await DB.getAllMeta().catch(() => []);
      const artistMap = new Map();
      for (const m of all) {
        if (!m.artist) continue;
        const name = m.artist.split(';')[0].trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!artistMap.has(key)) artistMap.set(key, name);
      }
      const autoPhotos   = (await DB.getState('artistImages').catch(() => null))    || {};
      const manualPhotos = (await DB.getState('ds_artistPhotos').catch(() => null)) || {};
      const photoMap = {};
      for (const [key] of artistMap) {
        const manual = manualPhotos[key];
        const auto   = autoPhotos[key];
        if (manual)    photoMap[key] = manual;
        else if (auto) photoMap[key] = auto;
      }
      _dsRenderArtists([...artistMap.entries()].sort((a, b) => a[0].localeCompare(b[0])), photoMap);
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
      UI.showToast(`${UI.t('settings_cache_limit')}: ${formatBytes(bytes)}`, 'success');
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
    // Spacebar — play/pause (unless focus is inside an input/textarea/select/contenteditable)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (UI.isQueuePanelVisible()) {
          UI.showQueuePanel(false);
        } else if (UI.isExpandedPlayerVisible()) {
          _closeExpandedPlayer();
        }
      }

      if (e.key === ' ') {
        const tag = document.activeElement?.tagName?.toLowerCase();
        const editable = document.activeElement?.isContentEditable;
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || editable) return;
        e.preventDefault();
        Player.togglePlayPause();
      }
    });

    // Library: tab clicks
    document.querySelectorAll('#lib-sidebar .lib-tab').forEach(el => {
      el.addEventListener('click', () => _setLibTab(el.dataset.tab));
    });

    // Library: search input (debounced — re-renders paginated list after 400ms idle)
    document.getElementById('lib-search-input')?.addEventListener('input', (e) => {
      clearTimeout(_libSearchDebounce);
      _libSearchDebounce = setTimeout(() => _onLibSearch(), 400);
      const clearBtn = document.getElementById('btn-lib-search-clear');
      if (clearBtn) clearBtn.style.display = e.target.value ? '' : 'none';
    });

    // Library: search clear button
    document.getElementById('btn-lib-search-clear')?.addEventListener('click', () => {
      const input = document.getElementById('lib-search-input');
      if (input) { input.value = ''; input.focus(); }
      const clearBtn = document.getElementById('btn-lib-search-clear');
      if (clearBtn) clearBtn.style.display = 'none';
      clearTimeout(_libSearchDebounce);
      _onLibSearch();
    });

    // Library: batch rescan visible album search results
    document.getElementById('btn-lib-rescan')?.addEventListener('click', onLibRescan);

    // Refresh cache bar when settings is opened
    document.querySelectorAll('[data-nav="settings"]').forEach(el => {
      el.addEventListener('click', _refreshCacheBar);
    });

  }

  /* ── Expose ─────────────────────────────────────────────── */
  /**
   * Synchronous check: is the given folderId classified as a collection?
   * Used by ui.js context menu to label songs correctly ("Ir a la colección" vs "Ir al álbum").
   * Accepts a song/folder item or a raw folderId string.
   */
  function isFolderCollection(folderIdOrItem) {
    if (!_collectionFolderIdsCache) return false;
    if (!folderIdOrItem) return false;
    // Accept both a raw ID string and an item object
    const id = typeof folderIdOrItem === 'string'
      ? folderIdOrItem
      : (folderIdOrItem.folderId || folderIdOrItem.parents?.[0] || null);
    return id ? _collectionFolderIdsCache.has(id) : false;
  }

  return {
    boot,
    // Called by UI event handlers
    onHomeCardClick,
    onPlaylistHomeCardClick,
    onPlaylistDetailPlay,
    onFolderClick,
    onGoToFolder,
    onGoToAlbum,
    onGoToLibraryAlbum,
    onGoToLibraryCollection,
    isFolderCollection,
    onGoToArtist,
    onArtistRadio,
    onSendToScan,
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
    onRemoveFromTopPlayed,
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
    liveMetaUpdate: _liveMetaUpdate,
    cacheExternalCover: _cacheExternalCover,
    _cacheItem,
    _resolveItemById,
    _doSearch,
    _loadStarred,
    _loadPlaylists,
    _loadCollections,
    _loadArtists,
    _loadAlbums,
    _setLibTab,
    _libGoBack,
    _onNewPlaylist,
    onArtistClick,
    onAlbumClick,
    onCollectionClick,
    onCollectionPlay,
    onCollectionQueue,
    onMoveToAlbums,
    onMoveToCollections,
    _openCollectionEditModal,
    onAlbumRescan,
    stopAlbumRescan,
    onSongEdit,
    onSongResetId3,
    onAlbumEdit,
    onAlbumResetId3,
    getMetaSuggestions,
    onAlbumPlay,
    onAlbumQueue,
    onAlbumGoToFolder,
    onAlbumShowPlaylistPicker,
    onTrackRename,
    onBrowseRescan,

    onPlaylistClick,
    onPlaylistPlay,
    onPlaylistQueue,
    onRenamePlaylist,
    onDeletePlaylist,
    onRemoveFromPlaylist,
    // Library batch rescan
    onLibRescan,
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
