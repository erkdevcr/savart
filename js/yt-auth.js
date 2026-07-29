/* ============================================================
   Savart — YouTube Auth
   OAuth separado de Drive: el usuario puede conectar una cuenta
   de Google distinta solo para YouTube.
   Reutiliza los endpoints /exchange y /refresh del worker de Drive
   (mismo client_id / client_secret, distinto scope).
   ============================================================ */

const YTAuth = (() => {

  const YT_SCOPE   = 'https://www.googleapis.com/auth/youtube.readonly';
  const LS_ACCESS  = 'savart_yt_access_token';
  const LS_REFRESH = 'savart_yt_refresh_token';
  const LS_EXPIRY  = 'savart_yt_expiry';
  const LS_USER    = 'savart_yt_user';   // JSON { name, email, picture }

  let _accessToken = null;
  let _expiresAt   = 0;
  let _renewTimer  = null;
  let _codeClient  = null;
  let _onLogin     = null;
  let _onLogout    = null;

  /* ── Init ─────────────────────────────────────────────── */

  function init({ onLogin, onLogout } = {}) {
    _onLogin  = onLogin  || null;
    _onLogout = onLogout || null;
    _accessToken = localStorage.getItem(LS_ACCESS) || null;
    _expiresAt   = parseInt(localStorage.getItem(LS_EXPIRY) || '0', 10);
    _scheduleRenewal();
  }

  /* ── Public API ───────────────────────────────────────── */

  function isAuthenticated() {
    return !!localStorage.getItem(LS_REFRESH);
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(LS_USER) || 'null'); }
    catch (_) { return null; }
  }

  /**
   * Returns a valid access token, refreshing silently if needed.
   */
  async function getToken() {
    if (_accessToken && Date.now() < _expiresAt - 60_000) return _accessToken;
    return _refresh();
  }

  /**
   * Opens the Google OAuth popup scoped to YouTube.
   * The user can pick any Google account — different from their Drive account.
   */
  async function login() {
    const workerUrl = CONFIG?.AUTH_WORKER_URL;
    if (!workerUrl) throw new Error('No AUTH_WORKER_URL configured');
    if (typeof google === 'undefined') throw new Error('GIS not loaded');

    return new Promise((resolve, reject) => {
      // Always create a fresh code client so the user can pick any account.
      _codeClient = google.accounts.oauth2.initCodeClient({
        client_id: CONFIG.CLIENT_ID,
        scope:     YT_SCOPE,
        ux_mode:   'popup',
        callback: async (resp) => {
          if (resp.error || !resp.code) {
            reject(new Error(resp.error || 'no_code'));
            return;
          }
          try {
            await _exchangeCode(resp.code, workerUrl);
            if (_onLogin) _onLogin();
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        error_callback: (e) => reject(new Error(e?.type || 'auth_error')),
      });
      _codeClient.requestCode();
    });
  }

  function logout() {
    _clearTokens();
    if (_renewTimer) { clearTimeout(_renewTimer); _renewTimer = null; }
    if (_onLogout) _onLogout();
  }

  /* ── Internal ─────────────────────────────────────────── */

  async function _exchangeCode(code, workerUrl) {
    const res = await fetch(`${workerUrl}/exchange`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, redirect_uri: 'postmessage' }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(data.error);
    _saveTokens(data);
    _fetchUserInfo(data.access_token).catch(() => {});
  }

  async function _refresh() {
    const rt = localStorage.getItem(LS_REFRESH);
    if (!rt) throw new Error('No YT refresh token');
    const workerUrl = CONFIG?.AUTH_WORKER_URL;
    if (!workerUrl) throw new Error('No AUTH_WORKER_URL');

    const res = await fetch(`${workerUrl}/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh_token: rt }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      if (data.error === 'invalid_grant') {
        // Expired — silent logout
        _clearTokens();
        if (_onLogout) _onLogout();
      }
      throw new Error(data.error);
    }
    _accessToken = data.access_token;
    _expiresAt   = Date.now() + (data.expires_in || 3600) * 1000;
    localStorage.setItem(LS_ACCESS, _accessToken);
    localStorage.setItem(LS_EXPIRY, String(_expiresAt));
    _scheduleRenewal();
    return _accessToken;
  }

  function _saveTokens(data) {
    _accessToken = data.access_token;
    _expiresAt   = Date.now() + (data.expires_in || 3600) * 1000;
    localStorage.setItem(LS_ACCESS, _accessToken);
    localStorage.setItem(LS_EXPIRY, String(_expiresAt));
    if (data.refresh_token) localStorage.setItem(LS_REFRESH, data.refresh_token);
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
    if (!localStorage.getItem(LS_REFRESH)) return;
    const delay = _expiresAt - Date.now() - 5 * 60_000; // 5 min before expiry
    if (delay > 0) _renewTimer = setTimeout(() => _refresh().catch(() => {}), delay);
  }

  function _clearTokens() {
    _accessToken = null;
    _expiresAt   = 0;
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_REFRESH);
    localStorage.removeItem(LS_EXPIRY);
    localStorage.removeItem(LS_USER);
  }

  return { init, isAuthenticated, getToken, getUser, login, logout };
})();
