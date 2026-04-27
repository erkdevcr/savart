/* ============================================================
   Savart — Auth module
   Google Identity Services (GIS) — token client (implicit flow)
   ============================================================
   Key behaviors:
   - Access tokens last ~1h. GIS does NOT provide silent refresh.
   - requestToken() MUST be called from a user gesture (click).
   - We monitor expiry and show a renewal banner before it happens.
   - Tokens are kept in memory + localStorage (timestamp only, not
     the token itself — the actual token lives only in memory).
   ============================================================ */

const Auth = (() => {
  /* ── Private state ─────────────────────────────────────── */
  let _tokenClient  = null;
  let _accessToken  = null;   // lives in memory only
  let _expiresAt    = 0;      // epoch ms
  let _warnTimer    = null;   // setTimeout id for expiry warning
  let _onReady      = null;   // callback when a fresh token arrives
  let _onExpiring   = null;   // callback when token is about to expire
  let _onLogout     = null;   // callback when user logs out
  let _initialized  = false;

  /* ── LocalStorage keys ─────────────────────────────────── */
  const LS_EXPIRY  = 'savart_token_expiry';
  const LS_AUTHED  = 'savart_authed';       // "1" = user was authenticated before

  /* ── Init ──────────────────────────────────────────────── */
  /**
   * Initialize GIS token client.
   * Must be called after the GIS script has loaded.
   *
   * @param {Object} callbacks
   * @param {Function} callbacks.onReady    - called with no args when a valid token is available
   * @param {Function} callbacks.onExpiring - called when token will expire soon (show banner)
   * @param {Function} callbacks.onLogout   - called after logout
   */
  function init({ onReady, onExpiring, onLogout } = {}) {
    if (_initialized) return;
    _initialized = true;

    _onReady    = onReady    || (() => {});
    _onExpiring = onExpiring || (() => {});
    _onLogout   = onLogout   || (() => {});

    // Try to create token client now; if GIS hasn't loaded yet,
    // it will be created lazily when requestToken() is called or
    // when onGISLoad() fires via the script's onload attribute.
    _tryCreateClient();
    console.log('[Auth] Initialized.');
  }

  /**
   * Creates the GIS token client if GIS is ready and client doesn't exist yet.
   * Called on init() and again via onGISLoad() / requestToken() as fallback.
   */
  function _tryCreateClient() {
    if (_tokenClient) return;                          // already created
    if (!window.google?.accounts?.oauth2) return;      // GIS not loaded yet
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: _handleTokenResponse,
      error_callback: _handleTokenError,
    });
    console.log('[Auth] GIS token client ready.');
  }

  /**
   * Called by the GIS script's onload attribute.
   * Ensures the token client is created even if init() ran before GIS loaded.
   */
  function onGISLoad() {
    _tryCreateClient();
  }

  /* ── Token response handler ────────────────────────────── */
  function _handleTokenResponse(response) {
    console.log('[Auth] Token callback fired. Error?', response?.error || 'none');
    if (response.error) {
      console.error('[Auth] Token error:', response.error, response.error_description);
      UI?.showToast('Error de autenticación: ' + response.error, 'error');
      return;
    }

    const expiresInMs = (parseInt(response.expires_in, 10) || 3600) * 1000;
    _saveToken(response.access_token, expiresInMs);
    console.log('[Auth] Token saved. Calling _onReady, fn=', typeof _onReady);
    try {
      _onReady();
      console.log('[Auth] _onReady() completed OK');
    } catch(err) {
      console.error('[Auth] _onReady() threw:', err.message, err.stack);
    }
  }

  function _handleTokenError(error) {
    console.error('[Auth] GIS error:', error);
    // popup_closed_by_user is not a real error, user just closed the consent window
    if (error.type === 'popup_closed') return;
    if (error.type === 'popup_failed_to_open') {
      UI?.showToast('El popup fue bloqueado. Permite popups para localhost en Chrome.', 'error');
      return;
    }
    UI?.showToast('No se pudo autenticar con Google: ' + (error.type || error.message || ''), 'error');
  }

  /* ── Token storage ─────────────────────────────────────── */
  function _saveToken(token, expiresInMs) {
    _accessToken = token;
    _expiresAt   = Date.now() + expiresInMs;

    // Persist expiry time (not the token) so we know the user was authenticated
    try {
      localStorage.setItem(LS_EXPIRY, String(_expiresAt));
      localStorage.setItem(LS_AUTHED, '1');
    } catch (_) { /* private browsing — ignore */ }

    _scheduleExpiryWarning(expiresInMs);
  }

  function _scheduleExpiryWarning(expiresInMs) {
    if (_warnTimer) clearTimeout(_warnTimer);
    const warnIn = expiresInMs - CONFIG.TOKEN_WARN_BEFORE_EXPIRY_MS;
    if (warnIn > 0) {
      _warnTimer = setTimeout(() => {
        console.warn('[Auth] Token expiring soon — showing renewal banner');
        _onExpiring();
      }, warnIn);
    } else {
      // Already within warning window — show banner immediately
      _onExpiring();
    }
  }

  /* ── Public API ─────────────────────────────────────────── */

  /**
   * Attempt a silent re-authentication without any UI.
   * Uses prompt:'none' — succeeds if there is an active Google session
   * and the user has previously granted the required scopes.
   * If it fails, the error_callback fires (popup_failed / access_denied)
   * and the caller should fall back to showing the login screen.
   * Safe to call on page load without a user gesture.
   */
  function tryAutoLogin() {
    _tryCreateClient();
    if (!_tokenClient) {
      // GIS not loaded yet — retry once it loads via onGISLoad()
      console.log('[Auth] GIS not ready for auto-login, will retry on load');
      return;
    }
    console.log('[Auth] Attempting silent re-auth (prompt:none)...');
    _tokenClient.requestAccessToken({ prompt: 'none' });
  }

  /**
   * Fetch the authenticated user's profile from Google.
   * Returns { email, name, picture } or null on error.
   * Call after a valid token is available.
   */
  async function fetchUserInfo() {
    const token = getValidToken();
    if (!token) return null;
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return res.json(); // { id, email, name, given_name, picture, ... }
    } catch (_) {
      return null;
    }
  }

  /**
   * Request a token forcing the Google consent screen.
   * Use when a new scope was added and the existing token doesn't include it.
   * MUST be called from a user gesture.
   */
  function requestTokenWithConsent() {
    _tryCreateClient();
    if (!_tokenClient) return;
    console.log('[Auth] Requesting token with forced consent screen');
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  /**
   * Request a new access token.
   * MUST be called from a user-driven event (click/tap).
   * If the user already has an active Google session, the GIS popup
   * may complete immediately without user interaction.
   */
  function requestToken() {
    _tryCreateClient(); // last-chance init if GIS loaded after init()
    if (!_tokenClient) {
      console.error('[Auth] GIS not ready yet — try again in a moment');
      if (typeof UI !== 'undefined') {
        UI.showToast('Google Sign-In aún cargando, intenta de nuevo', 'error');
      }
      return;
    }
    // prompt: '' — skip consent screen if user already granted this scope
    _tokenClient.requestAccessToken({ prompt: '' });
  }

  /**
   * Returns the current valid access token, or null if expired/missing.
   * Call this before every Drive API request.
   */
  function getValidToken() {
    if (!_accessToken) return null;
    // Consider token invalid 30s before it actually expires (clock skew buffer)
    if (Date.now() > _expiresAt - 30_000) return null;
    return _accessToken;
  }

  /**
   * Returns true if we have a valid (non-expired) token in memory.
   */
  function isAuthenticated() {
    return !!getValidToken();
  }

  /**
   * Returns true if the user was authenticated before (even if token expired).
   * Used to decide whether to auto-show the renewal banner vs the full login screen.
   */
  function wasAuthenticated() {
    try {
      return localStorage.getItem(LS_AUTHED) === '1';
    } catch (_) { return false; }
  }

  /**
   * Returns ms remaining until token expires (0 if already expired).
   */
  function tokenTimeRemaining() {
    return Math.max(0, _expiresAt - Date.now());
  }

  /**
   * Log out: revoke token, clear state.
   */
  function logout() {
    if (_accessToken) {
      google.accounts.oauth2.revoke(_accessToken, () => {
        console.log('[Auth] Token revoked.');
      });
    }
    _accessToken = null;
    _expiresAt   = 0;
    if (_warnTimer) { clearTimeout(_warnTimer); _warnTimer = null; }
    try {
      localStorage.removeItem(LS_EXPIRY);
      localStorage.removeItem(LS_AUTHED);
    } catch (_) {}
    _onLogout();
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return {
    init,
    onGISLoad,
    tryAutoLogin,
    fetchUserInfo,
    requestToken,
    requestTokenWithConsent,
    getValidToken,
    isAuthenticated,
    wasAuthenticated,
    tokenTimeRemaining,
    logout,
  };
})();
