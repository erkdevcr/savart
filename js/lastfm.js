/* ============================================================
   Savart — Last.fm module
   Fetches album cover art from the Last.fm API.
   ============================================================
   - Uses album.getinfo (artist + album → cover URL)
   - In-memory cache keyed by "artist::album" to avoid repeat calls
   - Filters out Last.fm's known "no image" placeholder
   - All requests are unauthenticated (read-only, public endpoint)
   ============================================================ */

const Lastfm = (() => {

  const API_BASE = 'https://ws.audioscrobbler.com/2.0/';

  // Known Last.fm "no image" placeholder hash — returned when no cover exists.
  // Filter these out so we don't store a gray placeholder as cover art.
  const PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

  // In-memory cache: "artist::album" → url (string) | null
  // Avoids hitting the API repeatedly for the same album in one session.
  const _cache = new Map();

  /* ── fetchCover ─────────────────────────────────────────────
   * Fetch the largest available album cover from Last.fm.
   *
   * @param {string} artist  — artist name (from ID3 tag)
   * @param {string} album   — album name (from ID3 tag)
   * @returns {Promise<string|null>}  — image URL, or null if not found
   */
  async function fetchCover(artist, album) {
    if (!artist?.trim() || !album?.trim()) return null;

    const key = `${artist.trim().toLowerCase()}::${album.trim().toLowerCase()}`;
    if (_cache.has(key)) return _cache.get(key);

    try {
      const params = new URLSearchParams({
        method:      'album.getinfo',
        api_key:     CONFIG.LASTFM_API_KEY,
        artist:      artist.trim(),
        album:       album.trim(),
        format:      'json',
        autocorrect: '1',   // Last.fm corrects minor spelling differences
      });

      const res = await fetch(`${API_BASE}?${params}`);
      if (!res.ok) { _cache.set(key, null); return null; }

      const data = await res.json();
      const images = data.album?.image;
      if (!Array.isArray(images) || images.length === 0) {
        _cache.set(key, null);
        return null;
      }

      // Last.fm returns sizes: small | medium | large | extralarge | mega
      // Prefer largest available. Filter out empty strings and the placeholder.
      const SIZES = ['mega', 'extralarge', 'large', 'medium'];
      let url = null;
      for (const size of SIZES) {
        const img = images.find(i => i.size === size);
        const src = img?.['#text']?.trim();
        if (src && !src.includes(PLACEHOLDER_HASH)) {
          url = src;
          break;
        }
      }

      _cache.set(key, url);
      return url;

    } catch (_) {
      _cache.set(key, null);
      return null;
    }
  }

  /* ── fetchCoverByTrack ──────────────────────────────────────
   * Fetch album cover using artist + track title (track.getInfo).
   * Used when no album tag is available in the file metadata.
   * Last.fm returns the album the track belongs to, including artwork.
   *
   * @param {string} artist
   * @param {string} title
   * @returns {Promise<string|null>}
   */
  async function fetchCoverByTrack(artist, title) {
    if (!artist?.trim() || !title?.trim()) return null;

    const key = `track::${artist.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
    if (_cache.has(key)) return _cache.get(key);

    try {
      const params = new URLSearchParams({
        method:      'track.getInfo',
        api_key:     CONFIG.LASTFM_API_KEY,
        artist:      artist.trim(),
        track:       title.trim(),
        format:      'json',
        autocorrect: '1',
      });

      const res = await fetch(`${API_BASE}?${params}`);
      if (!res.ok) { _cache.set(key, null); return null; }

      const data = await res.json();
      const images = data.track?.album?.image;
      if (!Array.isArray(images) || images.length === 0) {
        _cache.set(key, null);
        return null;
      }

      const SIZES = ['mega', 'extralarge', 'large', 'medium'];
      let url = null;
      for (const size of SIZES) {
        const img = images.find(i => i.size === size);
        const src = img?.['#text']?.trim();
        if (src && !src.includes(PLACEHOLDER_HASH)) {
          url = src;
          break;
        }
      }

      _cache.set(key, url);
      return url;

    } catch (_) {
      _cache.set(key, null);
      return null;
    }
  }

  /* ── fetchArtistImage ──────────────────────────────────────
   * Fetch an artist photo from TheAudioDB (free, no auth required).
   * Returns the strArtistThumb URL (square photo, suitable for circular avatars),
   * or null if not found.
   *
   * @param {string} artistName
   * @returns {Promise<string|null>}
   */
  async function fetchArtistImage(artistName) {
    if (!artistName?.trim()) return null;

    const key = `artist::${artistName.trim().toLowerCase()}`;
    if (_cache.has(key)) return _cache.get(key);

    try {
      const res = await fetch(
        `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artistName.trim())}`
      );
      if (!res.ok) { _cache.set(key, null); return null; }
      const data = await res.json();
      const artist = data.artists?.[0];
      // Prefer strArtistThumb (portrait/square photo) over fanart (landscape)
      const url = artist?.strArtistThumb || null;
      _cache.set(key, url);
      return url;
    } catch (_) {
      _cache.set(key, null);
      return null;
    }
  }

  /* ── clearCache ─────────────────────────────────────────────
   * Clear the in-memory cache (e.g. on logout or session end).
   */
  function clearCache() { _cache.clear(); }

  /* ── Expose ─────────────────────────────────────────────── */
  return { fetchCover, fetchCoverByTrack, fetchArtistImage, clearCache };

})();
