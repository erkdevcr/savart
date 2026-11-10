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

const APP_VERSION  = '3.5.713';
const CACHE_NAME   = `savart-shell-v${APP_VERSION}`; // 3.5.713 — Carpetas: opcion 'Descargar ZIP' en el menu (canciones directas de la carpeta, ZIP sin compresion, progreso y Cancelar). 3.5.712 — Estado del bot: 'Pensando/Thinking' pasa a 'Trabajando/Working' y sin la estrellita. 3.5.711 — Gestos poco frecuentes del bot (mirar abajo/arriba, sorpresa, enojo, tristeza) salen mas seguido. 3.5.710 — Ojos del bot un poco mas juntos. 3.5.709 — Autocorreccion de cache: si index.html y app.js quedan de versiones distintas (mezcla del CDN guardada por el service worker) se vacia la cache y se recarga una vez. 3.5.708 — Ajustes del bot: 'Color del bot' (predeterminado = acento, 11 colores o personalizado) con modal de vista previa (el personaje hace gestos al azar) y Aceptar/Cancelar; por dispositivo. 3.5.707 — Bot IA: nuevo personaje 'bolita' (SVG animado, color de acento) con gestos al azar; al tocarlo se pone feliz y abre la ventana; mira hacia la ventana (abajo/arriba) mientras se escribe; pensando = mira de lado a lado. 3.5.706 — Bot IA: microfono sin hueco (feedback inmediato 'Preparando microfono', no repide permiso si ya esta concedido, 'Habla ahora' cuando el audio realmente captura) + barritas tipo EQ que se mueven al detectar voz; las bolitas de pensando ya no se apagan con reducir movimiento (no se movian en el movil). 3.5.705 — Bot IA: exitos de genero/epoca suman, tras los titulos exactos, canciones de tu biblioteca de los mismos artistas de la lista (max 5 por artista, 60 en total, intercaladas, sin repetir). 3.5.704 — Bot IA: exitos de genero/epoca piden 60 canciones a Gemini (artista 40, max 100) para cruzar con mas de tu biblioteca; busqueda en YouTube limitada a 20 por cuota. Requiere redesplegar el Worker. 3.5.703 — Ajustes del bot: 'Idioma del bot' (Automatico / Espanol / English) que controla reconocimiento de voz, voz hablada, mensajes y placeholder, independiente del idioma de la app. 3.5.702 — Bot IA bilingue (todos los mensajes, botones Si/No, voz y reconocimiento siguen el idioma de la app; comandos tambien en ingles) y estado 'pensando': cuadro de texto en gris/solo lectura + bolitas animadas. 3.5.701 — Bot IA: segunda revision del queue en 'solo un artista': verifica cada cancion contra el artista pedido (nombre, etiqueta de artista, carpetas; en YouTube artista/canal) y descarta las de otro artista con nombre parecido (ej. Peter Gabriel al pedir Ana Gabriel). 3.5.700 — Ajustes del bot: nuevo interruptor 'Micrófono al tocar el bot' (activado: escucha al tocar; desactivado: solo con el boton de microfono dentro del panel). 3.5.699 — Bot IA: se quitan los botones de sugerencias (mas movidas, sin baladas, otra tanda, guardar como playlist). 3.5.698 — Bot IA: el permiso del microfono se pide primero y se espera la respuesta antes de escuchar; distingue 'sin permiso' de 'navegador sin reconocimiento de voz' (Brave) con mensaje claro y cae al texto. 3.5.697 — Bot IA: comandos locales sin Gemini (siguiente, anterior, pausa, volumen, temporizador de apagado, aleatorio, borrar cola, ecualizador), contexto de lo que suena (quien canta, mas como esta, otra del mismo album, agregar a playlist/favoritos) y botones de sugerencias tras cada respuesta (mas movidas, sin baladas, otra tanda, guardar como playlist). Respaldo: _backups/pre-3.5.697-bot-commands. // 3.5.696 — Bot IA: sintoniza emisoras de radio por nombre, frecuencia o genero (ej. sintoniza la 103, pon Radio Columbia, una emisora de jazz) usando el catalogo local, sin cuota; ofrece alternativas parecidas. Respaldo: _backups/pre-3.5.696-bot-radio. // 3.5.695 — Bot IA: al tocar el bot se activa el microfono (se envia solo al terminar de hablar; si no hay mic/permiso cae a texto), responde en voz alta cuando le hablas por voz (voz del sistema, sin cuota) y baja la musica mientras escucha/habla. Nuevo apartado en Ajustes > Asistente IA: activar el bot, respuestas habladas, comandos de voz. Respaldo: _backups/pre-3.5.695-bot-voice. // 3.5.694 — Bot IA: los exitos por genero/epoca/anio (ej. salsa de los 90) se buscan primero en tu biblioteca y lo que falta se ofrece en YouTube con Si/No; YouTube directo solo si lo pides (yt, ye te, youtube, internet, la web, soundrop). Respaldo: _backups/pre-3.5.694-hits-library. // 3.5.693 — Bot IA: exitos de un artista (ej. exitos de Shakira) -> el Worker los busca en la web, la app los empareja en tu biblioteca (metadatos locales y Drive) y los carga al queue en orden de popularidad sin repetir; ofrece buscar en YouTube las que falten. Interruptor AI_HITS_ENABLED; respaldo en _backups/pre-3.5.693-artist-hits. // 3.5.692 — Fix: una cancion/carpeta fijada que desfijabas volvia a aparecer al recargar (el snapshot remoto la resucitaba). Ahora el unpin deja una lapida que viaja por sync y se envia de inmediato. // 3.5.691 — Bot IA: pide exitos actuales (ej. reggaeton 2026) -> el Worker los busca en la web (Gemini), la app los busca en YouTube y los agrega al queue sin repetir. Interruptor AI_HITS_ENABLED; respaldo en _backups/pre-3.5.691-hits. // 3.5.690 — Fix mosaico de playlists en Biblioteca: ya no repite portadas (resolucion unica sin duplicados por cancion/URL y preferencia por albumes distintos). // 3.5.689 — Discogs: ya no cuenta el error 429 (limite de peticiones) como fallo; pausa y reintenta, enfria 60 s y guarda en cache local las busquedas. // 3.5.688 — Fix buscador: "arjona se fue" no daba resultados porque se comparaba solo contra el nombre del archivo ("Se Fue.mp3") y el artista esta en la carpeta/metadata. Ahora cada palabra puede coincidir con nombre, artista, album o carpetas padre; se consultan tambien sub-frases ("se fue") en Drive; se suman canciones de la biblioteca local que Drive no devolvio; y la busqueda offline ya no exige la frase completa contigua | 3.5.687 — EQ: en las filas de Normalizer y Live Gain el nombre va arriba del toggle y el valor del Normalizer debajo del toggle; Live Gain se mueve al margen derecho de la ventana (se elimina el separador |) | 3.5.686 — EQ: los presets personalizados se sincronizan entre dispositivos del mismo login mezclando POR PRESET (antes la lista completa del dispositivo con el reloj mas nuevo pisaba a las demas, y mover un slider en un equipo desactualizado perdia presets): cada preset lleva updatedAt, los borrados viajan como tombstones (60 dias) y borrar el ultimo preset tambien se propaga; ademas guardar el EQ ya no borra la carpeta raiz sincronizada | 3.5.685 — EQ: en las tarjetas de "Mis presets" el nombre y la papelera pasan debajo de las barras (que ahora son mas altas, 34 px) y las barras son grises | 3.5.684 — EQ: las barras de las tarjetas de "Mis presets" nacen del borde inferior de la tarjeta (1.5 px de margen) y crecen con la ganancia (-12 dB minima, +12 dB altura completa), en lugar de partir de una linea central | 3.5.683 — EQ: texto y borde de los botones "Guardar actual" / "Agrupar barras" y de la barra que despliega "Ajustes personalizados" pasan a un gris mas claro (mejor contraste) | 3.5.682 — Fix EQ: con la ventana o el movil poco alto, la lista de "Ajustes personalizados" quedaba cortada sin forma de llegar a los ultimos presets. Ahora el cajon de presets cede altura y hace scroll interno; en pantallas muy bajas (p. ej. horizontal) la tarjeta entera hace scroll con el encabezado fijo | 3.5.681 — EQ: las tarjetas de "Mis presets" dibujan una barra por banda (desde la linea de 0 dB; positivas arriba, negativas abajo mas tenues) en lugar de la linea curva | 3.5.680 — EQ: se elimina la representacion grafica de la curva (linea azul) de la ventana del ecualizador | 3.5.679 — EQ: al guardar un preset el nombre sugerido es el del preset cargado (de fabrica o propio, aunque despues se hayan movido los sliders); si se conserva el mismo nombre de un preset propio se sobrescribe en el sitio (aviso "actualizado"), y si se cambia se crea uno nuevo | 3.5.678 — Uso sin internet: en el login aparece "Entrar sin conexion" cuando ya hubo sesion y de verdad no hay red (se comprueba con una peticion al Worker, porque navigator.onLine devuelve true con WiFi sin salida o datos sin senal) — entra directo a la musica cacheada; js/radio-stations.js pasa a la precache del service worker (era el unico script que faltaba); Bot IA: los botones de microfono y enviar crecen de 28 a 36 px | 3.5.677 — Fix PWA: la app se "reiniciaba" sola al desbloquear el celular con musica sonando. Al publicarse una version nueva se armaba una recarga automatica que esperaba a que la musica parara; con la pantalla bloqueada el temporizador se congela y disparaba justo al volver a la app. Ahora solo se recarga sola si la app esta visible y en silencio; si no, queda el aviso "Nueva version disponible" (persistente) y la recarga la decide el usuario | 3.5.676 — Fix: el mini reproductor móvil mostraba los botones 15/30 seg también con canciones de Drive (una regla con ID los forzaba a display:flex); ahora solo aparecen cuando suena una emisora de radio | 3.5.675 — Bot IA: el personaje flotante ya no se muestra en la pantalla de login; aparece (con fade-in) apenas se muestra el Home | 3.5.674 — Bot IA: si Drive no tiene nada, pregunta "¿La busco en Soundrop?" con botones Sí / No (no aplica a carpetas); "Sí" reutiliza la interpretación sin otra llamada a Gemini. En Soundrop, una canción puntual se busca primero como "artista + título" | 3.5.673 — Bot IA: memoria corta de sesión — la app manda al worker las últimas 3 consultas interpretadas (history, caduca a los 15 min) para que "pon más de eso" / "sin baladas" funcionen | 3.5.672 — Radio Emisoras: se puede renombrar una grabación (3 puntos › Renombrar): cambia el nombre del archivo en Drive y guarda el título en appProperties (rec_title); la fila muestra el título y pasa la fecha a la línea secundaria | 3.5.671 — Radio Emisoras: nueva pestaña "Grabaciones" (entre Favoritas y Borradas) con la lista de grabaciones de Drive › Grabaciones de radio (reproducir / eliminar a la papelera de Drive); el 3 puntos de una emisora que ya grabó muestra "Ver grabaciones", que abre la pestaña filtrada por esa emisora (chip con ✕ para quitar el filtro). La emisora/fecha/duración viajan en appProperties del archivo → funciona entre dispositivos | 3.5.670 — Radio Emisoras: botón Grabar en el reproductor expandido (solo emisoras con buffer DVR). Al pulsarlo se elige "Desde ahora" o "Desde que sintonicé" (log de chunks crudos, tope ~24 MB); al detener se sube a Drive › "Grabaciones de radio" (mp3/aac sin recodificar), con respaldo de descarga si falla; cambiar de emisora cierra y sube la grabación activa | 3.5.669 — Radio Emisoras: tiempos de la barra de progreso con DVR — izquierda = tiempo avanzado dentro del buffer (positivo), derecha = tamaño del buffer acumulado (crece hasta ~5 min) | 3.5.668 — Fix Radio Emisoras: bucle de corte + recarga cada ~3 s en emisoras cuyo stream cae a los pocos segundos de conectar por el buffer DVR (p. ej. Azul 99.9); si el DVR cae antes de 30 s se desactiva para esa emisora (24 h) y reconecta con audio plano | 3.5.667 — Radio Emisoras: shuffle/repeat se ocultan en el reproductor expandido durante radio (no aplican) y el botón play/pausa ya no se deforma a óvalo (flex-shrink:0; los botones de seek ceden espacio) | 3.5.666 — Radio Emisoras: los botones de 15/30 seg llevan un pequeño − (retroceder) o + (adelantar) delante del número | 3.5.665 — Fix: la card de "Recent songs" a veces quedaba sin portada aunque el reproductor ya la mostraba (renders del Home solapados: uno con datos viejos pisaba al nuevo; ahora el render viejo se descarta, la canción en reproducción pinta su portada del player en su card, y el prefetch relee la DB / usa la URL de la caché de sesión cuando la card está vacía) | 3.5.664 — Radio Emisoras: la barra de progreso principal (reproductor expandido y mini-player de escritorio) ahora también puede rebobinar/adelantar dentro del buffer DVR retenido, arrastrando o haciendo click — no solo con los botones de 15s/30s — mostrando "-M:SS" detrás de vivo mientras se arrastra; sin DVR disponible para la emisora, se queda igual que antes (barra fija, no interactiva)

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
  `${BASE}/js/radio-stations.js`,   // v3.5.678: era el unico script fuera de la precache
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
