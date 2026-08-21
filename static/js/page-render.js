// ═══════════════════════════════════════════════════════════════
// page-render.js
// Rendering a single page: skeleton placeholder, bubble overlay render,
// and the retry-on-error path.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════
import { updatePageInCache } from './cache.js';
import { openCorrection } from './correction-ui.js';
import { _ENGINE_LABEL, _pageStore, maybeShowEngineRecommendation, ocrPage } from './ocr-client.js';
import { toggleReorderPanel } from './reorder-ui.js';
import { _activeChapterId, _manualOrder, _sortRegions } from './state-and-constants.js';
import { getModelInfo, getTargetLang, translateBatch } from './translate-client.js';
import { esc, toast } from './utils.js';

export function addSkeleton(i) {
  const el     = document.createElement('div');
  el.className = 'page-card';
  el.id        = `page-${i}`;
  el.innerHTML = `<div class="page-skeleton">
    <span class="sk-num">${i + 1}</span>
    <div class="sk-bar"></div>
  </div>`;
  document.getElementById('pages-container').appendChild(el);
  return el;
}

// Display-only: no translation panel (English chapters / full-art pages)
export function _renderPageDisplayCore(el, pageIdx, total, imgSrc) {
  el.innerHTML = `
    <div class="img-wrap">
      <img src="${esc(imgSrc)}" class="page-img page-img-only"
           loading="lazy" alt="Page ${pageIdx + 1}">
      <div class="pg-label">${pageIdx + 1} / ${total}</div>
    </div>`;
}

// Full render: image + numbered badges + translation panel
export function _renderPageCore(el, pageIdx, total, imgSrc, regions) {
  // Apply any stored manual reorder for this page
  const moKey = `${_activeChapterId}_${pageIdx}`;
  const moIdx = _manualOrder.get(moKey);
  const displayRegions = moIdx
    ? moIdx.map(i => regions[i]).filter(Boolean)
    : regions;

  let badgesHtml = '';
  let rowsHtml   = '';
  displayRegions.forEach((r, i) => {
    const tag = (r.t || 'speech').toLowerCase();
    // REVERTED: a fixed "3% outside the top-left corner" offset was tried
    // here to stop badges landing on top of bubble text, but a fixed
    // percentage nudge only works when a bubble's box has real margin
    // around its text. Many real regions are tightly cropped to the text
    // itself (e.g. a short SFX box with box=[79.5,49.3,87.1,50.7] — only
    // ~7.6 wide, no slack at all), so the same nudge just as often lands
    // outside the bubble entirely (over artwork, a neighbouring bubble, or
    // a panel border) — a worse failure than sitting on a letter inside
    // the bubble. The centroid is the only anchor guaranteed to land
    // inside the region regardless of its shape or padding, so that's
    // restored as the default. A real fix needs per-bubble empty-space
    // detection, not a fixed offset.
    const cx = r.x ?? 50;
    const cy = r.y ?? 50;
    badgesHtml += `<div class="badge t-${tag}" data-ridx="${i}" style="left:${cx}%;top:${cy}%" tabindex="0" role="button" aria-label="Jump to translation ${i + 1}">${i + 1}</div>`;
    rowsHtml   += `<div class="t-row" data-ridx="${i}">
      <span class="t-num">${i + 1}</span>
      <span class="t-tag ${tag}">${tag}</span>
      <span class="t-text">${esc(r.tl || '—')}</span>
    </div>`;
  });

  const hasRegions = displayRegions.length > 0;
  const reorderBtn = hasRegions
    ? `<button class="btn-reorder-page" id="ro-btn-${pageIdx}"
         onclick="toggleReorderPanel(${pageIdx})" title="Manually reorder badges">⇅ ORDER</button>`
    : '';
  const panel = hasRegions
    ? `<div class="trans-panel" id="trans-panel-${pageIdx}">${rowsHtml}</div>`
    : `<div class="no-text-note">— no text detected —</div>`;

  el.innerHTML = `
    <div class="img-wrap">
      <img src="${esc(imgSrc)}" class="page-img" loading="eager" alt="Page ${pageIdx + 1}">
      ${badgesHtml}
      <div class="pg-label">${pageIdx + 1} / ${total}</div>
      <div class="corner-btns-left">
        <button class="btn-correct" onclick="openCorrection(${pageIdx})" title="Correct this page">✏ CORRECT</button>
        <button class="btn-merge-tune" onclick="openMergeTuner(${pageIdx})"
          title="Bubbles merged wrong on this page? Preview what different Bubble Merge Sensitivity values would group, live, without re-running OCR or spending translation quota.">⚖ MERGE</button>
        <button class="btn-redo-vision" onclick="redoPageWithVision(${pageIdx})"
          title="EasyOCR wrong across the whole page? Discard every region and redo this page with Gemini Vision OCR only, then retranslate from scratch. Needs a Gemini key.">✦ Redo w/ Vision</button>
      </div>
      ${reorderBtn}
    </div>
    ${panel}
    <div class="reorder-panel" id="reorder-panel-${pageIdx}" style="display:none"></div>`;

  // Store regions on the element for reorder access
  el._regions = regions;
}

