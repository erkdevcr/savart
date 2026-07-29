/* ============================================================
   Savart — YouTube Auth  (implicit / token flow)

   Problema: GIS añade drive.file al scope de YouTube (include_
   granted_scopes:true por defecto) y Google rechaza la combinación
   con Error 400. include_granted_scopes:false en la config de GIS
   no es suficiente — GIS construye la URL del popup con los scopes
   ya fusionados antes de abrir la ventana.

   Solución: _withScopePatch() parcha window.open temporalmente.
   Cuando GIS abre el popup OAuth, la URL ya lleva ambos scopes;
   el patch la reescribe con SOLO YT_SCOPE antes de que el popup
   llegue a Google. Sin cambios en Google Cloud Console.
   ============================================================ */

const YTAuth = (() => {

  const YT_SCOPE  = 'https://www.googleapis.com/auth/youtube.readonly';
  const LS_ACCESS = 'savart_yt_access_token';
  const LS_MARKER = 'savart_yt_authed';   // '1' cuando autenticado
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

  function isAuthenticated() {
    return localStorage.getItem(LS_MARKER) === '1';
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(LS_USER) || 'null'); }
    catch (_) { return null; }
  }

  /** Devuelve un access token válido; renueva silenciosamente si expiró. */
  async function getToken() {
    if (_accessToken && Date.now() < _expiresAt - 60_000) return _accessToken;
    return _refreshSilent();
  }

  /**
   * Abre el selector de cuenta de Google (popup) para autorizar YouTube.
   * Usa _withScopePatch para que el popup solo lleve youtube.readonly.
   */
  function login() {
    if (typeof google === 'undefined') return Promise.reject(new Error('GIS not loaded'));
    const clientId = CONFIG?.YT_CLIENT_ID || CONFIG.CLIENT_ID;
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id:              clientId,
        scope:                  YT_SCOPE,
        include_granted_scopes: false,
        callback: async (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          _saveToken(resp);
          _fetchUserInfo(resp.access_token).catch(() => {});
          if (_onLogin) _onLogin();
          resolve();
        },
        error_callback: (e) => reject(new Error(e?.type || 'auth_error')),
      });
      _withScopePatch(() => client.requestAccessToken({ prompt: 'select_account' }));
    });
  }

  function logout() {
    _clearTokens();
    if (_renewTimer) { clearTimeout(_renewTimer); _renewTimer = null; }
    if (_onLogout) _onLogout();
  }

  /* ── Scope patch ──────────────────────────────────────── */

  /**
   * Parcha window.open UNA sola vez antes de llamar a action().
   * Cuando GIS abre el popup OAuth, reescribe el scope en la URL
   * para que solo lleve YT_SCOPE (elimina drive.file y fuerza
   * include_granted_scopes=false antes de que llegue a Google).
   */
  function _withScopePatch(action) {
    const origOpen = window.open.bind(window);
    let restored = false;

    const restore = () => {
      if (!restored) { restored = true; window.open = origOpen; }
    };
    // Safety net: restaura aunque GIS nunca llame a window.open
    const safety = setTimeout(restore, 8000);

    window.open = function patchedOpen(url, name, features) {
      restore();            // restaurar antes de abrir (re-entrant safe)
      clearTimeout(safety);
      if (typeof url === 'string' && url.includes('accounts.google.com/o/oauth2')) {
        try {
          const u = new URL(url);
          u.searchParams.set('scope', YT_SCOPE);
          u.searchParams.set('include_granted_scopes', 'false');
          return origOpen(u.toString(), name, features);
        } catch (_) { /* URL parse error — abre sin modificar */ }
      }
      return origOpen(url, name, features);
    };

    try {
      action();
    } catch (e) {
      restore();
      clearTimeout(safety);
      throw e;
    }
  }

  /* ── Internal ─────────────────────────────────────────── */

  /**
   * Renovación silenciosa: prompt:'' no abre selector de cuentas
   * si el usuario ya dio consent. También usa el scope patch.
   */
  function _refreshSilent() {
    if (!isAuthenticated()) return Promise.reject(new Error('Not authenticated'));
    if (typeof google === 'undefined') return Promise.reject(new Error('GIS not loaded'));
    const clientId = CONFIG?.YT_CLIENT_ID || CONFIG.CLIENT_ID;
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id:              clientId,
        scope:                  YT_SCOPE,
        include_granted_scopes: false,
        callback: (resp) => {
          if (resp.error) {
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
      _withScopePatch(() => client.requestAccessToken({ prompt: '' }));
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
    localStorage.removeItem('savart_yt_refresh_token'); // compat versiones anteriores
  }

  return { init, isAuthenticated, getToken, getUser, login, logout };
})();
