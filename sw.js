/* ============================================================
   Savart — Service Worker
   Caches the app shell for offline use.
   Audio blobs are cached in IndexedDB (by the app), NOT here.
   ============================================================
   Strategy:
   - App shell files (HTML, CSS, JS, fonts): Cache First
   - Drive API requests: Network Only (needs auth token)
   - Google Fonts: Cache First (CDN)
   ============================================================ */

const APP_VERSION  = '3.5.676';
const CACHE_NAME   = `savart-shell-v${APP_VERSION}`; // 3.5.676 — Fix: el mini reproductor móvil mostraba los botones 15/30 seg también con canciones de Drive (una regla con ID los forzaba a display:flex); ahora solo aparecen cuando suena una emisora de radio | 3.5.675 — Bot IA: el personaje flotante ya no se muestra en la pantalla de login; aparece (con fade-in) apenas se muestra el Home | 3.5.674 — Bot IA: si Drive no tiene nada, pregunta "¿La busco en Soundrop?" con botones Sí / No (no aplica a carpetas); "Sí" reutiliza la interpretación sin otra llamada a Gemini. En Soundrop, una canción puntual se busca primero como "artista + título" | 3.5.673 — Bot IA: memoria corta de sesión — la app manda al worker las últimas 3 consultas interpretadas (history, caduca a los 15 min) para que "pon más de eso" / "sin baladas" funcionen | 3.5.672 — Radio Emisoras: se puede renombrar una grabación (3 puntos › Renombrar): cambia el nombre del archivo en Drive y guarda el título en appProperties (rec_title); la fila muestra el título y pasa la fecha a la línea secundaria | 3.5.671 — Radio Emisoras: nueva pestaña "Grabaciones" (entre Favoritas y Borradas) con la lista de grabaciones de Drive › Grabaciones de radio (reproducir / eliminar a la papelera de Drive); el 3 puntos de una emisora que ya grabó muestra "Ver grabaciones", que abre la pestaña filtrada por esa emisora (chip con ✕ para quitar el filtro). La emisora/fecha/duración viajan en appProperties del archivo → funciona entre dispositivos | 3.5.670 — Radio Emisoras: botón Grabar en el reproductor expandido (solo emisoras con buffer DVR). Al pulsarlo se elige "Desde ahora" o "Desde que sintonicé" (log de chunks crudos, tope ~24 MB); al detener se sube a Drive › "Grabaciones de radio" (mp3/aac sin recodificar), con respaldo de descarga si falla; cambiar de emisora cierra y sube la grabación activa | 3.5.669 — Radio Emisoras: tiempos de la barra de progreso con DVR — izquierda = tiempo avanzado dentro del buffer (positivo), derecha = tamaño del buffer acumulado (crece hasta ~5 min) | 3.5.668 — Fix Radio Emisoras: bucle de corte + recarga cada ~3 s en emisoras cuyo stream cae a los pocos segundos de conectar por el buffer DVR (p. ej. Azul 99.9); si el DVR cae antes de 30 s se desactiva para esa emisora (24 h) y reconecta con audio plano | 3.5.667 — Radio Emisoras: shuffle/repeat se ocultan en el reproductor expandido durante radio (no aplican) y el botón play/pausa ya no se deforma a óvalo (flex-shrink:0; los botones de seek ceden espacio) | 3.5.666 — Radio Emisoras: los botones de 15/30 seg llevan un pequeño − (retroceder) o + (adelantar) delante del número | 3.5.665 — Fix: la card de "Recent songs" a veces quedaba sin portada aunque el reproductor ya la mostraba (renders del Home solapados: uno con datos viejos pisaba al nuevo; ahora el render viejo se descarta, la canción en reproducción pinta su portada del player en su card, y el prefetch relee la DB / usa la URL de la caché de sesión cuando la card está vacía) | 3.5.664 — Radio Emisoras: la barra de progreso principal (reproductor expandido y mini-player de escritorio) ahora también puede rebobinar/adelantar dentro del buffer DVR retenido, arrastrando o haciendo click — no solo con los botones de 15s/30s — mostrando "-M:SS" detrás de vivo mientras se arrastra; sin DVR disponible para la emisora, se queda igual que antes (barra fija, no interactiva)

/* Base path — auto-detected from sw.js location.
   localhost:8080  → ''
   erkdevcr.github.io/savart → '/savart'            */
const BASE = self.location.pathname.replace('/sw.js', '').replace(/\/$/, '');