// FIX #12: cdnUrl (for OCR retries) and imgSrc (for display) are now separate.
//          data-cdn / data-img are stored on the button so retryPage can use each correctly.
export function _renderPageErrorCore(el, pageIdx, total, cdnUrl, imgSrc, errMsg, sourceLang) {
  el.innerHTML = `
    <div class="img-wrap">
      <img src="${esc(imgSrc)}" class="page-img" loading="eager" alt="Page ${pageIdx + 1}">
      <div class="pg-label">${pageIdx + 1} / ${total}</div>
    </div>
    <div class="page-err-note">
      <span>${esc(errMsg)}</span>
      <button class="btn-retry"
        data-idx="${pageIdx}"
        data-total="${total}"
        data-cdn="${esc(cdnUrl)}"
        data-img="${esc(imgSrc)}"
        data-lang="${esc(sourceLang ?? '')}">↺ Retry</button>
    </div>`;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.btn-retry');
  if (!btn || btn.disabled) return;
  const el = btn.closest('.page-card');
  retryPage(btn, el,
    +btn.dataset.idx, +btn.dataset.total,
    btn.dataset.cdn, btn.dataset.img, btn.dataset.lang);
});

// ══════════════════════════════════════════════
// PAGE IMAGE RETRY
// ══════════════════════════════════════════════
// A page's image and its translation are two INDEPENDENT fetches of the same
// picture: /ocr hands the raw CDN url to the server, which fetches it
// server-side, while <img src> points at /proxy and is fetched by the browser
// (see fetchPageUrls' {cdn, img} pair). So the OCR + translate pass can
// succeed completely while the display fetch fails on its own — which is
// exactly what a reader sees as "it says translated, but the page is blank".
//
// /proxy turns ANY requests exception into a 502 (its own 20s timeout, an
// MD@Home node hiccup, or simply losing a connection race against a
// concurrent ~22s OCR call on the same local server). Until now nothing
// listened for the resulting error event, so one transient failure left that
// image broken permanently — no retry, no message, and the page's badges and
// translation panel rendered normally around the hole, because _pageStore was
// never involved.
//
// The known workaround was to open ✏ CORRECT and close it again, which works
// only because it replaces card.innerHTML and so builds a BRAND NEW <img>,
// issuing a fresh request. That it reliably worked is what says the failure is
// transient rather than a dead URL — so retrying the same src is the actual
// fix, and this does it automatically instead of making the reader discover
// the trick.
const _IMG_RETRY_DELAYS = [400, 1200, 3000];   // ms; length = max attempts

// error does not bubble, so this listens in the CAPTURE phase. One document
// -level listener covers every page image ever rendered, including cards
// rebuilt by correction-ui.js and pages appended long after load.
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (!img.matches('.page-img, .page-img-only, .corr-img')) return;
  _retryPageImage(img);
}, true);

function _retryPageImage(img) {
  const attempt = (+img.dataset.imgRetry || 0) + 1;
  if (attempt > _IMG_RETRY_DELAYS.length) { _markImageFailed(img); return; }
  img.dataset.imgRetry = attempt;

  // Remember the ORIGINAL src once: retrying off the current value would
  // stack one cache-buster on top of the last one.
  const base = img.dataset.imgBase || (img.dataset.imgBase = img.getAttribute('src') || '');
  if (!base) return;

  setTimeout(() => {
    // Don't re-request an image the DOM has since thrown away.
    if (!img.isConnected) return;
    // A local folder/CBZ page is a blob: url — same-process, never fails for
    // network reasons, and appending a query string to it produces an invalid
    // url. Re-assign it untouched; only proxied http(s) srcs get the buster,
    // which is needed so the browser doesn't just replay its cached 502.
    const isNetwork = /^(https?:)?\//.test(base);
    img.src = isNetwork
      ? base + (base.includes('?') ? '&' : '?') + '_retry=' + attempt
      : base;
  }, _IMG_RETRY_DELAYS[attempt - 1]);
}

