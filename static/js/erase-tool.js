// ═══════════════════════════════════════════════════════════════
// erase-tool.js
// Standalone erase tool — independent of the translate pipeline.
// Load a MangaDex page, draw your own boxes (or seed them from OCR data
// this session/cache already has — corrected versions preferred, see
// getEffectivePageRegions in cache.js), then either:
//   - just erase (leave the box blank), or
//   - fill each box with its translation, auto-matched to the nearest
//     already-translated/corrected region under that box and editable
//     per-box, or
//   - flag a box "outside" (text sits on art/signage that's hard to
//     cleanly paint over) so its translation prints in a numbered legend
//     outside the page instead of inside the box.
// No API key, no live OCR/translate call — this only reuses translations
// already produced elsewhere in the app, or text you type in yourself.
//
// Reuses:
//   - box-overlay.js for the drag-to-draw / render / click-to-remove
//     mechanics (shared with correction-ui.js — see that file's header)
//   - /export-page in "manual" mode (server.py — see typeset_manual_page)
//   - getEffectivePageRegions (cache.js) so a chapter you've already
//     corrected via ✏ CORRECT gets those corrections here too
// ═══════════════════════════════════════════════════════════════

// _eraseBoxes: [{id, box:[x1,y1,x2,y2] (0-100 pct), tl:string, outside:bool, matched:bool}]
import { createBoxOverlay } from './box-overlay.js';
import { chapterFromMangaDex, makeLocalSourceUI, makeSuwayomiSourceUI } from './chapter-source.js';
import { getCachedChapter, getEffectivePageRegions } from './cache.js';
import { recordUsage } from './cost-tracker.js';
import { _sanitizeForFilename, _showDownloadGuide } from './export.js';
import { setActiveGlossary } from './glossary.js';
import { _localBlobStore, clearLocalBlobStore, imageRefBody, isLocalRef } from './local-source.js';
import { parseChapterId } from './mangadex-api.js';
import { _pageStore } from './ocr-client.js';
import {
  getFinalErasedBlob,
  getPrePaintPatchForBox,
  hasPrePaintStrokes,
  initPaintBrush,
  initPrePaintBrush,
  teardownPaintBrush,
  toggleBrushMode,
} from './paint-brush.js';
import { getModelId, getModelInfo, getTargetLang, translateBatch } from './translate-client.js';
import { esc, getAiInpaintSetting, show, toast } from './utils.js';
import { buildZip } from './zip-writer.js';

export let _eraseBoxes = [];
export let _eraseImgMeta = null;    // { cdnUrl, imgSrc }
export let _eraseResultBlob = null; // last erased/typeset-page PNG blob, for download
export let _eraseOverlayCtl = null; // box-overlay controller for the current page
export let _eraseSelId = null;      // currently-selected box id (sidebar editing focus)
export let _eraseSourceLang = 'en'; // chapter's source language — needed for OCR/translate calls
export let _availableFonts = [];
export let _eraseDefaultFontPath = localStorage.getItem('mtl_erase_font_path') || '';
export let _eraseDefaultFontSize = parseInt(localStorage.getItem('mtl_erase_font_size') || '0', 10) || 0;
export let _fontsPromise = null;
export let _erasePrePaintOn = false; // true while "paint before erasing" mode is active on the current page
export let _eraseVisionDrawOn = false; // true while newly-drawn boxes should be read via Gemini Vision

// _eraseBatch: Map<pageIdx, {blobBytes, savedAt}> — pages explicitly saved
// (via eraseSaveToBatch) from the currently loaded chapter/local source,
// waiting to be zipped together by eraseDownloadBatchZip(). Scoped to
// "whatever's currently loaded" — loading a different chapter/URL/local
// folder starts a fresh batch (see loadEraseChapterFromSource)
// rather than silently mixing pages from two different sources into one zip.
export let _eraseBatch = new Map();

export function _ensureFontsLoaded() {
  if (_fontsPromise) return _fontsPromise;
  _fontsPromise = fetch('/fonts').then(function(r) {
    return r.ok ? r.json() : { fonts: [] };
  }).then(function(data) {
    _availableFonts = Array.isArray(data.fonts) ? data.fonts : [];
  });
  return _fontsPromise;
}

export function openEraseTool() {
  _eraseSyncAiInpaintToggle();
  _eraseBoxes = [];
  _eraseImgMeta = null;
  _eraseResultBlob = null;
  _eraseSelId = null;
  _erasePrePaintOn = false;
  _eraseVisionDrawOn = false;
  _erasePageList = [];
  _erasePageIdx = 0;
  _eraseChapterId = null;
  _eraseBatch = new Map();
  if (_eraseOverlayCtl) { _eraseOverlayCtl.detach(); _eraseOverlayCtl = null; }
  teardownPaintBrush();
  _ensureFontsLoaded();
  show('screen-erase');
  document.getElementById('erase-url').value = '';
  document.getElementById('erase-canvas-wrap').innerHTML =
    '<div class="erase-empty-hint">Paste a MangaDex page or chapter URL above, then hit LOAD.</div>';
  document.getElementById('erase-toolbar').style.display = 'none';
  document.getElementById('erase-font-toolbar').style.display = 'none';
  document.getElementById('erase-download-row').style.display = 'none';
  const sb = document.getElementById('erase-sidebar');
  if (sb) sb.innerHTML = '';
  _renderEraseBatchPanel();
}

// BUG FIX: #erase-ai-inpaint (index.html) is hardcoded to "off" and
// nothing was ever syncing it from the Settings-panel value on open — so
// a person who set Settings > Textured-area erase quality > AI inpaint
// would land on this screen looking at a toolbar that still read
// "Classical inpaint". getAiInpaintSetting() (utils.js) reads THIS
// toolbar element whenever it's present on screen and takes it over
// localStorage, so the stale display wasn't just cosmetic — it silently
// overrode their saved setting back to "off" on every export. Called at
// the top of openEraseTool(), before the toolbar is even shown, so the
// dropdown always reflects the real setting the first time it's visible.
export function _eraseSyncAiInpaintToggle() {
  const el = document.getElementById('erase-ai-inpaint');
  if (el) el.value = localStorage.getItem('mtl_ai_inpaint') === 'on' ? 'on' : 'off';
}

