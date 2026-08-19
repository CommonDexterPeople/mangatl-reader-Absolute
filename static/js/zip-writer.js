// ═══════════════════════════════════════════════════════════════
// zip-writer.js
// A minimal client-side ZIP writer (STORE method — no compression).
//
// Why this exists instead of a library: the rest of this app has zero
// external script dependencies (only a Google Fonts CSS link), so it works
// fully offline once loaded. Pulling in a JS zip library from a CDN for one
// button would be the first network dependency added to the frontend, and
// the exported pages are already-compressed PNGs — re-compressing them
// inside the zip would barely shrink the file, so "no compression" costs
// us nothing here. This is standard ZIP format (verified against the
// ZIP spec's local-file-header / central-directory / end-of-central-directory
// layout); any unzip tool can open the result.
// ═══════════════════════════════════════════════════════════════

export const _crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function _crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = _crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function _dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
  const dateVal = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
  return { time, dateVal };
}

/**
 * Build a valid ZIP archive (no compression) from a list of {name, data}
 * entries, where data is a Uint8Array (or anything new Uint8Array() accepts).
 * Returns a Uint8Array of the full archive.
 */
export function buildZip(files) {
  const encoder = new TextEncoder();
  const { time, dateVal } = _dosDateTime(new Date());

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data: rawData } of files) {
    const data = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    const nameBytes = encoder.encode(name);
    const crc = _crc32(data);
    const size = data.length;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);  // local file header signature
    localHeader.setUint16(4, 20, true);          // version needed to extract
    localHeader.setUint16(6, 0, true);           // general purpose flag
    localHeader.setUint16(8, 0, true);           // compression method: 0 = store
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, dateVal, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, size, true);       // compressed size
    localHeader.setUint32(22, size, true);       // uncompressed size
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);          // extra field length

    const localChunk = new Uint8Array(30 + nameBytes.length + data.length);
    localChunk.set(new Uint8Array(localHeader.buffer), 0);
    localChunk.set(nameBytes, 30);
    localChunk.set(data, 30 + nameBytes.length);
    localParts.push(localChunk);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true); // central directory header signature
    centralHeader.setUint16(4, 20, true);         // version made by
    centralHeader.setUint16(6, 20, true);         // version needed to extract
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, dateVal, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, size, true);
    centralHeader.setUint32(24, size, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);   // extra field length
    centralHeader.setUint16(32, 0, true);   // file comment length
    centralHeader.setUint16(34, 0, true);   // disk number start
    centralHeader.setUint16(36, 0, true);   // internal file attributes
    centralHeader.setUint32(38, 0, true);   // external file attributes
    centralHeader.setUint32(42, offset, true); // relative offset of local header

    const centralChunk = new Uint8Array(46 + nameBytes.length);
    centralChunk.set(new Uint8Array(centralHeader.buffer), 0);
    centralChunk.set(nameBytes, 46);
    centralParts.push(centralChunk);

    offset += localChunk.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((sum, c) => sum + c.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);   // end of central directory signature
  end.setUint16(4, 0, true);            // disk number
  end.setUint16(6, 0, true);            // disk with central directory start
  end.setUint16(8, files.length, true); // entries on this disk
  end.setUint16(10, files.length, true);// total entries
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);           // comment length

  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const c of localParts)   { out.set(c, pos); pos += c.length; }
  for (const c of centralParts) { out.set(c, pos); pos += c.length; }
  out.set(new Uint8Array(end.buffer), pos);
  return out;
}
