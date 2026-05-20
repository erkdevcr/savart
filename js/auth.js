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
  let _onReady          = null;   // callback when a fresh token arrives (initial login only)
  let _onExpiring       = null;   // callback when token is about to expire
  let _onLogout         = null;   // callback when user logs out
  let _onAutoLoginFail  = null;   // callback when silent re-auth fails
  let _initialized      = false;
  let _isSilentRenew    = false;  // true while a background token renewal is in flight
  let _renewTimeoutId   = null;   // safety timeout for silent renewal
  let _renewOnGesture   = false;  // renewal queued — fire on next user tap/click

  /* ── LocalStorage keys ─────────────────────────────────── */
  const LS_EXPIRY  = 'savart_token_expiry';
  const LS_AUTHED  = 'savart_authed';       // "1" = user was authenticated before

  /* ── Init ──────────────────────────────────────────────── */
  function init({ onReady, onExpiring, onLogout } = {}) {
    if (_initialized) return;
    _initialized = true;

    _onReady    = onReady    || (() => {});
    _onExpiring = onExpiring || (() => {});
    _onLogout   = onLogout   || (() => {});

    // In Capacitor (Android/iOS), GIS popups don't work — we use a direct
    // OAuth redirect instead. Check if the page loaded with a token in the URL.
    if (_tryExtractTokenFromUrl()) {
      console.log('[Auth] Token extracted from redirect URL (Capacitor flow).');
      _setupGestureRenewal();
      return;
    }

    // Try to create token client now; if GIS hasn't loaded yet,
    // it will be created lazily when requestToken() is called or
    // when onGISLoad() fires via the script's onload attribute.
    _tryCreateClient();
    _setupGestureRenewal();
    console.log('[Auth] Initialized.');
  }

  /**
   * Returns true if running inside a Capacitor native app (Android / iOS).
   * Primary check: custom UA token injected via capacitor.config.json.
   * Fallback: Capacitor bridge API.
   */
  function _isCapacitor() {
    return navigator.userAgent.includes('SavartNative') ||
           !!(window.Capacitor?.isNativePlatform?.());
  }

  /**
   * After a Capacitor OAuth redirect, Google returns to the app URL with
   * #access_token=...&expires_in=... in the hash. Parse it, store the
   * token, clean the URL, and fire _onReady().
   * Returns true if a token was found and consumed.
   */
  function _tryExtractTokenFromUrl() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return false;
    const params = new URLSearchParams(hash.substring(1));
    const token     = params.get('access_token');
    const expiresIn = params.get('expires_in');
    if (!token) return false;

    // Clean the token from the URL so it's not visible or reused on refresh
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) {}

    const expiresInMs = (parseInt(expiresIn, 10) || 3600) * 1000;
    _saveToken(token, expiresInMs);

    // Fire onReady asynchronously so the rest of init() can finish first
    setTimeout(() => {
      try { _onReady(); } catch (err) { console.error('[Auth] _onReady() threw:', err); }
    }, 0);

    return true;
  }

  /**
   * Creates the GIS token client if GIS is ready and client doesn't exist yet.
   */
  function _tryCreateClient() {
    if (_tokenClient) return;
    if (!window.google?.accounts?.oauth2) return;
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
   */
  function onGISLoad() {
    _tryCreateClient();
    if (_onAutoLoginFail && _tokenClient) {
      console.log('[Auth] GIS now ready — firing deferred silent re-auth');
      _tokenClient.requestAccessToken({ prompt: 'none' });
    }
  }

  /* ── Token response handler ────────────────────────────── */
  function _handleTokenResponse(response) {
    if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }

    console.log('[Auth] Token callback fired. Silent?', _isSilentRenew, 'Error?', response?.error || 'none');
    if (response.error) {
      console.error('[Auth] Token error:', response.error, response.error_description);
      _isSilentRenew = false;
      if (_onAutoLoginFail) {
        const cb = _onAutoLoginFail;
        _onAutoLoginFail = null;
        cb(response.error);
      } else {
        UI?.showToast('Error de autenticación: ' + response.error, 'error');
      }
      return;
    }

    _onAutoLoginFail = null;

    const expiresInMs = (parseInt(response.expires_in, 10) || 3600) * 1000;
    _saveToken(response.access_token, expiresInMs);

    if (_isSilentRenew) {
      _isSilentRenew = false;
      console.log('[Auth] Silent renewal succeeded — token refreshed silently.');
      return;
    }

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
    if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
    _isSilentRenew = false;

    if (_onAutoLoginFail) {
      const cb = _onAutoLoginFail;
      _onAutoLoginFail = null;
      cb(error.type || 'unknown');
      return;
    }

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

    try {
      localStorage.setItem(LS_EXPIRY, String(_expiresAt));
      localStorage.setItem(LS_AUTHED, '1');
    } catch (_) {}

    _scheduleExpiryWarning(expiresInMs);
  }

  function _scheduleExpiryWarning(expiresInMs) {
    if (_warnTimer) clearTimeout(_warnTimer);
    const warnIn = expiresInMs - CONFIG.TOKEN_WARN_BEFORE_EXPIRY_MS;
    if (warnIn > 0) {
      _warnTimer = setTimeout(_queueGestureRenewal, warnIn);
    } else {
      _queueGestureRenewal();
    }
  }

  function _queueGestureRenewal() {
    _tryCreateClient();
    if (!_tokenClient) {
      console.warn('[Auth] GIS not ready — showing renewal banner');
      _onExpiring();
      return;
    }

    console.log('[Auth] Token expiring — attempting proactive silent renewal (prompt:none)…');
    _isSilentRenew = true;

    if (_renewTimeoutId) clearTimeout(_renewTimeoutId);
    _renewTimeoutId = setTimeout(() => {
      _renewTimeoutId = null;
      if (_isSilentRenew) {
        _isSilentRenew = false;
        console.warn('[Auth] Proactive renewal timed out — falling back to gesture renewal');
        _fallbackToGestureRenewal();
      }
    }, 12_000);

    _onAutoLoginFail = (err) => {
      _onAutoLoginFail = null;
      _isSilentRenew   = false;
      console.warn('[Auth] Proactive silent renewal failed (' + err + ') — falling back to gesture renewal');
      _fallbackToGestureRenewal();
    };

    _tokenClient.requestAccessToken({ prompt: 'none' });
  }

  function _fallbackToGestureRenewal() {
    _renewOnGesture = true;
    const msUntilExpiry = Math.max(0, _expiresAt - Date.now());
    if (_renewTimeoutId) clearTimeout(_renewTimeoutId);
    if (msUntilExpiry > 0) {
      console.log('[Auth] Renewal queued for next user gesture (' + Math.round(msUntilExpiry / 1000) + 's until expiry)');
      _renewTimeoutId = setTimeout(() => {
        _renewTimeoutId = null;
        if (_renewOnGesture) {
          _renewOnGesture = false;
          console.warn('[Auth] Token expired before a user gesture — showing banner');
          _onExpiring();
        }
      }, msUntilExpiry);
    } else {
      _renewOnGesture = false;
      console.warn('[Auth] Token already expired — showing banner');
      _onExpiring();
    }
  }

  function _setupGestureRenewal() {
    const _attemptRenewal = () => {
      if (!_renewOnGesture || !_tokenClient || _isSilentRenew) return;
      _renewOnGesture = false;
      if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }

      console.log('[Auth] Renewing token on user gesture (prompt:\'\')…');
      _isSilentRenew = true;

      _renewTimeoutId = setTimeout(() => {
        _renewTimeoutId = null;
        if (_isSilentRenew) {
          _isSilentRenew = false;
          console.warn('[Auth] Gesture renewal timed out — showing banner');
          _onExpiring();
        }
      }, 12_000);

      _onAutoLoginFail = (err) => {
        _onAutoLoginFail = null;
        _isSilentRenew   = false;
        console.warn('[Auth] Gesture renewal failed:', err, '— showing banner');
        _onExpiring();
      };

      _tokenClient.requestAccessToken({ prompt: '' });
    };

    document.addEventListener('click',      _attemptRenewal, { passive: true, capture: true });
    document.addEventListener('touchstart', _attemptRenewal, { passive: true, capture: true });
  }

  /* ── Public API ─────────────────────────────────────────── */

  function tryAutoLogin(onFail) {
    _onAutoLoginFail = typeof onFail === 'function' ? onFail : null;
    _tryCreateClient();
    if (!_tokenClient) {
      console.log('[Auth] GIS not ready for auto-login, will retry on load');
      return;
    }
    console.log('[Auth] Attempting silent re-auth (prompt:none)...');
    _tokenClient.requestAccessToken({ prompt: 'none' });
  }

  async function fetchUserInfo() {
    const token = getValidToken();
    if (!token) return null;
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return res.json();
    } catch (_) {
      return null;
    }
  }

  function requestTokenWithConsent() {
    _tryCreateClient();
    if (!_tokenClient) return;
    console.log('[Auth] Requesting token with forced consent screen');
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function requestToken() {
    // ── Capacitor: use direct OAuth redirect (GIS popups don't work) ──
    if (_isCapacitor()) {
      const redirectUri = 'https://erkdevcr.github.io/savart';
      const params = new URLSearchParams({
        client_id:     CONFIG.CLIENT_ID,
        redirect_uri:  redirectUri,
        response_type: 'token',
        scope:         CONFIG.SCOPES,
        prompt:        'select_account',
      });
      window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
      return;
    }

    // ── Web: use GIS token client ───────────────────────────────────
    _tryCreateClient();
    if (!_tokenClient) {
      console.error('[Auth] GIS not ready yet — try again in a moment');
      if (typeof UI !== 'undefined') {
        UI.showToast('Google Sign-In aún cargando, intenta de nuevo', 'error');
      }
      return;
    }
    _tokenClient.requestAccessToken({ prompt: '' });
  }

  function getValidToken() {
    if (!_accessToken) return null;
    if (Date.now() > _expiresAt - 30_000) return null;
    return _accessToken;
  }

  function isAuthenticated() {
    return !!getValidToken();
  }

  function wasAuthenticated() {
    try {
      return localStorage.getItem(LS_AUTHED) === '1';
    } catch (_) { return false; }
  }

  function tokenTimeRemaining() {
    return Math.max(0, _expiresAt - Date.now());
  }

  function logout() {
    if (_accessToken) {
      google.accounts.oauth2.revoke(_accessToken, () => {
        console.log('[Auth] Token revoked.');
      });
    }
    _accessToken    = null;
    _expiresAt      = 0;
    _isSilentRenew  = false;
    _renewOnGesture = false;
    if (_warnTimer)      { clearTimeout(_warnTimer);      _warnTimer      = null; }
    if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
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
