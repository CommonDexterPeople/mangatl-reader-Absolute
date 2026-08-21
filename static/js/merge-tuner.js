// ═══════════════════════════════════════════════════════════════
// merge-tuner.js
// Live preview for Bubble Merge Sensitivity, against a real page.
// ═══════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS
//   "Bubble Merge Sensitivity" is a single number that decides which OCR
//   fragments get grouped into one region. The right value depends on the
//   lettering of the manga being read — how far apart its bubbles sit, how
//   tightly its lines are set — so there is no default that is correct for
//   everything, and no way for a reader to know which way to move the slider
//   except by re-running a whole chapter and eyeballing the result.
//
//   This shows the answer directly: the page they are already reading, with
//   the regions the current slider value would produce drawn on top, updating
//   as they drag.
//
// WHY IT IS CHEAP ENOUGH TO BE LIVE
//   Re-grouping already-detected fragments is pure geometry — measured at
//   ~20ms, against ~22s for the OCR pass that produced those fragments, a
//   1100x gap. The page's fragments are already in _pageStore from the
//   original OCR, so /merge-preview re-runs only the merge. Nothing here
//   spends OCR time or translation quota.

import { _pageStore } from './ocr-client.js';
import { imageRefBody } from './local-source.js';
// Imported, not read off window: module imports are LIVE bindings, whereas
// main.js's window bridge copies values once at load time and so would hand
// back whatever chapter was open then. See the caveat on that bridge.
import { _activeChapterId } from './state-and-constants.js';
import { esc, toast } from './utils.js';

let _tunerPageIdx = null;
let _tunerBoxes   = [];     // regions from the last preview response
let _tunerSeq     = 0;      // guards against out-of-order responses
let _tunerBusy    = false;
let _tunerPending = null;   // latest scale requested while a call was in flight

const MERGE_SCALE_KEY = 'mtl_merge_scale';

export function currentMergeScale() {
  const el = document.getElementById('merge-scale');
  const stored = localStorage.getItem(MERGE_SCALE_KEY);
  return parseFloat(el?.value ?? stored ?? '0.5');
}