/**
 * Accepts either a chapter URL (mangadex.org/chapter/<id>) — loads its
 * first page — or is extended later to accept a direct page pick. Keeping
 * chapter-URL-in, first-page-out for now matches how every other URL field
 * in this app works, and a "next/prev page" control lets you reach any
 * page in the chapter from there.
 */
export let _erasePageList = [];   // [{cdn, img}] for the currently loaded chapter
export let _erasePageIdx = 0;

export let _eraseChapterId = null;

export async function _loadEraseCurrentPage() {
  const p = _erasePageList[_erasePageIdx];
  if (!p) return;
  _eraseImgMeta = { cdnUrl: p.cdn, imgSrc: p.img };
  _eraseBoxes = [];
  _eraseSelId = null;
  _eraseResultBlob = null;
  _erasePrePaintOn = false;
  // NOTE: _eraseVisionDrawOn is intentionally NOT reset here anymore.
  // It used to be forced back to false on every page load/navigation with
  // no visible warning. Since the toolbar toggle looks like any other
  // button, that silent reset was easy to miss — you'd keep drawing boxes
  // thinking Vision OCR was still active, but they were quietly falling
  // back to auto-match-only (no srcText set), which can NEVER show up in
  // "↺ translate pending" (see _isErasePending). That's what made it look
  // like translate had randomly stopped working after a few pages/boxes.
  // Vision-draw mode now persists across pages until you explicitly toggle
  // it off, matching what a person actually expects: "I turned this on for
  // this chapter" rather than "I have to remember to re-enable it every page."
  document.getElementById('btn-toggle-vision-draw')?.classList.toggle('active', _eraseVisionDrawOn);
  document.getElementById('erase-download-row').style.display = 'none';
  _renderEraseCanvas();
  document.getElementById('erase-toolbar').style.display = 'flex';
  document.getElementById('erase-font-toolbar').style.display = 'flex';
  await _ensureFontsLoaded();
  _populateFontDropdown();
  _updateErasePageLabel();
  _updateErasePendingButton();
}

/**
 * Load any Chapter into the Erase Tool, whatever produced it.
 *
 * This is the single entry point for all three sources now. It used to be
 * three: loadEraseChapter() assembled a MangaDex chapter inline (duplicating
 * pipeline.js), _loadEraseLocalChapter() handled folder/CBZ, and
 * loadEraseFromSuwayomi() was a copy of the reader's Suwayomi loader ending in
 * a different call. They only ever differed in how the pages were obtained —
 * which is exactly what the Chapter shape (see chapter-source.js) abstracts.
 */
export function loadEraseChapterFromSource(chapter) {
  if (!chapter.pages.length) { toast('No pages found.'); return Promise.resolve(); }

  // Drop blobs the outgoing chapter was holding. Only local sources register
  // any; isLocalRef() makes this a no-op for MangaDex/Suwayomi rather than
  // something each caller has to know whether to do.
  for (const p of _erasePageList) {
    if (isLocalRef(p.cdn)) _localBlobStore.delete(p.cdn);
  }

  // Fresh source — don't mix pages from two chapters into one zip.
  _eraseBatch = new Map();
  _renderEraseBatchPanel();

  _erasePageList   = chapter.pages;
  _erasePageIdx    = 0;
  _eraseChapterId  = chapter.id;
  _eraseSourceLang = chapter.sourceLang;

  // Same glossary resolution pipeline.js's _runChapterPipeline uses — see
  // glossary.js's file header. mangaId is null for local folder/CBZ (no stable
  // series identity), which falls back to the name-keyed path.
  setActiveGlossary(chapter.mangaId || null, chapter.title || chapter.id);

  // Only a URL-loaded chapter should leave the URL box populated.
  if (chapter.kind !== 'mangadex') document.getElementById('erase-url').value = '';

  return _loadEraseCurrentPage();
}

/** MangaDex: read the chapter URL out of the input, then load it. */
export async function loadEraseChapter() {
  const rawUrl = document.getElementById('erase-url').value.trim();
  if (!rawUrl) { toast('Paste a MangaDex chapter URL.'); return; }
  const chapterId = parseChapterId(rawUrl);
  if (!chapterId) { toast("Could not find a chapter ID in that URL."); return; }

  const wrap = document.getElementById('erase-canvas-wrap');
  wrap.innerHTML = '<div class="erase-loading"><span class="spinner"></span> Loading page…</div>';

  try {
    clearLocalBlobStore();
    await loadEraseChapterFromSource(await chapterFromMangaDex(chapterId, 'data'));
  } catch (err) {
    wrap.innerHTML = `<div class="erase-empty-hint">Failed to load: ${esc(err.message || err)}</div>`;
  }
}

// ── Erase Tool source controls ───────────────────────────────────────────────
// The 'erase-' prefixed twins of the reader's controls in local-source.js and
// pipeline.js. Same factories, different prefix and destination — and no API
// key guard, because erasing text needs no translation key.
const _eraseLocalSource = makeLocalSourceUI({
  idPrefix: 'erase-',
  onChapter: loadEraseChapterFromSource,
});
const _eraseSuwayomiSource = makeSuwayomiSourceUI({
  idPrefix: 'erase-',
  onChapter: loadEraseChapterFromSource,
});

// Exported as function declarations, not `export const x = ui.toggle`. Both work
// under ES modules, but build.py flattens the frontend into one classic script
// for the single-file build, where a top-level `const` becomes a lexical global
// (reachable from inline handlers, but NOT a window property) while a function
// declaration becomes both. Keeping these as declarations means window.X
// resolves identically in the split build and the flattened one.
export function toggleEraseLocalSource()        { return _eraseLocalSource.toggle(); }
export function triggerEraseLocalFolderPicker() { return _eraseLocalSource.pickFolder(); }
export function triggerEraseLocalCbzPicker()    { return _eraseLocalSource.pickCbz(); }
export function handleEraseLocalFolderInput(ev) { return _eraseLocalSource.onFolderInput(ev); }
export function handleEraseLocalCbzInput(ev)    { return _eraseLocalSource.onCbzInput(ev); }
export function toggleEraseSuwayomiSource()     { return _eraseSuwayomiSource.toggle(); }
export function loadEraseFromSuwayomi()         { return _eraseSuwayomiSource.load(); }

