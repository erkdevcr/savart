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
  // fileId → parsed result
  const _cache = new Map();

  // Object URLs that need cleanup when cache is evicted
  const _objectUrls = new Set();

  /* ── Public API ─────────────────────────────────────────── */

  /**
   * Parse metadata from a Blob. Caches result by fileId.
   * @param {string} fileId
   * @param {Blob}   blob
   * @returns {Promise<{ title, artist, album, year, track, coverUrl }>}
   */
  async function parse(fileId, blob) {
    if (_cache.has(fileId)) return _cache.get(fileId);

    let result = {};
    try {
      result = await _extractAll(blob);
    } catch (err) {
      console.warn('[Meta] Parse error for', fileId, err.message);
    }

    // Cache without the raw blob (avoid double-memory; blob is for DB persistence only)
    const { coverBlob, ...cacheResult } = result;
    _cache.set(fileId, cacheResult);
    if (cacheResult.coverUrl) _objectUrls.add(cacheResult.coverUrl);
    return result; // caller gets coverBlob for one-time DB storage
  }

  /**
   * Return cached result without parsing.
   * @param {string} fileId
   * @returns {{ title, artist, album, year, coverUrl }|null}
   */
  function getCached(fileId) {
    return _cache.get(fileId) || null;
  }

  /**
   * Revoke object URL and remove from cache.
   * @param {string} fileId
   */
  function revoke(fileId) {
    const result = _cache.get(fileId);
    if (result?.coverUrl) {
      URL.revokeObjectURL(result.coverUrl);
      _objectUrls.delete(result.coverUrl);
    }
    _cache.delete(fileId);
  }

  /* ── Main extractor ─────────────────────────────────────── */

  async function _extractAll(blob) {
    // Read first 1MB — enough for any reasonable ID3 tag + embedded art
    const headBlob  = blob.slice(0, Math.min(1 * 1024 * 1024, blob.size));
    const buf       = await headBlob.arrayBuffer();
    const bytes     = new Uint8Array(buf);

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

        if (sampleRate > 0 && totalSamples > 0 && fileSize > 0) {
          const durationSec = totalSamples / sampleRate;
          result.bitrate = Math.round((fileSize * 8) / (durationSec * 1000));
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
  };
  const _TEXT_FRAMES_V23 = {
    TIT2: 'title', TPE1: 'artist', TPE2: 'artist',
    TALB: 'album', TYER: 'year',   TDRC: 'year', TRCK: 'track',
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
    const existing = _cache.get(fileId);
    if (existing?.coverUrl) return existing.coverUrl; // already resolved this session
    const url = URL.createObjectURL(blob);
    _objectUrls.add(url);
    _cache.set(fileId, { ...(existing || {}), coverUrl: url });
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
    _cache.set(fileId, { ...existing, ...patch });
  }

  /* ── Expose ─────────────────────────────────────────────── */
  return { parse, getCached, patchCached, revoke, injectCover };
})();
