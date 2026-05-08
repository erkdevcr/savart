/* ============================================================
   Savart — Discogs module
   Fetches release metadata and cover art from the Discogs API.
   ============================================================
   API: https://www.discogs.com/developers/
   Endpoints used:
     /database/search — search releases by artist + album or
                        free-text query
   Rate limit: 25 req/min unauthenticated · 60 req/min with key
               → throttled here to 1 req/s (conservative).
   Authentication: optional Consumer Key+Secret via config.
   No authentication required for read-only public data.

   lookup()                 → { artist, album, year, coverUrl }
   fetchMetadataForLyrics() → { artist, title } canonical names
   ============================================================ */

const Discogs = (() => {

  const BASE = 'https://api.discogs.com';
  const UA   = `Savart/${(typeof CONFIG !== 'undefined' ? CONFIG.VERSION : null) || '1.0'} (https://erkdevcr.github.io/savart)`;

  /* ── Rate limiter: 1 req / 1.1 s ────────────────────────── */
  let _lastReqAt = 0;
  const RATE_MS  = 1100;

  /* ── Session caches ──────────────────────────────────────── */
  // fileId → result object | null
  const _lookupCache = new Map();

  /* ── Helpers ─────────────────────────────────────────────── */

  function _norm(s) {
    return (s || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, '')   // strip parenthetical notes
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _looseMatch(a, b) {
    const na = _norm(a), nb = _norm(b);
    return !!(na && nb && (na.includes(nb) || nb.includes(na)));
  }

  /**
   * Parse Discogs "Artist - Album" title format.
   * Handles multi-hyphen album titles correctly.
   */
  function _parseDgTitle(raw) {
    const idx = (raw || '').indexOf(' - ');
    if (idx > 0) {
      return { artist: raw.slice(0, idx).trim(), album: raw.slice(idx + 3).trim() };
    }
    return { artist: '', album: (raw || '').trim() };
  }

  /**
   * Filter out Discogs placeholder / default cover images.
   * Returns the URL unchanged, or null if it is a placeholder.
   */
  function _cleanCoverUrl(url) {
    if (!url) return null;
    if (url.includes('spacer.gif'))        return null;
    if (url.includes('no-image'))          return null;
    if (url.includes('default-release'))   return null;
    if (url.includes('vinyl-placeholder')) return null;
    // Discogs CDN images are served from discogs-cdn.com — these are real
    return url.startsWith('http') ? url : null;
  }

  /* ── HTTP fetch with rate-limiting ──────────────────────── */

  /**
   * Build the Authorization header for Discogs Auth.
   * Priority: Personal Access Token > Consumer Key+Secret > none.
   * Without auth, image URLs are absent from search results.
   */
  function _authHeader() {
    if (typeof CONFIG === 'undefined') return null;
    const token  = CONFIG.DISCOGS_TOKEN  || '';
    const key    = CONFIG.DISCOGS_KEY    || '';
    const secret = CONFIG.DISCOGS_SECRET || '';
    if (token)         return `Discogs token=${token}`;
    if (key && secret) return `Discogs key=${key}, secret=${secret}`;
    return null; // unauthenticated — cover_image will be absent
  }

  async function _fetch(path) {
    const now  = Date.now();
    const wait = Math.max(0, RATE_MS - (now - _lastReqAt));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastReqAt = Date.now();

    const headers = { 'User-Agent': UA };
    const auth = _authHeader();
    if (auth) headers['Authorization'] = auth;

    const res = await fetch(`${BASE}${path}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Discogs HTTP ${res.status}`);
    return res.json();
  }

  /* ── Public: metadata + cover lookup ────────────────────── */

  /**
   * Look up metadata for a file from Discogs.
   * Searches by artist + album when both are available (precise),
   * falls back to artist + title query (broad).
   *
   * @param {string} fileId  — Savart file ID (session cache key)
   * @param {string} artist  — known artist (from ID3 / MB)
   * @param {string} title   — song title / display name
   * @param {string} [album] — known album name (improves precision)
   * @returns {Promise<{
   *   artist:   string|null,
   *   album:    string|null,
   *   year:     string|null,
   *   coverUrl: string|null
   * }|null>}
   */
  async function lookup(fileId, artist, title, album) {
    if (!artist?.trim() && !title?.trim()) return null;
    if (_lookupCache.has(fileId)) return _lookupCache.get(fileId);

    try {
      let params;
      if (artist && album) {
        // Precise search: Discogs artist + release_title filters
        params = new URLSearchParams({
          type:          'release',
          artist:        artist.trim(),
          release_title: album.trim(),
          per_page:      '5',
        });
      } else {
        // Broad free-text search
        const q = [artist, album || title].filter(Boolean).map(s => s.trim()).join(' ');
        params = new URLSearchParams({ q, type: 'release', per_page: '5' });
      }

      const data    = await _fetch(`/database/search?${params}`);
      const results = (data.results || []).filter(r =>
        r.type === 'release' || r.type === 'master'
      );

      if (results.length === 0) {
        _lookupCache.set(fileId, null);
        return null;
      }

      // Pick best result: prefer one that matches artist + album
      let hit = null;
      if (artist) {
        hit = results.find(r => {
          const p = _parseDgTitle(r.title);
          const artistOk = _looseMatch(p.artist, artist);
          const albumOk  = !album || _looseMatch(p.album, album);
          return artistOk && albumOk;
        });
      }
      if (!hit) hit = results[0];

      const parsed   = _parseDgTitle(hit.title);
      const coverUrl = _cleanCoverUrl(hit.cover_image);

      const result = {
        artist:   parsed.artist || artist  || null,
        album:    parsed.album  || album   || null,
        year:     hit.year ? String(hit.year) : null,
        coverUrl,
      };

      _lookupCache.set(fileId, result);
      return result;

    } catch (err) {
      console.warn('[Discogs] lookup failed:', err.message);
      return null; // don't cache network errors
    }
  }

  /* ── Public: lyrics-enrichment helper ───────────────────── */

  /**
   * Lightweight search to derive a canonical primary artist name
   * for a song. Used by the lyrics pipeline when artist+title metadata
   * contains compound strings ("feat.", "with", "&") that confuse
   * lyrics APIs.
   *
   * Returns { artist, title } with the primary (simplified) artist,
   * or null if nothing useful was found.
   *
   * @param {string} artist
   * @param {string} title
   * @returns {Promise<{ artist: string, title: string }|null>}
   */
  async function fetchMetadataForLyrics(artist, title) {
    if (!artist?.trim() || !title?.trim()) return null;

    // Strip "feat." and secondary artists locally first — if Discogs
    // confirms the primary artist it's a stronger signal.
    const primaryLocal = artist
      .replace(/\s+(feat\.|ft\.|featuring|with\s|&|\band\b|vs\.?).*/i, '')
      .trim();

    try {
      const q = `${primaryLocal} ${title.trim()}`;
      const params = new URLSearchParams({ q, type: 'release', per_page: '3' });
      const data   = await _fetch(`/database/search?${params}`);
      const results = (data.results || []).filter(r =>
        r.type === 'release' || r.type === 'master'
      );
      if (results.length === 0) {
        // Return the local-stripped version even if no Discogs result
        return primaryLocal !== artist ? { artist: primaryLocal, title } : null;
      }

      const hit    = results[0];
      const parsed = _parseDgTitle(hit.title);

      // Use Discogs artist if it loosely matches; otherwise fall back to
      // the locally-stripped version.
      const dgArtist  = parsed.artist || '';
      const bestArtist = (dgArtist && _looseMatch(dgArtist, primaryLocal))
        ? dgArtist
        : primaryLocal;

      // Only return if we actually simplified something
      if (bestArtist.toLowerCase() === artist.toLowerCase()) return null;
      return { artist: bestArtist, title };

    } catch (_) {
      // Non-fatal: return local-stripped version as best effort
      return primaryLocal !== artist ? { artist: primaryLocal, title } : null;
    }
  }

  /* ── clearCache ─────────────────────────────────────────── */
  function clearCache() { _lookupCache.clear(); }

  /* ── Expose ─────────────────────────────────────────────── */
  return { lookup, fetchMetadataForLyrics, clearCache };

})();
