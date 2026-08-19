// ═══════════════════════════════════════════════════════════════
// local-source.js
// Local-folder and .cbz/.zip chapter input — an alternative to the
// MangaDex adapter (mangadex-api.js) that never touches the network at
// all. A picked folder or an in-browser-unzipped .cbz produces the exact
// same {cdn, img} page shape fetchPageUrls() does:
//
//   cdn — MangaDex path: the https:// CDN url, sent to /ocr etc. for the
//         server to download itself.
//         Local path:    a "local-blob:<id>" reference into the
//         _localBlobStore below — there's no url to fetch, the browser
//         already has the bytes.
//   img — <img src>, either way: a MangaDex /proxy url, or (here) a
//         URL.createObjectURL(blob) the browser can render directly with
//         no server round-trip at all.
//
// Because pipeline.js, page-render.js, export.js, correction-ui.js etc.
// already only ever treat "cdn" as an opaque string, none of them need to
// know or care which kind of chapter they're looking at. The ONE place
// that has to tell the two apart is imageRefBody() below — every fetch
// call site that used to send {url: cdnUrl} to /ocr, /ocr-crop,
// /vision-crop or /export-page now sends {...(await imageRefBody(cdnUrl))}
// instead, which resolves to {url: ...} or {image_b64: ...} as appropriate.
//
// KNOWN LIMITATION — no persistence across a reload: a local page's Blob
// lives only in this tab's memory (kept alive by _localBlobStore + the
// object URLs handed to <img>). It's never written to disk or IndexedDB,
// so closing/reloading the tab loses it, exactly like closing a native
// file-picker dialog would. For that reason local chapters deliberately
// don't go into the localStorage chapter cache (see pipeline.js's
// `cacheable` flag on _runChapterPipeline / startPipelineWithLocalSource) —
// a "✓ cached" chapter that can never re-render its images would be worse
// than no cache entry at all. Corrections (✏ CORRECT) and Export Typeset
// still work fine within the same session; they just don't survive a
// reload, same as the images themselves don't.
// ═══════════════════════════════════════════════════════════════

// ── Local blob registry ─────────────────────────────────────────
// Holds the actual image Blob for every local page, for the lifetime of
// this tab. Blobs are never sent to the server as a whole file — only
// base64-encoded per OCR/crop/export request, on demand.
import { _validateApiKeyOrToast, startPipelineWithLocalSource } from './pipeline.js';
import { getTargetLang } from './translate-client.js';
import { toast } from './utils.js';

export const _localBlobStore = new Map();   // "local-blob:<id>" -> Blob
export let _localBlobSeq = 0;

export function registerLocalBlob(blob) {
  const id = `local-blob:${Date.now().toString(36)}-${(_localBlobSeq++).toString(36)}`;
  _localBlobStore.set(id, blob);
  return id;
}

export function isLocalRef(cdnRef) {
  return typeof cdnRef === 'string' && cdnRef.startsWith('local-blob:');
}

// Frees every local page's Blob + object URL. Called from goBack() (utils.js)
// alongside the rest of the per-chapter cleanup, and safe to call even when
// nothing local was ever opened (both Maps are just empty then).
export function clearLocalBlobStore() {
  _localBlobStore.clear();
}

export function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => {
      // reader.result is "data:<mime>;base64,<b64>" — keep just the payload.
      const s = reader.result || '';
      const i = s.indexOf(',');
      resolve(i === -1 ? '' : s.slice(i + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read local image data.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * The one place every OCR/crop/export fetch call site builds its request
 * body from, instead of hardcoding {url: cdnRef}. Transparently swaps in
 * image_b64 for a local page; every other field in the request is
 * unaffected — see _load_image_bytes() in server.py for the receiving end.
 */
export async function imageRefBody(cdnRef) {
  if (isLocalRef(cdnRef)) {
    const blob = _localBlobStore.get(cdnRef);
    if (!blob) throw new Error('This local page is no longer available — reopen the folder/CBZ to retry.');
    return { image_b64: await _blobToBase64(blob) };
  }
  return { url: cdnRef };
}

// ── Filename filtering + ordering ───────────────────────────────
export const _IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

// Skip macOS resource-fork junk, hidden files, and the CBZ metadata
// sidecar (ComicInfo.xml) that isn't a page image at all.
export function _isJunkPath(path) {
  const base = path.split('/').pop() || '';
  return path.includes('__MACOSX/') || base.startsWith('.') ||
         base.toLowerCase() === 'comicinfo.xml';
}

export function _isImagePath(path) {
  return _IMAGE_EXT_RE.test(path) && !_isJunkPath(path);
}

export function _mimeForPath(path) {
  const ext = (path.match(_IMAGE_EXT_RE)?.[1] || '').toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', bmp: 'image/bmp',
  }[ext] || 'application/octet-stream';
}

// Natural sort: "page2.jpg" before "page10.jpg", not after — plain string
// sort would put "page10" before "page2". Splits into digit / non-digit
// runs and compares digit runs numerically, everything else lexically.
export function _naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) || [];
  const bx = b.match(re) || [];
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const av = ax[i], bv = bx[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = /^\d+$/.test(av) ? parseInt(av, 10) : null;
    const bn = /^\d+$/.test(bv) ? parseInt(bv, 10) : null;
    const cmp = (an !== null && bn !== null) ? (an - bn) : av.localeCompare(bv);
    if (cmp) return cmp;
  }
  return 0;
}