export function _populateFontDropdown() {
  const sel = document.getElementById('erase-default-font');
  if (!sel) return;
  const current = _eraseDefaultFontPath;
  let html = '<option value="">System default</option>';
  _availableFonts.forEach(function(f) {
    const selected = f.path === current ? ' selected' : '';
    html += '<option value="' + esc(f.path) + '"' + selected + '>' + esc(f.name) + '</option>';
  });
  sel.innerHTML = html;
  const sizeInput = document.getElementById('erase-default-size');
  if (sizeInput) sizeInput.value = _eraseDefaultFontSize > 0 ? String(_eraseDefaultFontSize) : '';
}

export function eraseSetDefaultFont(path) {
  _eraseDefaultFontPath = path || '';
  localStorage.setItem('mtl_erase_font_path', _eraseDefaultFontPath);
}

export function eraseSetDefaultFontSize(value) {
  const n = parseInt(value, 10);
  _eraseDefaultFontSize = (Number.isFinite(n) && n > 0) ? n : 0;
  localStorage.setItem('mtl_erase_font_size', String(_eraseDefaultFontSize));
}

export function _updateErasePageLabel() {
  const lbl = document.getElementById('erase-page-label');
  if (lbl) lbl.textContent = `Page ${_erasePageIdx + 1} / ${_erasePageList.length}`;
  const prevBtn = document.getElementById('erase-prev-page');
  const nextBtn = document.getElementById('erase-next-page');
  if (prevBtn) prevBtn.disabled = _erasePageIdx <= 0;
  if (nextBtn) nextBtn.disabled = _erasePageIdx >= _erasePageList.length - 1;
}

export async function eraseGoToPage(delta) {
  const next = _erasePageIdx + delta;
  if (next < 0 || next >= _erasePageList.length) return;
  _erasePageIdx = next;
  await _loadEraseCurrentPage();
}

export function _renderEraseCanvas() {
  const wrap = document.getElementById('erase-canvas-wrap');
  if (_eraseOverlayCtl) { _eraseOverlayCtl.detach(); _eraseOverlayCtl = null; }
  teardownPaintBrush();
  if (!_eraseImgMeta) {
    wrap.innerHTML = '<div class="erase-empty-hint">Paste a MangaDex page or chapter URL above, then hit LOAD.</div>';
    const sb = document.getElementById('erase-sidebar');
    if (sb) sb.innerHTML = '';
    return;
  }
  wrap.innerHTML = `
    <div class="erase-img-wrap" id="erase-img-wrap">
      <img src="${esc(_eraseImgMeta.imgSrc)}" class="erase-img" id="erase-img" alt="Page">
      <div class="erase-overlay" id="erase-overlay"></div>
    </div>`;
  document.getElementById('erase-img').addEventListener('load', () => {
    _eraseOverlayCtl = createBoxOverlay({
      getImg: () => document.getElementById('erase-img'),
      getOverlay: () => document.getElementById('erase-overlay'),
      isDrawEnabled: () => !_erasePrePaintOn,
      previewClassFn: () => _eraseVisionDrawOn ? 'vision-mode' : '',
      onDrawEnd: box => { _eraseFinalizeDrawnBox(box); },
    });
    if (!_erasePrePaintOn) _eraseOverlayCtl.attach();
    _renderEraseBoxes();
    _renderEraseSidebar();
  }, { once: true });
}

/**
 * Handles a freshly-drawn box: either auto-matches it against an existing
 * translation (default), or — when ✦ VISION draw is on — sends the crop to
 * Gemini Vision for a fresh OCR read via /vision-crop and starts it as a
 * PENDING box (tl empty, needs ↺ translate pending) rather than pre-filled.
 *
 * This mirrors correction-ui.js's _finalizeBox split (OCR-only, no
 * auto-translate) so drawing several Vision boxes in a row costs one OCR
 * call each but zero translate calls until you explicitly batch-translate
 * — the whole point of the "draw fixes first, translate once" workflow.
 */
export async function _eraseFinalizeDrawnBox(box) {
  const id = Date.now() + Math.random();

  if (!_eraseVisionDrawOn) {
    const match = _findMatchingTranslation(box);
    _eraseBoxes.push({
      id, box,
      tl: match ? match.tl : '',
      outside: false,
      matched: !!match,
      prePainted: false,
      fontPath: '',
      fontSize: 0,
    });
    _eraseSelId = id;
    _renderEraseBoxes();
    _renderEraseSidebar();
    // A box with no auto-match has no srcText and never will unless it's
    // redrawn in ✦ VISION mode — it can't ever show up in "↺ translate
    // pending" (that button only looks at srcText). Without this nudge it
    // silently looks identical to a normal "erase only" box, which is what
    // made this look like "translate just stopped working": the box IS
    // there, but nothing will ever offer to translate it.
    if (!match) {
      toast('No existing translation found for that spot — turn on ✦ VISION draw and redraw it to OCR + translate it, or type a translation in yourself.');
    }
    return;
  }

  // ── Vision-draw: placeholder box while the OCR call is in flight ────────
  const placeholder = {
    id, box, tl: '', outside: false, matched: false, prePainted: false,
    fontPath: '', fontSize: 0, visionPending: true,
  };
  _eraseBoxes.push(placeholder);
  _eraseSelId = id;
  _renderEraseBoxes();
  _renderEraseSidebar();
  await _runVisionCropOn(placeholder, box);
}

/**
 * Runs the actual /vision-crop call for a box and updates it in place.
 * Shared by the initial draw (_eraseFinalizeDrawnBox) and eraseRetryVisionBox
 * so a transient failure (e.g. a 502 from an intermittently-flaky Gemini
 * call) doesn't require deleting and redrawing the box from scratch.
 */
