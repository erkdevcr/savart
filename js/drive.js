/* ============================================================
   Savart — Drive module
   Google Drive API v3 — all requests via fetch() + Bearer token
   ============================================================
   Design decisions:
   - No gapi.client — it wraps away Range headers and adds bloat.
   - All calls check Auth.getValidToken() and throw AuthError if null.
   - listFolder is lazy (per-folder, no global index).
   - downloadFile downloads the full blob in one shot (best for caching).
     For large files (>30MB) a streaming approach can be added later.
   ============================================================ */

const Drive = (() => {

  /* ── Custom error class ────────────────────────────────── */
  class DriveError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'DriveError';
      this.status = status;
    }
  }

  class AuthError extends Error {
    constructor() {
      super('No valid access token. User must re-authenticate.');
      this.name = 'AuthError';
    }
  }

  /* ── Internal fetch helper ─────────────────────────────── */
  /**
   * Authenticated fetch to Drive API.
   * Throws AuthError if no token, DriveError on HTTP errors.
   */
  async function _fetch(url, options = {}) {
    const token = Auth.getValidToken();
    if (!token) throw new AuthError();

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new DriveError(
        `Drive API ${response.status}: ${body.slice(0, 200)}`,
        response.status
      );
    }

    return response;
  }

  /* ── listFolder ─────────────────────────────────────────── */
  /**
   * List the contents of a Drive folder.
   * Returns folders first, then audio files, in alphabetical order.
   *
   * @param {string} folderId  - Drive folder ID ('root' for My Drive root)
   * @param {string} [pageToken] - for pagination (internal use)
   * @returns {Promise<{ folders: DriveItem[], files: DriveItem[], nextPageToken: string|null }>}
   */
  async function listFolder(folderId, pageToken = null) {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: CONFIG.FOLDER_PAGE_SIZE,
      fields: `nextPageToken,files(${CONFIG.FILE_FIELDS})`,
      orderBy: 'folder,name',
    });

    if (pageToken) params.set('pageToken', pageToken);

    const url = `${CONFIG.API_BASE}/files?${params}`;
    const res = await _fetch(url);
    const data = await res.json();

    const folders = [];
    const files   = [];

    for (const item of (data.files || [])) {
      if (isFolder(item.mimeType)) {
        folders.push(_normalizeItem(item));
      } else if (isAudio(item.mimeType)) {
        files.push(_normalizeItem(item));
      }
      // Ignore non-audio, non-folder items
    }

    return {
      folders,
      files,
      nextPageToken: data.nextPageToken || null,
    };
  }

  /**
   * Fetches ALL pages of a folder (auto-paginates).
   * Use for folders with >1000 items.
   *
   * @param {string} folderId
   * @returns {Promise<{ folders: DriveItem[], files: DriveItem[] }>}
   */
  async function listFolderAll(folderId) {
    const allFolders = [];
    const allFiles   = [];
    let pageToken = null;

    do {
      const page = await listFolder(folderId, pageToken);
      allFolders.push(...page.folders);
      allFiles.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);

    return { folders: allFolders, files: allFiles };
  }

  /* ── searchFiles ─────────────────────────────────────────── */
  /**
   * Search audio files by name across Drive (within a root folder if provided).
   * NOTE: Drive's 'name contains' is NOT recursive into subfolder structure —
   * it searches the entire Drive regardless of folder hierarchy.
   * To restrict to a subtree, use the 'in parents' constraint with specific folders
   * (not scalable for deep trees without a server-side index).
   *
   * @param {string} term         - search term
   * @param {string} [rootId]     - limit results to files that have this folder as an ancestor
   *                                (only works for direct children; Drive API limitation)
   * @param {string} [pageToken]
   * @returns {Promise<{ folders: DriveItem[], files: DriveItem[], nextPageToken: string|null }>}
   */
  async function searchFiles(term, rootId = null, pageToken = null) {
    // Escape single quotes in search term
    const safeTerm = term.replace(/'/g, "\\'");

    // Match both audio files and folders.
    // NOTE: 'in ancestors' (recursive subtree) was removed — it causes Drive API 400
    // for shared folders. We search the full drive and filter client-side if needed.
    const q = `(mimeType contains 'audio/' or mimeType = 'application/vnd.google-apps.folder') and name contains '${safeTerm}' and trashed = false`;

    const params = new URLSearchParams({
      q,
      pageSize: '100',
      fields: `nextPageToken,files(${CONFIG.FILE_FIELDS})`,
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });

    if (pageToken) params.set('pageToken', pageToken);

    const url = `${CONFIG.API_BASE}/files?${params}`;
    const res = await _fetch(url);
    const data = await res.json();

    const folders = [];
    const files   = [];

    for (const raw of (data.files || [])) {
      const item = _normalizeItem(raw);
      if (item.isFolder) folders.push(item);
      else               files.push(item);
    }

    return {
      folders,
      files,
      nextPageToken: data.nextPageToken || null,
    };
  }

  /* ── downloadFile ─────────────────────────────────────────── */
  /**
   * Download a file's content as a Blob.
   * This is the main method for fetching audio files before playback.
   * The returned Blob can be stored in IndexedDB for offline caching.
   *
   * @param {string} fileId
   * @param {Function} [onProgress] - called with (loadedBytes, totalBytes)
   * @returns {Promise<Blob>}
   */
  async function downloadFile(fileId, onProgress = null) {
    const url = `${CONFIG.API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await _fetch(url);

    // Stream with progress reporting if callback provided
    if (onProgress && res.body) {
      const contentLength = parseInt(res.headers.get('Content-Length') || '0', 10);
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (contentLength) onProgress(loaded, contentLength);
      }

      return new Blob(chunks, { type: res.headers.get('Content-Type') || 'audio/mpeg' });
    }

    return res.blob();
  }

  /* ── getFileInfo ─────────────────────────────────────────── */
  /**
   * Fetch metadata for a single file.
   * @param {string} fileId
   * @returns {Promise<DriveItem>}
   */
  async function getFileInfo(fileId) {
    const params = new URLSearchParams({
      fields: CONFIG.FILE_FIELDS,
    });
    const url = `${CONFIG.API_BASE}/files/${encodeURIComponent(fileId)}?${params}`;
    const res = await _fetch(url);
    const data = await res.json();
    return _normalizeItem(data);
  }

  /* ── downloadFileHead ───────────────────────────────────── */
  /**
   * Download only the first `bytes` bytes of a file (Range request).
   * Used to read ID3 tags without fetching the entire audio file.
   * Returns a Blob with the partial content.
   *
   * @param {string} fileId
   * @param {number} [bytes=1048576]  — how many bytes to fetch (default 1MB)
   * @returns {Promise<Blob>}
   */
  async function downloadFileHead(fileId, bytes = 1048576) {
    const url = `${CONFIG.API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await _fetch(url, {
      headers: { 'Range': `bytes=0-${bytes - 1}` },
    });
    return res.blob();
  }

  /* ── findCoverImage ──────────────────────────────────────── */
  /**
   * Find a cover art image file in a Drive folder.
   * Looks for common filenames (cover, folder, artwork, front) first.
   * Returns the file ID and thumbnailLink of the best match, or null.
   *
   * @param {string} folderId
   * @returns {Promise<{ id: string, thumbnailLink: string|null }|null>}
   */
  async function findCoverImage(folderId) {
    const params = new URLSearchParams({
      q:         `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
      pageSize:  '10',
      fields:    'files(id,name,mimeType,thumbnailLink)',
      orderBy:   'name',
    });

    const url  = `${CONFIG.API_BASE}/files?${params}`;
    const res  = await _fetch(url);
    const data = await res.json();
    const imgs = data.files || [];
    if (imgs.length === 0) return null;

    // Prefer common cover art filenames
    const PRIORITY = /^(cover|folder|artwork|front|album)\./i;
    const best = imgs.find(f => PRIORITY.test(f.name)) || imgs[0];
    return { id: best.id, thumbnailLink: best.thumbnailLink || null };
  }

  /* ── Normalize Drive API item ──────────────────────────── */
  /**
   * Normalize a raw Drive API file object into a consistent shape.
   * @param {Object} raw - raw Drive API file object
   * @returns {DriveItem}
   */
  function _normalizeItem(raw) {
    return {
      id:           raw.id,
      name:         raw.name,
      mimeType:     raw.mimeType,
      size:         parseInt(raw.size || '0', 10),
      parents:      raw.parents || [],
      thumbnailUrl: raw.thumbnailLink || null,
      durationMs:   parseInt(raw.videoMediaMetadata?.durationMillis || '0', 10),
      // Derived
      isFolder:     isFolder(raw.mimeType),
      isAudio:      isAudio(raw.mimeType),
      isPlayable:   isPlayable(raw.mimeType),
      isWma:        isUnplayable(raw.mimeType),
      displayName:  cleanTitle(raw.name),
    };
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return {
    listFolder,
    listFolderAll,
    searchFiles,
    downloadFile,
    downloadFileHead,
    getFileInfo,
    findCoverImage,
    AuthError,
    DriveError,
  };
})();
