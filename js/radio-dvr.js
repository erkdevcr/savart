/**
 * RadioDvr — best-effort live-stream rolling buffer + seek for Radio Emisoras.
 *
 * Plain <audio src="liveStream"> cannot seek backward: a live Icecast/Shoutcast-
 * style HTTP stream has no Content-Length/Range support, so audio.seekable is
 * always empty. To support the 15s/30s rewind/forward buttons, this module
 * fetches the raw stream itself and feeds it into a MediaSource SourceBuffer,
 * which DOES expose a seekable buffered range the <audio> element can scrub
 * within — effectively a small client-side DVR buffer for a live feed.
 *
 * Gated by the same kind of cross-origin constraint as js/icy-metadata.js: a
 * fetch() (unlike a plain <audio src>) requires the stream's server to permit
 * CORS for a plain cross-origin GET. This varies per server and can change
 * over time (Zeno FM, for instance, has been observed both blocking and
 * allowing it), so every station gets a genuine attempt on each connection
 * rather than being excluded by domain. When it fails, start() resolves
 * false and the caller falls straight back to today's plain <audio src>
 * playback (no seeking, exactly as before — see player.js). This is meant
 * as a routine, silent per-station fallback, not an error condition.
 */
const RadioDvr = (() => {
  const RETAIN_SECONDS         = 300;  // ~5 min rolling window — comfortably more than the
                                        // 30s max seek distance; bounds memory for a long session.
  const SOURCEOPEN_TIMEOUT_MS  = 6000;
  const FIRST_CHUNK_TIMEOUT_MS = 6000;

  function _pickMime(contentType) {
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('mpeg') || ct.includes('mp3')) return 'audio/mpeg';
    if (ct.includes('aac'))                        return 'audio/aac';
    if (ct.includes('mp4'))                        return 'audio/mp4; codecs="mp4a.40.2"';
    if (ct.includes('ogg') || ct.includes('opus'))  return 'audio/webm; codecs="opus"';
    return null; // unrecognized — caller defaults to audio/mpeg (the common case in this catalog)
  }

  function create(audioEl) {
    let ms         = null;
    let sb         = null;
    let reader     = null;
    let objectUrl  = null;
    let stopped    = false;
    let ready      = false;
    let onDropCb   = null;
    let onChunkCb  = null;   // v3.5.670: recibe cada chunk crudo (para grabar emisora)
    let contentType = '';    // v3.5.670: Content-Type de la respuesta (mp3 / aac …)
    let appendQueue = Promise.resolve();
    // v3.5.662: running estimate of the CURRENTLY retained buffer size, in
    // bytes — exposed via getBufferedBytes() for the player's "buffer en MB"
    // diagnostic chip (lets the user watch it grow and plateau around
    // RETAIN_SECONDS while staying on the same station). MediaSource has no
    // direct byte-size API for a SourceBuffer's content, so this is tracked
    // by hand: incremented as chunks are appended, then scaled down in
    // _evictOld() proportionally to the time range removed (reasonable since
    // a live stream's bitrate is roughly constant) rather than growing forever.
    let bytesAppended = 0;

    function _appendChunk(chunk) {
      if (onChunkCb && !stopped) { try { onChunkCb(chunk); } catch (_) {} }
      bytesAppended += chunk?.byteLength || 0;
      appendQueue = appendQueue.then(() => new Promise((resolve, reject) => {
        if (stopped || !sb) { resolve(); return; }
        const onUpdateEnd = () => { cleanup(); resolve(); };
        const onErr        = (e) => { cleanup(); reject(e); };
        function cleanup() {
          sb.removeEventListener('updateend', onUpdateEnd);
          sb.removeEventListener('error', onErr);
        }
        sb.addEventListener('updateend', onUpdateEnd, { once: true });
        sb.addEventListener('error', onErr, { once: true });
        try { sb.appendBuffer(chunk); } catch (e) { cleanup(); reject(e); }
      }));
      return appendQueue;
    }

    function _evictOld() {
      if (stopped || !sb || sb.updating || !audioEl.buffered || !audioEl.buffered.length) {
        return Promise.resolve();
      }
      const start = audioEl.buffered.start(0);
      const end   = audioEl.buffered.end(audioEl.buffered.length - 1);
      const removeEnd = audioEl.currentTime - RETAIN_SECONDS;
      if (!(removeEnd > start + 1)) return Promise.resolve();
      // Scale the byte estimate down by the fraction of the retained time
      // range we're about to remove — see bytesAppended's comment above.
      const totalDur = end - start;
      if (totalDur > 0) {
        const removedFraction = Math.min(1, Math.max(0, (removeEnd - start) / totalDur));
        bytesAppended = Math.max(0, bytesAppended * (1 - removedFraction));
      }
      return new Promise((resolve) => {
        const onUp = () => { sb.removeEventListener('updateend', onUp); resolve(); };
        sb.addEventListener('updateend', onUp, { once: true });
        try { sb.remove(start, removeEnd); } catch (_) { resolve(); }
      });
    }

    async function _pumpLoop() {
      try {
        while (!stopped) {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done) throw new Error('radio stream ended');
          await _appendChunk(value);
          await _evictOld();
        }
      } catch (e) {
        if (stopped) return;
        ready = false;
        if (onDropCb) { try { onDropCb(e); } catch (_) {} }
      }
    }

    async function start(url) {
      if (typeof MediaSource === 'undefined') return false;
      stopped = false;
      ready = false;

      try {
        ms = new MediaSource();
        objectUrl = URL.createObjectURL(ms);
        audioEl.src = objectUrl;

        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('sourceopen timeout')), SOURCEOPEN_TIMEOUT_MS);
          ms.addEventListener('sourceopen', () => { clearTimeout(t); resolve(); }, { once: true });
        });

        const resp = await fetch(url, { method: 'GET', mode: 'cors' });
        if (!resp.ok || !resp.body) throw new Error('bad response ' + resp.status);

        contentType = resp.headers.get('content-type') || '';
        const mime = _pickMime(contentType) || 'audio/mpeg';
        sb = ms.addSourceBuffer(mime);
        reader = resp.body.getReader();

        // Append just the first chunk before resolving, so playback can start
        // promptly — the rest keeps buffering in the background via _pumpLoop.
        const first = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('first chunk timeout')), FIRST_CHUNK_TIMEOUT_MS)),
        ]);
        if (first.done || !first.value) throw new Error('empty stream');
        await _appendChunk(first.value);

        ready = true;
        _pumpLoop(); // fire and forget — keeps running until stop()
        return true;
      } catch (e) {
        stop();
        return false;
      }
    }

    function stop() {
      stopped = true;
      ready = false;
      try { reader && reader.cancel(); } catch (_) {}
      try { if (objectUrl) URL.revokeObjectURL(objectUrl); } catch (_) {}
      ms = null; sb = null; reader = null; objectUrl = null;
    }

    function isReady() { return ready; }

    function getBufferedRange() {
      if (!ready || !audioEl.buffered || !audioEl.buffered.length) return null;
      return { start: audioEl.buffered.start(0), end: audioEl.buffered.end(audioEl.buffered.length - 1) };
    }

    /** Approximate size (bytes) of the currently retained rolling buffer. */
    function getBufferedBytes() {
      return ready ? bytesAppended : 0;
    }

    function onDrop(cb) { onDropCb = cb; }
    /** v3.5.670: callback por cada chunk crudo recibido (antes de pasar al SourceBuffer). */
    function onChunk(cb) { onChunkCb = cb; }
    function getContentType() { return contentType; }

    return { start, stop, isReady, getBufferedRange, getBufferedBytes, onDrop, onChunk, getContentType };
  }

  return { create };
})();
