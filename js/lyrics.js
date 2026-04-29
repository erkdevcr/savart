/* ============================================================
   Savart — Lyrics module
   Fetches song lyrics via lyrics.ovh (free, no API key needed).
   ============================================================
   Design decisions:
   - Lazy fetch: only called after all recognition passes are done
     (artist + title are finalized before the first request).
   - In-memory cache keyed by "artist::title" (normalized lowercase).
   - undefined = not yet fetched; null = fetched but not found.
   - Returns null on any failure (non-fatal, background only).
   ============================================================ */

const Lyrics = (() => {

  const API_BASE = 'https://api.lyrics.ovh/v1';

  // "artist::title" → string (lyrics) | null (not found)
  // undefined (not in map) = not yet fetched
  const _cache = new Map();

  /* ── fetch ──────────────────────────────────────────────────
   * Fetch lyrics for a song. Caches the result.
   * @param {string} artist
   * @param {string} title
   * @returns {Promise<string|null>}
   */
  async function fetch(artist, title) {
    if (!artist?.trim() || !title?.trim()) return null;

    const key = `${artist.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
    if (_cache.has(key)) return _cache.get(key);

    try {
      const url = `${API_BASE}/${encodeURIComponent(artist.trim())}/${encodeURIComponent(title.trim())}`;
      const res = await window.fetch(url);
      if (!res.ok) { _cache.set(key, null); return null; }

      const data = await res.json();
      const lyrics = data.lyrics?.trim() || null;
      _cache.set(key, lyrics);
      return lyrics;
    } catch (_) {
      _cache.set(key, null);
      return null;
    }
  }

  /* ── getCached ──────────────────────────────────────────────
   * Returns cached lyrics if already fetched, undefined if not yet.
   * Callers use undefined to detect "still in progress / not tried".
   * @param {string} artist
   * @param {string} title
   * @returns {string | null | undefined}
   */
  function getCached(artist, title) {
    if (!artist || !title) return undefined;
    const key = `${artist.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
    return _cache.has(key) ? _cache.get(key) : undefined;
  }

  /* ── clearCache ─────────────────────────────────────────────
   * Clear the in-memory cache (e.g. on logout).
   */
  function clearCache() { _cache.clear(); }

  /* ── Expose ─────────────────────────────────────────────── */
  return { fetch, getCached, clearCache };

})();