function _markImageFailed(img) {
  const wrap = img.closest('.img-wrap, .corr-img-wrap');
  if (!wrap || wrap.querySelector('.img-reload')) return;
  const btn = document.createElement('button');
  btn.className   = 'img-reload';
  btn.textContent = '↺ RELOAD IMAGE';
  btn.title       = 'The page image failed to load. The translation is unaffected — this re-requests just the picture.';
  btn.onclick = () => {
    btn.remove();
    delete img.dataset.imgRetry;
    _retryPageImage(img);
  };
  wrap.appendChild(btn);
}

// A retry that SUCCEEDS must clear the counter, or three transient failures
// spread across a long reading session would exhaust the budget and show the
// manual button on an image that is loading fine.
document.addEventListener('load', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (!img.matches('.page-img, .page-img-only, .corr-img')) return;
  if (img.dataset.imgRetry) delete img.dataset.imgRetry;
  img.closest('.img-wrap, .corr-img-wrap')?.querySelector('.img-reload')?.remove();
}, true);

// FIX #2: regions now use translated[j].t for type (was always hardcoded 'speech')
// FIX #12: uses cdnUrl for OCR, imgSrc for display
export async function retryPage(btn, el, pageIdx, total, cdnUrl, imgSrc, sourceLang) {
  btn.disabled    = true;
  btn.textContent = 'Retrying…';
  try {
    await _ocrTranslateAndRenderPage(el, pageIdx, total, cdnUrl, imgSrc, sourceLang);
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = '↺ Retry';
    // Update the error note in-place so the user can read why the retry failed
    // without relying on the disappearing toast alone.
    const errNote = el?.querySelector('.page-err-note span');
    if (errNote) errNote.textContent = err.message;
    toast(`Retry failed: ${err.message}`);
  }
}

// ══════════════════════════════════════════════
// Shared OCR → translate → render pipeline for one page. Used by both the
// error-state ↺ Retry button (visionModeOverride left unset — same
// smart/all/off behaviour as the initial pass) and ✦ Redo w/ Vision
// (visionModeOverride='all', discarding whatever regions existed before).
// Throws on failure — callers own their own button/error-UI state.
// ══════════════════════════════════════════════
export async function _ocrTranslateAndRenderPage(el, pageIdx, total, cdnUrl, imgSrc, sourceLang, visionModeOverride) {
  const targetLang = getTargetLang();
  const ocrData    = await ocrPage(cdnUrl, sourceLang, undefined, visionModeOverride);
  const ocrResult  = ocrData.regions;
  if (ocrData.visionFallback) {
    // See pipeline.js's matching toast for why this reads ocrData.ocrEngine
    // instead of hardcoding "EasyOCR" — it was wrong for RapidOCR users.
    const engineLabel = _ENGINE_LABEL[ocrData.ocrEngine] || 'the local engine';
    const msgs = { quota: 'Gemini quota hit', error: 'Gemini Vision error', network: 'Network error', parse: 'Vision response unreadable', empty: 'Gemini Vision found no text' };
    toast(`⚠ ${msgs[ocrData.visionFallback] ?? 'Vision OCR error'} — used ${engineLabel} as fallback.`);
  }
  maybeShowEngineRecommendation(sourceLang, ocrData.localEngineRecommendation);
  // Store raw data so the correction UI can access it
  _pageStore.set(`${_activeChapterId}_${pageIdx}`, {
    cdnUrl, imgSrc, sourceLang, total,
    rawBoxes: ocrData.rawBoxes,
    autoRegions: ocrResult,
    ocrEngine: ocrData.ocrEngine,
    hBorders: ocrData.hBorders,
    vBorders: ocrData.vBorders,
  });
  if (!ocrResult.length) {
    renderPageDisplay(el, pageIdx, total, imgSrc);
    updatePageInCache(pageIdx, []);
    return { regions: [], ocrEngine: ocrData.ocrEngine };
  }
  // Sort regions per user's reading order preference
  const sortedOcr = _sortRegions(ocrResult, ocrData.hBorders, ocrData.vBorders);
  const translated = await translateBatch(sortedOcr, sourceLang, targetLang);
  const regions    = sortedOcr.map((r, j) => ({
    text: r.text || '',   // needed so re-translate works if this page is cached
    t:  translated[j]?.t  || 'speech',
    x:  r.cx,
    y:  r.cy,
    box: r.box,
    tl: translated[j]?.tl || '—',
  }));
  // Save translated data so correction UI gets real tl values
  const _se = _pageStore.get(`${_activeChapterId}_${pageIdx}`);
  if (_se) _se.sortedRegions = sortedOcr.map((r, j) => ({
    text: r.text || '', t: translated[j]?.t || 'speech',
    cx: r.cx, cy: r.cy, box: r.box,
    raw_box_ids: r.raw_box_ids || [],
    tl: translated[j]?.tl || '—',
  }));
  renderPage(el, pageIdx, total, imgSrc, regions);
  updatePageInCache(pageIdx, regions);
  return { regions, ocrEngine: ocrData.ocrEngine };
}