export function _titleFromName(name) {
  return name.replace(/\.(cbz|zip)$/i, '').replace(/[_\.]+/g, ' ').trim() || 'Local chapter';
}

// ── Minimal client-side ZIP reader (STORE + DEFLATE) ────────────
// Mirrors zip-writer.js's "no external dependency" approach: parses the
// central directory directly off an ArrayBuffer and decompresses DEFLATE
// entries with the browser's built-in DecompressionStream — no JSZip, no
// external script. STORE (method 0) and DEFLATE (method 8) cover
// effectively every real-world CBZ, since that's what every common
// zip/CBZ-writing tool produces (including this app's own zip-writer.js).
// ZIP64 (>4GB archives — not a realistic concern for a manga chapter) and
// exotic compression methods (bzip2, LZMA) are explicitly rejected with a
// clear error rather than silently misreading them.
//
// Filenames are decoded as UTF-8 unconditionally. Real-world CBZs almost
// always either contain plain ASCII filenames (unaffected either way) or
// were written with the UTF-8 flag set by a modern tool; a handful of very
// old zip tools instead used CP437 for non-ASCII names with the flag
// unset, which this doesn't special-case — an uncommon-enough case for a
// manga-page filename that it's called out here rather than solved.
export const _EOCD_SIG = 0x06054b50;
export const _CDFH_SIG = 0x02014b50;
export const _LFH_SIG  = 0x04034b50;

export function _findEndOfCentralDirectory(view) {
  // EOCD is a fixed 22-byte record, optionally followed by a comment (up
  // to 65535 bytes) — search backwards from the end rather than assuming
  // a zero-length comment.
  const maxBack = Math.min(view.byteLength, 22 + 65535);
  for (let i = view.byteLength - 22; i >= view.byteLength - maxBack; i--) {
    if (i < 0) break;
    if (view.getUint32(i, true) === _EOCD_SIG) return i;
  }
  throw new Error('Not a valid .cbz/.zip file (no end-of-central-directory record found).');
}

export async function _inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse a .cbz/.zip ArrayBuffer and return every non-directory entry as
 * { name, bytes: Uint8Array }, in central-directory order (caller sorts).
 */
export async function _readZipEntries(arrayBuffer) {
  const view  = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  const eocdOff    = _findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocdOff + 10, true);
  const cdSize     = view.getUint32(eocdOff + 12, true);
  const cdOffset   = view.getUint32(eocdOff + 16, true);

  // ZIP64: classic EOCD fields are 0xFFFF/0xFFFFFFFF sentinels when the
  // real values don't fit. That format isn't implemented here — fail
  // clearly instead of misreading garbage as valid entries.
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('This archive uses ZIP64 (a very large .cbz) — not supported. Re-export it as a standard-size CBZ.');
  }

  const headers = [];
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== _CDFH_SIG) {
      throw new Error(`Corrupt CBZ: expected central-directory entry ${i} at offset ${pos}.`);
    }
    const method      = view.getUint16(pos + 10, true);
    const compSize    = view.getUint32(pos + 20, true);
    const uncompSize  = view.getUint32(pos + 24, true);
    const nameLen     = view.getUint16(pos + 28, true);
    const extraLen    = view.getUint16(pos + 30, true);
    const commentLen  = view.getUint16(pos + 32, true);
    const localHdrOff = view.getUint32(pos + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      throw new Error(`"${name}" uses ZIP64 sizing — not supported.`);
    }
    headers.push({ name, method, compSize, localHdrOff });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const out = [];
  for (const h of headers) {
    if (h.name.endsWith('/')) continue;  // directory entry, no data
    if (view.getUint32(h.localHdrOff, true) !== _LFH_SIG) {
      throw new Error(`Corrupt CBZ: bad local file header for "${h.name}".`);
    }
    const lfNameLen  = view.getUint16(h.localHdrOff + 26, true);
    const lfExtraLen = view.getUint16(h.localHdrOff + 28, true);
    const dataStart  = h.localHdrOff + 30 + lfNameLen + lfExtraLen;
    const raw        = bytes.subarray(dataStart, dataStart + h.compSize);

    let data;
    if (h.method === 0)      data = raw;
    else if (h.method === 8) data = await _inflateRaw(raw);
    else throw new Error(`"${h.name}" uses an unsupported compression method (${h.method}) — only STORE and DEFLATE are supported.`);

    out.push({ name: h.name, bytes: data });
  }
  return out;
}

