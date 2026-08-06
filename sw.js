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

const APP_VERSION  = '3.5.606';
const CACHE_NAME   = `savart-shell-v${APP_VERSION}`; // 3.5.606 — Recent playlists del Home: navegar ya no las pinta/reordena (getPlaylists ordena SOLO por lastPlayedAt; updatedAt queda de desempate — el prefetch de coverUrls lo bumpeaba al navegar); play a un ITEM dentro de la playlist también estampa lastPlayedAt (tercer disparador)

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
  `${BASE}/js/pitch-processor.js`,
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
      return cache.addAll(SHELL_FILES).catch((err) => {
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

  // Let Drive API and GIS requests go through to network always
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('accounts.google.com')) {
    return; // Don't intercept — browser handles normally
  }

  // Google Fonts: Cache First
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request, 'savart-fonts'));
    return;
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