export async function _runVisionCropOn(placeholder, box) {
  // Key source depends on which provider is translating — see
  // ocr-client.js's ocrPage() / correction-ui.js's _finalizeBox() for the
  // identical reasoning: Vision always calls Gemini regardless of the
  // translator, so under DeepL/DeepSeek mode the Gemini key comes from the
  // separate vision-ocr-key field instead of the main ai-key field (which
  // holds a non-Gemini key in that mode).
  const info    = getModelInfo();
  const needsSeparateVisionKey = info.provider === 'deepl' || info.provider === 'deepseek';
  const key     = info.provider === 'gemini'
    ? (document.getElementById('ai-key')?.value?.trim() || '')
    : needsSeparateVisionKey
    ? (document.getElementById('vision-ocr-key')?.value?.trim() || '')
    : '';
  const visionModel = info.provider === 'gemini' ? getModelId() : 'gemini-3.5-flash';
  if (!key) {
    toast(needsSeparateVisionKey
      ? 'Gemini key required for ✦ VISION draw — add one under Vision OCR in Reading Preferences.'
      : 'Gemini API key required for ✦ VISION draw.');
    placeholder.visionPending = false;
    _renderEraseBoxes(); _renderEraseSidebar();
    return;
  }
  const img = document.getElementById('erase-img');
  const nw = img?.naturalWidth || 0, nh = img?.naturalHeight || 0;
  const pxBox = [
    Math.round(box[0] / 100 * nw), Math.round(box[1] / 100 * nh),
    Math.round(box[2] / 100 * nw), Math.round(box[3] / 100 * nh),
  ];
  try {
    const res = await fetch('/vision-crop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(await imageRefBody(_eraseImgMeta.cdnUrl)), box: pxBox,
        lang: _eraseSourceLang, ai_key: key, ai_model: visionModel,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.description || `HTTP ${res.status}`;
      toast(`Vision crop error: ${msg}`);
      // Previously this box was left with no srcText and no visible marker —
      // identical to a normal "erase only" box, so a failed OCR call (e.g. a
      // transient 502 from Gemini) silently produced a dead box that could
      // never be picked up by ↺ translate pending. Now it's flagged so it's
      // obviously broken and retryable instead of quietly disappearing into
      // the pile, which is what made "several boxes work, then it stops"
      // look like a translate bug rather than an intermittent OCR failure.
      placeholder.visionFailed = true;
      placeholder.visionError = msg;
    } else {
      const data = await res.json();
      // Store the OCR'd source text separately from tl (the translation) —
      // tl stays blank/pending until ↺ translate pending runs. eraseTl2Src
      // lets eraseTranslatePending() find the original-language text to send.
      placeholder.srcText = data.text || '';
      placeholder.visionFailed = false;
      placeholder.visionError = '';
      if (!placeholder.srcText) toast('✦ Vision found no text in that box.');
      // data.usage is only present when the server actually got a
      // usageMetadata block back from Gemini (see server.py's
      // vision_crop()) — same shape/condition as ocr-client.js's /ocr
      // handling, so a Vision-drawn erase box counts toward the cost
      // tracker exactly like Vision OCR on a full page already does.
      if (data.usage) {
        recordUsage('vision-crop', data.usage, 'gemini', data.usage_model || visionModel);
      }
    }
  } catch (e) {
    toast(`Vision crop failed: ${e.message}`);
    placeholder.visionFailed = true;
    placeholder.visionError = e.message;
  }
  placeholder.visionPending = false;
  _renderEraseBoxes();
  _renderEraseSidebar();
  _updateErasePendingButton();
}

/** Re-runs the Vision OCR call for a box that previously failed (visionFailed). */
export async function eraseRetryVisionBox(id) {
  const b = _eraseBoxes.find(x => String(x.id) === String(id));
  if (!b) return;
  b.visionPending = true;
  b.visionFailed = false;
  _renderEraseSidebar();
  await _runVisionCropOn(b, b.box);
}

/**
 * Toggle "Vision draw" mode: newly drawn boxes get OCR'd via Gemini Vision
 * (see _eraseFinalizeDrawnBox) instead of auto-matched against existing
 * translations. Mutually exclusive with pre-paint mode — both repurpose
 * the same drag-to-draw canvas for a different action.
 */
export function eraseToggleVisionDraw() {
  if (!_eraseImgMeta) return;
  if (_erasePrePaintOn) eraseTogglePrePaint(); // turn off pre-paint first — modes don't mix
  _eraseVisionDrawOn = !_eraseVisionDrawOn;
  const btn = document.getElementById('btn-toggle-vision-draw');
  if (btn) btn.classList.toggle('active', _eraseVisionDrawOn);
}

/**
 * Toggle "paint before erase" mode: switches the canvas from box-drawing
 * (createBoxOverlay) to the pre-paint brush (paint-brush.js, 'pre' mode),
 * layered over the still-original page. Painting here edits the source
 * pixels the server will read once erase runs — see eraseRunErase(),
 * which packages any painted regions as per-box pre_paint patches.
 */
export function eraseTogglePrePaint() {
  if (!_eraseImgMeta) return;
  if (_eraseVisionDrawOn) {
    _eraseVisionDrawOn = false;
    document.getElementById('btn-toggle-vision-draw')?.classList.remove('active');
  }
  _erasePrePaintOn = !_erasePrePaintOn;
  const btn = document.getElementById('btn-toggle-prepaint');
  if (btn) btn.classList.toggle('active', _erasePrePaintOn);

  if (_erasePrePaintOn) {
    _eraseOverlayCtl?.detach();
    initPrePaintBrush();
    // Pre-paint brush starts inactive (matches paint-brush.js's own
    // default) — flip it on immediately so toggling this button both
    // switches modes AND starts painting in one click.
    toggleBrushMode();
  } else {
    teardownPaintBrush();
    _eraseOverlayCtl?.attach();
  }
}

