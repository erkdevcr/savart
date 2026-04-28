/* ============================================================
   Savart — AudD.io module
   Audio fingerprinting & identification via AudD.io API.
   ============================================================
   Design decisions:
   - Accepts a Blob directly (no URL needed — Drive files require auth).
   - Requests apple_music return to get high-res cover art URL.
   - Returns null on any failure (non-fatal, background only).
   - Caller is responsible for rate limiting and retry logic.
   ============================================================ */

const Audd = (() => {

  const API_URL = 'https://api.audd.io/';

  /* ── identify ───────────────────────────────────────────────
   * Send an audio Blob to AudD.io for fingerprinting.
   * The first 1MB of a file is enough for a confident match.
   *
   * @param {Blob} blob
   * @returns {Promise<{ title, artist, album, coverUrl } | null>}
   */
  async function identify(blob) {
    if (!CONFIG.AUDD_API_KEY || !blob) return null;

    const form = new FormData();
    form.append('api_token', CONFIG.AUDD_API_KEY);
    form.append('audio',     blob, 'audio.mp3');
    form.append('return',    'apple_music');   // get artwork URL in response

    const res = await fetch(API_URL, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`AudD HTTP ${res.status}`);

    const data = await res.json();

    // status: 'success' with null result → song not found (not an error)
    if (data.status !== 'success') throw new Error(`AudD error: ${data.error?.error_message}`);
    if (!data.result) return null;   // genuinely not found

    const r = data.result;

    // Apple Music artwork template: replace size placeholders
    let coverUrl = null;
    const tpl = r.apple_music?.artwork?.url;
    if (tpl) coverUrl = tpl.replace('{w}', '500').replace('{h}', '500');

    return {
      title:    r.title  || null,
      artist:   r.artist || null,
      album:    r.album  || null,
      coverUrl,
    };
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return { identify };

})();
