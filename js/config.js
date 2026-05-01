/* ============================================================
   Savart — Configuration
   ============================================================
   BEFORE USING: Replace CLIENT_ID with your Google Cloud
   OAuth 2.0 client ID (type: "Web application").
   Authorized JavaScript origins must include your deployment
   URL (e.g. https://erkdevcr.github.io).
   ============================================================ */

const CONFIG = {
  // ── Google OAuth ─────────────────────────────────────────
  // Get this from: console.cloud.google.com → APIs & Services → Credentials
  CLIENT_ID: '409671846168-u60nj8ib48se183sarosn0sicu8g4vvb.apps.googleusercontent.com',

  // Scopes: email+profile = user info | drive.readonly = read music | drive.appdata = sync
  // drive.file = write appProperties to files opened by the app (cross-device metadata sync)
  SCOPES: 'email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file',

  // ── Google Drive API ─────────────────────────────────────
  API_BASE: 'https://www.googleapis.com/drive/v3',

  // Max results per files.list call (API max = 1000)
  FOLDER_PAGE_SIZE: 1000,

  // Fields requested on every files.list call (minimize payload)
  // appProperties: private per-app metadata used for cross-device cover/tag sync
  FILE_FIELDS: 'id,name,mimeType,size,parents,thumbnailLink,videoMediaMetadata,appProperties',

  // ── Auth token management ─────────────────────────────────
  // Show "renew session" banner this many ms before token expires
  TOKEN_WARN_BEFORE_EXPIRY_MS: 5 * 60 * 1000,  // 5 minutes

  // ── Cache (IndexedDB) ─────────────────────────────────────
  CACHE_LIMIT_DEFAULT: 1 * 1024 * 1024 * 1024,  // 1 GB
  CACHE_LIMIT_OPTIONS: {
    '500 MB': 500  * 1024 * 1024,
    '1 GB':   1    * 1024 * 1024 * 1024,
    '2 GB':   2    * 1024 * 1024 * 1024,
    '5 GB':   5    * 1024 * 1024 * 1024,
    '10 GB':  10   * 1024 * 1024 * 1024,
    '20 GB':  20   * 1024 * 1024 * 1024,
  },

  // ── Root folder (fixed) ──────────────────────────────────
  // Always locked to MSK — browse and search never go above this.
  ROOT_FOLDER_ID:   '1jX_P0xZOsH2jl60cU4STyiyShSuF5uoa',
  ROOT_FOLDER_NAME: 'MSK',

  // How many recents to keep
  RECENTS_MAX: 30,

  // How many top-played items to show on Home
  TOP_PLAYED_MAX: 20,

  // ── Audio ─────────────────────────────────────────────────
  // MIME types that Chrome can play natively
  PLAYABLE_TYPES: new Set([
    'audio/mpeg',        // MP3
    'audio/mp3',
    'audio/wav',         // WAV
    'audio/x-wav',
    'audio/flac',        // FLAC
    'audio/x-flac',
    'audio/ogg',         // OGG
    'audio/vorbis',
    'audio/opus',
    'audio/aac',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
  ]),

  // These are visible in lists but cannot be played
  UNPLAYABLE_TYPES: new Set([
    'audio/x-ms-wma',    // WMA
    'audio/wma',
  ]),

  // ── EQ bands (Hz) ─────────────────────────────────────────
  EQ_BANDS: [32, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000],

  // ── History ───────────────────────────────────────────────
  HISTORY_MAX:      100,
  HISTORY_MAX_DAYS: 7,

  // ── IndexedDB ─────────────────────────────────────────────
  DB_NAME:    'savart_db',
  DB_VERSION: 2,

  // ── Last.fm ───────────────────────────────────────────────
  // Used by lastfm.js to fetch album cover art.
  // Free API key — get one at: https://www.last.fm/api/account/create
  LASTFM_API_KEY: 'a6a6ef739488b2b0c4a81980f17581e6',

  // ── AudD.io ───────────────────────────────────────────────
  // Used by audd.js to identify songs with no ID3 metadata.
  // Free tier: 500 identifications/day — https://dashboard.audd.io
  AUDD_API_KEY: '512d7b3a673ec6e6695e3d42e2be0a98',

  // Max files to identify per folder open (conserves daily quota).
  // With 500/day this allows ~100 folder opens before hitting the limit.
  AUDD_MAX_PER_FOLDER: 5,

  // ── App metadata ──────────────────────────────────────────
  APP_NAME: 'Savart',
  VERSION:  '1.6.7',
};

/* ── Audio format detection helpers ───────────────────────── */

/**
 * Returns true if the file can be played in Chrome.
 * @param {string} mimeType
 */
function isPlayable(mimeType) {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return CONFIG.PLAYABLE_TYPES.has(base);
}

/**
 * Returns true if this is an audio file that Chrome cannot play (e.g. WMA).
 * @param {string} mimeType
 */
function isUnplayable(mimeType) {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return CONFIG.UNPLAYABLE_TYPES.has(base);
}

/**
 * Returns true if this is any audio file (playable or not).
 * @param {string} mimeType
 */
function isAudio(mimeType) {
  if (!mimeType) return false;
  return mimeType.toLowerCase().startsWith('audio/');
}

/**
 * Returns true if this is a Drive folder.
 * @param {string} mimeType
 */
function isFolder(mimeType) {
  return mimeType === 'application/vnd.google-apps.folder';
}

/**
 * Formats bytes to a human-readable string (e.g. "4.2 MB").
 * @param {number} bytes
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Formats seconds to mm:ss or h:mm:ss.
 * @param {number} seconds
 */
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Extracts a clean display name from a filename
 * (removes extension and common separators).
 * @param {string} filename
 */
function cleanTitle(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}