// ── Auto-match a drawn box to an already-translated/corrected region ─────
// Looks up this page's effective regions (corrections preferred — see
// getEffectivePageRegions in cache.js) and returns the one whose center
// point falls inside the drawn box, if any. This is what lets a box you
// draw by hand come pre-filled with the real translation (including any
// ✏ CORRECT edits) instead of starting blank every time.
export function _findMatchingTranslation(box) {
  const regions = _getPageRegionsForErase();
  if (!regions || !regions.length) return null;
  const [x1, y1, x2, y2] = box;
  let best = null, bestArea = Infinity;
  for (const r of regions) {
    const cx = r.x ?? r.cx, cy = r.y ?? r.cy;
    if (cx == null || cy == null) continue;
    if (cx < x1 || cx > x2 || cy < y1 || cy > y2) continue;
    const tl = (r.tl || '').trim();
    if (!tl || tl === '—') continue;
    // If multiple region centers land in the same box, prefer the one
    // whose own box is smallest (most likely the specific bubble, not an
    // an accidental wide match) — ties are rare in practice.
    const rw = (r.box ? (r.box[2] - r.box[0]) * (r.box[3] - r.box[1]) : 1);
    if (rw < bestArea) { best = r; bestArea = rw; }
  }
  return best;
}

/** This page's effective (correction-preferring) regions, or null. */
export function _getPageRegionsForErase() {
  if (!_eraseChapterId) return null;
  const key = `${_eraseChapterId}_${_erasePageIdx}`;
  const pd = _pageStore.get(key);
  let fallback = pd?.sortedRegions
    ? pd.sortedRegions.map(r => ({ t: r.t, x: r.cx, y: r.cy, box: r.box, tl: r.tl }))
    : (pd?.autoRegions
        ? pd.autoRegions.map(r => ({ t: 'speech', x: r.cx, y: r.cy, box: r.box, tl: '' }))
        : null);
  if (!fallback) {
    const cached = getCachedChapter(_eraseChapterId);
    fallback = cached?.pageRegions?.[_erasePageIdx] || null;
  }
  return getEffectivePageRegions(_eraseChapterId, _erasePageIdx, fallback);
}

export function _renderEraseBoxes() {
  const ov = document.getElementById('erase-overlay');
  if (!ov) return;
  ov.querySelectorAll('.corr-rbox').forEach(el => el.remove());
  _eraseBoxes.forEach((b, i) => {
    const [x1, y1, x2, y2] = b.box;
    const el = document.createElement('div');
    const filled = (b.tl || '').trim().length > 0;
    let cls = 'corr-rbox erase-rbox';
    if (b.id === _eraseSelId) cls += ' selected';
    if (b.outside) cls += ' erase-rbox-outside';
    else if (filled) cls += ' erase-rbox-filled';
    el.className = cls;
    el.style.cssText = `left:${x1}%;top:${y1}%;width:${x2 - x1}%;height:${y2 - y1}%`;
    el.innerHTML = `<span class="rbox-num">${i + 1}</span>`;
    el.title = b.outside
      ? 'Outside-page translation — click to edit'
      : (filled ? 'Click to edit translation' : 'Click to edit / add translation');
    el.addEventListener('click', e => {
      e.stopPropagation();
      _eraseSelId = b.id;
      _renderEraseBoxes();
      _renderEraseSidebar();
    });
    ov.appendChild(el);
  });
  const countEl = document.getElementById('erase-box-count');
  if (countEl) countEl.textContent = `${_eraseBoxes.length} box${_eraseBoxes.length !== 1 ? 'es' : ''}`;
  const eraseBtn = document.getElementById('btn-do-erase');
  if (eraseBtn) eraseBtn.disabled = _eraseBoxes.length === 0;
}

// ── Sidebar: per-box translation text + "outside page" toggle + remove ───
export function _renderEraseSidebar() {
  const sb = document.getElementById('erase-sidebar');
  if (!sb) return;
  if (!_eraseBoxes.length) {
    sb.innerHTML = '<div class="corr-empty-hint">Draw a box on the page to add a translation,<br>or ✦ seed from OCR.</div>';
    return;
  }
  sb.innerHTML = _eraseBoxes.map((b, i) => {
    const sel = b.id === _eraseSelId;
    const filled = (b.tl || '').trim().length > 0;
    const isPending = !!b.srcText && !filled; // Vision read text but no translation yet
    const statusTag = b.visionPending
      ? '<span class="erase-box-tag pending">✦ reading…</span>'
      : (b.visionFailed
          ? `<span class="erase-box-tag failed" title="${esc(b.visionError || '')}">✦ OCR failed — <a href="#" onclick="eraseRetryVisionBox('${b.id}');return false;">retry</a></span>`
          : (b.outside
              ? '<span class="erase-box-tag outside">outside page</span>'
              : (isPending
                  ? '<span class="erase-box-tag pending">pending translation</span>'
                  : (b.matched
                      ? '<span class="erase-box-tag matched">auto-matched</span>'
                      : (filled ? '' : '<span class="erase-box-tag empty">erase only</span>')))));
    const prePaintTag = b.prePainted
      ? '<span class="erase-box-tag prepainted">pre-painted — server erase skipped</span>' : '';
    const fontOptions = _eraseFontOptionsHtml(b.fontPath);
    const srcTextRow = b.srcText
      ? `<div class="erase-box-src-text" title="Original text read by Vision — reference only, not editable here">✦ ${esc(b.srcText)}</div>`
      : '';
    return `
    <div class="erase-box-card${sel ? ' selected' : ''}" data-id="${b.id}">
      <div class="erase-box-card-hd">
        <span class="erase-box-num">${i + 1}</span>
        ${statusTag}
        ${prePaintTag}
        <button class="erase-box-remove" title="Remove this box" onclick="eraseRemoveBox('${b.id}')">✕</button>
      </div>
      ${srcTextRow}
      <textarea class="erase-box-text" rows="2"
        placeholder="${b.visionFailed ? 'Vision OCR failed for this box — retry above, or type the translation in yourself…' : (b.srcText ? 'Not translated yet — use ↺ translate pending, or type it in yourself…' : 'Translation text (leave blank to erase only)…')}"
        oninput="eraseSetBoxText('${b.id}', this.value)"
        onfocus="eraseSelectBox('${b.id}')">${esc(b.tl || '')}</textarea>
      <label class="erase-box-outside-toggle">
        <input type="checkbox" ${b.outside ? 'checked' : ''}
          onchange="eraseSetBoxOutside('${b.id}', this.checked)">
        Keep original as-is — put translation outside the page (not erased)
      </label>
      <label class="erase-box-outside-toggle">
        <input type="checkbox" ${b.prePainted ? 'checked' : ''}
          onchange="eraseSetBoxPrePainted('${b.id}', this.checked)">
        This box is already fully painted white — skip server erase
      </label>
      <div class="erase-box-font-row">
        <select class="form-input erase-box-font-select" title="Font override for this box (blank = page default)"
          onchange="eraseSetBoxFont('${b.id}', this.value)">
          ${fontOptions}
        </select>
        <input type="number" class="form-input erase-size-input" min="0" max="200" step="1"
          placeholder="auto" value="${b.fontSize > 0 ? b.fontSize : ''}"
          title="Explicit point size for this box (blank/0 = page default / auto-fit)"
          onchange="eraseSetBoxFontSize('${b.id}', this.value)">
      </div>
    </div>`;
  }).join('');
}

