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

const APP_VERSION  = '3.5.263';
const CACHE_NAME   = `savart-shell-v${APP_VERSION}`; // 3.5.263 — Capacitor OAuth redirect flow

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
        keys.filter(key => key !== CACHE_NAME).map(key => {
          console.log('[SW] Deleting old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

/* ── Fetch ───────────────────────────────────────────────── */

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('accounts.google.com')) {
    return;
  }

  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request, 'savart-fonts'));
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(cacheFirst(event.request, CACHE_NAME));
});

/* ── Cache strategies ────────────────────────────────────── */

async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
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