// ══════════════════════════════════════════════
// "Redo with Vision" — for when EasyOCR's boxes are wrong across the WHOLE
// page (missed bubbles, garbled reading order, phantom detections from
// screentone, etc.) and fixing them one at a time in ✏ CORRECT would be
// slower than just starting over. Discards every existing region for this
// page and re-runs OCR with vision_mode forced to 'all' (Gemini Vision for
// every region, not just the "smart"-list languages), then retranslates
// from scratch in one batch call. Requires a Gemini key from SOME source —
// either the main ai-key field (when Gemini is the translator) or the
// separate vision-ocr-key field (when DeepL is the translator — see
// ocr-client.js's ocrPage() for the full reasoning on why DeepL mode needs
// its own key field here). DeepSeek-only users still have no Vision OCR
// available at all (see server.py's /ocr route docstring and
// translate-client.js's onModelChange(), which hides the whole Vision OCR
// settings group for DeepSeek specifically).
// ══════════════════════════════════════════════
export async function redoPageWithVision(pageIdx) {
  const info = getModelInfo();
  const key = info.provider === 'gemini'
    ? document.getElementById('ai-key')?.value?.trim()
    : info.provider === 'deepl'
    ? document.getElementById('vision-ocr-key')?.value?.trim()
    : '';
  if (!key) {
    toast(info.provider === 'deepl'
      ? 'Redo with Vision needs a Gemini key — add one under Vision OCR in Reading Preferences.'
      : 'Redo with Vision needs a Gemini API key/model — switch AI Model to a Gemini option, or add one under Vision OCR in Reading Preferences if using DeepL.');
    return;
  }

  const pd = _pageStore.get(`${_activeChapterId}_${pageIdx}`);
  if (!pd) { toast('No page data for this page yet.'); return; }

  const el  = document.getElementById(`page-${pageIdx}`);
  const btn = el?.querySelector('.btn-redo-vision');
  if (btn) { btn.disabled = true; btn.textContent = '✦ Redoing…'; }

  try {
    const { regions } = await _ocrTranslateAndRenderPage(
      el, pageIdx, pd.total, pd.cdnUrl, pd.imgSrc, pd.sourceLang, 'all'
    );
    // Eagerly clear any saved ✏ CORRECT draft for this page now, at the
    // moment we know the region set just changed — belt-and-suspenders on
    // top of the general staleness check in _initWorkingRegions (see
    // _corrSourceSignature), which would also catch this the next time
    // Correct is opened even without this explicit clear.
    try { localStorage.removeItem(`mtl_corr_${_activeChapterId}_${pageIdx}`); } catch {}
    toast(regions.length
      ? `Redone with Vision — ${regions.length} region(s).`
      : 'Vision found no text on this page.');
  } catch (err) {
    toast(`Redo with Vision failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '✦ Redo w/ Vision'; }
  }
}

// ══════════════════════════════════════════════
// AFTER-RENDER HOOKS
// ══════════════════════════════════════════════
// trans-rail.js used to reassign renderPage/renderPageDisplay/renderPageError
// at load time to append its own behaviour ("call the original, then re-sync
// the docked panel"). That is impossible under ES modules — an imported
// binding is read-only — so the wrapping is inverted: this module now owns the
// seam and interested modules subscribe.
//
// The public functions below fire hooks UNCONDITIONALLY after the core body,
// exactly as the old wrapper did. That matters: the core functions can return
// early, and the old wrapper still ran its follow-up in those cases, so firing
// from inside the core body would have been a subtle behaviour change.
export const _afterPageRenderHooks = [];

export function onAfterPageRender(fn) { _afterPageRenderHooks.push(fn); }

export function _fireAfterPageRender(pageIdx) {
  for (const fn of _afterPageRenderHooks) fn(pageIdx);
}

export function renderPageDisplay(el, pageIdx, total, imgSrc) {
  _renderPageDisplayCore(el, pageIdx, total, imgSrc);
  _fireAfterPageRender(pageIdx);
}
export function renderPage(el, pageIdx, total, imgSrc, regions) {
  _renderPageCore(el, pageIdx, total, imgSrc, regions);
  _fireAfterPageRender(pageIdx);
}
export function renderPageError(el, pageIdx, total, cdnUrl, imgSrc, errMsg, sourceLang) {
  _renderPageErrorCore(el, pageIdx, total, cdnUrl, imgSrc, errMsg, sourceLang);
  _fireAfterPageRender(pageIdx);
}