/** Builds <option> markup for a per-box font <select>, with "Page default"
 * as the empty-value option (so a box only overrides the font when the
 * person deliberately picks one) followed by every discovered system font. */
export function _eraseFontOptionsHtml(selectedPath) {
  let html = '<option value=""' + (selectedPath ? '' : ' selected') + '>Page default</option>';
  _availableFonts.forEach(function(f) {
    const sel = f.path === selectedPath ? ' selected' : '';
    html += '<option value="' + esc(f.path) + '"' + sel + '>' + esc(f.name) + '</option>';
  });
  return html;
}

export function eraseSelectBox(id) {
  // ids are stored as numbers (Date.now()+Math.random()); template strings
  // pass them back as strings, so compare loosely.
  _eraseSelId = _eraseBoxes.find(b => String(b.id) === String(id))?.id ?? null;
  _renderEraseBoxes();
  const sb = document.getElementById('erase-sidebar');
  sb?.querySelectorAll('.erase-box-card').forEach(el => {
    el.classList.toggle('selected', String(el.dataset.id) === String(id));
  });
}

export function eraseSetBoxText(id, text) {
  const b = _eraseBoxes.find(x => String(x.id) === String(id));
  if (!b) return;
  b.tl = text;
  b.matched = false; // manually edited — no longer "just" the auto-match
  _renderEraseBoxes(); // updates filled/empty styling on the overlay box
  _updateErasePendingButton();
}

export function eraseSetBoxOutside(id, checked) {
  const b = _eraseBoxes.find(x => String(x.id) === String(id));
  if (!b) return;
  b.outside = checked;
  _renderEraseBoxes();
  _renderEraseSidebar();
}

export function eraseSetBoxPrePainted(id, checked) {
  const b = _eraseBoxes.find(x => String(x.id) === String(id));
  if (!b) return;
  b.prePainted = checked;
  _renderEraseSidebar();
}

export function eraseSetBoxFont(id, path) {
  const b = _eraseBoxes.find(x => String(x.id) === String(id));
  if (!b) return;
  b.fontPath = path || '';
}

export function eraseSetBoxFontSize(id, value) {
  const b = _eraseBoxes.find(x => String(x.id) === String(id));
  if (!b) return;
  const n = parseInt(value, 10);
  b.fontSize = (Number.isFinite(n) && n > 0) ? n : 0;
}

export function eraseRemoveBox(id) {
  _eraseBoxes = _eraseBoxes.filter(x => String(x.id) !== String(id));
  if (String(_eraseSelId) === String(id)) _eraseSelId = null;
  _renderEraseBoxes();
  _renderEraseSidebar();
  _updateErasePendingButton();
}

export function eraseClearBoxes() {
  _eraseBoxes = [];
  _eraseSelId = null;
  _renderEraseBoxes();
  _renderEraseSidebar();
  _updateErasePendingButton();
}

/**
 * Seed boxes from whatever translated data is already available for this
 * exact page — this session's _pageStore, the chapter's localStorage
 * cache, AND (via getEffectivePageRegions) any ✏ CORRECT edits saved for
 * it, correction taking priority exactly like the reader/download/export
 * paths already do. Doesn't call OCR or any API — purely reuses data
 * already on hand. Seeded boxes come pre-filled with their translation;
 * existing boxes are kept, seeded ones are appended (click ✕ to remove
 * any you don't want).
 */
export function eraseSeedFromOcr() {
  if (!_eraseChapterId) return;
  const regions = _getPageRegionsForErase();

  if (!regions || !regions.length) {
    toast('No OCR data found for this page yet — translate this chapter first, or draw boxes manually.');
    return;
  }

  let added = 0;
  regions.forEach((r, j) => {
    const cx = r.x ?? r.cx, cy = r.y ?? r.cy;
    const box = r.box || (cx != null ? [cx - 8, cy - 5, cx + 8, cy + 5] : null);
    if (!box) return;
    const tl = (r.tl || '').trim();
    const hasTl = tl && tl !== '—';
    _eraseBoxes.push({
      id: Date.now() + Math.random() + added,
      box,
      tl: hasTl ? tl : '',
      outside: false,
      matched: hasTl,
      prePainted: false,
      fontPath: '',
      fontSize: 0,
      // Carry the original-language text along even when there's no
      // translation yet, so an untranslated seeded region can still be
      // picked up by ↺ translate pending instead of being erase-only forever.
      srcText: !hasTl ? (r.text || '') : '',
    });
    added++;
  });
  _renderEraseBoxes();
  _renderEraseSidebar();
  _updateErasePendingButton();
  toast(added ? `Seeded ${added} box(es) — translations pre-filled where available.` : 'No usable boxes found on this page.');
}

/** A box is "pending" if it has Vision-read source text but no translation
 * yet. Boxes with no srcText at all (blank/manual/erase-only boxes) are
 * NOT pending — there's nothing to translate them from. */
export function _isErasePending(b) {
  return !!(b.srcText && b.srcText.trim()) && !(b.tl && b.tl.trim());
}