/* Files to precache on install */
const SHELL_FILES = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/styles.css`,
  `${BASE}/js/config.js`,
  `${BASE}/js/auth.js`,
  `${BASE}/js/drive.js`,
  `${BASE}/js/db.js`,
  `${BASE}/js/sync.js`,
  `${BASE}/js/player.js`,
  `${BASE}/js/icy-metadata.js`,
  `${BASE}/js/radio-dvr.js`,
  `${BASE}/js/meta.js`,
  `${BASE}/js/lastfm.js`,
  `${BASE}/js/audd.js`,
  `${BASE}/js/musicbrainz.js`,
  `${BASE}/js/discogs.js`,
  `${BASE}/js/lyrics.js`,
  `${BASE}/js/soundrop.js`,
  `${BASE}/js/yt-auth.js`,
  `${BASE}/js/yt-playlists.js`,
  `${BASE}/js/ui.js`,
  `${BASE}/js/app.js`,
  `${BASE}/js/bg.js`,
  `${BASE}/manifest.json`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
  `${BASE}/icons/icon-512-maskable.png`,
  `${BASE}/icon-preview.svg`,
  `${BASE}/images/bg1.webp`,
];

/* ── Install ─────────────────────────────────────────────── */

self.addEventListener('install', (event) => {
  console.log('[SW] Installing v' + APP_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // v3.5.641 (audit M1): { cache: 'reload' } fuerza a bypassear la caché
      // HTTP del navegador (GitHub Pages sirve con max-age=600) — sin esto,
      // dos deploys dentro de la misma ventana de 10 min podían dejar que el
      // SW instalara JS viejo bajo el nombre de caché nuevo.
      return cache.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' }))).catch((err) => {
        // Non-fatal: some files may not exist yet (e.g. icons)
        console.warn('[SW] Precache partial error:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

/* ── Activate ────────────────────────────────────────────── */

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating v' + APP_VERSION);
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        // Preservar 'savart-fonts': las fuentes no cambian entre versiones del shell;
        // borrarlas obligaba a re-descargarlas tras cada update y rompía su uso offline.
        keys.filter(key => key !== CACHE_NAME && key !== 'savart-fonts').map(key => {
          console.log('[SW] Deleting old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

/* ── Fetch ───────────────────────────────────────────────── */

self.addEventListener('fetch', (event) => {
  // Cache API only supports GET — let all other methods go straight to network
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // v3.5.641 (audit B1): la regla de fuentes va ANTES que la de googleapis —
  // 'fonts.googleapis.com' también matchea 'googleapis.com', así que si esa
  // regla corría primero (como antes) el CSS de Google Fonts jamás llegaba a
  // 'savart-fonts' (solo los .woff2 de fonts.gstatic.com sí). Sin el CSS
  // cacheado, las fuentes offline dependían de la caché HTTP de 1 día.

  // Google Fonts: Cache First
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request, 'savart-fonts'));
    return;
  }

  // Let Drive API and GIS requests go through to network always
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('accounts.google.com')) {
    return; // Don't intercept — browser handles normally
  }

  // Cross-origin requests (Discogs CDN, Last.fm, AudD, lrclib, etc.) must NOT
  // be intercepted — their servers don't send CORS headers for SW fetch(),
  // which causes the browser to block the request and throw a network error.
  // The browser handles these directly without the service worker.
  if (url.origin !== self.location.origin) {
    return;
  }

  // App shell (same-origin only): Cache First.
  // ignoreSearch=true: la página pide js/app.js?v=x.x.x pero el precache guarda
  // js/app.js sin query — sin esto el precache jamás matcheaba y el primer uso
  // offline tras instalar fallaba. Es seguro: el cache del shell se recrea vacío
  // en cada bump de versión (CACHE_NAME cambia), nunca conviven dos versiones.
  event.respondWith(cacheFirst(event.request, CACHE_NAME, /* ignoreSearch */ true));
});

/* ── Cache strategies ────────────────────────────────────── */

async function cacheFirst(request, cacheName, ignoreSearch = false) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request, ignoreSearch ? { ignoreSearch: true } : undefined);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline and not cached — return a minimal offline page if it's navigation
    if (request.mode === 'navigate') {
      const offlinePage = await cache.match(`${BASE}/index.html`);
      if (offlinePage) return offlinePage;
    }
    throw err;
  }
}

/* ── Message handling ────────────────────────────────────── */

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }
});
