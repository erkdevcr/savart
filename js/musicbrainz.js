/* ============================================================
   Savart — MusicBrainz + Cover Art Archive
   Queries MusicBrainz to enrich song metadata (artist, album,
   year, track number, release ID) and fetches cover art from
   the Cover Art Archive (CAA) when no ID3 embedded art exists.

   APIs used:
     MusicBrainz: https://musicbrainz.org/ws/2/
     Cover Art Archive: https://coverartarchive.org/
   Docs: https://musicbrainz.org/doc/MusicBrainz_API
   Rate limit: 1 request/second (MusicBrainz — enforced here).
               CAA has no stated limit; runs in parallel.
   No authentication required.

   lookup() returns:
     { track, artist, album, year, releaseMbid }
   fetchCoverUrl() returns:
     string URL (250px thumbnail) or null
   ============================================================ */

const MusicBrainz = (() => {

  const MB_BASE    = 'https://musicbrainz.org/ws/2';
  const CAA_BASE   = 'https://coverartarchive.org';
  const USER_AGENT = `Savart/${CONFIG.VERSION || '1.0'} (https://github.com/erkdevcr/savart)`;

  /* ── Rate limiter: 1 req / 1.1 s (MusicBrainz only) ─────── */
  let _lastMbReqAt = 0;

  async function _mbFetch(url) {
    const now  = Date.now();
    const wait = Math.max(0, 1100 - (now - _lastMbReqAt));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastMbReqAt = Date.now();

    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    });
    if (!resp.ok) throw new Error(`MusicBrainz HTTP ${resp.status}`);
    return resp.json();
  }

  /* ── Session caches ──────────────────────────────────────── */
  // fileId → result object | null
  const _lookupCache = new Map();
  // releaseMbid → cover URL | null
  const _coverCache  = new Map();

  /* ── Helpers ─────────────────────────────────────────────── */

  /** Escape Lucene special characters. */
  function _esc(s) {
    return s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
  }

  /** Normalise string for fuzzy comparison. */
  function _norm(s) {
    return (s || '')
      .toLowerCase()
      .replace(/\s*\(.*?\)/g, '')
      .replace(/\s*[\-–—].*?(remaster|live|version|remix|edit).*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Substring match after normalising. */
  function _looseMatch(a, b) {
    const na = _norm(a), nb = _norm(b);
    return na.includes(nb) || nb.includes(na);
  }

  /** Build display artist from artist-credit array. */
  function _artistFromCredit(credits) {
    if (!Array.isArray(credits) || credits.length === 0) return null;
    return credits
      .map(c => (c.artist?.name || c.name || '') + (c.joinphrase || ''))
      .join('').trim() || null;
  }

  /** Extract 4-digit year from "YYYY", "YYYY-MM", or "YYYY-MM-DD". */
  function _year(dateStr) {
    const m = String(dateStr || '').match(/^(\d{4})/);
    return m ? m[1] : null;
  }

  /* ── Public: metadata lookup ─────────────────────────────── */

  /**
   * Look up full metadata for a recording from MusicBrainz.
   *
   * @param {string} fileId   — Savart file id (session cache key)
   * @param {string} title    — song title (required)
   * @param {string} [artist] — known artist (improves accuracy)
   * @param {string} [album]  — known album (improves release selection)
   * @returns {Promise<{
   *   track: string|null,
   *   artist: string|null,
   *   album: string|null,
   *   year: string|null,
   *   releaseMbid: string|null
   * }|null>}
   */
  async function lookup(fileId, title, artist, album) {
    if (!title) return null;
    if (_lookupCache.has(fileId)) return _lookupCache.get(fileId);

    try {
      let q = `recording:"${_esc(title)}"`;
      if (artist) q += ` AND artist:"${_esc(artist)}"`;

      const url = `${MB_BASE}/recording?query=${encodeURIComponent(q)}&inc=releases+artist-credits&fmt=json&limit=5`;
      const data = await _mbFetch(url);
      const recordings = Array.isArray(data.recordings) ? data.recordings : [];

      for (const rec of recordings) {
        if ((rec.score || 0) < 85) break;
        if (!_looseMatch(rec.title, title)) continue;

        const mbArtist = _artistFromCredit(rec['artist-credit']);
        const releases  = Array.isArray(rec.releases) ? rec.releases : [];

        // Prefer releases matching the known album name
        const preferred  = album ? releases.filter(r => _looseMatch(r.title, album)) : releases;
        const candidates = preferred.length > 0 ? preferred : releases;

        for (const rel of candidates) {
          for (const medium of (rel.media || [])) {
            for (const track of (medium.tracks || [])) {
              const pos = track.position ?? track.number;
              const result = {
                track:        pos != null ? String(pos) : null,
                artist:       mbArtist,
                album:        rel.title || null,
                year:         _year(rel.date),
                releaseMbid:  rel.id    || null,
              };
              _lookupCache.set(fileId, result);
              return result;
            }
          }
        }

        // Recording matched but releases have no track list — return artist at least
        if (mbArtist) {
          const result = { track: null, artist: mbArtist, album: null, year: null, releaseMbid: null };
          _lookupCache.set(fileId, result);
          return result;
        }
      }

      _lookupCache.set(fileId, null);
      return null;
    } catch (err) {
      console.warn('[MusicBrainz] Lookup failed:', err.message);
      return null; // don't cache network errors
    }
  }

  /* ── Public: Cover Art Archive ───────────────────────────── */

  /**
   * Fetch the front-cover URL for a MusicBrainz release from the
   * Cover Art Archive. Returns the 250px thumbnail URL or null.
   *
   * CAA endpoint: GET https://coverartarchive.org/release/{mbid}
   * Response: { images: [{ front: true, thumbnails: { 250: "url" } }] }
   *
   * @param {string} releaseMbid
   * @returns {Promise<string|null>}
   */
  async function fetchCoverUrl(releaseMbid) {
    if (!releaseMbid) return null;
    if (_coverCache.has(releaseMbid)) return _coverCache.get(releaseMbid);

    try {
      // CAA has no strict rate limit — use plain fetch (no MB throttle)
      const resp = await fetch(`${CAA_BASE}/release/${releaseMbid}`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      });
      if (!resp.ok) { _coverCache.set(releaseMbid, null); return null; }

      const data = await resp.json();
      const images = Array.isArray(data.images) ? data.images : [];

      // Prefer the front cover; fall back to first image
      const front = images.find(img => img.front) || images[0];
      if (!front) { _coverCache.set(releaseMbid, null); return null; }

      const url = front.thumbnails?.['250'] || front.thumbnails?.small || front.image || null;
      _coverCache.set(releaseMbid, url);
      return url;
    } catch (err) {
      console.warn('[CAA] Cover fetch failed:', err.message);
      return null;
    }
  }

  return { lookup, fetchCoverUrl };
})();
