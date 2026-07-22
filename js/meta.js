/* ============================================================
   Savart — Metadata / ID3 parser
   Extracts cover art (APIC), text tags, and audio specs from blobs.
   ============================================================
   Supported formats:
   - ID3v2.2 (3-char frame IDs, rare but exists)
   - ID3v2.3 (most common — MP3, AAC, M4A)
   - ID3v2.4 (modern synchsafe sizes)
   - FLAC PICTURE block + STREAMINFO + VORBIS_COMMENT

   Result shape:
   {
     title       : string|null,
     artist      : string|null,
     album       : string|null,
     year        : string|null,
     track       : string|null,
     coverUrl    : string|null,  ← Object URL, session-only
     bitrate     : number|null,  ← kbps (real from headers, or null)
     sampleRate  : number|null,  ← Hz (FLAC/ID3 only)
     channels    : number|null,
     bitsPerSample: number|null, ← FLAC only
   }

   Performance: reads only the first 1MB of the blob.
   ID3 tags (with art) are almost always < 1MB.
   ============================================================ */

const Meta = (() => {

  /* ── In-memory cache ─────────────────────────────────────── */
  // fileId → parsed result (LRU — Map preserves insertion order;
  // delete+re-insert on access moves entry to the end = most-recently-used).
  const _cache = new Map();

  // Object URLs that need cleanup when cache is evicted
  const _objectUrls = new Set();

  // Maximum number of entries kept in the cache.
  // Browse folders can have 100-200+ songs all visible at once — each needs its
  // blob URL alive in the cache or the <img> shows a broken image when evicted.
  // 300 entries × ~35 KB average cover ≈ 10 MB of blob memory, acceptable for
  // a music player.  Old value of 40 caused covers to disappear mid-scan as the
  // cache overflowed while _prefetchAndApplyFolderCovers batched large folders.
  const _MAX_CACHE = 300;

  /* ── LRU helpers ─────────────────────────────────────────── */

  /** Move an existing entry to the end of the Map (mark as recently used). */
  function _touch(fileId) {
    if (!_cache.has(fileId)) return;
    const val = _cache.get(fileId);
    _cache.delete(fileId);
    _cache.set(fileId, val);
  }

  /**
   * Evict the least-recently-used entries until cache is within _MAX_CACHE.
   *
   * Revocación DIFERIDA (fix I9): revocar inmediatamente rompía las portadas
   * todavía visibles — en carpetas con >300 pistas con arte embebido, el scroll
   * evictaba entradas cuyas <img> seguían en el DOM (mismo bug que ya ocurrió
   * con la cota en 40). Ahora la URL evictada va a una cola y solo se revoca
   * ~30 s después Y si ningún <img> del documento la está usando.
   */
  const _pendingRevoke = []; // { url, at }
  let   _revokeTimer   = null;

  function _scheduleRevoke(url) {
    _pendingRevoke.push({ url, at: Date.now() });
    if (_revokeTimer) return;
    _revokeTimer = setInterval(() => {
      const now = Date.now();
      for (let i = _pendingRevoke.length - 1; i >= 0; i--) {
        const { url: u, at } = _pendingRevoke[i];
        if (now - at < 30_000) continue; // aún en periodo de gracia
        // ¿Sigue algún <img> visible usando esta URL? — no revocar todavía
        const inUse = !!document.querySelector(`img[src="${CSS.escape(u)}"]`);
        if (inUse) { _pendingRevoke[i].at = now; continue; } // re-agendar
        URL.revokeObjectURL(u);
        _objectUrls.delete(u);
        _pendingRevoke.splice(i, 1);
      }
      if (!_pendingRevoke.length) { clearInterval(_revokeTimer); _revokeTimer = null; }
    }, 15_000);
  }

  function _evictLRU() {
    while (_cache.size > _MAX_CACHE) {
      const oldest = _cache.keys().next().value; // first key = LRU
      const entry  = _cache.get(oldest);
      if (entry?.coverUrl?.startsWith('blob:')) {
        _scheduleRevoke(entry.coverUrl);
      }
      _cache.delete(oldest);
    }
  }

  /* ── Public API ─────────────────────────────────────────── */

  /**
   * Parse metadata from a Blob. Caches result by fileId.
   * @param {string}  fileId
   * @param {Blob}    blob
   * @param {boolean} [force=false] — bypass cache and re-parse (use when a larger
   *   blob is available than what was originally parsed, e.g. full file after 1MB head).
   * @returns {Promise<{ title, artist, album, year, track, coverUrl }>}
   */
  async function parse(fileId, blob, force = false) {
    if (!force && _cache.has(fileId)) {
      _touch(fileId); // mark as recently used
      return _cache.get(fileId);
    }

    // When force-re-parsing, retire the old object URL (deferred — fix M1:
    // revocar al instante rompía los <img> de superficies aún no repintadas).
    if (force) {
      const old = _cache.get(fileId);
      if (old?.coverUrl?.startsWith('blob:')) _scheduleRevoke(old.coverUrl);
      _cache.delete(fileId);
    }

    let result = {};
    try {
      result = await _extractAll(blob);
    } catch (err) {
      console.warn('[Meta] Parse error for', fileId, err.message);
    }

    // v3.5.511: recortar franjas negras horneadas (letterbox) ANTES de cachear
    // y de que el caller persista coverBlob — así el arte guardado ya va limpio.
    if (result.coverBlob) {
      try {
        const cropped = await _deLetterbox(result.coverBlob);
        if (cropped) {
          if (result.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(result.coverUrl);
          result.coverBlob = cropped;
          result.coverUrl  = URL.createObjectURL(cropped);
        }
      } catch (_) { /* detección fallida → arte original intacto */ }
    }

    // Cache without the raw blob (avoid double-memory; blob is for DB persistence only)
    const { coverBlob, ...cacheResult } = result;
    _cache.set(fileId, cacheResult);
    if (cacheResult.coverUrl) _objectUrls.add(cacheResult.coverUrl);
    _evictLRU();
    return result; // caller gets coverBlob for one-time DB storage
  }

  /**
   * Return cached result without parsing.
   * @param {string} fileId
   * @returns {{ title, artist, album, year, coverUrl }|null}
   */
  function getCached(fileId) {
    if (!_cache.has(fileId)) return null;
    _touch(fileId); // mark as recently used so it isn't the next eviction target
    return _cache.get(fileId);
  }

  /**
   * Revoke object URL and remove from cache.
   * @param {string} fileId
   */
  function revoke(fileId) {
    const result = _cache.get(fileId);
    // Diferido (fix M1): la entrada sale del cache YA (el resolutor no la
    // reutiliza), pero el object URL vive 30 s más por si algún <img> visible
    // (cola, history, mosaicos) todavía lo referencia.
    if (result?.coverUrl?.startsWith('blob:')) _scheduleRevoke(result.coverUrl);
    _cache.delete(fileId);
  }

  /* ── Main extractor ─────────────────────────────────────── */

  async function _extractAll(blob) {
    // Caller controls the blob size — use whatever data was passed in full.
    // Soft scan passes a 1MB head download; _onBlobReady can pass the full file,
    // ensuring covers embedded beyond the 1MB boundary are found and stored.
    const buf   = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (bytes.length < 4) return {};

    // ── ID3v2 ─────────────────────────────────────────────
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      return _parseID3v2(bytes);
    }

    // ── FLAC ──────────────────────────────────────────────
    if (bytes[0] === 0x66 && bytes[1] === 0x4C &&
        bytes[2] === 0x61 && bytes[3] === 0x43) {
      return _parseFlac(bytes, blob.size);
    }

    return {};
  }

  /* ── MP3 bitrate scanner ─────────────────────────────────── */
  // Scans bytes starting at `offset` for the first valid MPEG Layer III
  // frame header and returns the declared bitrate in kbps, or null.
  // Works for both CBR (exact) and VBR (first-frame declared rate).
  function _mp3Bitrate(bytes, offset) {
    const BR_MPEG1  = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
    const BR_MPEG2  = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
    const limit     = Math.min(bytes.length - 4, offset + 65536); // scan ≤64KB

    for (let i = offset; i < limit; i++) {
      if (bytes[i] !== 0xFF) continue;
      const b1 = bytes[i + 1];
      if ((b1 & 0xE0) !== 0xE0) continue;          // need all sync bits

      const version = (b1 >> 3) & 0x03;            // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      const layer   = (b1 >> 1) & 0x03;            // 1=LayerIII, 2=LayerII, 3=LayerI
      if (layer !== 1) continue;                    // only MP3 (Layer III)

      const brIdx = (bytes[i + 2] >> 4) & 0x0F;
      if (brIdx === 0 || brIdx === 15) continue;    // free-format or invalid

      const kbps = (version === 3) ? BR_MPEG1[brIdx] : BR_MPEG2[brIdx];
      if (kbps > 0) return kbps;
    }
    return null;
  }

  /* ── ID3v2 parser ────────────────────────────────────────── */

  function _parseID3v2(bytes) {
    const version     = bytes[3]; // 2, 3 or 4
    const flags       = bytes[5];
    const hasExtHdr   = (flags & 0x40) !== 0;

    const tagSize = _synchsafe4(bytes, 6);
    let   pos     = 10;

    // Skip extended header (ID3v2.3/2.4)
    if (hasExtHdr && version >= 3) {
      const extSize = version === 4
        ? _synchsafe4(bytes, pos)
        : _uint32(bytes, pos);
      pos += (version === 4) ? extSize : (extSize + 4);
    }

    const end    = Math.min(10 + tagSize, bytes.length);
    const isV22  = (version === 2);
    const idLen  = isV22 ? 3 : 4;
    const hdrLen = isV22 ? 6 : 10; // id(3|4) + size(3|4) + flags(0|2)

    const result = {};
    const apicFrames = []; // collect ALL picture frames, pick best after loop

    while (pos + hdrLen <= end) {
      // Padding check
      if (bytes[pos] === 0) break;

      const id = _str(bytes, pos, idLen);

      const frameSize = isV22
        ? _uint24(bytes, pos + 3)
        : version === 4
          ? _synchsafe4(bytes, pos + 4)
          : _uint32(bytes, pos + 4);

      if (frameSize <= 0 || pos + hdrLen + frameSize > end) break;

      const dPos = pos + hdrLen; // start of frame data

      // ── Text frames ──────────────────────────────────────
      const textKey = _textKey(id, version);
      if (textKey && !result[textKey]) {
        const raw = _textFrame(bytes, dPos, frameSize) || undefined;
        result[textKey] = (textKey === 'artist' && raw) ? _firstArtist(raw) : raw;
      }

      // ── Cover art frames — collect all, pick best below ───
      if ((id === 'APIC' || id === 'PIC') && apicFrames.length < 8) {
        const cover = _apicFrame(bytes, dPos, frameSize, isV22);
        if (cover) apicFrames.push(cover);
      }

      pos += hdrLen + frameSize;
    }

    // Pick best cover: type 3 (front) > type 0 (other) > first available.
    // Revoke unused Object URLs immediately to avoid memory leaks.
    if (apicFrames.length > 0) {
      const best = apicFrames.find(f => f.pictureType === 3)
                || apicFrames.find(f => f.pictureType === 0)
                || apicFrames[0];
      result.coverUrl  = best.url;
      result.coverBlob = best.blob;
      for (const f of apicFrames) {
        if (f !== best) URL.revokeObjectURL(f.url);
      }
    }

    // ── MP3 bitrate: scan first audio frame after ID3 tag ────
    result.bitrate = _mp3Bitrate(bytes, 10 + tagSize);

    // ── TLEN → durationSec ───────────────────────────────────
    if (result.tlen) {
      const ms = parseInt(result.tlen, 10);
      if (ms > 0) result.durationSec = ms / 1000;
      delete result.tlen;
    }

    return result;
  }

  /* ── FLAC parser ─────────────────────────────────────────── */

  function _parseFlac(bytes, fileSize) {
    const result   = {};
    const pictures = []; // collect ALL PICTURE blocks, pick best after loop
    let   pos      = 4;  // skip "fLaC"

    while (pos + 4 <= bytes.length) {
      const blockType = bytes[pos] & 0x7F;
      const isLast    = (bytes[pos] & 0x80) !== 0;
      const blockSize = _uint24(bytes, pos + 1);
      pos += 4;

      if (pos + blockSize > bytes.length) break;

      // STREAMINFO (block type 0) — audio specs + bitrate
      if (blockType === 0 && blockSize >= 18) {
        // Byte layout (from FLAC spec):
        //  0-1  : min block size (16 bits)
        //  2-3  : max block size (16 bits)
        //  4-6  : min frame size (24 bits)
        //  7-9  : max frame size (24 bits)
        //  10-12: sample rate (20 bits) | channels-1 (3 bits) | bits/sample-1 (5 bits)
        //  13-17: bits/sample cont. (4 bits) | total samples (36 bits)
        const p = pos;
        const sampleRate    = (bytes[p+10] << 12) | (bytes[p+11] << 4) | (bytes[p+12] >> 4);
        const channels      = ((bytes[p+12] >> 1) & 0x07) + 1;
        const bitsPerSample = (((bytes[p+12] & 0x01) << 4) | (bytes[p+13] >> 4)) + 1;
        // total samples: 4 bits from byte 13 + bytes 14-17 (36 bits total)
        const totalSamplesHi = (bytes[p+13] & 0x0F);
        const totalSamplesLo = (bytes[p+14] * 16777216) + (bytes[p+15] << 16) +
                               (bytes[p+16] << 8) + bytes[p+17];
        const totalSamples   = totalSamplesHi * 4294967296 + totalSamplesLo;

        result.sampleRate    = sampleRate;
        result.channels      = channels;
        result.bitsPerSample = bitsPerSample;

        if (sampleRate > 0 && totalSamples > 0) {
          const durationSec = totalSamples / sampleRate;
          result.durationSec = durationSec;
          if (fileSize > 0) {
            result.bitrate = Math.round((fileSize * 8) / (durationSec * 1000));
          }
        }
      }

      // VORBIS_COMMENT (block type 4) — text metadata
      if (blockType === 4) {
        _parseVorbisComment(bytes, pos, pos + blockSize, result);
      }

      // PICTURE (block type 6) — collect all, pick best below
      if (blockType === 6 && pictures.length < 8) {
        const cover = _parseFLACPicture(bytes, pos, pos + blockSize);
        if (cover) pictures.push(cover);
      }

      pos += blockSize;
      if (isLast) break;
    }

    // Pick best cover: type 3 (front) > type 0 (other) > first available.
    if (pictures.length > 0) {
      const best = pictures.find(p => p.pictureType === 3)
                || pictures.find(p => p.pictureType === 0)
                || pictures[0];
      result.coverUrl  = best.url;
      result.coverBlob = best.blob;
      for (const p of pictures) {
        if (p !== best) URL.revokeObjectURL(p.url);
      }
    }

    return result;
  }

  function _parseVorbisComment(bytes, start, end, out) {
    // Structure: vendor string length (4LE) + vendor string
    //            + comment count (4LE) + comments
    let pos = start;
    const vendorLen = _uint32LE(bytes, pos); pos += 4 + vendorLen;
    const count = _uint32LE(bytes, pos); pos += 4;

    for (let i = 0; i < count && pos + 4 <= end; i++) {
      const len = _uint32LE(bytes, pos); pos += 4;
      if (pos + len > end) break;
      const raw = new TextDecoder('utf-8').decode(bytes.slice(pos, pos + len));
      const eq  = raw.indexOf('=');
      if (eq > 0) {
        const key = raw.slice(0, eq).toUpperCase();
        const val = raw.slice(eq + 1).trim();
        if (key === 'TITLE'       && !out.title)  out.title  = val;
        if (key === 'ARTIST'      && !out.artist) out.artist = _firstArtist(val);
        if (key === 'ALBUM'       && !out.album)  out.album  = val;
        if (key === 'DATE'        && !out.year)   out.year   = val.slice(0, 4);
        if (key === 'TRACKNUMBER' && !out.track)  out.track  = val;
      }
      pos += len;
    }
  }

  function _parseFLACPicture(bytes, start, end) {
    // pictureType(4) + mimeLen(4) + mime + descLen(4) + desc
    // + width(4) + height(4) + depth(4) + colors(4) + dataLen(4) + data
    let pos = start;
    if (pos + 8 > end) return null;
    const pictureType = _uint32(bytes, pos); pos += 4; // 3 = front cover, 4 = back cover…
    const mimeLen = _uint32(bytes, pos); pos += 4 + mimeLen;
    const descLen = _uint32(bytes, pos); pos += 4 + descLen;
    pos += 16; // width + height + depth + colors
    const dataLen = _uint32(bytes, pos); pos += 4;
    if (pos + dataLen > end) return null;
    const pic = bytes.slice(pos, pos + dataLen);
    const mime = (pic[0] === 0xFF && pic[1] === 0xD8) ? 'image/jpeg' : 'image/png';
    const picBlob = new Blob([pic], { type: mime });
    return { url: URL.createObjectURL(picBlob), blob: picBlob, pictureType };
  }

  /* ── Artist normalisation ───────────────────────────────────
     ID3 / Vorbis tags often store multiple artists separated by
     ";" (e.g. "3 Doors Down;Alfred Tom;Carlos Luis").
     We keep only the primary artist (first token).              */
  function _firstArtist(str) {
    if (!str) return str;
    return str.split(';')[0].trim() || str.trim();
  }

  /* ── Frame helpers ───────────────────────────────────────── */

  const _TEXT_FRAMES_V22 = {
    TT2: 'title', TP1: 'artist', TAL: 'album', TYE: 'year', TRK: 'track',
    TLE: 'tlen',  // duration in milliseconds
  };
  const _TEXT_FRAMES_V23 = {
    TIT2: 'title', TPE1: 'artist', TPE2: 'artist',
    TALB: 'album', TYER: 'year',   TDRC: 'year', TRCK: 'track',
    TLEN: 'tlen',  // duration in milliseconds
  };

  function _textKey(id, version) {
    return (version === 2 ? _TEXT_FRAMES_V22 : _TEXT_FRAMES_V23)[id] || null;
  }

  function _textFrame(bytes, dPos, size) {
    if (size < 2) return '';
    const encoding = bytes[dPos];
    const payload  = bytes.slice(dPos + 1, dPos + size);
    try {
      let s;
      if (encoding === 1 || encoding === 2) {
        s = new TextDecoder('utf-16').decode(payload);
      } else if (encoding === 3) {
        s = new TextDecoder('utf-8').decode(payload);
      } else {
        s = new TextDecoder('iso-8859-1').decode(payload);
      }
      return s.replace(/\0+$/, '').trim();
    } catch { return ''; }
  }

  function _apicFrame(bytes, dPos, size, isV22) {
    let i = dPos;
    const enc = bytes[i++];

    if (isV22) {
      i += 3; // skip 3-char format ("JPG"/"PNG")
    } else {
      while (i < dPos + size && bytes[i] !== 0) i++;
      i++; // skip null terminator of MIME string
    }

    // Read picture type (3 = Cover front, 4 = Cover back, 0 = Other, …)
    const pictureType = bytes[i++];

    // Skip description (null-terminated; double-null for UTF-16)
    if (enc === 1 || enc === 2) {
      while (i + 1 < dPos + size) {
        if (bytes[i] === 0 && bytes[i + 1] === 0) { i += 2; break; }
        i += 2;
      }
    } else {
      while (i < dPos + size && bytes[i] !== 0) i++;
      i++;
    }

    const picEnd = dPos + size;
    if (i >= picEnd) return null;

    const pic  = bytes.slice(i, picEnd);
    const mime = (pic[0] === 0xFF && pic[1] === 0xD8) ? 'image/jpeg'
               : (pic[0] === 0x89 && pic[1] === 0x50) ? 'image/png'
               : 'image/jpeg';

    const picBlob = new Blob([pic], { type: mime });
    return { url: URL.createObjectURL(picBlob), blob: picBlob, pictureType };
  }

  /* ── Bit / byte helpers ──────────────────────────────────── */

  function _synchsafe4(b, i) {
    return ((b[i] & 0x7F) << 21) | ((b[i+1] & 0x7F) << 14) |
           ((b[i+2] & 0x7F) << 7)  |  (b[i+3] & 0x7F);
  }
  function _uint32(b, i)   { return (b[i]<<24) | (b[i+1]<<16) | (b[i+2]<<8) | b[i+3]; }
  function _uint32LE(b, i) { return (b[i+3]<<24) | (b[i+2]<<16) | (b[i+1]<<8) | b[i]; }
  function _uint24(b, i)   { return (b[i]<<16) | (b[i+1]<<8) | b[i+2]; }
  function _str(b, i, len) { return String.fromCharCode(...b.slice(i, i + len)); }

  /* ── De-letterbox (v3.5.511) ─────────────────────────────────
     Los MP3 convertidos desde Soundrop (RapidAPI youtube-mp36) traen el arte
     embebido como lienzo CUADRADO con el thumbnail 16:9 centrado y franjas
     negras puras arriba/abajo HORNEADAS en la imagen. No es un problema de
     CSS: object-fit:cover no puede recortar barras que son parte del JPEG.
     Detección ESTRICTA para no tocar portadas legítimas oscuras:
       • lienzo ~cuadrado (0.85 ≤ w/h ≤ 1.2)
       • franjas negras casi puras (canal máx ≤ 26) que cubren TODA la fila,
         con un grosor ≥8% del alto tanto arriba COMO abajo
       • banda de contenido con firma 16:9 (1.35 ≤ ratio ≤ 2.15)
     Devuelve un blob nuevo con solo la banda de contenido, o null si la
     imagen no matchea la firma (se deja intacta). */
  async function _deLetterbox(blob) {
    try {
      if (!blob || blob.size < 2000) return null;
      const bmp = await createImageBitmap(blob);
      const W = bmp.width, H = bmp.height;
      const ratio = W / H;
      if (W < 100 || H < 100 || ratio < 0.85 || ratio > 1.2) { bmp.close?.(); return null; }
      // Muestreo reducido (64px de ancho) — abarata la lectura de píxeles
      const SW = 64, SH = Math.max(16, Math.round(H * (SW / W)));
      const s  = document.createElement('canvas');
      s.width = SW; s.height = SH;
      const sx = s.getContext('2d', { willReadFrequently: true });
      sx.drawImage(bmp, 0, 0, SW, SH);
      const d = sx.getImageData(0, 0, SW, SH).data;
      const rowIsBlack = (y) => {
        for (let i = y * SW * 4, n = i + SW * 4; i < n; i += 4) {
          if (d[i] > 26 || d[i + 1] > 26 || d[i + 2] > 26) return false;
        }
        return true;
      };
      let top = 0;
      while (top < SH * 0.45 && rowIsBlack(top)) top++;
      let bot = SH - 1;
      while (bot > SH * 0.55 && rowIsBlack(bot)) bot--;
      const minBar    = Math.max(2, SH * 0.08);
      const contentH  = bot - top + 1;
      if (top < minBar || (SH - 1 - bot) < minBar) { bmp.close?.(); return null; }
      if (contentH < SH * 0.3)                     { bmp.close?.(); return null; }
      const contentRatio = ratio * (SH / contentH); // ratio real de la banda de contenido
      if (contentRatio < 1.35 || contentRatio > 2.15) { bmp.close?.(); return null; }
      // Recorte a resolución original
      const topPx = Math.round(top * (H / SH));
      const hPx   = Math.min(H - topPx, Math.round(contentH * (H / SH)));
      const out   = document.createElement('canvas');
      out.width = W; out.height = hPx;
      out.getContext('2d').drawImage(bmp, 0, topPx, W, hPx, 0, 0, W, hPx);
      bmp.close?.();
      const nb = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.9));
      return (nb && nb.size > 500) ? nb : null;
    } catch (_) { return null; }
  }

  /* Migración one-shot de coverBlobs YA persistidos con letterbox (guardados
     antes del fix). Corre en background la primera vez que un blob se inyecta
     en la sesión; estampa coverBarsChecked en DB para no re-analizar nunca.
     Si recorta: persiste el blob limpio, refresca el cache de sesión y avisa
     a app.js (evento 'savart:cover-recropped') para repintar superficies. */
  const _recropChecked = new Set();
  function _maybeRecropPersisted(fileId, blob) {
    if (_recropChecked.has(fileId)) return;
    _recropChecked.add(fileId);
    (async () => {
      try {
        if (typeof DB === 'undefined') return;
        const m = await DB.getMeta(fileId).catch(() => null);
        if (!m || m.coverBarsChecked) return;
        const cropped = await _deLetterbox(blob);
        await DB.setMeta(fileId, cropped
          ? { coverBarsChecked: true, coverBlob: cropped }
          : { coverBarsChecked: true }).catch(() => {});
        if (!cropped) return;
        const newUrl = URL.createObjectURL(cropped);
        _objectUrls.add(newUrl);
        const existing = _cache.get(fileId);
        if (existing?.coverUrl?.startsWith('blob:')) _scheduleRevoke(existing.coverUrl);
        _cache.delete(fileId);
        _cache.set(fileId, { ...(existing || {}), coverUrl: newUrl });
        _evictLRU();
        document.dispatchEvent(new CustomEvent('savart:cover-recropped', {
          detail: { fileId, url: newUrl },
        }));
      } catch (_) { /* nunca romper el flujo de covers */ }
    })();
  }

  /**
   * Inject a persisted cover blob into the in-memory cache.
   * Creates a fresh Object URL and caches it for this session.
   * No-op if this fileId already has a coverUrl cached.
   * @param {string} fileId
   * @param {Blob}   blob  — image blob from IndexedDB
   * @returns {string|null} the Object URL, or null if skipped
   */
  function injectCover(fileId, blob) {
    if (!blob) return null;
    _maybeRecropPersisted(fileId, blob); // v3.5.511 — async, no bloquea
    const existing = _cache.get(fileId);
    // FIX A1: solo reutilizar la URL cacheada si ya es un object URL (blob:)
    // vivo — o sea, el MISMO arte embebido ya inyectado. Antes, cualquier
    // coverUrl cacheado (Last.fm, volátil, lo que forcePatch/patchCached
    // hubiera escrito) se devolvía tal cual y el resolutor canónico dejaba
    // de garantizar el arte ID3 → cada superficie mostraba una portada
    // distinta según el orden en que corrieron las rutinas.
    if (existing?.coverUrl?.startsWith('blob:')) {
      _touch(fileId); // already resolved — just mark as recently used
      return existing.coverUrl;
    }
    const url = URL.createObjectURL(blob);
    _objectUrls.add(url);
    // delete + re-set so this entry lands at the end (most-recently-used position)
    _cache.delete(fileId);
    _cache.set(fileId, { ...(existing || {}), coverUrl: url });
    _evictLRU();
    return url;
  }

  /**
   * Patch the in-memory cache with additional fields resolved after parse()
   * (e.g. AudD artist/title/coverUrl that aren't in the ID3 tags).
   * Only writes fields that are truthy and not already set.
   * @param {string} fileId
   * @param {Object} fields — partial meta object
   */
  function patchCached(fileId, fields) {
    const existing = _cache.get(fileId) || {};
    const patch = Object.fromEntries(
      Object.entries(fields).filter(([k, v]) => v && !existing[k])
    );
    if (Object.keys(patch).length === 0) return;
    if (patch.coverUrl) _objectUrls.add(patch.coverUrl);
    // delete + re-set → moves entry to most-recently-used position
    _cache.delete(fileId);
    _cache.set(fileId, { ...existing, ...patch });
    _evictLRU();
  }

  /**
   * Overwrite cached metadata fields unconditionally (used after manual edits).
   * Unlike patchCached(), this replaces existing values so the miniplayer
   * reflects manual changes immediately without a track reload.
   * Only non-empty values are applied to avoid blanking fields the user
   * did not touch.
   * @param {string} fileId
   * @param {Object} fields — partial meta object
   */
  function forcePatch(fileId, fields) {
    const existing = _cache.get(fileId) || {};
    const next = { ...existing };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined && v !== '') next[k] = v;
    }
    if (next.coverUrl && next.coverUrl !== existing.coverUrl) {
      // Revoke the old blob: URL before replacing it — prevents Object URL leak.
      // External URLs (https:) don't need revoking; only blob: URLs hold live memory.
      if (existing.coverUrl?.startsWith('blob:')) _scheduleRevoke(existing.coverUrl); // diferido (fix M1)
      _objectUrls.add(next.coverUrl);
    }
    // delete + re-set → moves entry to most-recently-used position
    _cache.delete(fileId);
    _cache.set(fileId, next);
    _evictLRU();
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return { parse, getCached, patchCached, forcePatch, revoke, injectCover };
})();
