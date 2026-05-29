/* ============================================================
   Savart — Auth module
   Dual-mode: Web (GIS implicit flow) + Android nativo (Capacitor)
   ============================================================
   En navegador web: usa Google Identity Services (GIS), igual que antes.
   En Android nativo (Capacitor): usa @codetrix-studio/capacitor-google-auth
   que invoca el Google Sign-In SDK nativo de Android.

   Detección de plataforma:
     _isNative() → window.Capacitor?.isNativePlatform() === true

   Token management nativo:
   - signIn()   → abre el selector de cuenta nativo de Google
   - refresh()  → refresca el token silenciosamente (sin UI)
   - signOut()  → cierra sesión
   ============================================================ */

const Auth = (() => {
  /* ── Private state ─────────────────────────────────────── */
  let _tokenClient  = null;
  let _accessToken  = null;   // lives in memory only
  let _expiresAt    = 0;      // epoch ms
  let _warnTimer    = null;   // setTimeout id for expiry warning
  let _onReady          = null;
  let _onExpiring       = null;
  let _onLogout         = null;
  let _onAutoLoginFail  = null;
  let _initialized      = false;
  let _isSilentRenew    = false;
  let _renewTimeoutId   = null;
  let _renewOnGesture   = false;
  let _nativeInitialized = false;  // true after GoogleAuth.initialize() completes
  let _onRenewed             = null;  // callback fired after a silent mid-session renewal
  let _gestureRenewRetries   = 0;     // counts re-armed gesture renewal attempts
  const MAX_GESTURE_RETRIES  = 3;     // give up re-arming after 3 failed popup attempts

  /* ── LocalStorage keys ─────────────────────────────────── */
  const LS_EXPIRY  = 'savart_token_expiry';
  const LS_AUTHED  = 'savart_authed';

  /* ── Platform detection ────────────────────────────────── */
  function _isNative() {
    return !!(window.Capacitor?.isNativePlatform?.());
  }

  function _getGoogleAuthPlugin() {
    return window.Capacitor?.Plugins?.GoogleAuth || null;
  }

  /* ── Native auth helpers ────────────────────────────────── */

  /**
   * Inicializa el GoogleSignInClient en Android.
   * DEBE llamarse antes de signIn() o refresh().
   * Lee el clientId y scopes de CONFIG para mantener consistencia con la web app.
   */
  async function _initNativeGoogleAuth() {
    const GoogleAuth = _getGoogleAuthPlugin();
    if (!GoogleAuth) {
      console.error('[Auth] GoogleAuth plugin no disponible.');
      return;
    }
    try {
      await GoogleAuth.initialize({
        clientId: CONFIG.CLIENT_ID,
        scopes: [
          'email',
          'profile',
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/drive.appdata',
          'https://www.googleapis.com/auth/drive.file',
        ],
        grantOfflineAccess: true,
      });
      _nativeInitialized = true;
      console.log('[Auth] GoogleAuth inicializado correctamente.');
    } catch (err) {
      console.error('[Auth] Error al inicializar GoogleAuth:', err);
    }
  }

  async function _nativeSignIn(silent = false) {
    const GoogleAuth = _getGoogleAuthPlugin();
    if (!GoogleAuth) {
      console.error('[Auth] GoogleAuth plugin no disponible en modo nativo.');
      const cb = _onAutoLoginFail;
      _onAutoLoginFail = null;
      cb?.('plugin_not_available');
      return;
    }

    // Asegurar que el plugin esté inicializado antes de cualquier operación
    if (!_nativeInitialized) {
      await _initNativeGoogleAuth();
    }

    try {
      if (silent) {
        console.log('[Auth] Native: intentando refresh silencioso…');
        try {
          const refreshed = await GoogleAuth.refresh();
          if (refreshed?.accessToken) {
            _saveToken(refreshed.accessToken, 55 * 60 * 1000);
            console.log('[Auth] Native: refresh silencioso exitoso.');
            _onAutoLoginFail = null;
            _onReady?.();
            return;
          }
        } catch (refreshErr) {
          console.log('[Auth] Native: refresh silencioso falló (' + (refreshErr?.message || refreshErr) + ')');
        }
        // Refresh falló → notificar para mostrar pantalla de login
        const cb = _onAutoLoginFail;
        _onAutoLoginFail = null;
        cb?.('silent_failed');
        return;
      }

      // Sign-in completo (muestra selector de cuenta nativo)
      console.log('[Auth] Native: abriendo Google Sign-In…');
      const user = await GoogleAuth.signIn();
      const token = user?.authentication?.accessToken;
      if (!token) throw new Error('No access token en la respuesta de sign-in');

      _saveToken(token, 55 * 60 * 1000);
      console.log('[Auth] Native: sign-in exitoso.');
      _onAutoLoginFail = null;
      _onReady?.();

    } catch (err) {
      console.error('[Auth] Native sign-in error:', err);
      _isSilentRenew = false;
      const errMsg = err?.message || String(err) || 'unknown';

      if (_onAutoLoginFail) {
        const cb = _onAutoLoginFail;
        _onAutoLoginFail = null;
        cb(errMsg);
      } else {
        // 12501 = usuario canceló el diálogo de cuentas
        if (!errMsg.includes('cancel') && !errMsg.includes('12501')) {
          UI?.showToast('No se pudo iniciar sesión con Google: ' + errMsg, 'error');
        }
      }
    }
  }

  async function _nativeRefresh() {
    const GoogleAuth = _getGoogleAuthPlugin();
    if (!GoogleAuth) { _onExpiring?.(); return; }

    if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
    console.log('[Auth] Native: refresh en background…');
    _isSilentRenew = true;

    _renewTimeoutId = setTimeout(() => {
      _renewTimeoutId = null;
      if (_isSilentRenew) {
        _isSilentRenew = false;
        console.warn('[Auth] Native: refresh timeout — mostrando banner de renovación');
        _onExpiring?.();
      }
    }, 15_000);

    try {
      const refreshed = await GoogleAuth.refresh();
      if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
      if (refreshed?.accessToken) {
        _isSilentRenew = false;
        _saveToken(refreshed.accessToken, 55 * 60 * 1000);
        console.log('[Auth] Native: refresh en background exitoso.');
      } else {
        throw new Error('No accessToken en la respuesta de refresh');
      }
    } catch (err) {
      if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
      _isSilentRenew = false;
      console.warn('[Auth] Native: refresh en background falló:', err?.message || err);
      _onExpiring?.();
    }
  }

  /* ── Init ──────────────────────────────────────────────── */
  function init({ onReady, onExpiring, onLogout, onRenewed } = {}) {
    if (_initialized) return;
    _initialized = true;

    _onReady    = onReady    || (() => {});
    _onExpiring = onExpiring || (() => {});
    _onLogout   = onLogout   || (() => {});
    _onRenewed  = onRenewed  || null;

    if (_isNative()) {
      console.log('[Auth] Modo Android nativo — inicializando Capacitor GoogleAuth.');
      _initNativeGoogleAuth();
      return;
    }

    _tryCreateClient();
    _setupGestureRenewal();
    console.log('[Auth] Inicializado (modo web).');
  }

  /* ── Web-mode GIS helpers ───────────────────────────────── */
  function _tryCreateClient() {
    if (_tokenClient) return;
    if (!window.google?.accounts?.oauth2) return;
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: _handleTokenResponse,
      error_callback: _handleTokenError,
    });
    console.log('[Auth] GIS token client listo.');
  }

  function onGISLoad() {
    if (_isNative()) return;
    _tryCreateClient();
    if (_onAutoLoginFail && _tokenClient) {
      console.log('[Auth] GIS cargado — ejecutando re-auth silenciosa diferida');
      _tokenClient.requestAccessToken({ prompt: 'none' });
    }
  }

  function _handleTokenResponse(response) {
    if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
    console.log('[Auth] Token callback. Silent?', _isSilentRenew, 'Error?', response?.error || 'none');
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
      _gestureRenewRetries = 0;   // reset on every successful silent renewal
      console.log('[Auth] Renovación silenciosa exitosa.');
      try { _onRenewed?.(); } catch (_) {}
      return;
    }
    console.log('[Auth] Token guardado. Llamando _onReady');
    try { _onReady(); } catch(err) { console.error('[Auth] _onReady() error:', err.message); }
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
    // Modo nativo: refresh silencioso directo (no requiere gesto del usuario)
    if (_isNative()) {
      _nativeRefresh();
      return;
    }

    // Modo web: lógica original con GIS
    _tryCreateClient();
    if (!_tokenClient) {
      console.warn('[Auth] GIS no listo — mostrando banner');
      _onExpiring();
      return;
    }
    console.log('[Auth] Token expirando — intentando renovación proactiva (prompt:none)…');
    _isSilentRenew = true;
    if (_renewTimeoutId) clearTimeout(_renewTimeoutId);
    _renewTimeoutId = setTimeout(() => {
      _renewTimeoutId = null;
      if (_isSilentRenew) {
        _isSilentRenew = false;
        console.warn('[Auth] Renovación proactiva timeout — fallback a gesto');
        _fallbackToGestureRenewal();
      }
    }, 12_000);
    _onAutoLoginFail = (err) => {
      _onAutoLoginFail = null;
      _isSilentRenew   = false;
      console.warn('[Auth] Renovación proactiva falló (' + err + ') — fallback a gesto');
      _fallbackToGestureRenewal();
    };
    _tokenClient.requestAccessToken({ prompt: 'none' });
  }

  function _fallbackToGestureRenewal() {
    _renewOnGesture = true;
    const msUntilExpiry = Math.max(0, _expiresAt - Date.now());
    if (_renewTimeoutId) clearTimeout(_renewTimeoutId);
    if (msUntilExpiry > 0) {
      _renewTimeoutId = setTimeout(() => {
        _renewTimeoutId = null;
        if (_renewOnGesture) {
          _renewOnGesture = false;
          console.warn('[Auth] Token expiró sin gesto del usuario — mostrando banner');
          _onExpiring();
        }
      }, msUntilExpiry);
    } else {
      _renewOnGesture = false;
      console.warn('[Auth] Token ya expirado — mostrando banner');
      _onExpiring();
    }
  }

  function _setupGestureRenewal() {
    const _attemptRenewal = () => {
      if (!_renewOnGesture || !_tokenClient || _isSilentRenew) return;
      _renewOnGesture = false;
      if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
      console.log('[Auth] Renovando token en gesto de usuario (prompt:\'\')…');
      _isSilentRenew = true;
      _renewTimeoutId = setTimeout(() => {
        _renewTimeoutId = null;
        if (_isSilentRenew) {
          _isSilentRenew = false;
          console.warn('[Auth] Renovación por gesto timeout — mostrando banner');
          _onExpiring();
        }
      }, 12_000);
      _onAutoLoginFail = (err) => {
        _onAutoLoginFail = null;
        _isSilentRenew   = false;
        console.warn('[Auth] Renovación por gesto falló:', err);
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
    if (_isNative()) {
      _nativeSignIn(/* silent= */ true);
      return;
    }
    _tryCreateClient();
    if (!_tokenClient) {
      console.log('[Auth] GIS no listo para auto-login, reintentará al cargar');
      return;
    }
    console.log('[Auth] Intentando re-auth silenciosa (prompt:none)...');
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
    } catch (_) { return null; }
  }

  function requestTokenWithConsent() {
    if (_isNative()) {
      _nativeSignIn(/* silent= */ false);
      return;
    }
    _tryCreateClient();
    if (!_tokenClient) return;
    console.log('[Auth] Solicitando token con pantalla de consentimiento');
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function requestToken() {
    // If a gesture-based silent renewal is already in flight (triggered by the
    // capture-phase click listener before this handler fires), skip to avoid
    // a double requestAccessToken call on the same user gesture.
    if (_isSilentRenew) return;
    if (_isNative()) {
      _nativeSignIn(/* silent= */ false);
      return;
    }
    _tryCreateClient();
    if (!_tokenClient) {
      console.error('[Auth] GIS aún no cargado — intenta de nuevo en un momento');
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

  /**
   * Re-enables the gesture-based renewal so that the NEXT user click anywhere on
   * the page will silently request a new token (no specific "Renovar" click needed).
   * Called by the app when the token-expiry banner is displayed.
   * Guards against infinite retry loops via MAX_GESTURE_RETRIES.
   */
  function rearmGestureRenewal() {
    if (_isSilentRenew) return;  // renewal already in flight — nothing to do
    if (_gestureRenewRetries >= MAX_GESTURE_RETRIES) {
      console.warn('[Auth] Demasiados intentos de renovación por gesto — usuario debe hacer login de nuevo.');
      return;
    }
    _gestureRenewRetries++;
    _renewOnGesture = true;
    console.log(`[Auth] Gesture renewal re-armado (intento ${_gestureRenewRetries}/${MAX_GESTURE_RETRIES}).`);
  }

  async function logout() {
    if (_isNative()) {
      const GoogleAuth = _getGoogleAuthPlugin();
      if (GoogleAuth) {
        try { await GoogleAuth.signOut(); } catch (_) {}
      }
    } else if (_accessToken) {
      try {
        google.accounts.oauth2.revoke(_accessToken, () => {
          console.log('[Auth] Token revocado.');
        });
      } catch (_) {}
    }
    _accessToken           = null;
    _expiresAt             = 0;
    _isSilentRenew         = false;
    _renewOnGesture        = false;
    _gestureRenewRetries   = 0;
    if (_warnTimer)      { clearTimeout(_warnTimer);      _warnTimer      = null; }
    if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
    try {
      localStorage.removeItem(LS_EXPIRY);
      localStorage.removeItem(LS_AUTHED);
    } catch (_) {}
    _onLogout?.();
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return {
    init,
    onGISLoad,
    tryAutoLogin,
    fetchUserInfo,
    requestToken,
    requestTokenWithConsent,
    rearmGestureRenewal,
    getValidToken,
    isAuthenticated,
    wasAuthenticated,
    tokenTimeRemaining,
    logout,
  };
})();
