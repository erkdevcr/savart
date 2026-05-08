/* ============================================================
   Savart — Lyrics module
   Fetches song lyrics via a chain of free, CORS-enabled APIs:
     1. lyrics.ovh   — fast, no auth, plain lyrics
     2. lrclib       — direct match (plain + synced LRC)
     3. lrclib       — fuzzy search fallback
     4. Discogs      — canonical artist enrichment → retry 1–3
   ============================================================
   Design decisions:
   - Lazy fetch: only called after all recognition passes are done
     (artist + title are finalized before the first request).
   - In-memory cache keyed by "artist::title" (normalized lowercase).
   - undefined = not yet fetched; null = fetched but not found.
   - Returns null on any failure (non-fatal, background only).
   ============================================================ */

const Lyrics = (() => {

  // "artist::title" → string (lyrics) | null (not found)
  // undefined (not in map) = not yet fetched
  const _cache = new Map();

  /* ── helpers ─────────────────────────────────────────────── */

  function _key(artist, title) {
    return `${artist.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
  }

  /**
   * Strip LRC timestamps so synced lyrics can be used as plain text.
   * "[01:23.45] Line text" → "Line text"
   */
  function _stripLrc(synced) {
    if (!synced) return null;
    const plain = synced
      .split('\n')
      .map(l => l.replace(/^\[[\d:.]+\]\s*/, ''))
      .filter(l => l.trim())
      .join('\n')
      .trim();
    return plain || null;
  }

  /* ── provider 1: lyrics.ovh ──────────────────────────────── */

  async function _fetchOvh(artist, title) {
    try {
      const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist.trim())}/${encodeURIComponent(title.trim())}`;
      const res = await window.fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) return null;
      const data = await res.json();
      return data.lyrics?.trim() || null;
    } catch (_) {
      return null;
    }
  }

  /* ── provider 2: lrclib ──────────────────────────────────── */

  /**
   * lrclib direct-get endpoint — exact match by track_name + artist_name.
   * Returns lyrics string or null.
   */
  async function _fetchLrclibGet(artist, title) {
    try {
      const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title.trim())}&artist_name=${encodeURIComponent(artist.trim())}`;
      const res = await window.fetch(url, {
        signal: AbortSignal.timeout(7000),
        headers: { 'User-Agent': 'Savart/1.0 (https://erkdevcr.github.io/savart)' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const plain  = data.plainLyrics?.trim()  || null;
      const synced = data.syncedLyrics?.trim() || null;
      return plain || _stripLrc(synced);
    } catch (_) {
      return null;
    }
  }

  /**
   * lrclib search endpoint — fuzzy match, takes first result.
   * Used as fallback when the direct get returns nothing.
   */
  async function _fetchLrclibSearch(artist, title) {
    try {
      const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title.trim())}&artist_name=${encodeURIComponent(artist.trim())}&limit=1`;
      const res = await window.fetch(url, {
        signal: AbortSignal.timeout(7000),
        headers: { 'User-Agent': 'Savart/1.0 (https://erkdevcr.github.io/savart)' },
      });
      if (!res.ok) return null;
      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) return null;
      const hit    = results[0];
      const plain  = hit.plainLyrics?.trim()  || null;
      const synced = hit.syncedLyrics?.trim() || null;
      return plain || _stripLrc(synced);
    } catch (_) {
      return null;
    }
  }

  /* ── fetch ──────────────────────────────────────────────────
   * Fetch lyrics for a song, trying each provider in order.
   * @param {string} artist
   * @param {string} title
   * @returns {Promise<string|null>}
   */
  async function fetch(artist, title) {
    if (!artist?.trim() || !title?.trim()) return null;

    const key = _key(artist, title);
    if (_cache.has(key)) return _cache.get(key);

    let lyrics = null;

    // 1. lyrics.ovh
    lyrics = await _fetchOvh(artist, title);

    // 2. lrclib — direct match
    if (!lyrics) lyrics = await _fetchLrclibGet(artist, title);

    // 3. lrclib — fuzzy search (handles slight spelling differences)
    if (!lyrics) lyrics = await _fetchLrclibSearch(artist, title);

    // 4. Discogs metadata enrichment → retry providers with canonical artist
    // Handles compound artist strings like "Eminem feat. Rihanna" that lyrics
    // APIs don't recognise — Discogs resolves the primary artist name.
    if (!lyrics && typeof Discogs !== 'undefined') {
      try {
        const enriched = await Discogs.fetchMetadataForLyrics(artist, title);
        if (enriched && enriched.artist.toLowerCase() !== artist.toLowerCase()) {
          lyrics = await _fetchOvh(enriched.artist, enriched.title);
          if (!lyrics) lyrics = await _fetchLrclibGet(enriched.artist, enriched.title);
          if (!lyrics) lyrics = await _fetchLrclibSearch(enriched.artist, enriched.title);
        }
      } catch (_) { /* non-fatal */ }
    }

    _cache.set(key, lyrics);
    return lyrics;
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
    const key = _key(artist, title);
    return _cache.has(key) ? _cache.get(key) : undefined;
  }

  /* ── clearCache ─────────────────────────────────────────────
   * Clear the in-memory cache (e.g. on logout).
   */
  function clearCache() { _cache.clear(); }

  /* ── Expose ─────────────────────────────────────────────── */
  return { fetch, getCached, clearCache };

})();