// ── High-level chapter builders ─────────────────────────────────
export function _buildLocalChapter(kind, title, sourceLang, orderedFiles) {
  // orderedFiles: [{ name, blob }], already sorted
  const pages = orderedFiles.map(f => ({
    cdn: registerLocalBlob(f.blob),
    img: URL.createObjectURL(f.blob),
  }));
  return {
    id: `local:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,               // 'folder' | 'cbz' — shown in the reader header
    title,
    sourceLang,
    pages,
  };
}

/** Build a local chapter from a FileList (e.g. <input webkitdirectory>). */
export async function chapterFromFileList(fileList, sourceLang) {
  const all = Array.from(fileList);
  const images = all
    .filter(f => _isImagePath(f.webkitRelativePath || f.name))
    .sort((a, b) => _naturalCompare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));

  if (!images.length) {
    throw new Error(all.length
      ? 'No image files found in that folder (looked for .jpg/.jpeg/.png/.gif/.webp/.bmp).'
      : 'That folder appears to be empty.');
  }

  const firstPath = images[0].webkitRelativePath || images[0].name;
  const title = _titleFromName(firstPath.split('/')[0] || images[0].name);
  const orderedFiles = images.map(f => ({ name: f.webkitRelativePath || f.name, blob: f }));
  return _buildLocalChapter('folder', title, sourceLang, orderedFiles);
}

/** Build a local chapter from a .cbz/.zip File. */
export async function chapterFromCbz(file, sourceLang) {
  const arrayBuffer = await file.arrayBuffer();
  const entries = await _readZipEntries(arrayBuffer);
  const images = entries
    .filter(e => _isImagePath(e.name))
    .sort((a, b) => _naturalCompare(a.name, b.name));

  if (!images.length) {
    throw new Error('No image files found inside that .cbz/.zip.');
  }

  const orderedFiles = images.map(e => ({
    name: e.name,
    blob: new Blob([e.bytes], { type: _mimeForPath(e.name) }),
  }));
  return _buildLocalChapter('cbz', _titleFromName(file.name), sourceLang, orderedFiles);
}

// ── Home-screen wiring ───────────────────────────────────────────
export function toggleLocalSource() {
  document.getElementById('local-source-wrap')?.classList.toggle('open');
}

export function _localSourceLang() {
  return document.getElementById('local-source-lang')?.value || 'ja';
}

export function triggerLocalFolderPicker() { document.getElementById('local-folder-input')?.click(); }
export function triggerLocalCbzPicker()    { document.getElementById('local-cbz-input')?.click(); }

export async function handleLocalFolderInput(event) {
  const files = event.target.files;
  event.target.value = '';  // allow picking the same folder again later
  if (!files || !files.length) return;
  if (!_validateApiKeyOrToast()) return;
  try {
    toast('Reading folder…', 3000);
    const chapter = await chapterFromFileList(files, _localSourceLang());
    startPipelineWithLocalSource(chapter, getTargetLang());
  } catch (e) {
    toast(`Couldn't read that folder: ${e.message}`);
  }
}

export async function handleLocalCbzInput(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!_validateApiKeyOrToast()) return;
  try {
    toast('Unpacking .cbz…', 3000);
    const chapter = await chapterFromCbz(file, _localSourceLang());
    startPipelineWithLocalSource(chapter, getTargetLang());
  } catch (e) {
    toast(`Couldn't read that file: ${e.message}`);
  }
}
