/* ============================================================
   Savart — YouTube Auth  (implicit / token flow)

   Google no permite pedir youtube.readonly + drive.file en el
   mismo authorization-code request (Error 400: invalid_request).
   Solución: usar initTokenClient (implicit flow) — flujo distinto
   que no mezcla scopes con el cliente de Drive.

   Trade-off: no hay refresh token del lado del servidor.
   La renovación se hace con prompt:'' (silenciosa si el usuario
   ya dio consent). Si el usuario revoca el acceso, se hace logout.
   ============================================================ */

const YTAuth = (() => {

  const YT_SCOPE  = 'https://www.googleapis.com/auth/youtube.readonly';
  const LS_ACCESS = 'savart_yt_access_token';
  const LS_MARKER = 'savart_yt_authed';   // '1' cuando autenticado; reemplaza LS_REFRESH
  const LS_EXPIRY = 'savart_yt_expiry';
  const LS_USER   = 'savart_yt_user';     // JSON { name, email, picture }

  let _accessToken  = null;
  let _expiresAt    = 0;
  let _renewTimer   = null;
  let _onLogin      = null;
  let _onLogout     = null;

  /* ── Init ─────────────────────────────────────────────── */

  function init({ onLogin, onLogout } = {}) {
    _onLogin  = onLogin  || null;
    _onLogout = onLogout || null;
    _accessToken = localStorage.getItem(LS_ACCESS) || null;
    _expiresAt   = parseInt(localStorage.getItem(LS_EXPIRY) || '0', 10);
    _scheduleRenewal();
  }

  /* ── Public API ───────────────────────────────────────── */

  /** True si el usuario conectó su cuenta de YT en esta sesión o en una anterior. */
  function isAuthenticated() {
    return localStorage.getItem(LS_MARKER) === '1';
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(LS_USER) || 'null'); }
    catch (_) { return null; }
  }

  /**
   * Devuelve un access token válido.
   * Si expiró, intenta renovación silenciosa (sin popup).
   */
  async function getToken() {
    if (_accessToken && Date.now() < _expiresAt - 60_000) return _accessToken;
    return _refreshSilent();
  }

  /**
   * Abre el selector de cuenta de Google (popup) para autorizar YouTube.
   * Usa initTokenClient — flujo separado del de Drive, no mezcla scopes.
   */
  function login() {
    if (typeof google === 'undefined') return Promise.reject(new Error('GIS not loaded'));
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id:  CONFIG.CLIENT_ID,
        scope:      YT_SCOPE,
        callback:   async (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          _saveToken(resp);
          _fetchUserInfo(resp.access_token).catch(() => {});
          if (_onLogin) _onLogin();
          resolve();
        },
        error_callback: (e) => reject(new Error(e?.type || 'auth_error')),
      });
      // prompt:'select_account' fuerza la pantalla de elección de cuenta
      client.requestAccessToken({ prompt: 'select_account' });
    });
  }

  function logout() {
    _clearTokens();
    if (_renewTimer) { clearTimeout(_renewTimer); _renewTimer = null; }
    if (_onLogout) _onLogout();
  }

  /* ── Internal ─────────────────────────────────────────── */

  /**
   * Renovación silenciosa: prompt:'' no abre popup si el usuario ya dio consent.
   * Si falla (revocó acceso, sesión expirada, etc.) → logout silencioso.
   */
  function _refreshSilent() {
    if (!isAuthenticated()) return Promise.reject(new Error('Not authenticated'));
    if (typeof google === 'undefined') return Promise.reject(new Error('GIS not loaded'));
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id:  CONFIG.CLIENT_ID,
        scope:      YT_SCOPE,
        callback:   (resp) => {
          if (resp.error) {
            // Acceso revocado o error → logout silencioso
            _clearTokens();
            if (_onLogout) _onLogout();
            reject(new Error(resp.error));
            return;
          }
          _saveToken(resp);
          resolve(_accessToken);
        },
        error_callback: (e) => {
          _clearTokens();
          if (_onLogout) _onLogout();
          reject(new Error(e?.type || 'refresh_error'));
        },
      });
      client.requestAccessToken({ prompt: '' }); // silencioso
    });
  }

  function _saveToken(resp) {
    _accessToken = resp.access_token;
    _expiresAt   = Date.now() + (resp.expires_in || 3600) * 1000;
    localStorage.setItem(LS_ACCESS, _accessToken);
    localStorage.setItem(LS_EXPIRY, String(_expiresAt));
    localStorage.setItem(LS_MARKER, '1');
    _scheduleRenewal();
  }

  async function _fetchUserInfo(token) {
    try {
      const res  = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      localStorage.setItem(LS_USER, JSON.stringify({
        name:    data.name    || '',
        email:   data.email   || '',
        picture: data.picture || '',
      }));
    } catch (_) {}
  }

  function _scheduleRenewal() {
    if (_renewTimer) clearTimeout(_renewTimer);
    if (!isAuthenticated()) return;
    const delay = _expiresAt - Date.now() - 5 * 60_000; // 5 min antes de expirar
    if (delay > 0) _renewTimer = setTimeout(() => _refreshSilent().catch(() => {}), delay);
  }

  function _clearTokens() {
    _accessToken = null;
    _expiresAt   = 0;
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_MARKER);
    localStorage.removeItem(LS_EXPIRY);
    localStorage.removeItem(LS_USER);
    // Compat: limpiar también la clave vieja si existía
    localStorage.removeItem('savart_yt_refresh_token');
  }

  return { init, isAuthenticated, getToken, getUser, login, logout };
})();