export function _updateErasePendingButton() {
  const btn = document.getElementById('btn-erase-translate-pending');
  if (!btn) return;
  let countEl = document.getElementById('erase-pending-count');
  if (!countEl) {
    // Self-heal: the span should always exist inside this button, but if
    // something ever wipes it out (see the postmortem in eraseTranslatePending
    // above), rebuild it here rather than silently giving up on updating the
    // button ever again — that silent-give-up is exactly what turned one
    // missing span into a permanently-stuck "translate pending" button.
    btn.innerHTML = '↺ translate pending (<span id="erase-pending-count">0</span>)';
    countEl = document.getElementById('erase-pending-count');
  }
  const pending = _eraseBoxes.filter(_isErasePending);
  countEl.textContent = pending.length;
  btn.disabled = pending.length === 0;
}

/**
 * Batch-translate every pending box (Vision-read text, no translation yet)
 * in ONE /translate call — same "draw/fix everything first, translate once"
 * workflow as correction-ui.js's translatePendingRegions(). Uses each box's
 * center point as cx/cy so the model gets the same spatial reading-order
 * signal translateBatch always uses for a full page.
 */
export async function eraseTranslatePending() {
  const pending = _eraseBoxes.filter(_isErasePending);
  if (!pending.length) {
    const failed = _eraseBoxes.filter(b => b.visionFailed).length;
    toast(failed
      ? `Nothing pending — but ${failed} box${failed !== 1 ? 'es' : ''} failed Vision OCR. Click retry on ${failed !== 1 ? 'them' : 'it'} in the sidebar.`
      : 'Nothing pending — draw a box in ✦ VISION mode first.');
    return;
  }

  const key = document.getElementById('ai-key')?.value?.trim();
  if (!key) { toast(`${getModelInfo().label} API key not set.`); return; }

  const btn = document.getElementById('btn-erase-translate-pending');
  // IMPORTANT: never set btn.textContent here — the button's default markup
  // is `↺ translate pending (<span id="erase-pending-count">0</span>)`, and
  // .textContent replaces ALL child nodes, including that span. Once it's
  // gone, every future document.getElementById('erase-pending-count') call
  // returns null, which makes _updateErasePendingButton() silently bail out
  // (see its `if (!countEl || !btn) return;` guard) and never touch
  // btn.disabled again — permanently freezing the button disabled after the
  // very first click, with no error anywhere. That's what made this look
  // like "works once, then dead forever until reload." Use innerHTML with
  // the span rebuilt in place instead, so it always survives.
  if (btn) { btn.disabled = true; btn.innerHTML = `Translating ${pending.length}…`; }
  try {
    const targetLang = getTargetLang();
    const ocrLike = pending.map(b => {
      const [x1, y1, x2, y2] = b.box;
      return { text: b.srcText, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
    });
    const translated = await translateBatch(ocrLike, _eraseSourceLang, targetLang);
    pending.forEach((b, j) => { b.tl = translated[j]?.tl || '—'; });
    _renderEraseBoxes();
    _renderEraseSidebar();
    toast(`Translated ${pending.length} pending box${pending.length !== 1 ? 'es' : ''}.`);
  } catch (e) {
    toast(`Translation failed: ${e.message}`);
  }
  // Rebuild with a fresh span rather than reading the (now-destroyed) old
  // one — _updateErasePendingButton() below will immediately fill in the
  // correct count, this just restores the span's existence.
  if (btn) btn.innerHTML = '↺ translate pending (<span id="erase-pending-count">0</span>)';
  _updateErasePendingButton();
}

export async function eraseRunErase() {
  if (!_eraseBoxes.length) { toast('Draw at least one box first.'); return; }

  const stillPending = _eraseBoxes.filter(_isErasePending).length;
  if (stillPending > 0) {
    const proceed = confirm(
      `${stillPending} box${stillPending !== 1 ? 'es have' : ' has'} Vision-read text but ` +
      `no translation yet. Erasing now will blank ${stillPending !== 1 ? 'them' : 'it'} with ` +
      `nothing drawn back in.\n\nRun ↺ translate pending first, or Erase anyway?`
    );
    if (!proceed) return;
  }

  const btn = document.getElementById('btn-do-erase');
  const eraseMode = document.getElementById('erase-mode').value;
  const legendLayout = document.getElementById('erase-legend-layout')?.value || 'below';
  btn.disabled = true;
  btn.textContent = 'Erasing…';
  const wrap = document.getElementById('erase-canvas-wrap');
  wrap.classList.add('erase-busy');

  try {
    // Pull any pre-erase white-paint strokes out of the brush canvas
    // BEFORE it gets torn down — getPrePaintPatchForBox reads the live
    // canvas, so this has to happen while pre-paint mode is still active.
    const havePrePaint = typeof hasPrePaintStrokes === 'function' && hasPrePaintStrokes();
    const boxes = _eraseBoxes.map(b => {
      const out = {
        box: b.box,
        tl: (b.tl || '').trim(),
        outside: !!b.outside,
      };
      if (b.prePainted) out.pre_painted = true;
      if (b.fontPath) out.font_path = b.fontPath;
      if (b.fontSize > 0) out.font_size = b.fontSize;
      if (havePrePaint) {
        const patch = getPrePaintPatchForBox(b.box);
        if (patch) out.pre_paint = patch;
      }
      return out;
    });

    // Done reading the pre-paint canvas — safe to leave pre-paint mode now.
    if (_erasePrePaintOn) eraseTogglePrePaint();

    const resp = await fetch('/export-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(await imageRefBody(_eraseImgMeta.cdnUrl)),
        manual: true,
        boxes,
        erase_mode: eraseMode,
        ai_inpaint: getAiInpaintSetting(),
        legend_layout: legendLayout,
        font_path: _eraseDefaultFontPath,
        font_size: _eraseDefaultFontSize,
      }),
    });
    if (!resp.ok) {
      const msg = await resp.text().catch(() => '');
      throw new Error(msg || `HTTP ${resp.status}`);
    }
    _eraseResultBlob = await resp.blob();
    const row = document.getElementById('erase-download-row');
    row.style.display = 'flex';
    const filledCount = boxes.filter(b => b.tl && !b.outside).length;
    const outsideCount = boxes.filter(b => b.outside).length;
    // pre_painted / outside boxes are both excluded from server-side erase
    // (see typeset_manual_page's erase_targets) — outside boxes additionally
    // keep their original pixels untouched entirely (no erase, no pre-paint).
    const paintedCount = boxes.filter(b => !b.outside && (b.pre_paint || b.pre_painted)).length;
    const erasedCount  = boxes.length - outsideCount;
    const parts = [`${erasedCount} box${erasedCount !== 1 ? 'es' : ''} erased`];
    if (filledCount)  parts.push(`${filledCount} typeset`);
    if (outsideCount) parts.push(`${outsideCount} kept as-is, in legend`);
    if (paintedCount) parts.push(`${paintedCount} pre-painted`);
    toast(`Done — ${parts.join(', ')}. Preview below, or download it.`);
    _showErasePreview();
  } catch (err) {
    toast(`Erase failed: ${err.message || err}`);
  } finally {
    btn.disabled = _eraseBoxes.length === 0;
    btn.textContent = '🧹 Erase';
    wrap.classList.remove('erase-busy');
  }
}

