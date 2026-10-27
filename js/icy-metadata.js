/* ============================================================
   Savart — ICY metadata module (Radio Emisoras "now playing")
   ============================================================
   Best-effort live song metadata for internet radio streams.

   HOW IT WORKS
   Icecast/Shoutcast-family servers can interleave small text blocks
   ("StreamTitle='Artist - Song';...") into the raw audio byte stream,
   at a fixed byte interval advertised via the `icy-metaint` response
   header — but ONLY when the client sends `Icy-MetaData: 1` on the
   request. There is no separate "now playing" endpoint for this: the
   only way to read it is to fetch the actual stream bytes and walk
   the audio/metadata framing by hand. There is no browser API for it
   (the <audio>/<video> elements never expose ICY metadata).

   CORS gates all of this: a stream only works here if its server
   sends Access-Control-Allow-Origin for cross-origin fetch(). In
   practice (verified against this catalog's real stream hosts):
     - Zeno.fm (the majority of this catalog's stations) actively
       rejects cross-origin requests (401, anti-leech) — never works.
     - Triton Digital / StreamTheWorld streams fail the CORS preflight
       that `Icy-MetaData: 1` triggers (server-side bug: their
       Access-Control-Allow-Header response is malformed) — never works.
     - Plain self-hosted Icecast/Shoutcast/RadioBOSS servers are hit
       or miss — some allow it (confirmed working), many don't.
   So this module is deliberately a silent, best-effort layer: when a
   stream doesn't cooperate, it gives up quickly and stays quiet, and
   the caller just keeps showing the station logo.

   BANDWIDTH: reading the interleaved stream means downloading real
   audio bytes just to reach the next metadata block — there's no way
   around that for this family of servers. To keep this cheap, each
   probe (`peekOnce`) opens its own short-lived fetch, reads only up to
   one full metaint cycle (usually tens of KB), and closes — it does
   NOT hold a second full-bitrate connection open for the song's whole
   duration. `watch()` just re-probes on a slow timer.
   ============================================================ */

const IcyMetadata = (() => {

  const STREAM_TITLE_RE = /StreamTitle=(['"])([\s\S]*?)\1/;

  /**
   * Open one short-lived connection to `url`, read up to a single
   * icy-metaint cycle, and return whatever StreamTitle (if any) was
   * embedded in it.
   *
   * @param {string} url
   * @param {{timeoutMs?: number, maxBytes?: number}} [opts]
   * @returns {Promise<{unavailable: boolean, title: string|null}>}
   *   unavailable=true means this stream can't be read this way at all
   *   (CORS-blocked, no icy-metaint, non-OK response, etc.) — the
   *   caller should stop retrying. unavailable=false + title=null just
   *   means this particular cycle didn't surface a title in time.
   */
  async function peekOnce(url, { timeoutMs = 8000, maxBytes = 2_000_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(url, {
        method:  'GET',
        mode:    'cors',
        headers: { 'Icy-MetaData': '1' },
        signal:  controller.signal,
      });
    } catch (_) {
      clearTimeout(timer);
      return { unavailable: true, title: null };
    }

    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      try { resp.body?.cancel(); } catch (_) {}
      return { unavailable: true, title: null };
    }

    const metaintStr = resp.headers.get('icy-metaint');
    const metaint = metaintStr ? parseInt(metaintStr, 10) : 0;
    if (!metaint || !Number.isFinite(metaint) || metaint <= 0) {
      clearTimeout(timer);
      try { resp.body.cancel(); } catch (_) {}
      return { unavailable: true, title: null };
    }

    const reader = resp.body.getReader();
    let mode                 = 'audio'; // 'audio' | 'metalen' | 'metadata'
    let audioBytesRemaining  = metaint;
    let metaBytesRemaining   = 0;
    let metaChunks           = [];
    let totalRead            = 0;
    let title                = null;

    try {
      while (totalRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        totalRead += value.length;

        let pos = 0;
        while (pos < value.length) {
          if (mode === 'audio') {
            const take = Math.min(audioBytesRemaining, value.length - pos);
            pos += take;
            audioBytesRemaining -= take;
            if (audioBytesRemaining === 0) mode = 'metalen';

          } else if (mode === 'metalen') {
            const lenByte = value[pos]; pos += 1;
            metaBytesRemaining = lenByte * 16;
            metaChunks = [];
            if (metaBytesRemaining === 0) {
              mode = 'audio';
              audioBytesRemaining = metaint;
            } else {
              mode = 'metadata';
            }

          } else { // 'metadata'
            const take = Math.min(metaBytesRemaining, value.length - pos);
            metaChunks.push(value.slice(pos, pos + take));
            pos += take;
            metaBytesRemaining -= take;
            if (metaBytesRemaining === 0) {
              const totalLen = metaChunks.reduce((s, c) => s + c.length, 0);
              const merged = new Uint8Array(totalLen);
              let off = 0;
              for (const c of metaChunks) { merged.set(c, off); off += c.length; }
              const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
              const m = STREAM_TITLE_RE.exec(text);
              title = m ? m[2].trim() : '';
              pos = value.length; // stop scanning — we got our one block
            }
          }
        }
        if (title !== null) break;
      }
    } catch (_) {
      // Transient read error mid-cycle — not a permanent "unavailable" verdict,
      // just no title this round. The caller's slow retry timer handles it.
    } finally {
      clearTimeout(timer);
      try { reader.cancel(); } catch (_) {}
    }

    return { unavailable: false, title };
  }

  /**
   * Best-effort live "now playing" watcher for a radio stream URL.
   * Probes immediately, then re-probes every `intervalMs` as long as
   * the stream keeps responding; gives up permanently (and calls
   * `onUnavailable` once) after two consecutive failed probes, so a
   * Zeno/Triton-style stream that can never work doesn't keep
   * reconnecting forever.
   *
   * @param {string} url
   * @param {{onTitle?: (title:string)=>void, onUnavailable?: ()=>void, intervalMs?: number}} callbacks
   * @returns {{stop(): void}}
   */
  function watch(url, { onTitle, onUnavailable, intervalMs = 25000 } = {}) {
    let stopped              = false;
    let timer                = null;
    let lastTitle             = null;
    let consecutiveFailures  = 0;

    async function cycle() {
      if (stopped) return;
      let result;
      try {
        result = await peekOnce(url);
      } catch (_) {
        result = { unavailable: true, title: null };
      }
      if (stopped) return;

      if (result.unavailable) {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          try { onUnavailable?.(); } catch (_) {}
          stop();
          return;
        }
      } else {
        consecutiveFailures = 0;
        if (result.title && result.title !== lastTitle) {
          lastTitle = result.title;
          try { onTitle?.(result.title); } catch (_) {}
        }
      }

      if (!stopped) timer = setTimeout(cycle, intervalMs);
    }

    function stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    }

    cycle();

    return { stop };
  }

  return { peekOnce, watch };

})();
