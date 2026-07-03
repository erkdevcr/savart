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
  let _codeClient            = null;  // GIS code client (authorization code flow)
  let _workerRefreshBusy     = false; // guards concurrent worker refresh calls
  let _workerRefreshLastFail = 0;     // epoch ms of last failed worker refresh

  /* ── LocalStorage keys ─────────────────────────────────── */
  const LS_EXPIRY  = 'savart_token_expiry';
  const LS_AUTHED  = 'savart_authed';
  const LS_REFRESH = 'savart_refresh_token';

  /* ── Refresh-token (Worker) helpers ─────────────────────── */
  function _workerUrl() {
    return (typeof CONFIG !== 'undefined' && CONFIG.AUTH_WORKER_URL) || '';
  }

  function _getRefreshToken() {
    try { return localStorage.getItem(LS_REFRESH) || null; } catch (_) { return null; }
  }

  function _setRefreshToken(rt) {
    if (!rt) return;
    try { localStorage.setItem(LS_REFRESH, rt); } catch (_) {}
  }

  function _clearRefreshToken() {
    try { localStorage.removeItem(LS_REFRESH); } catch (_) {}
  }

  /**
   * Renueva el access token contra el Worker usando el refresh token guardado.
   * 100% silencioso — sin popup ni gesto. Devuelve true si renovó.
   * @param {'renew'|'login'} purpose — 'renew' dispara _onRenewed, 'login' dispara _onReady
   */
  async function _workerRefresh(purpose = 'renew') {
    const rt = _getRefreshToken();
    if (!rt || !_workerUrl()) return false;
    if (_workerRefreshBusy) return false;
    // Cooldown de 15 s tras un fallo — evita martilleo desde getValidToken()
    if (Date.now() - _workerRefreshLastFail < 15_000) return false;
    _workerRefreshBusy = true;
    try {
      // Hasta 3 intentos ante fallos de red (5 s entre cada uno)
      for (let attempt = 1; attempt <= 3; attempt++) {
        let res, data;
        try {
          res = await fetch(_workerUrl() + '/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: rt }),
          });
          data = await res.json().catch(() => ({}));
        } catch (netErr) {
          console.warn(`[Auth] Worker refresh: error de red (intento ${attempt}/3)`, netErr?.message || netErr);
          if (attempt < 3) { await new Promise(r => setTimeout(r, 5000)); continue; }
          _workerRefreshLastFail = Date.now();
          return false;
        }
        if (res.ok && data.access_token) {
          _saveToken(data.access_token, (data.expires_in || 3600) * 1000);
          _gestureRenewRetries = 0;
          _workerRefreshLastFail = 0;
          console.log('[Auth] Worker refresh exitoso — token renovado sin interacción.');
          if (purpose === 'login') {
            try { _onReady?.(); } catch (_) {}
          } else {
            try { _onRenewed?.(); } catch (_) {}
          }
          return true;
        }
        // invalid_grant = refresh token revocado o expirado → borrar y no reintentar
        if (data.error === 'invalid_grant') {
          console.warn('[Auth] Worker refresh: refresh token inválido — se elimina.');
          _clearRefreshToken();
          return false;
        }
        console.warn('[Auth] Worker refresh falló:', res.status, data.error || '');
        _workerRefreshLastFail = Date.now();
        return false;
      }
      return false;
    } finally {
      _workerRefreshBusy = false;
    }
  }

  /**
   * Intercambia un authorization code por tokens en el Worker y los guarda.
   * @param {string} code
   * @param {string} redirectUri — 'postmessage' (GIS popup) o '' (serverAuthCode Android)
   */
  async function _exchangeCode(code, redirectUri = 'postmessage') {
    const res = await fetch(_workerUrl() + '/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(data.error || ('exchange HTTP ' + res.status));
    }
    if (data.refresh_token) {
      _setRefreshToken(data.refresh_token);
      console.log('[Auth] Refresh token obtenido y guardado — renovación automática activa.');
    }
    _saveToken(data.access_token, (data.expires_in || 3600) * 1000);
    return true;
  }

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
            _saveToken(refreshed.accessToken, 60 * 60 * 1000);
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

      _saveToken(token, 60 * 60 * 1000);
      console.log('[Auth] Native: sign-in exitoso.');
      _onAutoLoginFail = null;
      _onReady?.();

      // grantOfflineAccess entrega un serverAuthCode → intercambiarlo en el
      // Worker para obtener un refresh token (renovación automática sin plugin).
      const serverCode = user?.serverAuthCode || user?.authentication?.serverAuthCode;
      if (serverCode && _workerUrl()) {
        _exchangeCode(serverCode, '')
          .then(() => console.log('[Auth] Native: refresh token obtenido vía Worker.'))
          .catch((e) => console.warn('[Auth] Native: intercambio de serverAuthCode falló:', e?.message || e));
      }

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
        _saveToken(refreshed.accessToken, 60 * 60 * 1000);
        console.log('[Auth] Native: refresh en background exitoso.');
        try { _onRenewed?.(); } catch (_) {}
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
    if (!window.google?.accounts?.oauth2) return;
    if (!_tokenClient) {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: _handleTokenResponse,
        error_callback: _handleTokenError,
      });
      console.log('[Auth] GIS token client listo.');
    }
    if (!_codeClient && _workerUrl()) {
      _codeClient = google.accounts.oauth2.initCodeClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        ux_mode: 'popup',
        callback: _handleCodeResponse,
        error_callback: _handleTokenError,
      });
      console.log('[Auth] GIS code client listo (refresh token vía Worker).');
    }
  }

  /**
   * Callback del code client (login con authorization code flow).
   * Intercambia el code en el Worker → access token + refresh token.
   */
  function _handleCodeResponse(response) {
    if (_renewTimeoutId) { clearTimeout(_renewTimeoutId); _renewTimeoutId = null; }
    if (response.error || !response.code) {
      console.error('[Auth] Code flow error:', response.error || 'sin code');
      _isSilentRenew = false;
      if (_onAutoLoginFail) {
        const cb = _onAutoLoginFail;
        _onAutoLoginFail = null;
        cb(response.error || 'no_code');
      } else {
        UI?.showToast('Error de autenticación: ' + (response.error || 'sin código'), 'error');
      }
      return;
    }
    const wasSilent = _isSilentRenew;
    _exchangeCode(response.code, 'postmessage')
      .then(() => {
        _onAutoLoginFail = null;
        if (wasSilent) {
          _isSilentRenew = false;
          _gestureRenewRetries = 0;
          console.log('[Auth] Renovación vía code flow exitosa.');
          try { _onRenewed?.(); } catch (_) {}
        } else {
          console.log('[Auth] Login vía code flow exitoso. Llamando _onReady');
          try { _onReady(); } catch (err) { console.error('[Auth] _onReady() error:', err.message); }
        }
      })
      .catch((err) => {
        console.error('[Auth] Intercambio de code falló:', err?.message || err);
        _isSilentRenew = false;
        if (_onAutoLoginFail) {
          const cb = _onAutoLoginFail;
          _onAutoLoginFail = null;
          cb('exchange_failed');
        } else {
          UI?.showToast('Error al completar el inicio de sesión', 'error');
        }
      });
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
    // Vía preferida (web y nativo): refresh token vía Worker — sin popup ni gesto.
    if (_getRefreshToken() && _workerUrl()) {
      _workerRefresh('renew').then((ok) => {
        if (ok) return;
        console.warn('[Auth] Worker refresh falló — usando fallback de plataforma');
        if (_isNative()) _nativeRefresh();
        else _queueGestureRenewalLegacy();
      });
      return;
    }

    // Modo nativo: refresh silencioso directo (no requiere gesto del usuario)
    if (_isNative()) {
      _nativeRefresh();
      return;
    }

    _queueGestureRenewalLegacy();
  }

  function _queueGestureRenewalLegacy() {
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

    // Vía preferida: refresh token vía Worker (funciona en web y nativo, sin UI)
    if (_getRefreshToken() && _workerUrl()) {
      console.log('[Auth] Auto-login vía refresh token (Worker)…');
      _workerRefresh('login').then((ok) => {
        if (ok) { _onAutoLoginFail = null; return; }
        console.warn('[Auth] Auto-login vía Worker falló — fallback de plataforma');
        _tryAutoLoginLegacy();
      });
      return;
    }
    _tryAutoLoginLegacy();
  }

  function _tryAutoLoginLegacy() {
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
    // Con Worker configurado: code flow con consentimiento → además obtiene refresh token
    if (_codeClient) {
      console.log('[Auth] Solicitando code con pantalla de consentimiento');
      _codeClient.requestCode();
      return;
    }
    if (!_tokenClient) return;
    console.log('[Auth] Solicitando token con pantalla de consentimiento');
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function requestToken() {
    // If a gesture-based silent renewal is already in flight (triggered by the
    // capture-phase click listener before this handler fires), skip to avoid
    // a double requestAccessToken call on the same user gesture.
    if (_isSilentRenew) return;

    // Si hay refresh token, renovar vía Worker (sin popup). Si falla, seguir
    // con el flujo interactivo normal.
    if (_getRefreshToken() && _workerUrl()) {
      // Con sesión previa en memoria → renovación; sin ella → login (llama _onReady)
      _workerRefresh(_accessToken ? 'renew' : 'login').then((ok) => {
        if (!ok) _requestTokenInteractive();
      });
      return;
    }
    _requestTokenInteractive();
  }

  function _requestTokenInteractive() {
    if (_isNative()) {
      _nativeSignIn(/* silent= */ false);
      return;
    }
    _tryCreateClient();
    // Con Worker configurado: usar code flow para obtener refresh token
    // (renovación automática de por vida a partir de este login).
    if (_codeClient) {
      console.log('[Auth] Login vía code flow (obtendrá refresh token)…');
      _codeClient.requestCode();
      return;
    }
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
    if (Date.now() > _expiresAt - 30_000) {
      // Safety net: si el timer de renovación no corrió (tab en background,
      // throttling), dispara la renovación vía Worker ahora mismo.
      if (_getRefreshToken() && _workerUrl()) _workerRefresh('renew');
      return null;
    }
    // Renovación perezosa anticipada: si queda poco tiempo, renovar ya
    // (sin bloquear — el token actual sigue siendo válido).
    if (Date.now() > _expiresAt - CONFIG.TOKEN_WARN_BEFORE_EXPIRY_MS &&
        _getRefreshToken() && _workerUrl()) {
      _workerRefresh('renew');
    }
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

  /**
   * Programmatic renewal attempt — triggered automatically when the expiry banner
   * appears. Calls requestAccessToken({ prompt:'' }) without a user gesture.
   * If the Google session is still active (common case), GIS returns a token
   * silently without opening any popup, hiding the banner automatically.
   * If a popup would be required, GIS calls the error_callback and the banner
   * stays visible so the user can click manually as a fallback.
   * Web mode only — native mode uses GoogleAuth.refresh() directly.
   */
  function autoAttemptRenewal() {
    // Vía preferida: refresh token vía Worker — sin popup ni gesto
    if (_getRefreshToken() && _workerUrl()) {
      _workerRefresh('renew');
      return;
    }
    // Modo nativo: reintenta refresh silencioso directo (no requiere gesto)
    if (_isNative()) {
      if (!_isSilentRenew) _nativeRefresh();
      return;
    }
    if (_isSilentRenew) return;
    _tryCreateClient();
    if (!_tokenClient) return;

    console.log('[Auth] Auto-renovación programática (sin gesto)…');
    _isSilentRenew = true;

    if (_renewTimeoutId) clearTimeout(_renewTimeoutId);
    _renewTimeoutId = setTimeout(() => {
      _renewTimeoutId = null;
      if (_isSilentRenew) {
        _isSilentRenew = false;
        _onAutoLoginFail = null;
        console.warn('[Auth] Auto-renovación timeout — banner sigue visible, gesto re-armado');
        _renewOnGesture = true;
      }
    }, 12_000);

    _onAutoLoginFail = (err) => {
      _onAutoLoginFail = null;
      _isSilentRenew = false;
      console.log('[Auth] Auto-renovación falló (' + err + ') — banner sigue visible, gesto re-armado');
      _renewOnGesture = true;
    };

    _tokenClient.requestAccessToken({ prompt: '' });
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
    _clearRefreshToken();
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
    autoAttemptRenewal,
    getValidToken,
    isAuthenticated,
    wasAuthenticated,
    tokenTimeRemaining,
    logout,
  };
})();