export function _showErasePreview() {
  if (!_eraseResultBlob) return;
  const img = document.getElementById('erase-img');
  if (img) img.src = URL.createObjectURL(_eraseResultBlob);
  // Boxes no longer correspond to editable regions on the current view —
  // clear the overlay/sidebar so it doesn't look like there's still
  // something to erase or edit. (The legend, if any, is baked into the
  // downloaded image itself now.)
  document.getElementById('erase-overlay').innerHTML = '';
  const sb = document.getElementById('erase-sidebar');
  if (sb) sb.innerHTML = '<div class="corr-empty-hint">Done — download below,<br>or clear boxes to start a new page.</div>';
  initPaintBrush();
}

export async function eraseDownloadPage() {
  if (!_eraseResultBlob) return;
  const blob = await getFinalErasedBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `erased_page_${_erasePageIdx + 1}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════
// BATCH EXPORT — save several pages' results as you go, then zip them all
// at once (see _eraseBatch's doc comment near the top of this file).
// Deliberately a manual "💾 Save to batch" click rather than auto-saving the
// moment ↺ Erase finishes: that leaves room to touch a page up with the
// 🖌 brush first (see paint-brush.js) before locking it in, same as
// ⬇ Download this page only already did one page at a time.
// ══════════════════════════════════════════════

export function _eraseBatchPanelEl() { return document.getElementById('erase-batch-panel'); }

export function _renderEraseBatchPanel() {
  const panel = _eraseBatchPanelEl();
  if (!panel) return;

  if (!_eraseBatch.size) {
    panel.classList.remove('active');
    panel.innerHTML = '';
    return;
  }

  const indices = [..._eraseBatch.keys()].sort((a, b) => a - b);
  const rows = indices.map(i => `
    <div class="export-row export-row-done">
      <span class="export-row-icon">✓</span>
      <span class="export-row-label">Page ${i + 1}</span>
      <span class="export-row-actions">
        <button class="export-row-btn" onclick="eraseRemoveFromBatch(${i})">✕ remove</button>
      </span>
    </div>`).join('');

  panel.classList.add('active');
  panel.innerHTML = `
    <div class="export-panel-header">
      <span>${_eraseBatch.size} page${_eraseBatch.size !== 1 ? 's' : ''} saved</span>
      <button class="export-row-btn" onclick="eraseDownloadBatchZip()">⬇ Download ZIP (${_eraseBatch.size})</button>
      <button class="export-row-btn" onclick="eraseClearBatch()">✕ clear batch</button>
    </div>
    <div class="export-panel-rows">${rows}</div>
  `;
}

/**
 * Saves the current page's final erased image — same getFinalErasedBlob()
 * eraseDownloadPage() uses, so any 🖌 brush touch-ups made since ↺ Erase
 * are included — into _eraseBatch, keyed by page index. Re-saving the same
 * page (e.g. after redrawing a box and erasing again) just replaces its
 * previous entry. Nothing downloads yet; that's ⬇ Download ZIP below.
 */
export async function eraseSaveToBatch() {
  if (!_eraseResultBlob) return;
  const blob = await getFinalErasedBlob();
  const blobBytes = new Uint8Array(await blob.arrayBuffer());
  const alreadySaved = _eraseBatch.has(_erasePageIdx);
  _eraseBatch.set(_erasePageIdx, { blobBytes, savedAt: Date.now() });
  _renderEraseBatchPanel();
  toast(`Page ${_erasePageIdx + 1} ${alreadySaved ? 're-' : ''}saved to batch (${_eraseBatch.size} ready).`);
}

export function eraseRemoveFromBatch(pageIdx) {
  _eraseBatch.delete(pageIdx);
  _renderEraseBatchPanel();
}

export function eraseClearBatch() {
  if (!_eraseBatch.size) return;
  if (!confirm(`Clear all ${_eraseBatch.size} saved page(s) from the batch? This can't be undone.`)) return;
  _eraseBatch = new Map();
  _renderEraseBatchPanel();
}

/**
 * Zips every page currently in _eraseBatch and downloads it immediately —
 * same client-side buildZip() (zip-writer.js) the reader's "⬇ Export
 * Typeset" uses, so no server round-trip and no re-encoding of pages
 * that are already finished.
 */
export function eraseDownloadBatchZip() {
  if (!_eraseBatch.size) {
    toast('Nothing saved yet — ↺ Erase a page, then 💾 Save to batch, before downloading a zip.');
    return;
  }
  const indices = [..._eraseBatch.keys()].sort((a, b) => a - b);
  const label = _sanitizeForFilename(`erased_${_eraseChapterId || 'pages'}`);
  const files = indices.map(i => ({
    name: `${label}_${String(i + 1).padStart(3, '0')}.png`,
    data: _eraseBatch.get(i).blobBytes,
  }));
  const zipBytes = buildZip(files);
  const zipName = `${label}.zip`;
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast(`Downloaded ${indices.length} page(s) as ${zipName}.`);
  _showDownloadGuide(zipName, 'erase-batch-panel');
}