/** Open the tuner for one page of the chapter currently being read. */
export function openMergeTuner(pageIdx) {
  const pd = _pageStore.get(`${_activeChapterId}_${pageIdx}`);
  if (!pd) { toast('Translate this page first — the tuner needs its OCR fragments.'); return; }
  if (!pd.rawBoxes || !pd.rawBoxes.length) {
    // Vision-only pages carry no local fragments (see pipeline.js's
    // _pageStore.set for the Vision branch: rawBoxes is []), and there is
    // nothing to re-group without them.
    toast('This page has no local OCR fragments to re-group (Vision-only page).');
    return;
  }

  _tunerPageIdx = pageIdx;
  document.getElementById('merge-tuner-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'merge-tuner-modal';
  // Same shell every other modal in the app uses: .flow-modal-backdrop is the
  // fixed, centred, z-indexed overlay; .flow-modal is the panel inside it.
  // This used to put .flow-modal on the backdrop element itself and then wrap
  // the content in .flow-modal-inner / .flow-modal-head — neither of which
  // exists in style.css, so the panel had no background, border, padding or
  // shadow, the header was a plain block instead of a flex row, and the whole
  // thing rendered inline in the document flow rather than as an overlay.
  modal.className = 'flow-modal-backdrop';
  modal.innerHTML = `
    <div class="flow-modal merge-tuner-modal">
      <div class="flow-modal-hdr">
        <span>⚖ MERGE SENSITIVITY — PAGE ${pageIdx + 1}</span>
        <button class="flow-modal-close" onclick="closeMergeTuner()">✕</button>
      </div>
      <div class="flow-modal-body merge-tuner-body">
        <p class="merge-tuner-hint">
          Each box is one region the pipeline would translate as a unit. Too few
          boxes means separate bubbles are being merged together; too many means
          one bubble is being split apart. Drag until each speech bubble has
          exactly one box. This does not re-run OCR or use any translation quota.
        </p>
        <!-- The scroll container and the positioning context MUST be separate
             elements. With overflow:auto and position:relative on the same box,
             the overlay's inset:0 resolves against the scroll VIEWPORT rather
             than the full image, so every region box gets squashed toward the
             top (measured: a 1557px-tall page got a 446px-tall overlay). The
             inner .merge-tuner-stage is sized by the image itself. -->
        <div class="merge-tuner-scroll">
          <div class="merge-tuner-stage">
            <img id="merge-tuner-img" src="${esc(pd.imgSrc)}" alt="Page ${pageIdx + 1}">
            <div id="merge-tuner-overlay" class="merge-tuner-overlay"></div>
          </div>
        </div>
        <!-- .merge-slider-row is the app's existing styled range input (3px
             track, mint thumb) — the same one the settings panel uses for this
             very setting. It was previously an unstyled browser default. -->
        <div class="merge-slider-row merge-tuner-controls">
          <label class="merge-tuner-label" for="merge-tuner-slider">SENSITIVITY</label>
          <input id="merge-tuner-slider" type="range" min="0.1" max="1.5" step="0.05">
          <span id="merge-tuner-val" class="merge-slider-val"></span>
        </div>
        <div id="merge-tuner-count" class="merge-tuner-count"></div>
      </div>
      <div class="flow-modal-footer">
        <button class="corr-btn-close" onclick="closeMergeTuner()">CANCEL</button>
        <button class="corr-btn-retrans" onclick="applyMergeTuner()">✓ USE THIS VALUE</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const slider = document.getElementById('merge-tuner-slider');
  slider.value = currentMergeScale();
  slider.addEventListener('input', () => _requestPreview(parseFloat(slider.value)));
  document.getElementById('merge-tuner-img')
          .addEventListener('load', () => _drawTunerBoxes());
  window.addEventListener('resize', _drawTunerBoxes);

  _requestPreview(parseFloat(slider.value));
}

export function closeMergeTuner() {
  window.removeEventListener('resize', _drawTunerBoxes);
  document.getElementById('merge-tuner-modal')?.remove();
  _tunerPageIdx = null;
  _tunerBoxes = [];
}

/** Save the previewed value into the real slider and persist it. */
export function applyMergeTuner() {
  const v = document.getElementById('merge-tuner-slider')?.value;
  if (v == null) return;
  const real = document.getElementById('merge-scale');
  if (real) {
    real.value = v;
    const label = document.getElementById('merge-scale-val');
    if (label) label.textContent = parseFloat(v).toFixed(2);
  }
  localStorage.setItem(MERGE_SCALE_KEY, v);
  closeMergeTuner();
  // Deliberately does NOT re-run the chapter: that would cost a full OCR pass
  // per page and re-spend translation quota. The new value applies to pages
  // translated from here on, and to any page explicitly retried.
  toast(`Merge sensitivity set to ${parseFloat(v).toFixed(2)}. Applies to pages translated from now on — use ↻ on a page to redo it with the new value.`);
}

/**
 * Ask the server to re-group this page at `scale`.
 *
 * Coalescing, not debouncing: a range input fires continuously while dragging,
 * and the response is fast enough (~20ms warm) that a fixed debounce delay
 * would add more lag than it removes. Instead one request is kept in flight
 * and the newest requested value is remembered; when the call returns, if the
 * slider has moved on, it fires once more for the latest value. The sequence
 * guard drops any response that arrives after a newer one has already landed.
 */
async function _requestPreview(scale) {
  document.getElementById('merge-tuner-val').textContent = scale.toFixed(2);
  if (_tunerBusy) { _tunerPending = scale; return; }
  _tunerBusy = true;
  const seq = ++_tunerSeq;

  const pd = _pageStore.get(`${_activeChapterId}_${_tunerPageIdx}`);
  if (!pd) { _tunerBusy = false; return; }

  // imageRefBody is async — it inlines local-folder/CBZ pages as base64,
  // since those have no URL the server could fetch.
  let ref;
  try {
    ref = await imageRefBody(pd.cdnUrl);
  } catch (e) {
    _tunerBusy = false;
    toast(`Preview failed: ${e.message}`);
    return;
  }

  fetch('/merge-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...ref,
      raw_boxes: pd.rawBoxes,
      margin_scale: scale,
    }),
  })
    .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(new Error(j.error || r.status))))
    .then(j => {
      if (seq !== _tunerSeq) return;            // a newer response already won
      _tunerBoxes = j.regions || [];
      const c = document.getElementById('merge-tuner-count');
      if (c) c.textContent = `${j.count} region${j.count === 1 ? '' : 's'} from ${j.fragment_count} fragments`;
      _drawTunerBoxes();
    })
    .catch(e => toast(`Preview failed: ${e.message}`))
    .finally(() => {
      _tunerBusy = false;
      if (_tunerPending != null) {
        const next = _tunerPending;
        _tunerPending = null;
        if (next !== scale) _requestPreview(next);
      }
    });
}

function _drawTunerBoxes() {
  const overlay = document.getElementById('merge-tuner-overlay');
  const img     = document.getElementById('merge-tuner-img');
  if (!overlay || !img) return;
  // box coords are percentages of page dimensions (same convention as
  // region.box everywhere else), so they map straight onto the rendered
  // image at whatever size it is displayed.
  overlay.innerHTML = _tunerBoxes.map((r, i) => {
    const [x1, y1, x2, y2] = r.box || [0, 0, 0, 0];
    return `<div class="merge-tuner-box" style="
      left:${x1}%;top:${y1}%;width:${Math.max(0, x2 - x1)}%;height:${Math.max(0, y2 - y1)}%">
      <span class="merge-tuner-badge">${i + 1}</span></div>`;
  }).join('');
}
