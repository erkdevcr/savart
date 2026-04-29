/* ============================================================
   Savart — UI module
   DOM manipulation, view routing, component rendering
   ============================================================
   Views (screens):
   - login    : full-screen login (no auth)
   - home     : Pinned + Recents + Top played
   - browse   : Folder browser (Examinar)
   - search   : Search screen
   - library  : Playlists / Songs / Artists tabs
   - settings : Ajustes
   - eq       : Ecualizador (overlay)

   Mini-player updates happen via updateMiniPlayer().
   Context menu is managed by showContextMenu() / hideContextMenu().
   ============================================================ */

const UI = (() => {

  /* ── Current state ──────────────────────────────────────── */
  let _currentView   = null;
  let _currentLang   = 'es';

  /* ── i18n strings ────────────────────────────────────────── */
  const STRINGS = {
    es: {
      // ── Navigation ─────────────────────────────────────────
      home:      'Inicio',
      browse:    'Examinar',
      search:    'Buscar',
      library:   'Biblioteca',
      history:   'Historial',
      settings:  'Ajustes',
      // ── Login ──────────────────────────────────────────────
      login_tagline: 'Tu música de Google Drive,\ndonde quieras.',
      login_btn: 'Continuar con Google',
      // ── Home sections ──────────────────────────────────────
      now_playing: 'REPRODUCIENDO AHORA',
      pinned:    'Fijadas',
      recents:          'Recientes',
      recents_folders:  'Carpetas recientes',
      recents_songs:    'Canciones recientes',
      recent_playlists: 'Playlists',
      top_played:       'Más reproducidas',
      // ── Home empty states ──────────────────────────────────
      empty_pinned:          'Fija carpetas desde el menú ··· para verlas aquí.',
      empty_recents_folders: 'Las carpetas que abras aparecerán aquí.',
      empty_recents_songs:   'Las canciones que escuches aparecerán aquí.',
      empty_top_played:      'Tus canciones más reproducidas aparecerán aquí.',
      empty_history:         'Las canciones que escuches aparecerán aquí.',
      home_cta_browse:       'Examinar tu Drive',
      // ── General labels ─────────────────────────────────────
      folders:   'Carpetas',
      songs:     'Canciones',
      playlists: 'Playlists',
      artists:   'Artistas',
      no_results:'Sin resultados',
      loading:   'Cargando…',
      empty_folder: 'Carpeta vacía',
      format_unsupported: 'Formato no compatible',
      // ── Context menu ───────────────────────────────────────
      ctx_play:           'Reproducir',
      ctx_go_to_album:    'Ir al álbum',
      ctx_go_to_folder:   'Ir a carpeta',
      ctx_add_fav_folder: 'Añadir a favoritos',
      ctx_pin_to_home:    'Agregar a inicio',
      ctx_unpin_from_home:'Eliminar de inicio',
      ctx_remove_from_pl: 'Eliminar de playlist',
      ctx_rename:         'Renombrar',
      ctx_delete:         'Eliminar',
      ctx_remove_history: 'Borrar del historial',
      ctx_mark_fav:       'Marcar favorita',
      // ── Queue actions ──────────────────────────────────────
      play_next: 'A continuación',
      play_after:'Después',
      add_to_pl: 'Agregar a playlist',
      pin_folder:'Fijar carpeta',
      unpin_folder:'Quitar de fijadas',
      add_fav:   'Marcar favorita',
      remove_fav:'Quitar de favoritas',
      // ── Queue panel ────────────────────────────────────────
      queue_title:      'Cola',
      queue_previous:   'Anteriores',
      queue_now_playing:'Reproduciendo ahora',
      queue_upcoming:   'A continuación',
      queue_empty:      'Cola vacía',
      // ── Library ────────────────────────────────────────────
      lib_favorites:     'Favoritos',
      lib_new_playlist:  'Nueva playlist',
      lib_no_favorites:  'Sin favoritas aún.\nToca ♥ en cualquier canción.',
      lib_playlist_empty:'Esta playlist está vacía.\nAgrega canciones desde el menú de contexto.',
      lib_no_artists:    'Sin artistas aún.',
      lib_artist_fav:    'Artista favorito',
      // ── Playlist sort ──────────────────────────────────────
      pl_sort_recent:  'Reciente',
      // ── Browse ─────────────────────────────────────────────
      browse_back: 'Atrás',
      // ── Search ─────────────────────────────────────────────
      search_placeholder: 'Canciones, carpetas…',
      // ── Session / auth ─────────────────────────────────────
      session_expiring: 'La sesión expirará pronto.',
      renew:     'Renovar',
      logout:    'Cerrar sesión',
      // ── Stats ──────────────────────────────────────────────
      reproductions: 'reproducciones',
      cached:    'En caché',
      // ── Filters ────────────────────────────────────────────
      filter_all:   'Todo',
      filter_songs: 'Canciones',
      filter_folders: 'Carpetas',
      // ── Settings sections ──────────────────────────────────
      settings_playback:    'Reproducción',
      settings_eq:          'Ecualizador',
      settings_eq_12band:   '12 bandas',
      settings_open_eq:     'Abrir EQ',
      settings_tempo:       'Tempo',
      settings_sleep_timer: 'Sleep timer',
      settings_library:     'Biblioteca',
      settings_root_folder: 'Carpeta raíz',
      settings_storage:     'Almacenamiento',
      settings_cache:       'Caché',
      settings_cache_limit: 'Límite de caché',
      settings_clear_cache: 'Borrar caché',
      settings_appearance:  'Apariencia',
      settings_language:    'Idioma',
      settings_text_size:   'Tamaño de texto',
      settings_account:     'Cuenta',
      settings_drive_linked:'Google Drive vinculado',
      // ── Player actions ─────────────────────────────────────
      player_queue:       'Cola',
      player_speed:       'Velocidad',
      player_timer:       'Temporizador',
      player_lyrics:      'LETRA',
      player_show_album:  'MOSTRAR ÁLBUM',
      lyrics_loading:     'Buscando letra…',
      lyrics_not_found:   'Letra no encontrada',
      // ── Playlist picker ────────────────────────────────────
      pl_picker_search: 'Busca una playlist',
      pl_picker_name:   'Nombre de la playlist',
      // ── Toast messages ─────────────────────────────────────
      toast_session_expired:    'Sesión expirada — renueva tu sesión',
      toast_folder_error:       'Error al cargar la carpeta',
      toast_folder_unavailable: 'Carpeta no disponible',
      toast_folder_open_error:  'No se pudo abrir la carpeta',
      toast_added_fav:          'Marcada como favorita ♥',
      toast_removed_fav:        'Quitada de favoritas',
      toast_removed_history:    'Eliminado del historial',
      toast_no_playable:        'No hay canciones reproducibles',
      toast_playlist_empty:     'Playlist vacía',
      toast_playlist_error:     'Error al abrir playlist',
      toast_playlist_play_error:'Error al reproducir playlist',
      toast_queue_error:        'Error al cargar carpeta',
      toast_pl_add_error:       'Error al agregar a playlist',
      toast_pl_create_error:    'Error al crear la playlist',
      toast_pl_remove_error:    'Error al eliminar',
      toast_pl_load_error:      'Error al cargar playlists',
      toast_removed_pl:         'Canción eliminada de la playlist',
      toast_no_folder:          'No hay carpeta disponible',
      toast_folder_no_songs:    'No hay canciones reproducibles en esta carpeta',
      toast_added_to_pl:        'Agregada a',
      toast_pl_created:         'Playlist creada y canción agregada',
      toast_cache_cleared:      'Caché borrada',
      toast_sleep_stopped:      'Sleep timer: reproducción detenida',
      toast_back_error:         'No se pudo navegar a la carpeta anterior',
      // ── Native dialog prompts ──────────────────────────────
      prompt_rename_playlist:   'Nuevo nombre:',
      confirm_delete_playlist:  '¿Eliminar',
      confirm_logout:           '¿Cerrar sesión?',
      prompt_sleep_mins:        'Minutos:',
      prompt_eq_preset_name:    'Nombre del preset:',
      prompt_eq_preset_default: 'Mi preset',
      prompt_playlist_name:     'Nombre de la playlist:',
      prompt_playlist_default:  'Nueva playlist',
    },
    en: {
      // ── Navigation ─────────────────────────────────────────
      home:      'Home',
      browse:    'Browse',
      search:    'Search',
      library:   'Library',
      history:   'History',
      settings:  'Settings',
      // ── Login ──────────────────────────────────────────────
      login_tagline: 'Your Google Drive music,\nanywhere.',
      login_btn: 'Continue with Google',
      // ── Home sections ──────────────────────────────────────
      now_playing: 'NOW PLAYING',
      pinned:    'Pinned',
      recents:          'Recents',
      recents_folders:  'Recent folders',
      recents_songs:    'Recent songs',
      recent_playlists: 'Playlists',
      top_played:       'Most played',
      // ── Home empty states ──────────────────────────────────
      empty_pinned:          'Pin folders from the ··· menu to see them here.',
      empty_recents_folders: 'Folders you open will appear here.',
      empty_recents_songs:   'Songs you listen to will appear here.',
      empty_top_played:      'Your most played songs will appear here.',
      empty_history:         'Songs you listen to will appear here.',
      home_cta_browse:       'Browse your Drive',
      // ── General labels ─────────────────────────────────────
      folders:   'Folders',
      songs:     'Songs',
      playlists: 'Playlists',
      artists:   'Artists',
      no_results:'No results',
      loading:   'Loading…',
      empty_folder: 'Empty folder',
      format_unsupported: 'Unsupported format',
      // ── Context menu ───────────────────────────────────────
      ctx_play:           'Play',
      ctx_go_to_album:    'Go to album',
      ctx_go_to_folder:   'Go to folder',
      ctx_add_fav_folder: 'Add to favorites',
      ctx_pin_to_home:    'Add to home',
      ctx_unpin_from_home:'Remove from home',
      ctx_remove_from_pl: 'Remove from playlist',
      ctx_rename:         'Rename',
      ctx_delete:         'Delete',
      ctx_remove_history: 'Remove from history',
      ctx_mark_fav:       'Mark as favorite',
      // ── Queue actions ──────────────────────────────────────
      play_next: 'Play next',
      play_after:'Play later',
      add_to_pl: 'Add to playlist',
      pin_folder:'Pin folder',
      unpin_folder:'Unpin folder',
      add_fav:   'Add to favorites',
      remove_fav:'Remove from favorites',
      // ── Queue panel ────────────────────────────────────────
      queue_title:      'Queue',
      queue_previous:   'Previous',
      queue_now_playing:'Now playing',
      queue_upcoming:   'Up next',
      queue_empty:      'Empty queue',
      // ── Library ────────────────────────────────────────────
      lib_favorites:     'Favorites',
      lib_new_playlist:  'New playlist',
      lib_no_favorites:  'No favorites yet.\nTap ♥ on any song.',
      lib_playlist_empty:'This playlist is empty.\nAdd songs from the context menu.',
      lib_no_artists:    'No artists yet.',
      lib_artist_fav:    'Favorite artist',
      // ── Playlist sort ──────────────────────────────────────
      pl_sort_recent:  'Recent',
      // ── Browse ─────────────────────────────────────────────
      browse_back: 'Back',
      // ── Search ─────────────────────────────────────────────
      search_placeholder: 'Songs, folders…',
      // ── Session / auth ─────────────────────────────────────
      session_expiring: 'Session expiring soon.',
      renew:     'Renew',
      logout:    'Log out',
      // ── Stats ──────────────────────────────────────────────
      reproductions: 'plays',
      cached:    'Cached',
      // ── Filters ────────────────────────────────────────────
      filter_all:   'All',
      filter_songs: 'Songs',
      filter_folders: 'Folders',
      // ── Settings sections ──────────────────────────────────
      settings_playback:    'Playback',
      settings_eq:          'Equalizer',
      settings_eq_12band:   '12 bands',
      settings_open_eq:     'Open EQ',
      settings_tempo:       'Tempo',
      settings_sleep_timer: 'Sleep timer',
      settings_library:     'Library',
      settings_root_folder: 'Root folder',
      settings_storage:     'Storage',
      settings_cache:       'Cache',
      settings_cache_limit: 'Cache limit',
      settings_clear_cache: 'Clear cache',
      settings_appearance:  'Appearance',
      settings_language:    'Language',
      settings_text_size:   'Text size',
      settings_account:     'Account',
      settings_drive_linked:'Google Drive linked',
      // ── Player actions ─────────────────────────────────────
      player_queue:       'Queue',
      player_speed:       'Speed',
      player_timer:       'Timer',
      player_lyrics:      'LYRIC',
      player_show_album:  'SHOW ALBUM',
      lyrics_loading:     'Fetching lyrics…',
      lyrics_not_found:   'Lyrics not found',
      // ── Playlist picker ────────────────────────────────────
      pl_picker_search: 'Search a playlist',
      pl_picker_name:   'Playlist name',
      // ── Toast messages ─────────────────────────────────────
      toast_session_expired:    'Session expired — renew your session',
      toast_folder_error:       'Error loading folder',
      toast_folder_unavailable: 'Folder not available',
      toast_folder_open_error:  'Could not open folder',
      toast_added_fav:          'Added to favorites ♥',
      toast_removed_fav:        'Removed from favorites',
      toast_removed_history:    'Removed from history',
      toast_no_playable:        'No playable songs',
      toast_playlist_empty:     'Empty playlist',
      toast_playlist_error:     'Error opening playlist',
      toast_playlist_play_error:'Error playing playlist',
      toast_queue_error:        'Error loading folder',
      toast_pl_add_error:       'Error adding to playlist',
      toast_pl_create_error:    'Error creating playlist',
      toast_pl_remove_error:    'Error removing',
      toast_pl_load_error:      'Error loading playlists',
      toast_removed_pl:         'Song removed from playlist',
      toast_no_folder:          'Folder not available',
      toast_folder_no_songs:    'No playable songs in this folder',
      toast_added_to_pl:        'Added to',
      toast_pl_created:         'Playlist created and song added',
      toast_cache_cleared:      'Cache cleared',
      toast_sleep_stopped:      'Sleep timer: playback stopped',
      toast_back_error:         'Could not navigate to parent folder',
      // ── Native dialog prompts ──────────────────────────────
      prompt_rename_playlist:   'New name:',
      confirm_delete_playlist:  'Delete',
      confirm_logout:           'Log out?',
      prompt_sleep_mins:        'Minutes:',
      prompt_eq_preset_name:    'Preset name:',
      prompt_eq_preset_default: 'My preset',
      prompt_playlist_name:     'Playlist name:',
      prompt_playlist_default:  'New playlist',
    },
  };

  function t(key) {
    return STRINGS[_currentLang]?.[key] ?? STRINGS['es'][key] ?? key;
  }

  /* ── View routing ────────────────────────────────────────── */

  /**
   * Navigate to a top-level view.
   * Hides all .screen elements, shows the target one.
   * Updates nav tab / sidebar active state.
   * @param {string} viewId - 'home' | 'browse' | 'search' | 'library' | 'settings' | 'eq' | 'login'
   */
  function showView(viewId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-tab, #sidebar .nav-item').forEach(el => {
      el.classList.remove('active');
      if (el.dataset.view === viewId) el.classList.add('active');
    });

    const screen = document.getElementById(`screen-${viewId}`);
    if (screen) screen.classList.add('active');

    _currentView = viewId;

    // Show/hide structural elements
    const isLoggedIn = viewId !== 'login';
    document.getElementById('bottom-nav').style.display = isLoggedIn ? '' : 'none';
    document.getElementById('sidebar').style.display    = isLoggedIn ? '' : 'none';
  }

  function getCurrentView() { return _currentView; }

  /* ── Toast ──────────────────────────────────────────────── */

  /**
   * Show a brief toast message.
   * @param {string} message
   * @param {'default'|'error'|'success'} type
   */
  function showToast(message, type = 'default') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error')   toast.style.borderColor = 'var(--error)';
    if (type === 'success') toast.style.borderColor = 'var(--success)';
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2800);
  }

  /* ── Token renewal banner ────────────────────────────────── */

  function showTokenBanner() {
    const banner = document.getElementById('token-banner');
    if (banner) banner.classList.add('visible');
  }

  function hideTokenBanner() {
    const banner = document.getElementById('token-banner');
    if (banner) banner.classList.remove('visible');
  }

  /* ── Mini-player ─────────────────────────────────────────── */

  /**
   * Update the mini-player with current track info.
   * @param {DriveItem|null} track
   * @param {boolean} isPlaying
   */
  function updateMiniPlayer(track, isPlaying) {
    const mp = document.getElementById('mini-player');
    if (!mp) return;

    if (!track) {
      mp.classList.remove('visible', 'playing');
      return;
    }

    mp.classList.add('visible');
    mp.classList.toggle('playing', isPlaying);

    const titleEl  = mp.querySelector('.mini-title');
    const artistEl = mp.querySelector('.mini-artist');
    const thumbImg = mp.querySelector('.mini-thumb img');

    if (titleEl)  titleEl.textContent  = track.displayName || track.name;
    if (artistEl) artistEl.textContent = track.artist || '';

    if (thumbImg) {
      if (track.thumbnailUrl) {
        thumbImg.src = track.thumbnailUrl;
        thumbImg.style.display = '';
      } else {
        thumbImg.style.display = 'none';
      }
    }

    // Update play/pause icon (mobile + desktop)
    const btnPlay = mp.querySelector('.btn-play-mini');
    if (btnPlay) btnPlay.innerHTML = isPlaying ? iconPause() : iconPlay();
    const btnPlayDesk = mp.querySelector('.btn-play-mini-desk');
    if (btnPlayDesk) btnPlayDesk.innerHTML = isPlaying ? iconPause(18) : iconPlay(18);
  }

  /* ── Expanded player ────────────────────────────────────── */

  /**
   * Open or close the expanded player.
   * @param {boolean} open
   */
  function _isDesktop() {
    return window.matchMedia('(min-width: 768px)').matches;
  }

  function setExpandedPlayerVisible(open) {
    if (_isDesktop()) return; // Always visible as right panel on desktop
    document.getElementById('player-expanded')?.classList.toggle('visible', open);
  }

  function isExpandedPlayerVisible() {
    if (_isDesktop()) return true; // Always visible on desktop
    return document.getElementById('player-expanded')?.classList.contains('visible') ?? false;
  }

  /**
   * Update the expanded player with current track info.
   * @param {DriveItem|null} track
   * @param {boolean} isPlaying
   */
  function updateExpandedPlayer(track, isPlaying) {
    const ep = document.getElementById('player-expanded');
    if (!ep) return;

    // Title
    const titleEl  = document.getElementById('pexp-title');
    const artistEl = document.getElementById('pexp-artist');
    const albumEl  = document.getElementById('pexp-album');
    const fileEl   = document.getElementById('pexp-file');

    if (titleEl)  titleEl.textContent  = track ? (track.displayName || track.name) : '—';
    if (artistEl) artistEl.textContent = track?.artist || '';
    if (albumEl)  albumEl.textContent  = track?.albumName ? `${track.albumName}${track.year ? ' · ' + track.year : ''}` : '';

    // File info: "04 Comfortably Numb.flac · 38.2 MB"
    if (fileEl && track) {
      const ext  = (track.name || '').split('.').pop();
      const size = track.size ? formatBytes(parseInt(track.size, 10)) : '';
      fileEl.textContent = [track.name, size].filter(Boolean).join(' · ');
    } else if (fileEl) {
      fileEl.textContent = '';
    }

    // File badges: type · kbps · size
    const badgesEl   = document.getElementById('pexp-badges');
    const badgeType  = document.getElementById('pexp-badge-type');
    const badgeKbps  = document.getElementById('pexp-badge-kbps');
    const badgeSize  = document.getElementById('pexp-badge-size');
    if (badgesEl && track) {
      const ext     = (track.name || '').split('.').pop().toUpperCase() || '—';
      const sizeNum = parseInt(track.size || '0', 10);
      const durMs   = parseInt(track.durationMs || '0', 10);
      const sizeStr = sizeNum > 0 ? formatBytes(sizeNum) : '—';

      // Prefer real bitrate from headers; fall back to size/duration estimate
      let kbps = track.bitrate || null;
      if (!kbps && sizeNum > 0 && durMs > 0) {
        kbps = Math.round((sizeNum * 8) / durMs);
      }

      if (badgeType) badgeType.textContent = ext;
      if (badgeKbps) badgeKbps.textContent = kbps ? `${kbps} kbps` : '— kbps';
      if (badgeSize) badgeSize.textContent = sizeStr;
      badgesEl.style.display = 'flex';
    } else if (badgesEl) {
      badgesEl.style.display = 'none';
    }

    // Album art
    const artImg  = document.getElementById('pexp-art-img');
    const artPh   = document.getElementById('pexp-art-placeholder');
    if (artImg && artPh) {
      if (track?.thumbnailUrl) {
        artImg.src = track.thumbnailUrl;
        artImg.style.display = '';
        artPh.style.display  = 'none';
      } else {
        artImg.style.display = 'none';
        artPh.style.display  = '';
      }
    }

    // Play/Pause button icon
    const playBtn = document.getElementById('btn-pexp-play');
    if (playBtn) {
      playBtn.innerHTML = isPlaying ? iconPause(30) : iconPlay(30);
    }
  }

  /**
   * Update the expanded player progress bar.
   * @param {number} currentTime - seconds
   * @param {number} duration    - seconds
   */
  function updateExpandedPlayerProgress(currentTime, duration) {
    const fill    = document.getElementById('pexp-progress-fill');
    const curEl   = document.getElementById('pexp-time-cur');
    const totEl   = document.getElementById('pexp-time-tot');

    if (fill && duration > 0) {
      fill.style.width = `${(currentTime / duration) * 100}%`;
    }
    if (curEl) curEl.textContent = formatTime(currentTime);
    if (totEl) totEl.textContent = formatTime(duration);
  }

  /**
   * Update the mini-player progress bar.
   * @param {number} currentTime - seconds
   * @param {number} duration    - seconds
   */
  function updateProgress(currentTime, duration) {
    const mp = document.getElementById('mini-player');
    if (!mp) return;

    const bar = mp.querySelector('.mini-progress');
    if (bar && duration > 0) {
      bar.style.width = `${(currentTime / duration) * 100}%`;
    }
  }

  /* ── Home screen rendering ────────────────────────────────── */

  /**
   * Render the Home screen with pinned, recents, and top played.
   * @param {{ pinned: Object[], recents: Object[], topPlayed: Object[] }} data
   */
  function renderHome({ pinned = [], recents = [], topPlayed = [], playlists = [] }) {
    const screen = document.getElementById('screen-home');
    if (!screen) return;

    const content = screen.querySelector('.home-content') || screen;

    // Clear dynamic sections + old CTA
    content.querySelectorAll('.home-section, .home-cta-btn').forEach(s => s.remove());

    // Always hide old global empty state
    const emptyState = document.getElementById('home-empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const hasData = pinned.length > 0 || recents.length > 0 || topPlayed.length > 0;

    // Show prominent CTA only when completely empty (first-run)
    if (!hasData) {
      const ctaBtn = document.createElement('button');
      ctaBtn.className = 'home-cta-btn btn-primary';
      ctaBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
        ${t('home_cta_browse')}
      `;
      ctaBtn.addEventListener('click', () => {
        if (typeof App !== 'undefined') App.onNavClick?.('browse');
      });
      content.appendChild(ctaBtn);
    }

    // Only songs in recents row (folders row removed; replaced by playlists)
    const recentSongs = recents.filter(r => r.type === 'song');

    content.appendChild(_buildHomeSection(t('pinned'), pinned, 'pinned'));
    // Playlists row: only rendered if user has playlists
    if (playlists.length > 0) {
      content.appendChild(_buildHomeSection(t('recent_playlists'), playlists, 'playlists'));
    }
    content.appendChild(_buildHomeSection(t('recents_songs'), recentSongs, 'recents'));
    content.appendChild(_buildHomeSection(t('top_played'), topPlayed, 'top_played'));
  }

  /**
   * Build a home section with the appropriate layout based on type.
   * @param {string} title
   * @param {Object[]} items
   * @param {'pinned'|'recents'|'top_played'} type
   */
  function _buildHomeSection(title, items, type) {
    const section = document.createElement('div');
    section.className = 'home-section';

    const headerEl = document.createElement('div');
    headerEl.className = 'home-section-header';
    headerEl.innerHTML = `<span class="home-section-title">${title}</span>`;
    section.appendChild(headerEl);

    // Empty state per section
    if (items.length === 0) {
      const ph = document.createElement('div');
      ph.className = 'home-section-empty';
      ph.textContent =
        type === 'pinned'    ? t('empty_pinned') :
        type === 'top_played'? t('empty_top_played') :
        title === t('recents_folders') ? t('empty_recents_folders') :
                               t('empty_recents_songs');
      section.appendChild(ph);
      return section;
    }

    if (type === 'pinned') {
      // 2-column wide-card grid — folders first, then songs
      const grid = document.createElement('div');
      grid.className = 'pinned-grid';
      const sorted = [...items].sort((a, b) => {
        const aFolder = (a.isFolder || a.type === 'folder') ? 0 : 1;
        const bFolder = (b.isFolder || b.type === 'folder') ? 0 : 1;
        return aFolder - bFolder;
      });
      sorted.forEach(item => grid.appendChild(_buildPinnedCard(item)));
      section.appendChild(grid);

    } else if (type === 'top_played') {
      // Numbered ranked list
      const list = document.createElement('div');
      list.className = 'top-list';
      items.slice(0, 12).forEach((item, i) => list.appendChild(_buildTopPlayedItem(item, i + 1)));
      section.appendChild(list);

    } else if (type === 'playlists') {
      // Playlists: horizontal scroll with mosaic-cover cards
      const scroll = document.createElement('div');
      scroll.className = 'home-cards-scroll';
      items.forEach(pl => scroll.appendChild(_buildPlaylistHomeCard(pl)));
      section.appendChild(scroll);
      _bindDragScroll(scroll);

    } else {
      // recents: horizontal square-card scroll
      const scroll = document.createElement('div');
      scroll.className = 'home-cards-scroll';
      items.forEach(item => scroll.appendChild(_buildHomeCard(item)));
      section.appendChild(scroll);
      // Enable mouse-drag scrolling (desktop)
      _bindDragScroll(scroll);
    }

    return section;
  }

  /** Pinned card: cover art (or colored square for folders) + play overlay + name + 3-dot */
  function _buildPinnedCard(item) {
    const card = document.createElement('div');
    card.className = 'pinned-card';

    const isFolder = item.isFolder || item.type === 'folder';

    // Flat background: one color for all folders, one for songs without cover
    const bg = isFolder ? '#1E3A5F' : '#1E4040';

    // For songs: show stored thumbnailUrl immediately; async cover injected later by _prefetchPinnedCovers.
    // For folders: always show folder icon over colored square (no cover art).
    const storedUrl = !isFolder ? (item.thumbnailUrl || item.thumbnailLink || null) : null;
    const imgHtml   = storedUrl ? `<img class="pinned-art-img" src="${escHtml(storedUrl)}" alt="">` : '';
    const iconHtml  = isFolder
      ? `<div class="pinned-art-icon">${iconFolder(26)}</div>`
      : (storedUrl ? '' : `<div class="pinned-art-icon">${iconMusicNote(24)}</div>`);

    const artist = !isFolder ? (item.artist || '') : '';

    card.innerHTML = `
      <div class="pinned-card-art" data-id="${escHtml(item.id)}" style="background:${bg}">
        ${imgHtml}${iconHtml}
        <div class="pinned-art-play">${iconPlay(13)}</div>
      </div>
      <div class="pinned-card-info">
        <span class="pinned-card-name">${escHtml(item.displayName || item.name)}</span>
        ${artist ? `<span class="pinned-card-artist">${escHtml(artist)}</span>` : ''}
      </div>
      <button class="btn-more pinned-card-more" aria-label="Más opciones">${iconDots(14)}</button>
    `;

    // Art square → immediate playback
    card.querySelector('.pinned-card-art').addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof App === 'undefined') return;
      if (isFolder) {
        App.onFolderPlay(item);
      } else {
        if (typeof Player !== 'undefined') Player.setQueue([item], 0);
      }
    });

    // 3-dot button → context menu
    card.querySelector('.pinned-card-more').addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e, 'pinned', item);
    });

    // Name / card body → navigate (open folder or play song)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.pinned-card-more') || e.target.closest('.pinned-card-art')) return;
      if (typeof App !== 'undefined') App.onHomeCardClick(item);
    });

    return card;
  }

  /** Ranked top-played list item: rank + cover + title + artist + album + year + count */
  function _buildTopPlayedItem(item, rank) {
    const el = document.createElement('div');
    el.className = 'top-list-item';
    el.dataset.id = item.id;

    const isFolder = item.isFolder || item.type === 'folder';

    // Prefer ID3 cover, fall back to Drive thumbnail
    const meta    = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
    const title   = meta?.title  || item.displayName || item.name || '—';
    const artist  = meta?.artist || item.artist  || '';
    const album   = meta?.album  || item.album   || item.albumName || '';
    const year    = meta?.year   || item.year    || '';
    const coverSrc = meta?.coverUrl || item.coverUrl || item.thumbnailUrl || item.thumbnailLink || '';

    const thumbHtml = coverSrc
      ? `<img src="${coverSrc}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-disabled)">${isFolder ? iconFolder(18) : iconMusicNote(18)}</div>`;

    // Secondary line: artist | album · year (only non-empty parts)
    const metaParts = [artist, [album, year].filter(Boolean).join(' · ')].filter(Boolean);
    const metaLine  = metaParts.join(' — ');

    el.innerHTML = `
      <span class="top-list-rank">${rank}</span>
      <div class="top-list-thumb">${thumbHtml}</div>
      <div class="top-list-info">
        <div class="top-list-title">${escHtml(title)}</div>
        ${metaLine ? `<div class="top-list-meta">${escHtml(metaLine)}</div>` : ''}
      </div>
      ${item.playCount ? `<span class="top-list-count">${item.playCount}</span>` : ''}
      <button class="btn-more" aria-label="Más opciones">${iconDots()}</button>
    `;

    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-more')) return;
      if (typeof App !== 'undefined') App.onHomeCardClick(item);
    });

    el.querySelector('.btn-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e, 'top_played', item);
    });

    return el;
  }

  function _buildHomeCard(item) {
    const card = document.createElement('div');
    card.className = 'home-card';
    card.dataset.id = item.id;

    const isFolder = item.isFolder || item.type === 'folder';

    const coverSrc = item.thumbnailUrl || item.thumbnailLink || null;
    const artist = item.artist || '';
    card.innerHTML = `
      <div class="home-card-art">
        ${coverSrc
          ? `<img src="${coverSrc}" alt="" loading="lazy" draggable="false">`
          : isFolder
            ? `<div class="folder-icon-placeholder">${iconFolder(32)}</div>`
            : `<div class="folder-icon-placeholder" style="color:var(--text-disabled)">${iconMusicNote(28)}</div>`
        }
      </div>
      <button class="home-card-more" aria-label="Más opciones">${iconDots(14)}</button>
      <div class="home-card-name">${escHtml(item.displayName || item.name || '—')}</div>
      ${artist && !isFolder ? `<div class="home-card-sub">${escHtml(artist)}</div>` : ''}
    `;

    card.querySelector('.home-card-more').addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e, isFolder ? 'home_folder' : 'home_song', item);
    });

    card.addEventListener('click', (e) => {
      if (e.target.closest('.home-card-more')) return;
      if (typeof App !== 'undefined') App.onHomeCardClick(item);
    });

    return card;
  }

  /** Playlist home card: 2×2 mosaic cover + name + song count */
  function _buildPlaylistHomeCard(pl) {
    const card = document.createElement('div');
    card.className = 'home-card';
    card.dataset.plid = pl.id;

    const covers = pl.resolvedCovers || [];
    const count  = pl.songIds ? pl.songIds.length : 0;

    card.innerHTML = `
      <div class="home-card-art home-card-art--mosaic">
        ${_buildPlaylistMosaic(covers, pl.name)}
      </div>
      <div class="home-card-name">${escHtml(pl.name || '—')}</div>
      <div class="home-card-sub">${count} ${count === 1 ? 'canción' : 'canciones'}</div>
    `;

    card.addEventListener('click', () => {
      if (typeof App !== 'undefined') App.onPlaylistHomeCardClick(pl);
    });

    return card;
  }

  /* ── History screen ──────────────────────────────────────── */

  /**
   * Render the Historial screen with a top-list style numbered list.
   * @param {Object[]} items - history items from DB.getHistory()
   */
  function renderHistory(items) {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '';

    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'home-section-empty';
      empty.style.padding = '32px 16px';
      empty.textContent = t('empty_history');
      container.appendChild(empty);
      return;
    }

    items.forEach((item, i) => {
      const el = _buildHistoryItem(item, i + 1);
      container.appendChild(el);
    });
  }

  /** Build a single history list item (same appearance as top-played). */
  function _buildHistoryItem(item, rank) {
    const el = document.createElement('div');
    el.className = 'top-list-item';
    el.dataset.id = item.id;

    const meta     = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
    const title    = meta?.title  || item.displayName || item.name || '—';
    const artist   = meta?.artist || item.artist  || '';
    const coverSrc = meta?.coverUrl || item.thumbnailUrl || '';

    const thumbHtml = coverSrc
      ? `<img src="${coverSrc}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-disabled)">${iconMusicNote(18)}</div>`;

    el.innerHTML = `
      <span class="top-list-rank">${rank}</span>
      <div class="top-list-thumb">${thumbHtml}</div>
      <div class="top-list-info">
        <div class="top-list-title">${escHtml(title)}</div>
        ${artist ? `<div class="top-list-meta">${escHtml(artist)}</div>` : ''}
      </div>
      <button class="btn-more" aria-label="Más opciones">${iconDots()}</button>
    `;

    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-more')) return;
      if (typeof App !== 'undefined') App.onHomeCardClick(item);
    });

    el.querySelector('.btn-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e, 'history', item);
    });

    return el;
  }

  /* ── Drag-to-scroll for recent cards ────────────────────── */

  /**
   * Enable pointer-drag horizontal scrolling on a .home-cards-scroll element.
   * Attached after the DOM node is created so we call this from renderHome.
   * @param {HTMLElement} el
   */
  function _bindDragScroll(el) {
    if (!el || el._dragBound) return;
    el._dragBound = true;

    // Pointer must travel this many px before we treat it as a drag (not a click).
    const DRAG_THRESHOLD = 6;

    let _pressing     = false;
    let _hasDragged   = false;
    let _startClientX = 0;
    let _scrollLeft   = 0;

    // Listeners attached to document so the drag keeps working even when
    // the pointer leaves the scroll container — without setPointerCapture,
    // which would redirect click events away from the actual card target.
    const _onDocMove = (e) => {
      if (!_pressing) return;
      const dx = e.clientX - _startClientX;
      if (Math.abs(dx) < DRAG_THRESHOLD) return; // still within click tolerance
      _hasDragged         = true;
      el.style.cursor     = 'grabbing';
      el.style.userSelect = 'none';
      el.scrollLeft       = _scrollLeft - dx;
    };

    const _onDocUp = () => {
      if (!_pressing) return;
      _pressing           = false;
      el.style.cursor     = '';
      el.style.userSelect = '';
      document.removeEventListener('pointermove', _onDocMove);
      document.removeEventListener('pointerup',   _onDocUp);
      document.removeEventListener('pointercancel', _onDocUp);
      // _hasDragged stays true until the click event fires and clears it
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.home-card-more')) return;
      _pressing     = true;
      _hasDragged   = false;
      _startClientX = e.clientX;
      _scrollLeft   = el.scrollLeft;
      // Track pointer globally so drag continues even outside el
      document.addEventListener('pointermove',  _onDocMove);
      document.addEventListener('pointerup',    _onDocUp);
      document.addEventListener('pointercancel', _onDocUp);
    });

    // Suppress click only when a drag actually happened.
    // Capture phase so we run before the card's own listener.
    el.addEventListener('click', (e) => {
      if (_hasDragged) {
        _hasDragged = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, { capture: true });
  }

  /* ── Browse (Examinar) ───────────────────────────────────── */

  /**
   * Render the breadcrumb trail (file-explorer style).
   * The current folder name is shown prominently in #browse-folder-name.
   * The parent path (all crumbs except current) is shown in .browse-path
   * as small accent-colored clickable chips — they ARE the back navigation.
   * No back button needed.
   *
   * @param {{ id: string, name: string }[]} trail - array from root to current
   */
  function renderBreadcrumb(trail) {
    // ── 1. Update current folder name in header ────────────
    const folderNameEl = document.getElementById('browse-folder-name');
    if (folderNameEl) {
      folderNameEl.textContent = trail.length > 0
        ? trail[trail.length - 1].name
        : 'Mi Drive';
    }

    // ── 1b. Show back button whenever we're inside any folder
    const backBtn = document.getElementById('btn-browse-back');
    if (backBtn) backBtn.style.display = trail.length >= 1 ? '' : 'none';

    // ── 2. Render parent path (all crumbs except last) ─────
    const container = document.querySelector('#screen-browse .browse-path');
    if (!container) return;

    container.innerHTML = '';

    const parents = trail.slice(0, -1); // everything before the current folder

    if (parents.length === 0) {
      // At root — no parent trail to show
      container.setAttribute('data-empty', '1');
      return;
    }

    container.removeAttribute('data-empty');

    parents.forEach((crumb, i) => {
      const el = document.createElement('span');
      el.className = 'breadcrumb-item';
      el.textContent = crumb.name;
      el.title = `Ir a "${crumb.name}"`;
      el.addEventListener('click', () => {
        if (typeof App !== 'undefined') App.onBreadcrumbClick(crumb, i);
      });
      container.appendChild(el);

      // Separator after each parent
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      container.appendChild(sep);
    });
  }

  /**
   * Render folder contents (folders + files) into the browse screen.
   * @param {DriveItem[]} folders
   * @param {DriveItem[]} files
   * @param {string|null} activeSongId - currently playing song id (for active state)
   */
  function renderFolderContents(folders, files, activeSongId = null) {
    const screen = document.getElementById('screen-browse');
    if (!screen) return;

    let list = screen.querySelector('.item-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'item-list';
      screen.appendChild(list);
    }
    list.innerHTML = '';

    if (folders.length === 0 && files.length === 0) {
      list.innerHTML = `<div class="empty-state">${iconFolder(36)}<p>${t('empty_folder')}</p></div>`;
      return;
    }

    // Folders
    folders.forEach(folder => list.appendChild(_buildFolderRow(folder)));

    // Section label if both folders and files
    if (folders.length > 0 && files.length > 0) {
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = t('songs');
      list.appendChild(label);
    }

    // Files
    files.forEach(file => list.appendChild(_buildSongRow(file, file.id === activeSongId)));
  }

  function _buildFolderRow(folder) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.dataset.id = folder.id;

    // Sub-label: song count if known, otherwise empty
    const subHtml = folder.songCount
      ? `<div class="folder-row-sub">${folder.songCount} ${t('songs').toLowerCase()}</div>`
      : '';

    row.innerHTML = `
      <div class="folder-icon">${iconFolder(22)}</div>
      <div class="folder-row-info">
        <div class="folder-row-name">${escHtml(folder.name)}</div>
        ${subHtml}
      </div>
      <button class="btn-more folder-more-btn" aria-label="Más opciones" data-id="${escHtml(folder.id)}">${iconDots()}</button>
      <div class="folder-row-chevron">${iconChevronRight()}</div>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-more')) return;
      if (typeof App !== 'undefined') App.onFolderClick(folder);
    });

    row.querySelector('.btn-more').addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e, 'folder', folder);
    });

    // Long-press or right-click for context menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'folder', folder);
    });

    return row;
  }

  function _buildSongRow(file, isActive = false) {
    const row = document.createElement('div');
    row.className = 'song-row' + (isActive ? ' active' : '') + (file.isWma ? ' wma' : '');
    row.dataset.id = file.id;

    // Build metadata string: "8.4 MB · MP3" or "Formato no compatible"
    const _ext  = (file.name || '').split('.').pop().toUpperCase();
    const _size = file.size ? formatBytes(parseInt(file.size, 10)) : '';
    const _meta = file.isWma
      ? t('format_unsupported')
      : [_size, _ext].filter(Boolean).join(' · ');

    row.innerHTML = `
      <div class="song-thumb">
        ${file.thumbnailUrl
          ? `<img src="${file.thumbnailUrl}" alt="" loading="lazy">`
          : `<div class="thumb-placeholder">${iconMusicNote(20)}</div>`
        }
        <div class="eq-bars">
          <div class="eq-bar"></div>
          <div class="eq-bar"></div>
          <div class="eq-bar"></div>
          <div class="eq-bar"></div>
        </div>
      </div>
      <div class="song-row-info">
        <div class="song-row-title">${escHtml(file.displayName || file.name)}</div>
        <div class="song-row-meta">${_meta}</div>
      </div>
      ${file.isWma ? `<span class="wma-badge">WMA</span>` : ''}
      <button class="btn-more" aria-label="Más opciones" data-id="${escHtml(file.id)}">${iconDots()}</button>
    `;

    // Register item in App cache so queue-building can resolve it by ID
    if (typeof App !== 'undefined') App._cacheItem(file);

    if (!file.isWma) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-more')) return;
        if (typeof App !== 'undefined') App.onSongClick(file);
      });

      row.querySelector('.btn-more').addEventListener('click', (e) => {
        e.stopPropagation();
        showContextMenu(e, 'song', file);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e, 'song', file);
      });
    }

    return row;
  }

  /** Mark a song row as the currently active track. */
  function setActiveSongRow(fileId) {
    document.querySelectorAll('.song-row').forEach(row => {
      const isActive = row.dataset.id === fileId;
      row.classList.toggle('active', isActive);
      // EQ bars only inside Browse screen, nowhere else
      const eqBars = row.querySelector('.eq-bars');
      if (eqBars) {
        const inBrowse = !!row.closest('#screen-browse');
        eqBars.style.display = (isActive && inBrowse) ? 'flex' : '';
      }
    });
  }

  /* ── Loading / empty states ──────────────────────────────── */

  function showLoading(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    let list = el.querySelector('.item-list');
    if (!list) { list = document.createElement('div'); list.className = 'item-list'; el.appendChild(list); }
    list.innerHTML = `<div class="loading-row"><div class="spinner"></div>${t('loading')}</div>`;
  }

  /* ── Context menu ────────────────────────────────────────── */

  const _ctxMenu = { el: null, target: null };

  /**
   * Show the context menu near the triggering event.
   * @param {MouseEvent|PointerEvent} e
   * @param {'song'|'folder'} type
   * @param {DriveItem} item
   */
  function showContextMenu(e, type, item) {
    const menu = document.getElementById('context-menu');
    if (!menu) return;

    _ctxMenu.el     = menu;
    _ctxMenu.target = item;

    // Build items
    menu.innerHTML = '';

    // Shared SVG icons for context menus
    const _iconNext   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM20 6v12h2V6h-2z"/></svg>`;
    const _iconQueue  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>`;
    const _iconFolder = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
    const _iconEdit   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm18.71-10.8a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;

    if (type === 'song') {
      _addCtxItem(menu, iconPlay(14),  t('ctx_play'),    () => { App.onSongClick(item);         hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconNext,     t('play_next'),   () => { Player.insertNext(item);        hideContextMenu(); });
      _addCtxItem(menu, _iconQueue,    t('play_after'),  () => { Player.appendToQueue(item);     hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconFolder,   t('ctx_go_to_album'), () => { App.onGoToFolder(item);    hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, iconStar(14),  t('add_fav'),     () => { App.onToggleStar(item);         hideContextMenu(); });
      _addCtxItem(menu, iconPlus(14),  t('add_to_pl'),  (e) => { hideContextMenu(); App.onShowPlaylistPicker(e, item); });
      if (item._playlistId) {
        _addCtxDivider(menu);
        _addCtxItem(menu, iconTrash(14), t('ctx_remove_from_pl'), () => { App.onRemoveFromPlaylist?.(item.id, item._playlistId); hideContextMenu(); });
      }
    }

    if (type === 'folder') {
      _addCtxItem(menu, iconPlay(14),   t('ctx_play'),           () => { App.onFolderPlay(item);              hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconNext,      t('play_next'),          () => { App.onFolderQueue(item, 'next');      hideContextMenu(); });
      _addCtxItem(menu, _iconQueue,     t('play_after'),         () => { App.onFolderQueue(item, 'end');       hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconFolder,    t('ctx_go_to_folder'),   () => { App.onGoToFolder(item);              hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, iconStar(14),   t('ctx_add_fav_folder'), () => { App.onToggleStar(item);              hideContextMenu(); });
      _addCtxItem(menu, iconPin(14),    t('ctx_pin_to_home'),    () => { App.onTogglePin(item);               hideContextMenu(); });
      _addCtxItem(menu, iconPlus(14),   t('add_to_pl'),         (e) => { hideContextMenu(); App.onShowPlaylistPicker(e, item); });
    }

    if (type === 'pinned') {
      const isFolder = item.isFolder || item.type === 'folder';
      _addCtxItem(menu, iconPlay(14), t('ctx_play'), () => {
        if (isFolder) { App.onFolderPlay(item); }
        else { if (typeof Player !== 'undefined') Player.setQueue([item], 0); }
        hideContextMenu();
      });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconFolder,
        isFolder ? t('ctx_go_to_folder') : t('ctx_go_to_album'),
        () => { App.onGoToFolder(item); hideContextMenu(); }
      );
      _addCtxDivider(menu);
      _addCtxItem(menu, iconPin(14), t('ctx_unpin_from_home'), () => {
        App.onTogglePin(item);
        hideContextMenu();
      });
    }

    if (type === 'top_played') {
      const isFolder = item.isFolder || item.type === 'folder';
      _addCtxItem(menu, iconPlay(14), t('ctx_play'), () => {
        if (isFolder) { App.onFolderPlay(item); }
        else { if (typeof Player !== 'undefined') Player.setQueue([item], 0); }
        hideContextMenu();
      });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconNext,  t('play_next'),  () => { isFolder ? App.onFolderQueue(item,'next') : Player.insertNext(item);     hideContextMenu(); });
      _addCtxItem(menu, _iconQueue, t('play_after'), () => { isFolder ? App.onFolderQueue(item,'end')  : Player.appendToQueue(item);  hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconFolder,
        isFolder ? t('ctx_go_to_folder') : t('ctx_go_to_album'),
        () => { App.onGoToFolder(item); hideContextMenu(); }
      );
      _addCtxDivider(menu);
      _addCtxItem(menu, iconStar(14), isFolder ? t('ctx_add_fav_folder') : t('add_fav'),
        () => { App.onToggleStar(item); hideContextMenu(); }
      );
      _addCtxItem(menu, iconPlus(14), t('add_to_pl'), (e) => { hideContextMenu(); App.onShowPlaylistPicker(e, item); });
      _addCtxItem(menu, iconPin(14),  t('ctx_pin_to_home'), () => { App.onTogglePin(item); hideContextMenu(); });
    }

    if (type === 'playlist') {
      _addCtxItem(menu, iconPlay(14),  t('ctx_play'),     () => { App.onPlaylistPlay?.(item);        hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconNext,     t('play_next'),    () => { App.onPlaylistQueue?.(item,'next'); hideContextMenu(); });
      _addCtxItem(menu, _iconQueue,    t('play_after'),   () => { App.onPlaylistQueue?.(item,'end');  hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconEdit,     t('ctx_rename'),   () => { hideContextMenu(); App.onRenamePlaylist?.(item); });
      _addCtxItem(menu, iconTrash(14), t('ctx_delete'),   () => { hideContextMenu(); App.onDeletePlaylist?.(item); });
    }

    // ── Recents home cards ───────────────────────────────────────

    if (type === 'home_song') {
      _addCtxItem(menu, iconPlay(14),  t('ctx_play'),           () => { Player.setQueue([item], 0);  hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconNext,     t('play_next'),          () => { Player.insertNext(item);      hideContextMenu(); });
      _addCtxItem(menu, _iconQueue,    t('play_after'),         () => { Player.appendToQueue(item);   hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconFolder,   t('ctx_go_to_album'),    () => { App.onGoToFolder(item);       hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, iconStar(14),  t('ctx_mark_fav'),       () => { App.onToggleStar(item);       hideContextMenu(); });
      _addCtxItem(menu, iconPlus(14),  t('add_to_pl'),         (e) => { hideContextMenu(); App.onShowPlaylistPicker(e, item); });
      _addCtxItem(menu, iconPin(14),   t('ctx_pin_to_home'),    () => { App.onTogglePin(item);        hideContextMenu(); });
      _addCtxItem(menu, iconTrash(14), t('ctx_remove_history'), () => { App.onRemoveFromHistory(item);hideContextMenu(); });
    }

    if (type === 'home_folder') {
      _addCtxItem(menu, iconPlay(14),  t('ctx_play'),           () => { App.onFolderPlay(item);          hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconNext,     t('play_next'),          () => { App.onFolderQueue(item, 'next'); hideContextMenu(); });
      _addCtxItem(menu, _iconQueue,    t('play_after'),         () => { App.onFolderQueue(item, 'end');  hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconFolder,   t('ctx_go_to_folder'),   () => { App.onGoToFolder(item);          hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, iconPin(14),   t('ctx_pin_to_home'),    () => { App.onTogglePin(item);           hideContextMenu(); });
      _addCtxItem(menu, iconTrash(14), t('ctx_remove_history'), () => { App.onRemoveFromHistory(item);   hideContextMenu(); });
    }

    // ── History screen items ─────────────────────────────────────

    if (type === 'history') {
      _addCtxItem(menu, iconPlay(14),  t('ctx_play'),        () => { Player.setQueue([item], 0);  hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconNext,     t('play_next'),       () => { Player.insertNext(item);      hideContextMenu(); });
      _addCtxItem(menu, _iconQueue,    t('play_after'),      () => { Player.appendToQueue(item);   hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, _iconFolder,   t('ctx_go_to_album'), () => { App.onGoToFolder(item);       hideContextMenu(); });
      _addCtxDivider(menu);
      _addCtxItem(menu, iconStar(14),  t('add_fav'),         () => { App.onToggleStar(item);       hideContextMenu(); });
      _addCtxItem(menu, iconPlus(14),  t('add_to_pl'),      (e) => { hideContextMenu(); App.onShowPlaylistPicker(e, item); });
      _addCtxDivider(menu);
      _addCtxItem(menu, iconTrash(14), t('ctx_remove_history'), () => { App.onRemoveFromHistoryItem(item); hideContextMenu(); });
    }

    // Position menu near cursor
    const margin = 8;
    const mw = 200;
    const mh = type === 'home_folder' ? 260
             : type === 'folder'    ? 270
             : type === 'home_song' ? 310
             : type === 'top_played'? 300
             : type === 'playlist'  ? 230
             : type === 'pinned'    ? 175
             : type === 'history'   ? 290
             : type === 'song'      ? 260
             : 200;
    let x = e.clientX || (e.touches?.[0]?.clientX || 0);
    let y = e.clientY || (e.touches?.[0]?.clientY || 0);

    x = Math.min(x, window.innerWidth - mw - margin);
    y = Math.min(y, window.innerHeight - mh - margin);

    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
    menu.classList.add('visible');

    // Click outside to dismiss
    requestAnimationFrame(() => {
      document.addEventListener('click', hideContextMenu, { once: true });
    });
  }

  function hideContextMenu() {
    document.getElementById('context-menu')?.classList.remove('visible');
  }

  /* ── Playlist picker ─────────────────────────────────────── */

  let _plPickerPendingItem = null;
  let _plPickerAllPlaylists = [];
  let _plPickerInitialized  = false;

  function _initPlaylistPicker() {
    if (_plPickerInitialized) return;
    _plPickerInitialized = true;

    // Search input → filter list in real-time
    document.getElementById('pl-picker-input')?.addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase();
      const filtered = term
        ? _plPickerAllPlaylists.filter(pl => pl.name.toLowerCase().includes(term))
        : _plPickerAllPlaylists;
      _renderPickerList(filtered);
    });

    // "Nueva playlist" row → show inline create input
    document.getElementById('pl-picker-new')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const createRow = document.getElementById('pl-picker-create');
      const newRow    = document.getElementById('pl-picker-new');
      const input     = document.getElementById('pl-picker-create-input');
      if (!createRow) return;
      createRow.classList.add('visible');
      newRow.style.display = 'none';
      input?.focus();
    });

    // Confirm create (button click)
    document.getElementById('pl-picker-create-confirm')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _confirmCreatePlaylist();
    });

    // Confirm create (Enter key)
    document.getElementById('pl-picker-create-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.stopPropagation(); _confirmCreatePlaylist(); }
      if (e.key === 'Escape') { hidePlaylistPicker(); }
    });

    // Search Escape → close picker
    document.getElementById('pl-picker-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePlaylistPicker();
    });
  }

  function _confirmCreatePlaylist() {
    const input = document.getElementById('pl-picker-create-input');
    const name  = input?.value?.trim();
    if (!name) { input?.focus(); return; }
    if (typeof App !== 'undefined') App.onCreateAndAddPlaylist(_plPickerPendingItem, name);
    hidePlaylistPicker();
  }

  function _renderPickerList(playlists) {
    const container = document.getElementById('pl-picker-list');
    if (!container) return;
    container.innerHTML = '';

    if (!playlists.length) {
      const empty = document.createElement('div');
      empty.className = 'pl-picker-empty';
      empty.textContent = t('no_results');
      container.appendChild(empty);
      return;
    }

    playlists.forEach(pl => {
      const row = document.createElement('div');
      row.className = 'pl-picker-item';
      row.textContent = pl.name;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof App !== 'undefined') App.onAddToPlaylist(_plPickerPendingItem, pl.id);
        hidePlaylistPicker();
      });
      container.appendChild(row);
    });
  }

  /**
   * Show the playlist picker panel near the triggering event.
   * @param {MouseEvent} e
   * @param {DriveItem} item — the song/folder to add
   * @param {Object[]}  playlists — from DB.getPlaylists()
   */
  function showPlaylistPicker(e, item, playlists) {
    _initPlaylistPicker();

    _plPickerPendingItem  = item;
    _plPickerAllPlaylists = playlists;

    const picker = document.getElementById('playlist-picker');
    if (!picker) return;

    // Reset state
    const searchInput  = document.getElementById('pl-picker-input');
    const createRow    = document.getElementById('pl-picker-create');
    const createInput  = document.getElementById('pl-picker-create-input');
    const newRow       = document.getElementById('pl-picker-new');
    if (searchInput)  searchInput.value = '';
    if (createRow)    createRow.classList.remove('visible');
    if (createInput)  createInput.value = '';
    if (newRow)       newRow.style.display = '';

    _renderPickerList(playlists);

    // Position near click — keep inside viewport
    const margin = 10;
    const pw = 280;
    const ph = Math.min(460, 110 + playlists.length * 42);
    let x = e.clientX || 0;
    let y = e.clientY || 0;
    if (x + pw + margin > window.innerWidth)  x = window.innerWidth  - pw - margin;
    if (y + ph + margin > window.innerHeight) y = window.innerHeight - ph - margin;
    x = Math.max(margin, x);
    y = Math.max(margin, y);

    picker.style.left = `${x}px`;
    picker.style.top  = `${y}px`;
    picker.classList.add('visible');

    requestAnimationFrame(() => searchInput?.focus());

    // Dismiss on outside click
    setTimeout(() => {
      document.addEventListener('click', _onPickerOutsideClick);
    }, 0);
  }

  function _onPickerOutsideClick(e) {
    const picker = document.getElementById('playlist-picker');
    if (!picker?.contains(e.target)) {
      hidePlaylistPicker();
    }
  }

  function hidePlaylistPicker() {
    document.getElementById('playlist-picker')?.classList.remove('visible');
    document.removeEventListener('click', _onPickerOutsideClick);
  }

  function _addCtxItem(menu, icon, label, onClick) {
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.innerHTML = `${icon}<span>${label}</span>`;
    item.addEventListener('click', onClick);
    menu.appendChild(item);
  }

  function _addCtxDivider(menu) {
    const div = document.createElement('div');
    div.className = 'ctx-divider';
    menu.appendChild(div);
  }

  /* ── Language ────────────────────────────────────────────── */

  function setLanguage(lang) {
    _currentLang = lang === 'en' ? 'en' : 'es';
    _updateStaticStrings();
  }

  function getLanguage() { return _currentLang; }

  function _updateStaticStrings() {
    // Update all elements with data-i18n attribute (textContent)
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      const val = t(key);
      if (val) el.textContent = val;
    });

    // Update elements with data-i18n-placeholder attribute (placeholder)
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.dataset.i18nPlaceholder;
      const val = t(key);
      if (val) el.placeholder = val;
    });

    // Update elements with data-i18n-label attribute (button label text child)
    // Used for buttons that contain an SVG + text span
    document.querySelectorAll('[data-i18n-label]').forEach(el => {
      const key = el.dataset.i18nLabel;
      const val = t(key);
      if (!val) return;
      // Find the last text node or a span inside the button
      const span = el.querySelector('span');
      if (span) { span.textContent = val; return; }
      // Fallback: set textContent of last child text node
      for (let i = el.childNodes.length - 1; i >= 0; i--) {
        const n = el.childNodes[i];
        if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
          n.textContent = ' ' + val;
          return;
        }
      }
    });

    // Specific non-data-i18n elements that still need updating
    // Search placeholder
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.placeholder = t('search_placeholder');

    // Playlist picker placeholders
    const plPickerInput = document.getElementById('pl-picker-input');
    if (plPickerInput) plPickerInput.placeholder = t('pl_picker_search');
    const plPickerCreate = document.getElementById('pl-picker-create-input');
    if (plPickerCreate) plPickerCreate.placeholder = t('pl_picker_name');

    // Queue panel title
    const queueHeaderTitle = document.querySelector('.queue-header-title');
    if (queueHeaderTitle) queueHeaderTitle.textContent = t('queue_title');

    // Library sidebar static items
    const libFavName = document.querySelector('#lib-fav-item .lib-sidebar-name');
    if (libFavName) libFavName.textContent = t('lib_favorites');
    const libNewPlName = document.querySelector('#btn-new-playlist .lib-sidebar-name');
    if (libNewPlName) libNewPlName.textContent = t('lib_new_playlist');
    const plPickerNewSpan = document.querySelector('#pl-picker-new span');
    if (plPickerNewSpan) plPickerNewSpan.textContent = t('lib_new_playlist');

    // Browse back button
    const browseBackSpan = document.querySelector('#btn-browse-back span');
    if (browseBackSpan) browseBackSpan.textContent = t('browse_back');

    // Token banner
    const tokenBannerSpan = document.querySelector('#token-banner > span');
    if (tokenBannerSpan) tokenBannerSpan.textContent = t('session_expiring');
    const tokenBannerBtn = document.getElementById('btn-renew-token');
    if (tokenBannerBtn) tokenBannerBtn.textContent = t('renew');

    // Player expanded top bar title
    const pexpTopTitle = document.querySelector('.pexp-topbar-title');
    if (pexpTopTitle) pexpTopTitle.textContent = t('queue_now_playing');

    // Queue in player action bar
    const pexpQueueSpan = document.querySelector('#btn-pexp-queue span');
    if (pexpQueueSpan) pexpQueueSpan.textContent = t('player_queue');

    // Speed and Timer buttons
    const pexpSpeedSpan = document.querySelector('#btn-pexp-speed span');
    if (pexpSpeedSpan) pexpSpeedSpan.textContent = t('player_speed');
    const pexpTimerSpan = document.querySelector('#btn-pexp-timer span');
    if (pexpTimerSpan) pexpTimerSpan.textContent = t('player_timer');
    const pexpLyricsSpan = document.querySelector('#btn-pexp-lyrics span');
    if (pexpLyricsSpan) pexpLyricsSpan.textContent = t('player_lyrics');
    const pexpShowAlbumSpan = document.querySelector('#btn-pexp-show-album span');
    if (pexpShowAlbumSpan) pexpShowAlbumSpan.textContent = t('player_show_album');

    // Mini-player queue button (desktop label)
    const miniQueueLabel = document.querySelector('#btn-mini-queue span');
    if (miniQueueLabel) miniQueueLabel.textContent = t('queue_title');
  }

  /* ── Icons (inline SVG) ──────────────────────────────────── */
  // All icons use currentColor and are sized via width/height attrs.

  function iconPlay(size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  }

  function iconPause(size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
  }

  function iconPrev(size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>`;
  }

  function iconNext(size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 6v12l8.5-6z"/></svg>`;
  }

  function iconFolder(size = 22) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  }

  function iconMusicNote(size = 20) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`;
  }

  function iconChevronRight(size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>`;
  }

  function iconDots(size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
  }

  function iconStar(size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
  }

  function iconPin(size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
  }

  function iconPlus(size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
  }

  function iconTrash(size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
  }

  function iconHome(size = 22) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`;
  }

  function iconSearch(size = 22) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
  }

  function iconLibrary(size = 22) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h2v12H4zm3 0h2v12H7zm3 0h12v2H10V6zm0 4h12v2H10v-2zm0 4h12v2H10v-2z"/></svg>`;
  }

  function iconSettings(size = 22) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84a.484.484 0 0 0-.47.41l-.36 2.54a7.024 7.024 0 0 0-1.62.94l-2.39-.96a.479.479 0 0 0-.59.22L2.74 8.87a.479.479 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.27.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54a7.024 7.024 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>`;
  }

  function iconGoogle(size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;
  }

  /* ── Queue panel ─────────────────────────────────────────── */

  /**
   * Toggle the queue panel on/off within #player-expanded.
   * @param {boolean} open
   */
  function showQueuePanel(open) {
    const el = document.getElementById('player-expanded');
    if (!el) return;
    el.classList.toggle('showing-queue', open);
    if (open) el.classList.remove('showing-lyrics');  // mutual exclusion
  }

  function isQueuePanelVisible() {
    return document.getElementById('player-expanded')?.classList.contains('showing-queue') ?? false;
  }

  /**
   * Render the queue list into #queue-list.
   * Groups into "Reproduciendo ahora" (current) and "A continuación" (rest).
   * @param {DriveItem[]} queue
   * @param {number}      currentIndex
   */
  function renderQueuePanel(queue, currentIndex) {
    const list      = document.getElementById('queue-list');
    const countEl   = document.getElementById('queue-count');
    if (!list) return;

    list.innerHTML = '';

    if (queue.length === 0 || !queue[currentIndex]) {
      list.innerHTML = `<div class="empty-state" style="padding:32px 16px;text-align:center;color:var(--text-disabled)">${t('queue_empty')}</div>`;
      if (countEl) countEl.textContent = '';
      return;
    }

    const after = queue.length - currentIndex - 1;
    if (countEl) countEl.textContent = after > 0 ? `${after} ${t('songs').toLowerCase()}` : '';

    // ── Section: Anteriores (ya reproducidas) ─────────────────
    const before = queue.slice(0, currentIndex);
    if (before.length > 0) {
      const prevLabel = document.createElement('div');
      prevLabel.className = 'queue-section-label';
      prevLabel.textContent = t('queue_previous');
      list.appendChild(prevLabel);

      before.forEach((item, i) => {
        const el = _buildQueueItem(item, i, false);
        el.classList.add('queue-item-played');
        list.appendChild(el);
      });
    }

    // ── Section: Reproduciendo ahora ─────────────────────────
    const nowLabel = document.createElement('div');
    nowLabel.className = 'queue-section-label';
    nowLabel.textContent = t('queue_now_playing');
    list.appendChild(nowLabel);

    list.appendChild(_buildQueueItem(queue[currentIndex], currentIndex, true));

    // ── Section: A continuación ───────────────────────────────
    const upcoming = queue.slice(currentIndex + 1);
    if (upcoming.length > 0) {
      const nextLabel = document.createElement('div');
      nextLabel.className = 'queue-section-label';
      nextLabel.textContent = t('queue_upcoming');
      list.appendChild(nextLabel);

      upcoming.forEach((item, i) => {
        list.appendChild(_buildQueueItem(item, currentIndex + 1 + i, false));
      });
    }
  }

  function _buildQueueItem(item, queueIndex, isActive) {
    const el = document.createElement('div');
    el.className = 'queue-item' + (isActive ? ' active' : '');
    el.dataset.queueIndex = queueIndex;
    el.dataset.id = item.id; // needed for async cover injection

    const meta = (typeof Meta !== 'undefined') ? Meta.getCached(item.id) : null;
    const title  = meta?.title  || item.displayName || item.name;
    const artist = meta?.artist || item.artist       || '';
    const cover  = meta?.coverUrl || item.thumbnailUrl || '';

    const thumbHtml = cover
      ? `<img src="${cover}" alt="">`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`;

    el.innerHTML = `
      <span class="queue-item-num">${isActive ? '' : queueIndex}</span>
      <div class="queue-item-thumb">${thumbHtml}</div>
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(title)}</div>
        ${artist ? `<div class="queue-item-artist">${escHtml(artist)}</div>` : ''}
      </div>
      ${isActive ? '' : `
        <button class="queue-remove-btn" aria-label="Quitar de la cola" data-queue-index="${queueIndex}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      `}
    `;

    if (!isActive) {
      // Click on row → jump to this track
      el.addEventListener('click', (e) => {
        if (e.target.closest('.queue-remove-btn')) return;
        if (typeof App !== 'undefined') App.onQueueItemClick(queueIndex);
      });

      // Remove button
      el.querySelector('.queue-remove-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof App !== 'undefined') App.onQueueItemRemove(queueIndex);
      });
    }

    return el;
  }

  /* ── Library — Starred Songs (Canciones) ────────────────── */

  /**
   * Render starred songs into the Canciones tab.
   * @param {Object[]} songs - array of { id, name, displayName, artist, albumName, size, thumbnailUrl }
   */
  function renderStarredSongs(songs) {
    const container = document.getElementById('lib-detail-content');
    if (!container) return;
    container.innerHTML = '';

    if (songs.length === 0) {
      const [line1, line2] = t('lib_no_favorites').split('\n');
      container.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
          <p>${line1}${line2 ? `<br>${line2}` : ''}</p>
        </div>`;
      return;
    }

    // Section header
    const header = document.createElement('div');
    header.className = 'lib-detail-header';
    const starIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    header.innerHTML = `${starIcon} ${t('lib_favorites')} <span class="lib-detail-count">${songs.length}</span>`;
    container.appendChild(header);

    songs.forEach(song => {
      const row = document.createElement('div');
      row.className = 'song-row lib-song-row';
      row.dataset.id = song.id;

      const _ext  = (song.name || '').split('.').pop().toUpperCase();
      const _size = song.size ? formatBytes(parseInt(song.size, 10)) : '';
      const _artist = song.artist || '';
      const _album  = song.albumName || '';
      const _sub = [_artist, _album].filter(Boolean).join(' · ') || [_size, _ext].filter(Boolean).join(' · ');

      row.innerHTML = `
        <div class="song-thumb">
          ${song.thumbnailUrl
            ? `<img src="${song.thumbnailUrl}" alt="" loading="lazy">`
            : `<div class="thumb-placeholder">${iconMusicNote(20)}</div>`
          }
        </div>
        <div class="song-row-info">
          <div class="song-row-title">${escHtml(song.displayName || song.name)}</div>
          <div class="song-row-meta">${escHtml(_sub)}</div>
        </div>
        <button class="lib-star-btn active" aria-label="Quitar de favoritas">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </button>
        <button class="btn-more" aria-label="Más opciones">${iconDots()}</button>
      `;

      row.querySelector('.lib-star-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof App !== 'undefined') App.onToggleStar(song);
        row.remove();
        // Update count
        const remaining = container.querySelectorAll('.lib-song-row').length;
        const hdr = container.querySelector('.lib-detail-header .lib-detail-count');
        if (hdr) hdr.textContent = remaining;
      });

      row.querySelector('.btn-more').addEventListener('click', (e) => {
        e.stopPropagation();
        showContextMenu(e, 'song', song);
      });

      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-more') || e.target.closest('.lib-star-btn')) return;
        if (typeof App !== 'undefined') App.onSongClick(song);
      });

      if (typeof App !== 'undefined') App._cacheItem(song);
      container.appendChild(row);
    });
  }

  /* ── Library — Playlist detail (right pane) ─────────────── */

  /**
   * Render songs for a selected playlist into #lib-detail-content.
   * @param {Object[]} songs  - array of metadata objects with .id
   * @param {string}   name   - playlist name for the header
   */
  function renderPlaylistDetail(songs, name) {
    const container = document.getElementById('lib-detail-content');
    if (!container) return;
    container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'lib-detail-header';
    const plIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm13-4v8l5-4-5-4z"/></svg>`;
    header.innerHTML = `${plIcon} ${escHtml(name)} <span class="lib-detail-count">${songs.length}</span>`;

    // "Reproducir" play-all button — only shown when playlist is non-empty
    if (songs.length > 0) {
      const playBtn = document.createElement('button');
      playBtn.className = 'pl-detail-play-btn';
      playBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> <span>${t('ctx_play')}</span>`;
      playBtn.addEventListener('click', () => {
        if (typeof App !== 'undefined') App.onPlaylistPlay(songs);
      });
      header.appendChild(playBtn);
    }

    container.appendChild(header);

    if (songs.length === 0) {
      const [line1, line2] = t('lib_playlist_empty').split('\n');
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `<p>${line1}${line2 ? `<br>${line2}` : ''}</p>`;
      container.appendChild(empty);
      return;
    }

    songs.forEach(song => {
      const row = document.createElement('div');
      row.className = 'song-row lib-song-row';
      row.dataset.id = song.id;

      const _ext    = (song.name || '').split('.').pop().toUpperCase();
      const _size   = song.size ? formatBytes(parseInt(song.size, 10)) : '';
      const _artist = song.artist || '';
      const _album  = song.albumName || '';
      const _sub = [_artist, _album].filter(Boolean).join(' · ') || [_size, _ext].filter(Boolean).join(' · ');

      row.innerHTML = `
        <div class="song-thumb">
          ${song.thumbnailUrl
            ? `<img src="${song.thumbnailUrl}" alt="">`
            : `<div class="thumb-placeholder">${iconMusicNote(20)}</div>`
          }
        </div>
        <div class="song-row-info">
          <div class="song-row-title">${escHtml(song.displayName || song.name || song.id)}</div>
          <div class="song-row-meta">${escHtml(_sub)}</div>
        </div>
        <button class="btn-more" aria-label="Más opciones">${iconDots()}</button>
      `;

      row.querySelector('.btn-more').addEventListener('click', e => {
        e.stopPropagation();
        showContextMenu(e, 'song', song);
      });

      row.addEventListener('click', e => {
        if (e.target.closest('.btn-more')) return;
        if (typeof App !== 'undefined') App.onSongClick(song);
      });

      if (typeof App !== 'undefined') App._cacheItem?.(song);
      container.appendChild(row);
    });
  }

  /* ── Library — Artistas ──────────────────────────────────── */

  /**
   * Render artists into the Artistas tab.
   * @param {Object[]} artists - array of { id, name, songCount }
   */
  function renderArtists(artists) {
    const container = document.getElementById('lib-artists');
    if (!container) return;
    container.innerHTML = '';

    if (artists.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          <p>${t('lib_no_artists')}</p>
        </div>`;
      return;
    }

    // Count header
    const header = document.createElement('div');
    header.className = 'lib-count-header';
    header.textContent = `${artists.length} ${t('artists').toUpperCase()}`;
    container.appendChild(header);

    const AVATAR_COLORS = ['#2A3D6A','#2A4A2A','#4A2A2A','#3A2A4A','#1A3A4A','#4A3A1A','#3A1A4A','#1A4A3A','#3A3A1A'];

    artists.forEach(artist => {
      const row = document.createElement('div');
      row.className = 'artist-row';

      // Deterministic avatar color
      const hash = [...(artist.name || '')].reduce((a, c) => a + c.charCodeAt(0), 0);
      const bg   = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];

      // Initials: up to 2 letters
      const parts    = (artist.name || '').trim().split(/\s+/);
      const initials = parts.length >= 2
        ? (parts[0][0] + parts[1][0]).toUpperCase()
        : (artist.name || '?').substring(0, 2).toUpperCase();

      row.innerHTML = `
        <div class="artist-avatar" style="background:${bg}">${initials}</div>
        <div class="artist-info">
          <div class="artist-name">${escHtml(artist.name)}</div>
          <div class="artist-sub">${t('lib_artist_fav')}</div>
        </div>
        <button class="btn-more" aria-label="Más opciones">${iconDots()}</button>
      `;

      row.addEventListener('click', () => {
        if (typeof App !== 'undefined') App.onArtistClick?.(artist);
      });

      container.appendChild(row);
    });
  }

  /* ── Library — Playlists ─────────────────────────────────── */

  /**
   * Render playlists into the Playlists tab.
   * @param {Object[]} playlists - array of { id, name, songs: [], coverUrls: [] }
   */
  // Playlist sort state (persists between renders)
  let _plSortMode = 'recent'; // 'recent' | 'az' | 'za'

  function renderPlaylists(playlists) {
    const container = document.getElementById('playlists-list');
    if (!container) return;
    container.innerHTML = '';

    // ── Sort bar ───────────────────────────────────────────────
    const sortBar = document.createElement('div');
    sortBar.className = 'pl-sort-bar';
    [
      { mode: 'recent', label: t('pl_sort_recent') },
      { mode: 'az',     label: 'A–Z'               },
      { mode: 'za',     label: 'Z–A'               },
    ].forEach(({ mode, label }) => {
      const btn = document.createElement('button');
      btn.className = 'pl-sort-btn' + (mode === _plSortMode ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _plSortMode = mode;
        renderPlaylists(_lastPlaylists || playlists);
      });
      sortBar.appendChild(btn);
    });
    container.appendChild(sortBar);

    if (playlists.length === 0) return;

    // Remember for re-render on sort change
    _lastPlaylists = playlists;

    // Apply sort
    const sorted = [...playlists];
    if (_plSortMode === 'az') sorted.sort((a, b) => a.name.localeCompare(b.name));
    if (_plSortMode === 'za') sorted.sort((a, b) => b.name.localeCompare(a.name));
    // 'recent' = as returned from DB (insertion order)

    sorted.forEach(pl => {
      const item = document.createElement('div');
      item.className = 'lib-sidebar-item';
      item.dataset.plId = pl.id;

      // Thumbnail: first cover or mosaic placeholder
      const firstCover = (pl.coverUrls || [])[0];
      const thumbHtml = firstCover
        ? `<img src="${firstCover}" alt="">`
        : _buildMosaicThumb(pl.coverUrls || [], pl.name);

      const songCount = pl.songIds?.length || 0;
      const songNoun  = songCount === 1
        ? (_currentLang === 'es' ? 'canción' : 'song')
        : (_currentLang === 'es' ? 'canciones' : 'songs');
      item.innerHTML = `
        <div class="lib-sidebar-thumb">${thumbHtml}</div>
        <div class="lib-sidebar-info">
          <span class="lib-sidebar-name" title="${escHtml(pl.name)}">${escHtml(pl.name)}</span>
          <span class="lib-sidebar-count">${songCount} ${songNoun}</span>
        </div>
        <button class="pl-item-more" aria-label="Más opciones">${iconDots()}</button>
      `;

      // Click on item (not the more button) → open detail
      item.addEventListener('click', (e) => {
        if (e.target.closest('.pl-item-more')) return;
        document.querySelectorAll('.lib-sidebar-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        if (typeof App !== 'undefined') App.onPlaylistClick?.(pl);
      });

      // 3-dot menu
      item.querySelector('.pl-item-more').addEventListener('click', (e) => {
        e.stopPropagation();
        showContextMenu(e, 'playlist', pl);
      });

      container.appendChild(item);
    });
  }

  // Stored for sort re-render without re-fetching
  let _lastPlaylists = [];

  /** Tiny 2×2 colored mosaic for sidebar thumbnail (30×30). */
  function _buildMosaicThumb(coverUrls, name) {
    const COLORS = ['#2A3D6A','#2A4A2A','#4A2A2A','#3A2A4A','#1A3A4A','#4A3A1A'];
    const hash = [...(name||'')].reduce((a,c) => a + c.charCodeAt(0), 0);
    const cells = [0,1,2,3].map(i => {
      const url = coverUrls[i];
      const bg  = url ? `#000` : COLORS[(hash+i) % COLORS.length];
      const img = url ? `<img src="${url}" style="width:100%;height:100%;object-fit:cover;display:block">` : '';
      return `<div style="flex:1;background:${bg}">${img}</div>`;
    });
    return `<div style="display:grid;grid-template-columns:1fr 1fr;width:100%;height:100%">${cells.join('')}</div>`;
  }

  /**
   * Build a 2×2 mosaic thumbnail for a playlist.
   * If < 4 covers, fills with colored squares using the playlist name hash.
   */
  function _buildPlaylistMosaic(coverUrls, name) {
    const MOSAIC_COLORS = ['#2A3D6A','#2A4A2A','#4A2A2A','#3A2A4A','#1A3A4A','#4A3A1A'];
    const hash  = [...(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0);
    const cells = [0, 1, 2, 3].map(i => {
      const url = coverUrls[i];
      if (url) {
        return `<div class="mosaic-cell" style="background:#000"><img src="${url}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block"></div>`;
      }
      const bg = MOSAIC_COLORS[(hash + i) % MOSAIC_COLORS.length];
      return `<div class="mosaic-cell" style="background:${bg}"></div>`;
    });
    return cells.join('');
  }

  /* ── Search results rendering ────────────────────────────── */

  /**
   * Render search results into #search-results.
   * @param {{ folders: Object[], files: Object[] }} results
   * @param {string} filter - 'all' | 'songs' | 'folders'
   */
  /**
   * Update the count badge on each search filter chip.
   * Pass null to clear all counts (e.g. while searching or on nav away).
   * @param {{ all: number, songs: number, folders: number } | null} counts
   */
  function updateSearchChipCounts(counts) {
    const isMobile = !window.matchMedia('(min-width: 768px)').matches;

    // ── Desktop: counts inside chip buttons ──────────────────
    document.querySelectorAll('.filter-chip[data-filter]').forEach(chip => {
      const badge = chip.querySelector('.chip-count');
      if (!badge) return;
      if (counts === null || isMobile) {
        badge.textContent = '';
        badge.style.display = 'none';
      } else {
        const n = counts[chip.dataset.filter] ?? 0;
        if (n > 0) {
          badge.textContent = `${n}`;
          badge.style.display = 'inline';
        } else {
          badge.textContent = '';
          badge.style.display = 'none';
        }
      }
    });

    // ── Mobile: plain count bar below chips ──────────────────
    const bar = document.getElementById('search-count-bar');
    if (!bar) return;
    if (counts === null || !isMobile) {
      bar.textContent = '';
      bar.style.display = 'none';
    } else {
      const nSongs   = counts.songs   ?? 0;
      const nFolders = counts.folders ?? 0;
      if (nSongs === 0 && nFolders === 0) {
        bar.textContent = '';
        bar.style.display = 'none';
      } else {
        const parts = [];
        if (nSongs   > 0) parts.push(`${nSongs} ${nSongs   === 1 ? 'canción' : 'canciones'}`);
        if (nFolders > 0) parts.push(`${nFolders} ${nFolders === 1 ? 'carpeta' : 'carpetas'}`);
        bar.textContent = parts.join(' · ');
        bar.style.display = 'block';
      }
    }
  }

  function renderSearchResults(results, filter = 'all') {
    const container = document.getElementById('search-results');
    if (!container) return;
    container.innerHTML = '';

    const nFolders = (results.folders || []).length;
    const nFiles   = (results.files   || []).length;
    updateSearchChipCounts({ all: nFolders + nFiles, songs: nFiles, folders: nFolders });

    const folders = (filter === 'songs') ? [] : (results.folders || []);
    const files   = (filter === 'folders') ? [] : (results.files || []);

    if (folders.length === 0 && files.length === 0) {
      container.innerHTML = `<div class="empty-state"><p>${t('no_results')}</p></div>`;
      return;
    }

    if (folders.length > 0) {
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = t('folders');
      container.appendChild(label);
      folders.forEach(f => container.appendChild(_buildFolderRow(f)));
    }

    if (files.length > 0) {
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = t('songs');
      container.appendChild(label);
      files.forEach(f => container.appendChild(_buildSongRow(f)));
    }
  }

  /* ── Utils ───────────────────────────────────────────────── */

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Loading wave overlay ───────────────────────────────── */

  const _WAVE_HTML = `<div class="savart-loading-overlay" aria-hidden="true">
    <div class="savart-wave-wrap">
      <svg class="savart-wave-svg" viewBox="0 0 144 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 16 C6 8,18 8,24 16 C30 24,42 24,48 16
                 M48 16 C54 8,66 8,72 16 C78 24,90 24,96 16
                 M96 16 C102 8,114 8,120 16 C126 24,138 24,144 16"
              stroke="#4A88F5" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  </div>`;

  function setPlayerLoading(loading) {
    [
      document.querySelector('#mini-player .mini-thumb'),
      document.getElementById('pexp-art'),
    ].forEach(el => {
      if (!el) return;
      el.querySelector('.savart-loading-overlay')?.remove();
      if (loading) el.insertAdjacentHTML('beforeend', _WAVE_HTML);
    });
  }

  /**
   * Set heart/favorite button state on both mini-player and expanded player.
   * @param {boolean} active
   */
  function setHeartActive(active) {
    document.getElementById('btn-pexp-fav')?.classList.toggle('active', active);
    document.getElementById('btn-mini-star')?.classList.toggle('active', active);
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return {
    // Navigation
    showView,
    getCurrentView,
    // Feedback
    showToast,
    showTokenBanner,
    hideTokenBanner,
    // Mini-player
    setPlayerLoading,
    setHeartActive,
    updateMiniPlayer,
    updateProgress,
    // Expanded player
    setExpandedPlayerVisible,
    isExpandedPlayerVisible,
    updateExpandedPlayer,
    updateExpandedPlayerProgress,
    // Queue panel
    showQueuePanel,
    isQueuePanelVisible,
    renderQueuePanel,
    // Home
    renderHome,
    // History
    renderHistory,
    // Browse
    renderBreadcrumb,
    renderFolderContents,
    setActiveSongRow,
    showLoading,
    // Library
    renderStarredSongs,
    renderPlaylistDetail,
    renderArtists,
    renderPlaylists,
    // Search
    renderSearchResults,
    updateSearchChipCounts,
    // Context menu
    showContextMenu,
    hideContextMenu,
    // Playlist picker
    showPlaylistPicker,
    hidePlaylistPicker,
    // Language
    setLanguage,
    getLanguage,
    t,
    // Icons (available for use in index.html and other modules)
    iconPlay, iconPause, iconPrev, iconNext,
    iconFolder, iconMusicNote, iconHome, iconSearch, iconLibrary, iconSettings,
    iconChevronRight, iconDots, iconStar, iconPin, iconPlus, iconGoogle,
    // Utils
    escHtml,
  };
})();
