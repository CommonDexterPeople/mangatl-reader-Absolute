// ═══════════════════════════════════════════════════════════════
// correction-ui.js
// The manual correction UI: drawing/splitting/merging bubble regions,
// per-region retranslation, and its own small local-storage draft cache.
//
// Drag-to-draw / box-render mechanics are shared with the standalone
// Erase Tool via box-overlay.js (createBoxOverlay / _imgPct) — this file
// only owns what's unique to Correction: select/delete/split/merge/reorder
// modes, the vision-draw "replace overlapping region" behaviour, and the
// sidebar/translation logic.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// CORRECTION UI
// ══════════════════════════════════════════════

const _corrMode  = {};  // pageIdx → 'select'|'draw'|'vision-draw'|'delete'|'reorder'
const _corrSelId = {};  // pageIdx → selected region id (or null)
const _corrWork  = {};  // pageIdx → working regions array
const _corrOverlayCtl = {}; // pageIdx → box-overlay controller

// ── Helpers ───────────────────────────────────
function _corrStoreKey(pageIdx)  { return `${_activeChapterId}_${pageIdx}`; }
function _corrLocalKey(pageIdx)  { return `mtl_corr_${_activeChapterId}_${pageIdx}`; }

// A saved draft is only trustworthy for the EXACT region set it was made
// against. Chapter+page alone is not a strong enough key: a MangaDex
// chapter ID can be revisited, a local/Suwayomi source can theoretically
// reuse an id, and — more commonly — the SAME page can get re-OCR'd with
// different settings (source language, Vision toggle, merge-sensitivity
// slider, or just a server-side algorithm change) without the user ever
// touching Correct in between. In every one of those cases the fresh
// region set from the server no longer matches what a stale draft was
// drafted against, but nothing about the chapterId/pageIdx pair changes,
// so a plain existence check on mtl_corr_<chapterId>_<pageIdx> can't tell
// the difference between "my real earlier edits" and "leftover data from
// something else that happens to share this key".
//
// _corrSourceSignature is a cheap fingerprint of the page's CURRENT fresh
// region data (count + concatenated raw OCR text) — recomputed every time
// a draft is saved, and compared every time one is loaded. If a saved
// draft's signature doesn't match the current page's fresh signature, the
// draft is treated as stale and discarded rather than silently trusted.
// This isn't cryptographic — collisions are fine to miss occasionally,
// since correctly rejecting a genuinely-different region set is the goal,
// not tamper-proofing local storage.
function _corrSourceSignature(pd) {
  if (!pd) return '';
  const base = pd.sortedRegions || pd.autoRegions || [];
  // Text, not translation — text is what OCR/merge actually produced and
  // is stable across re-translation; tl can legitimately change (e.g. a
  // different target language) without the underlying regions being stale.
  return `${base.length}|${base.map(r => (r.text || '').trim()).join('\u241F')}`;
}

function _saveCorrections(pageIdx) {
  try {
    const pd  = _pageStore.get(_corrStoreKey(pageIdx));
    const sig = _corrSourceSignature(pd);
    localStorage.setItem(_corrLocalKey(pageIdx),
      JSON.stringify({ regions: _corrWork[pageIdx], savedAt: Date.now(), sourceSig: sig }));
  } catch(e) { console.warn('Could not save corrections', e); }
}

function _loadCorrections(pageIdx) {
  try {
    const raw = localStorage.getItem(_corrLocalKey(pageIdx));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function _initWorkingRegions(pageIdx) {
  const pd  = _pageStore.get(_corrStoreKey(pageIdx));
  const saved = _loadCorrections(pageIdx);

  if (saved?.regions?.length) {
    const currentSig = _corrSourceSignature(pd);
    // sourceSig is undefined on drafts saved before this check existed —
    // treat those as trusted once (grandfathered), rather than discarding
    // every pre-existing user's in-progress edits the moment this ships.
    // Going forward every save carries a real signature, so this
    // grandfather path only ever applies to the one-time transition.
    const staleDraft = saved.sourceSig !== undefined && saved.sourceSig !== currentSig;
    if (staleDraft) {
      console.warn(`Discarding stale correction draft for page ${pageIdx} `
        + `(saved data no longer matches this page's current OCR regions — `
        + `likely a re-OCR, a reused chapter id, or unrelated cached data).`);
      try { localStorage.removeItem(_corrLocalKey(pageIdx)); } catch {}
      // fall through to rebuild from pd below, same as the no-draft case
    } else {
      _corrWork[pageIdx] = JSON.parse(JSON.stringify(saved.regions));
      return;
    }
  }

  if (!pd) { _corrWork[pageIdx] = []; return; }
  // Prefer sortedRegions (translated) over raw autoRegions so the correction
  // sidebar shows real tl values instead of hardcoded '—' for every bubble.
  const base = pd.sortedRegions || pd.autoRegions;
  _corrWork[pageIdx] = base.map((r, i) => ({
    id: i, text: r.text || '', t: r.t || 'speech',
    cx: r.cx, cy: r.cy,
    box: r.box || [r.cx-5, r.cy-5, r.cx+5, r.cy+5],
    rawBoxIds: r.raw_box_ids || [],
    deleted: false, isNew: false, tl: r.tl || '—',
  }));
}

// ── Open / Close ──────────────────────────────
function openCorrection(pageIdx) {
  const card = document.getElementById(`page-${pageIdx}`);
  if (!card) return;
  const pd = _pageStore.get(_corrStoreKey(pageIdx));
  if (!pd) { toast('Translate this page first, then use ✏ CORRECT.'); return; }

  _corrMode[pageIdx]  = 'select';
  _corrSelId[pageIdx] = null;
  _initWorkingRegions(pageIdx);
  card.classList.add('correcting');
  card.querySelector('.btn-correct')?.classList.add('active');
  card.innerHTML = _buildCorrHTML(pageIdx, pd.imgSrc);
  _attachCorrDrawEvents(pageIdx, pd);
  _renderCorrOverlay(pageIdx);
  _updatePendingButton(pageIdx);
}

function closeCorrection(pageIdx) {
  const card = document.getElementById(`page-${pageIdx}`);
  if (!card) return;
  _corrOverlayCtl[pageIdx]?.detach();
  delete _corrOverlayCtl[pageIdx];
  card.classList.remove('correcting');
  const pd = _pageStore.get(_corrStoreKey(pageIdx));
  if (!pd) return;
  // Rebuild normal page view from working (corrected) regions
  const displayRegions = (_corrWork[pageIdx] || [])
    .filter(r => !r.deleted)
    .map(r => ({ t: r.t||'speech', x: r.cx, y: r.cy, box: r.box, tl: r.tl||'—' }));
  renderPage(card, pageIdx, pd.total, pd.imgSrc, displayRegions);
}

// ── HTML builder ──────────────────────────────
function _buildCorrHTML(pageIdx, imgSrc) {
  // Check Flow is a continuity-analysis pass — it judges whether a pronoun
  // matches who's speaking, whether tone holds across lines, etc. That's an
  // inherently LLM reasoning task, not a translation task, so unlike
  // translateBatch/translateSingleWithContext there's no DeepL equivalent
  // to dispatch to here — DeepL has no capability to "read a scene and spot
  // a continuity break" at all, it's a plain string-in/string-out
  // translator. Disabling with a clear reason beats letting the button
  // silently misroute a DeepL key into checkPageFlow()'s /translate call
  // (which has no 'deepl' branch and would fail confusingly).
  const isDeepL = getModelInfo().provider === 'deepl';
  return `
<div class="corr-layout">
  <div class="corr-left">
    <div class="corr-toolbar" id="corr-tb-${pageIdx}">
      <button class="corr-tool active" onclick="setCorrMode(${pageIdx},'select')">SELECT</button>
      <button class="corr-tool" onclick="setCorrMode(${pageIdx},'draw')">＋ DRAW</button>
      <button class="corr-tool" onclick="setCorrMode(${pageIdx},'vision-draw')" id="tb-vision-${pageIdx}" title="Draw a region and re-OCR it with Gemini Vision — replaces overlapping badge text">✦ VISION</button>
      <button class="corr-tool" onclick="setCorrMode(${pageIdx},'delete')">✕ DELETE</button>
      <button class="corr-tool" onclick="setCorrMode(${pageIdx},'reorder')">⇅ ORDER</button>
    </div>
    <div class="corr-img-wrap" id="corr-iw-${pageIdx}">
      <img src="${esc(imgSrc)}" class="corr-img" id="corr-img-${pageIdx}" draggable="false">
      <div class="corr-overlay mode-select" id="corr-ov-${pageIdx}"></div>
    </div>
  </div>
  <div class="corr-sidebar" id="corr-sb-${pageIdx}">
    <div class="corr-empty-hint">Click a region to edit<br>or use ＋ DRAW to add one.</div>
  </div>
</div>
<div class="corr-footer">
  <button class="corr-btn-retrans" id="corr-pending-${pageIdx}" onclick="translatePendingRegions(${pageIdx})"
    title="Translate every region that has no translation yet (drawn/re-read but not yet sent to the AI) in ONE batch call, instead of one call per region">
    ↺ TRANSLATE PENDING (<span id="corr-pending-count-${pageIdx}">0</span>)
  </button>
  <button class="corr-btn-retrans" id="corr-retrans-${pageIdx}" onclick="retranslatePage(${pageIdx})">↺ RE-TRANSLATE ALL</button>
  <button class="corr-btn-retrans" id="corr-checkflow-${pageIdx}" onclick="checkPageFlow(${pageIdx})"
    ${isDeepL ? 'disabled' : ''}
    title="${isDeepL
      ? 'Not available with DeepL — continuity checking (does this pronoun match who\u2019s speaking? does the tone hold across lines?) requires an LLM to reason about the scene. Switch to Gemini or DeepSeek to use Check Flow.'
      : 'One AI call re-reads every translation on this page together and flags lines that break story/dialogue flow'}">
    ✓ CHECK FLOW
  </button>
  <button class="corr-btn-retrans" id="corr-redovision-${pageIdx}" onclick="closeCorrection(${pageIdx}); redoPageWithVision(${pageIdx})"
    title="EasyOCR wrong across the whole page? Discard every region here and redo the page with Gemini Vision OCR only, then retranslate from scratch. Needs a Gemini key.">
    ✦ REDO W/ VISION
  </button>
  <button class="corr-btn-close" onclick="closeCorrection(${pageIdx})">CLOSE</button>
</div>`;
}

/** True if a region has never been translated (still the '—' sentinel) or
 * was cleared back to it — i.e. it needs a translate call before export.
 * Same sentinel _exportRegionsForPage / typeset_page already treat as
 * "nothing to draw", so this is consistent with what export actually does. */
function _isPendingTranslation(r) {
  const tl = (r.tl || '').trim();
  return !tl || tl === '—';
}

/** Update the "TRANSLATE PENDING (N)" button's count + enabled state to
 * match the current working regions. Call after anything that can change
 * how many regions are untranslated (finalize box, delete, split, merge,
 * undo, etc.) — the count would otherwise go stale until the next
 * sidebar/overlay re-render, which don't always coincide with a tl change. */
function _updatePendingButton(pageIdx) {
  const btn = document.getElementById(`corr-pending-${pageIdx}`);
  if (!btn) return;
  let countEl = document.getElementById(`corr-pending-count-${pageIdx}`);
  if (!countEl) {
    // Self-heal: rebuild the span if something ever wipes it out (see the
    // postmortem in translatePendingRegions above) instead of silently
    // giving up on updating this button ever again.
    btn.innerHTML = `↺ TRANSLATE PENDING (<span id="corr-pending-count-${pageIdx}">0</span>)`;
    countEl = document.getElementById(`corr-pending-count-${pageIdx}`);
  }
  const pending = (_corrWork[pageIdx] || []).filter(r => !r.deleted && r.text.trim() && _isPendingTranslation(r));
  countEl.textContent = pending.length;
  btn.disabled = pending.length === 0;
}

// ── Overlay rendering ─────────────────────────
function _renderCorrOverlay(pageIdx) {
  const ov = document.getElementById(`corr-ov-${pageIdx}`);
  if (!ov) return;
  const mode    = _corrMode[pageIdx] || 'select';
  const selId   = _corrSelId[pageIdx];
  const regions = (_corrWork[pageIdx] || []).filter(r => !r.deleted);

  ov.className  = `corr-overlay mode-${mode}`;
  ov.innerHTML  = regions.map((r, vi) => {
    const [x1,y1,x2,y2] = r.box;
    const sel = r.id === selId;
    return `<div class="corr-rbox${sel?' selected':''} mode-${mode}" id="rbox-${pageIdx}-${r.id}"
      style="left:${x1}%;top:${y1}%;width:${x2-x1}%;height:${y2-y1}%" data-id="${r.id}">
      <span class="rbox-num">${vi+1}</span>
    </div>`;
  }).join('');

  ov.querySelectorAll('.corr-rbox').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(el.dataset.id);
      if ((_corrMode[pageIdx]||'select') === 'delete') _deleteCorrRegion(pageIdx, id);
      else _selectCorrRegion(pageIdx, id);
    });
  });
}

// ── Draw mode events ──────────────────────────
// Uses the shared box-overlay controller (box-overlay.js) for the actual
// drag/preview mechanics. What's Correction-specific here is just:
//   - gating drawing behind 'draw'/'vision-draw' mode (isDrawEnabled)
//   - the vision-mode preview tint (previewClassFn)
//   - live-highlighting the region a vision-draw box would replace (onDragMove)
//   - what happens once a box is finalized (onDrawEnd → _finalizeBox)
function _attachCorrDrawEvents(pageIdx, pd) {
  // Detach any controller left over from a previous openCorrection() call —
  // openCorrection() rebuilds card.innerHTML, so the old overlay element is
  // gone and its listeners would otherwise leak on document forever.
  _corrOverlayCtl[pageIdx]?.detach();

  const ctl = createBoxOverlay({
    getImg:    () => document.getElementById(`corr-img-${pageIdx}`),
    getOverlay: () => document.getElementById(`corr-ov-${pageIdx}`),
    isDrawEnabled: () => {
      const m = _corrMode[pageIdx] || 'select';
      return m === 'draw' || m === 'vision-draw';
    },
    previewClassFn: () => (_corrMode[pageIdx] || 'select') === 'vision-draw' ? 'vision-mode' : '',
    onDragMove: box => {
      if ((_corrMode[pageIdx] || 'select') !== 'vision-draw') return;
      const ov = document.getElementById(`corr-ov-${pageIdx}`);
      if (!ov) return;
      const hit = _findOverlappingRegion(pageIdx, box);
      ov.querySelectorAll('.corr-rbox').forEach(el => {
        el.classList.toggle('vision-replace-target', !!hit && parseInt(el.dataset.id) === hit.id);
      });
    },
    onDrawEnd: async box => {
      document.getElementById(`corr-ov-${pageIdx}`)
        ?.querySelectorAll('.vision-replace-target')
        .forEach(el => el.classList.remove('vision-replace-target'));
      const curMode = _corrMode[pageIdx] || 'select';
      await _finalizeBox(pageIdx, box, pd, curMode === 'vision-draw');
    },
  });
  ctl.attach();
  _corrOverlayCtl[pageIdx] = ctl;
}

// ── IoU overlap helpers ───────────────────────
// Returns Intersection-over-Union for two [x1,y1,x2,y2] boxes (% coords).
function _iou(a, b) {
  const ix1=Math.max(a[0],b[0]), iy1=Math.max(a[1],b[1]);
  const ix2=Math.min(a[2],b[2]), iy2=Math.min(a[3],b[3]);
  const inter = Math.max(0,ix2-ix1) * Math.max(0,iy2-iy1);
  if (!inter) return 0;
  const aA=(a[2]-a[0])*(a[3]-a[1]), bA=(b[2]-b[0])*(b[3]-b[1]);
  return inter / (aA + bA - inter);
}

// Find the existing (non-deleted) region whose box most overlaps `box`.
// Returns the region object if IoU > 0.35, else null.
function _findOverlappingRegion(pageIdx, box) {
  const regions = (_corrWork[pageIdx]||[]).filter(r => !r.deleted && r.box);
  let best = null, bestScore = 0.35; // min threshold
  for (const r of regions) {
    const score = _iou(box, r.box);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

async function _finalizeBox(pageIdx, box, pd, useVision = false) {
  const img = document.getElementById(`corr-img-${pageIdx}`);
  if (!img) return;
  const nw=img.naturalWidth, nh=img.naturalHeight;
  const pxBox = [
    Math.round(box[0]/100*nw), Math.round(box[1]/100*nh),
    Math.round(box[2]/100*nw), Math.round(box[3]/100*nh),
  ];
  const sb = document.getElementById(`corr-sb-${pageIdx}`);

  // ── Vision-draw: check for overlapping region FIRST ──────────────────────
  // If the drawn box substantially overlaps an existing region, Vision Draw
  // should REPLACE that region's text (better re-read) rather than stacking
  // a duplicate badge on top of it.
  const overlapping = useVision ? _findOverlappingRegion(pageIdx, box) : null;

  if (sb) sb.innerHTML = `<div class="corr-empty-hint">${
    useVision
      ? (overlapping ? '✦ Re-reading with Gemini Vision…' : '✦ Gemini Vision OCR…')
      : 'Running OCR on selection…'
  }</div>`;

  let ocrText = '';
  if (useVision) {
    // ── /vision-crop — Gemini reads the cropped region ─────────────────────
    // Key source depends on which provider is translating — see
    // ocr-client.js's ocrPage() for the identical reasoning: Vision always
    // calls Gemini regardless of the translator, so under DeepL/DeepSeek
    // mode the Gemini key has to come from the separate vision-ocr-key
    // field instead of the main ai-key field (which holds a non-Gemini key
    // in that case).
    const info    = getModelInfo();
    const needsSeparateVisionKey = info.provider === 'deepl' || info.provider === 'deepseek';
    const key     = info.provider === 'gemini'
      ? (document.getElementById('ai-key')?.value?.trim() || '')
      : needsSeparateVisionKey
      ? (document.getElementById('vision-ocr-key')?.value?.trim() || '')
      : '';
    const modelId = info.provider === 'gemini' ? getModelId() : 'gemini-3.5-flash';
    if (!key) {
      toast(needsSeparateVisionKey
        ? 'Gemini key required for Vision Draw — add one under Vision OCR in Reading Preferences.'
        : 'Gemini API key required for Vision Draw.');
      return;
    }
    try {
      const res = await fetch('/vision-crop', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...(await imageRefBody(pd.cdnUrl)), box: pxBox,
                               lang: pd.sourceLang, ai_key: key, ai_model: modelId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(`Vision crop error: ${err?.description || `HTTP ${res.status}`}`);
      } else {
        const data = await res.json();
        ocrText = data.text || '';
        // data.usage is only present when the server actually got a
        // usageMetadata block back from Gemini (see server.py's
        // vision_crop()) — same shape/condition as ocr-client.js's /ocr
        // handling, so a Vision Draw box counts toward the cost tracker
        // exactly like Vision OCR on a full page already does.
        if (data.usage) {
          recordUsage('vision-crop', data.usage, 'gemini', data.usage_model || modelId);
        }
      }
    } catch(e) { toast(`Vision crop failed: ${e.message}`); }
  } else {
    // ── /ocr-crop — EasyOCR reads the cropped region ───────────────────────
    try {
      const res = await fetch('/ocr-crop', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...(await imageRefBody(pd.cdnUrl)), box: pxBox, lang: pd.sourceLang }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(`OCR crop error: ${err?.description || `HTTP ${res.status}`}`);
      } else {
        const data = await res.json();
        ocrText = data.text || '';
      }
    } catch(e) { toast(`OCR crop failed: ${e.message}`); }
  }

  _corrMode[pageIdx] = 'select';
  _updateToolbar(pageIdx);

  if (useVision && overlapping) {
    // ── REPLACE MODE: update existing region's text in place ────────────────
    // Don't create a new badge — just overwrite the text, and reset tl back
    // to the "pending" sentinel so this region shows up in TRANSLATE PENDING
    // (its old translation was for the old OCR text and no longer applies).
    // The user can draw/fix as many boxes as they want, then translate all
    // of them together in one batch call via ↺ TRANSLATE PENDING — no need
    // to hit a per-region ↺ after every single box.
    overlapping.text = ocrText;
    overlapping.tl   = '—';
    _saveCorrections(pageIdx);
    _renderCorrOverlay(pageIdx);
    _selectCorrRegion(pageIdx, overlapping.id);
    _updatePendingButton(pageIdx);
    const vis = (_corrWork[pageIdx]||[]).filter(r=>!r.deleted).findIndex(r=>r.id===overlapping.id)+1;
    toast(`✦ Vision re-read Region ${vis}${ocrText ? ' — pending translation' : ' (no text detected)'}`);
  } else {
    // ── ADD MODE: create new region (same as original Draw behavior) ────────
    const newId = Date.now();
    const cx=(box[0]+box[2])/2, cy=(box[1]+box[3])/2;
    _corrWork[pageIdx].push({ id:newId, text:ocrText, t:'speech', cx, cy, box, rawBoxIds:[], deleted:false, isNew:true, tl:'—' });
    _renderCorrOverlay(pageIdx);
    _selectCorrRegion(pageIdx, newId);
    _saveCorrections(pageIdx);
    _updatePendingButton(pageIdx);
    if (useVision) toast(`✦ Vision added new region${ocrText ? ' — pending translation' : ' (no text — draw more precisely?)'}`);
  }
}

// ── Select + sidebar ──────────────────────────
function _selectCorrRegion(pageIdx, id) {
  _corrSelId[pageIdx] = id;
  _renderCorrOverlay(pageIdx);
  _renderCorrSidebar(pageIdx);
}

function _renderCorrSidebar(pageIdx) {
  const sb = document.getElementById(`corr-sb-${pageIdx}`);
  if (!sb) return;
  const mode = _corrMode[pageIdx] || 'select';
  if (mode === 'reorder') { _renderReorderSidebar(pageIdx); return; }
  const id = _corrSelId[pageIdx];
  if (id == null) { sb.innerHTML=`<div class="corr-empty-hint">Click a region to edit<br>or use ＋ DRAW to add one.</div>`; return; }
  const regions = _corrWork[pageIdx] || [];
  const r = regions.find(x => x.id === id);
  if (!r) return;
  const vis     = regions.filter(x=>!x.deleted).findIndex(x=>x.id===id)+1;
  const others  = regions.filter(x=>!x.deleted && x.id!==id);
  const canSplit = (r.rawBoxIds||[]).length > 1;
  const mergeOpts = others.map((o,oi)=>{
    const ovi = regions.filter(x=>!x.deleted).findIndex(x=>x.id===o.id)+1;
    return `<option value="${o.id}">Region ${ovi}</option>`;
  }).join('');

  sb.innerHTML = `
    <div class="corr-sid-title">REGION ${vis}</div>
    <div class="corr-sid-label">OCR TEXT</div>
    <textarea class="corr-textarea" id="cta-${pageIdx}-${id}" rows="4">${esc(r.text)}</textarea>
    <div class="corr-sid-label">TYPE</div>
    <select class="corr-type-sel" id="ctype-${pageIdx}-${id}">
      ${['speech','thought','sfx','narration','sign'].map(t=>`<option value="${t}"${r.t===t?' selected':''}>${t}</option>`).join('')}
    </select>
    <div class="corr-action-row">
      ${canSplit?`<button class="corr-action-btn" onclick="_showSplitUI(${pageIdx},${id})">SPLIT</button>`:''}
      ${others.length?`
        <select class="corr-type-sel" id="cmerge-${pageIdx}-${id}" style="flex:1">
          <option value="">Merge with…</option>${mergeOpts}
        </select>
        <button class="corr-action-btn" onclick="_doMerge(${pageIdx},${id})">MERGE</button>`:''}
    </div>
    <button class="corr-action-btn danger" style="width:100%;margin-top:0.5rem" onclick="_deleteCorrRegion(${pageIdx},${id})">DELETE REGION</button>
    <div class="corr-sid-label" style="display:flex;align-items:center;justify-content:space-between">
      TRANSLATION
      <button id="crr-${pageIdx}-${id}" class="corr-action-btn"
        style="padding:0.1rem 0.6rem;font-size:0.75rem;margin:0"
        title="Re-translate this region using the rest of the page as context"
        onclick="retranslateRegion(${pageIdx},${id})">↺</button>
    </div>
    <textarea class="corr-textarea corr-tl-textarea" id="ctl-${pageIdx}-${id}" rows="4"
      title="Edit the translated text directly — this is what gets exported"
      placeholder="—">${esc(r.tl && r.tl !== '—' ? r.tl : '')}</textarea>
    <button class="corr-action-btn" style="width:100%;margin-top:0.4rem"
      title="Add this term to the series glossary, so future pages translate it the same way"
      onclick="_quickAddToGlossary(${pageIdx},${id})">+ ADD TO GLOSSARY</button>`;

  document.getElementById(`cta-${pageIdx}-${id}`)?.addEventListener('input', e=>{
    const reg = (_corrWork[pageIdx]||[]).find(x=>x.id===id);
    if (reg) { reg.text=e.target.value; _saveCorrections(pageIdx); }
    // Deliberately NOT resetting tl to '—' here: unlike the Vision re-read
    // path (a full text replacement), a manual OCR-text tweak is often a
    // small typo fix the person is about to immediately hit per-region ↺
    // on anyway, and forcing every keystroke into "pending" would make the
    // TRANSLATE PENDING count flicker/grow while they're still typing.
  });
  document.getElementById(`ctype-${pageIdx}-${id}`)?.addEventListener('change', e=>{
    const reg = (_corrWork[pageIdx]||[]).find(x=>x.id===id);
    if (reg) { reg.t=e.target.value; _saveCorrections(pageIdx); _renderCorrOverlay(pageIdx); }
  });
  // Direct translation edit — this is the field export.js actually reads
  // (_exportRegionsForPage prefers r.tl from saved corrections). Previously
  // this was a read-only div and the only way to change tl was to hit
  // retranslate, so a manual wording fix here silently never made it into
  // the exported page. Empty input falls back to '—' (the same "nothing to
  // draw" sentinel used everywhere else) rather than an empty string, so a
  // cleared box doesn't get treated as "has a translation" by typeset_page.
  document.getElementById(`ctl-${pageIdx}-${id}`)?.addEventListener('input', e=>{
    const reg = (_corrWork[pageIdx]||[]).find(x=>x.id===id);
    if (reg) { reg.tl = e.target.value.trim() ? e.target.value : '—'; _saveCorrections(pageIdx); }
  });
}

// Quick-add for the Correct UI sidebar's "+ ADD TO GLOSSARY" button. Reads
// the LIVE textarea values (not the closed-over `r` from when the sidebar
// was rendered) so an edit the person just typed but hasn't clicked away
// from yet is what actually gets prefilled — same reasoning the ctl-/cta-
// input listeners above already read e.target.value rather than a stale
// region snapshot. A whole OCR line is rarely the term itself (e.g. "Hey
// there, Yodaka!" vs. just "Yodaka") — prefilled into the modal's inputs
// rather than auto-saved, so the person can trim it down to the actual
// term before it's written to the glossary.
function _quickAddToGlossary(pageIdx, id) {
  const srcEl = document.getElementById(`cta-${pageIdx}-${id}`);
  const tlEl  = document.getElementById(`ctl-${pageIdx}-${id}`);
  openGlossaryModal({ src: srcEl?.value || '', tl: tlEl?.value || '' });
}

// ── Split UI ──────────────────────────────────
function _showSplitUI(pageIdx, regionId) {
  const sb = document.getElementById(`corr-sb-${pageIdx}`);
  if (!sb) return;
  const pd = _pageStore.get(_corrStoreKey(pageIdx));
  const r  = (_corrWork[pageIdx]||[]).find(x=>x.id===regionId);
  if (!r || !pd) return;

  const rawBoxes = (r.rawBoxIds||[]).map(i=>pd.rawBoxes?.[i]).filter(Boolean)
    .sort((a,b)=>a.box[1]-b.box[1]);
  if (rawBoxes.length < 2) { toast('Not enough sub-boxes to split.'); return; }

  // Highlight raw boxes on overlay
  _renderCorrOverlay(pageIdx);
  const ov = document.getElementById(`corr-ov-${pageIdx}`);
  rawBoxes.forEach((b,i)=>{
    const d=document.createElement('div'); d.className='corr-raw-box';
    const [x1,y1,x2,y2]=b.box;
    d.style.cssText=`left:${x1}%;top:${y1}%;width:${x2-x1}%;height:${y2-y1}%`;
    d.innerHTML=`<span class="rbox-num raw">${i+1}</span>`;
    ov?.appendChild(d);
  });

  const items = rawBoxes.map((b,i)=>`
    <div class="corr-split-item">${esc(b.text)}</div>
    ${i<rawBoxes.length-1?`<button class="corr-split-line-btn" onclick="_confirmSplit(${pageIdx},${regionId},${i})">── split here ──</button>`:''}`).join('');

  sb.innerHTML = `
    <div class="corr-sid-title">SPLIT REGION</div>
    <div class="corr-split-list">${items}</div>
    <button class="corr-action-btn" style="margin-top:0.8rem;width:100%" onclick="_selectCorrRegion(${pageIdx},${regionId})">CANCEL</button>`;
}

function _confirmSplit(pageIdx, regionId, splitAfterIdx) {
  const pd = _pageStore.get(_corrStoreKey(pageIdx));
  const regions = _corrWork[pageIdx];
  if (!pd||!regions) return;
  const rIdx = regions.findIndex(x=>x.id===regionId);
  if (rIdx===-1) return;
  const r = regions[rIdx];
  const rawBoxes = (r.rawBoxIds||[]).map(i=>pd.rawBoxes?.[i]).filter(Boolean)
    .sort((a,b)=>a.box[1]-b.box[1]);

  const groupA = rawBoxes.slice(0, splitAfterIdx+1);
  const groupB = rawBoxes.slice(splitAfterIdx+1);
  if (!groupA.length||!groupB.length) return;

  function mkRegion(group, id) {
    const text = group.map(b=>b.text).join(' ');
    const x1=Math.min(...group.map(b=>b.box[0])), y1=Math.min(...group.map(b=>b.box[1]));
    const x2=Math.max(...group.map(b=>b.box[2])), y2=Math.max(...group.map(b=>b.box[3]));
    return { id, text, t:r.t, box:[x1,y1,x2,y2], cx:(x1+x2)/2, cy:(y1+y2)/2,
             rawBoxIds:group.map(b=>b.id??0), deleted:false, isNew:false, tl:'—' };
  }
  regions.splice(rIdx, 1, mkRegion(groupA, r.id), mkRegion(groupB, Date.now()));
  _corrSelId[pageIdx]=null;
  _renderCorrOverlay(pageIdx);
  _renderCorrSidebar(pageIdx);
  _saveCorrections(pageIdx);
  _updatePendingButton(pageIdx);
  toast('Region split.');
}

// ── Merge ─────────────────────────────────────
function _doMerge(pageIdx, regionId) {
  const sel = document.getElementById(`cmerge-${pageIdx}-${regionId}`);
  if (!sel?.value) { toast('Select a region to merge with.'); return; }
  const otherId = parseInt(sel.value);
  const regions = _corrWork[pageIdx];
  if (!regions) return;
  const rA = regions.find(x=>x.id===regionId);
  const rBIdx = regions.findIndex(x=>x.id===otherId);
  const rB = regions[rBIdx];
  if (!rA||!rB) return;
  const allBoxes=[rA.box,rB.box];
  const box=[Math.min(...allBoxes.map(b=>b[0])),Math.min(...allBoxes.map(b=>b[1])),
             Math.max(...allBoxes.map(b=>b[2])),Math.max(...allBoxes.map(b=>b[3]))];
  rA.text=[rA.text,rB.text].filter(Boolean).join(' ');
  rA.tl='—'; // merged text is different from either half's original translation — needs a fresh one
  rA.box=box; rA.cx=(box[0]+box[2])/2; rA.cy=(box[1]+box[3])/2;
  rA.rawBoxIds=[...(rA.rawBoxIds||[]),...(rB.rawBoxIds||[])];
  regions.splice(rBIdx,1);
  _corrSelId[pageIdx]=regionId;
  _renderCorrOverlay(pageIdx); _renderCorrSidebar(pageIdx);
  _saveCorrections(pageIdx); _updatePendingButton(pageIdx);
  toast('Regions merged — pending translation (use ↺ TRANSLATE PENDING).');
}

// ── Delete ────────────────────────────────────
function _deleteCorrRegion(pageIdx, regionId) {
  const regions = _corrWork[pageIdx];
  const r = regions?.find(x=>x.id===regionId);
  if (r) r.deleted=true;
  if (_corrSelId[pageIdx]===regionId) _corrSelId[pageIdx]=null;
  _renderCorrOverlay(pageIdx); _renderCorrSidebar(pageIdx);
  _saveCorrections(pageIdx);
  _updatePendingButton(pageIdx);
}

// ── Reorder sidebar ───────────────────────────
function _renderReorderSidebar(pageIdx) {
  const sb=document.getElementById(`corr-sb-${pageIdx}`); if(!sb) return;
  const regions=(_corrWork[pageIdx]||[]).filter(r=>!r.deleted);
  sb.innerHTML=`
    <div class="corr-sid-title">READING ORDER</div>
    <div class="corr-order-hint">Use ↑↓ to set translation order</div>
    <div class="corr-order-list">${regions.map((r,i)=>`
      <div class="corr-order-item">
        <span class="corr-order-num">${i+1}</span>
        <span class="corr-order-text">${esc(r.text.slice(0,38))}${r.text.length>38?'…':''}</span>
        <div class="corr-order-btns">
          ${i>0?`<button onclick="_reorderReg(${pageIdx},${r.id},-1)">↑</button>`:'<span></span>'}
          ${i<regions.length-1?`<button onclick="_reorderReg(${pageIdx},${r.id},1)">↓</button>`:'<span></span>'}
        </div>
      </div>`).join('')||'<div class="corr-empty-hint">No regions</div>'}
    </div>`;
}

function _reorderReg(pageIdx, regionId, dir) {
  const all=_corrWork[pageIdx]; if(!all) return;
  const active=all.filter(r=>!r.deleted);
  const ci=active.findIndex(r=>r.id===regionId);
  const ni=ci+dir; if(ni<0||ni>=active.length) return;
  const i1=all.findIndex(r=>r.id===active[ci].id);
  const i2=all.findIndex(r=>r.id===active[ni].id);
  [all[i1],all[i2]]=[all[i2],all[i1]];
  _saveCorrections(pageIdx); _renderReorderSidebar(pageIdx); _renderCorrOverlay(pageIdx);
}

// ── Toolbar ───────────────────────────────────
function setCorrMode(pageIdx, mode) {
  _corrMode[pageIdx]=mode; _corrSelId[pageIdx]=null;
  _updateToolbar(pageIdx); _renderCorrOverlay(pageIdx); _renderCorrSidebar(pageIdx);
}

function _updateToolbar(pageIdx) {
  const tb=document.getElementById(`corr-tb-${pageIdx}`); if(!tb) return;
  const mode=_corrMode[pageIdx]||'select';
  const map={select:'SELECT',draw:'DRAW','vision-draw':'VISION',delete:'DELETE',reorder:'ORDER'};
  tb.querySelectorAll('.corr-tool').forEach(btn=>{
    btn.classList.toggle('active', btn.textContent.trim().startsWith(map[mode]));
  });
  // Disable Vision button if no Gemini key is configured
  const vBtn = document.getElementById(`tb-vision-${pageIdx}`);
  if (vBtn) {
    const hasKey = !!(document.getElementById('ai-key')?.value?.trim());
    vBtn.disabled = !hasKey;
    vBtn.title = hasKey
      ? 'Draw a region and re-OCR it with Gemini Vision — replaces overlapping badge text'
      : 'Gemini API key required for Vision Draw';
  }
}

// ── Re-translate ──────────────────────────────
// ── Single-region retranslation with page context ────────────────────────────
// Sends ONE bubble to the AI but includes the rest of the page's already-
// translated regions as context so pronouns, names, and register stay consistent.
//
// CATCH: if the existing translations contain errors they will feed back as context.
// Recommended workflow: fix global/systemic errors with full-page ↺ RE-TRANSLATE
// first, then use the per-bubble ↺ to fine-tune individual regions.

async function translateSingleWithContext(region, contextRegions, sourceLang, targetLang) {
  const key     = document.getElementById('ai-key').value.trim();
  const info    = getModelInfo();
  const modelId = getModelId();
  if (!key) throw new Error(`${info.label} API key not set.`);

  // DeepL branch — same reasoning as translateBatchDeepL(): DeepL is not
  // an LLM, so the page-context/system-prompt/classification machinery
  // below this point doesn't apply to it at all. Context lines exist to
  // help an LLM keep names/pronouns/register consistent across a page —
  // DeepL has no way to consume that kind of freeform instruction, it only
  // takes a string and returns a translated string. This is the single-
  // region equivalent of translateBatchDeepL(), reusing the same target-
  // language validation (throws the same clear "DeepL doesn't support
  // this language" error rather than sending a request DeepL would reject).
  if (info.provider === 'deepl') {
    const deepLTarget = _DEEPL_TARGET_LANG_MAP[targetLang];
    if (!deepLTarget) {
      throw new Error(
        `DeepL doesn't support "${targetLang}" as a target language. ` +
        `Switch to Gemini or DeepSeek for this language, or pick a different target language.`
      );
    }
    const res = await fetch('/translate-deepl', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key, texts: [region.text],
        target_lang: deepLTarget, source_lang: sourceLang,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.description || err?.message || `DeepL error ${res.status}`);
    }
    const data = await res.json();
    recordUsage('translate', null, 'deepl', 'deepl', 0, 0, region.text.length);
    return { tl: (data.translations || [])[0] || '—', t: 'speech' };
  }

  // Build context from nearby already-translated, non-deleted regions.
  // Using the 8 closest neighbours by vertical position (cy) rather than the
  // full page keeps the context payload tight while still covering every bubble
  // in the same panel or the panels immediately above/below.
  // Exclude em-dash '—' (never translated) and hyphen '-' (AI noise-skip)
  // so those stubs don't teach the model that '-' is a valid translation style.
  const ctxLines = contextRegions
    .filter(r => r.tl && r.tl !== '—' && r.tl !== '-' && r.id !== region.id)
    .sort((a, b) => Math.abs(a.cy - region.cy) - Math.abs(b.cy - region.cy))
    .slice(0, 8)                                     // nearest 8 neighbours
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)     // restore reading order
    .map(r => `[${r.t ?? 'speech'}] ${r.text} → ${r.tl}`)
    .join('\n');

  const userMsg = (ctxLines
    ? `PAGE CONTEXT (already translated — use for consistency in names, pronouns, register):\n${ctxLines}\n\n`
    : '') +
    `RETRANSLATE THIS REGION:\n${JSON.stringify({ text: region.text, cx: region.cx, cy: region.cy })}`;

  const res = await fetch('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider:    info.provider,
      key,
      source_lang: sourceLang,
      // DeepSeek only — see server.py's /translate docstring. This call's
      // prompt asks for a bare {"tl":...,"t":...} object, not the
      // {"translations":[...]} shape the server's rescue defaults to, so
      // without this, a thinking-mode response that lands in
      // reasoning_content instead of content could never be rescued and
      // always 422'd instead.
      rescue_key: 'tl',
      payload: {
        model:       modelId,
        temperature: 0.3,
        max_tokens:  800,
        ...(info.provider === 'deepseek' ? {
          response_format: { type: 'json_object' },
          // DeepSeek V4 models default to thinking mode ON. That's fine for
          // the full-page batch call (translateBatch, 8000-token budget —
          // plenty of room for a reasoning pass AND the JSON answer), but
          // this single-region call's 800-token budget is sized for a
          // plain translate+classify, not a reasoning pass first — thinking
          // mode routinely ate the whole budget before ever writing the
          // final JSON to `content`, leaving content empty. rescue_key above
          // is a safety net for whenever that still happens; explicitly
          // disabling thinking here (mirrors _translate_gemini's
          // thinkingBudget:0 for the same reason) stops it from happening
          // in the first place for a task this simple.
          thinking: { type: 'disabled' },
        } : {}),
        messages: [
          {
            role: 'system',
            content:
              `You are a manga translation expert. Re-translate ONE text region from ` +
              `${getLangName(sourceLang)} to ${targetLang}.\n` +
              `Use the page context to keep character names, pronouns, and speech register consistent.\n` +
              `Classify the text type: speech | thought | sfx | narration | sign.\n\n` +
              `SFX RULE: If the text is a sound effect or onomatopoeia — even if it is in a different ` +
              `script (e.g. Japanese kana in a Vietnamese chapter) — translate or adapt it as a brief ` +
              `English sound effect wrapped in asterisks (e.g. *CRASH*, *Sigh*, *Rumble*, *Screaming*). ` +
              `Do NOT skip it.\n` +
              `IMPORTANT: NEVER return "-" as the translation. Always provide your best-effort ` +
              `translation. If the text is ambiguous, romanise it or describe it (e.g. *aaah*, ` +
              `*laughter*). A "-" response is never acceptable here.\n` +
              `Return ONLY a JSON object: {"tl":"translated text","t":"type"}\n` +
              `No markdown fences, no explanation, no extra keys.`,
          },
          { role: 'user', content: userMsg },
        ],
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `${info.label} error ${res.status}`);
  }

  const data  = await res.json();
  const raw   = data.choices?.[0]?.message?.content ?? '';
  const clean = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(clean);
    return {
      tl: String(parsed.tl ?? parsed.text ?? '—'),
      t:  VALID_TEXT_TYPES.has(parsed.t) ? parsed.t : 'speech',
    };
  } catch { return { tl: '—', t: 'speech' }; }
}

async function retranslateRegion(pageIdx, id) {
  const btn = document.getElementById(`crr-${pageIdx}-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const pd = _pageStore.get(_corrStoreKey(pageIdx));
  if (!pd) {
    toast('No page data.');
    if (btn) { btn.disabled = false; btn.textContent = '↺'; }
    return;
  }
  const regions = (_corrWork[pageIdx] || []).filter(r => !r.deleted);
  const target  = regions.find(r => r.id === id);
  if (!target) { if (btn) { btn.disabled = false; btn.textContent = '↺'; } return; }
  try {
    const result = await translateSingleWithContext(target, regions, pd.sourceLang, getTargetLang());
    target.tl = result.tl;
    target.t  = result.t;
    _saveCorrections(pageIdx);
    // Re-render sidebar AND overlay — the type may have changed (e.g. speech→sfx),
    // so the badge colour on the image needs to update too.
    _renderCorrSidebar(pageIdx);
    _renderCorrOverlay(pageIdx);
    _updatePendingButton(pageIdx);
    toast('Region re-translated.');
  } catch (e) { toast(`Translation failed: ${e.message}`); }
  if (btn) { btn.disabled = false; btn.textContent = '↺'; }
}

// ── Batch-translate every pending (untranslated) region in ONE call ─────────
// This is the point of ↺ TRANSLATE PENDING: draw/re-read as many boxes as
// you want with ✦ VISION first (each finalize call only OCRs — see
// _finalizeBox — it never translates), THEN hit this once. One /translate
// call handles all of them together instead of one call per box, which
// both saves API calls and gives the model the other pending regions'
// cx/cy as context for reading order (same mechanism translateBatch always
// uses) rather than translating each in total isolation.
//
// Deliberately reuses translateBatch (whole-page-shaped context) rather
// than translateSingleWithContext (single-region + up-to-8-neighbour
// context) — pending regions are usually clustered fixes for one problem
// area of the page, so letting the model see them as one connected batch
// is more useful here than the neighbour-sampling approach that per-region
// ↺ uses for a single already-isolated retranslation.
async function translatePendingRegions(pageIdx) {
  const btn = document.getElementById(`corr-pending-${pageIdx}`);
  const pd  = _pageStore.get(_corrStoreKey(pageIdx));
  if (!pd) { toast('No page data.'); return; }

  const allActive = (_corrWork[pageIdx] || []).filter(r => !r.deleted);
  const pending    = allActive.filter(r => r.text.trim() && _isPendingTranslation(r));
  if (!pending.length) { toast('Nothing pending — every region already has a translation.'); return; }

  // IMPORTANT: never set btn.textContent here — it destroys the
  // <span id="corr-pending-count-${pageIdx}"> living inside the button,
  // which makes every future _updatePendingButton() call silently no-op
  // (see its `if (!countEl || !btn) return;` guard) since it can never find
  // that span again. Use innerHTML with the span rebuilt in place instead,
  // so the displayed count doesn't get permanently stuck.
  if (btn) { btn.disabled = true; btn.innerHTML = `Translating ${pending.length}…`; }
  try {
    const targetLang = getTargetLang();
    const ocrLike = pending.map(r => ({ text: r.text, cx: r.cx, cy: r.cy }));
    const translated = await translateBatch(ocrLike, pd.sourceLang, targetLang);
    pending.forEach((r, j) => {
      r.tl = translated[j]?.tl || '—';
      r.t  = translated[j]?.t  || r.t;
    });
    _saveCorrections(pageIdx);
    _renderCorrOverlay(pageIdx);   // badge colours may have changed (type reclassified)
    const sid = _corrSelId[pageIdx];
    if (sid != null) _renderCorrSidebar(pageIdx);
    toast(`Translated ${pending.length} pending region${pending.length !== 1 ? 's' : ''}.`);
  } catch (e) {
    toast(`Translation failed: ${e.message}`);
  }
  if (btn) btn.innerHTML = `↺ TRANSLATE PENDING (<span id="corr-pending-count-${pageIdx}">0</span>)`;
  _updatePendingButton(pageIdx);
}

async function retranslatePage(pageIdx) {
  const btn=document.getElementById(`corr-retrans-${pageIdx}`);
  if(btn){btn.disabled=true; btn.textContent='Translating…';}
  const pd=_pageStore.get(_corrStoreKey(pageIdx));
  if(!pd){toast('No page data.');if(btn){btn.disabled=false;btn.textContent='↺ RE-TRANSLATE ALL';} return;}
  const targetLang=getTargetLang();
  const working=(_corrWork[pageIdx]||[]).filter(r=>!r.deleted&&r.text.trim());
  if(!working.length){toast('No regions to translate.');if(btn){btn.disabled=false;btn.textContent='↺ RE-TRANSLATE ALL';} return;}
  try {
    const ocrLike=working.map(r=>({text:r.text,cx:r.cx,cy:r.cy}));
    const translated=await translateBatch(ocrLike,pd.sourceLang,targetLang);
    working.forEach((r,j)=>{ r.tl=translated[j]?.tl||'—'; r.t=translated[j]?.t||r.t; });
    _saveCorrections(pageIdx);
    const sid=_corrSelId[pageIdx]; if(sid!=null) _renderCorrSidebar(pageIdx);
    _updatePendingButton(pageIdx);
    toast('Page re-translated.');
  } catch(e){ toast(`Translation failed: ${e.message}`); }
  if(btn){btn.disabled=false; btn.textContent='↺ RE-TRANSLATE ALL';}
}

// ══════════════════════════════════════════════════════════════════════════
// CHECK FLOW — one AI call re-reads every translation on the page TOGETHER
// (not one region at a time) and flags any line that breaks story/dialogue
// continuity: a pronoun that doesn't match who's speaking, a reply that
// doesn't follow from the line before it, inconsistent terminology, tone
// that suddenly shifts mid-conversation, etc.
//
// Deliberately manual (button-triggered), not automatic after every
// translate/re-translate: translateBatch/retranslatePage already send the
// whole page in one call with cx/cy for reading order, so a lot of "flow"
// is already accounted for in the first pass — Check Flow is a second,
// dedicated read specifically hunting for continuity problems, and costs
// an extra API call every time it runs. Running it only when asked keeps
// that cost opt-in rather than doubling the call count on every page by
// default.
// ══════════════════════════════════════════════════════════════════════════
async function checkPageFlow(pageIdx) {
  const btn = document.getElementById(`corr-checkflow-${pageIdx}`);
  const pd  = _pageStore.get(_corrStoreKey(pageIdx));
  if (!pd) { toast('No page data.'); return; }

  const working = (_corrWork[pageIdx] || []).filter(r => !r.deleted && r.text.trim());
  const translatedRegions = working.filter(r => r.tl && r.tl !== '—' && r.tl !== '-');
  if (translatedRegions.length < 2) {
    toast('Need at least 2 translated regions to check flow between them.');
    return;
  }

  const key     = document.getElementById('ai-key')?.value?.trim();
  const info    = getModelInfo();
  const modelId = getModelId();
  if (!key) { toast(`${info.label} API key not set.`); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    // Reading order matches what the page already shows (cy then cx) — the
    // model should judge flow the same way a reader encounters it, not in
    // whatever order regions happen to sit in _corrWork.
    const ordered = [...translatedRegions].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const items = ordered.map((r, i) => ({
      i, t: r.t || 'speech', cx: Math.round(r.cx), cy: Math.round(r.cy),
      src: r.text, tl: r.tl,
    }));

    const res = await fetch('/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: info.provider,
        key,
        source_lang: pd.sourceLang,
        // DeepSeek only — this prompt's top-level JSON key is "issues", not
        // the server's "translations" default; see server.py's /translate
        // docstring and translateSingleWithContext's identical fix above.
        rescue_key: 'issues',
        payload: {
          model: modelId,
          temperature: 0.2,
          max_tokens: 3000,
          ...(info.provider === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            {
              role: 'system',
              content:
                `You are a manga localization editor doing a continuity pass. Below is one full page's ` +
                `worth of text regions IN READING ORDER, each with its original ${getLangName(pd.sourceLang)} ` +
                `text (src) and its current ${getTargetLang()} translation (tl).\n\n` +
                `Read them as one connected sequence — the same conversation/scene — and find lines whose ` +
                `translation breaks the flow: a reply that doesn't follow from the line before it, a pronoun ` +
                `or name that doesn't match who's speaking, a tone/register that jars against neighbouring ` +
                `lines, or terminology that's inconsistent with how it was translated elsewhere on this page.\n\n` +
                `Do NOT flag a line just because you'd phrase it differently — only flag genuine continuity ` +
                `breaks that would confuse a reader following the scene. Most pages should have FEW or ZERO ` +
                `flagged lines; if the page reads fine, return an empty array.\n\n` +
                `For each flagged line, return its original i, a corrected "tl" that fixes the continuity ` +
                `problem while staying faithful to "src", and a short "why" (one sentence, for a human to ` +
                `read before approving the change).\n\n` +
                `Return ONLY a JSON object: {"issues":[{"i":0,"tl":"corrected text","why":"reason"}]}\n` +
                `No markdown fences, no explanation outside the JSON, no extra keys.`,
            },
            { role: 'user', content: JSON.stringify(items) },
          ],
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `${info.label} error ${res.status}`);
    }

    const data  = await res.json();
    const raw   = data.choices?.[0]?.message?.content ?? '';
    const clean = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
    if (!clean) throw new Error(`${info.label} returned an empty response.`);

    // Same tolerant multi-strategy recovery translateBatch uses — thinking
    // models can leak reasoning text before the JSON object.
    let parsed = null;
    try {
      const top = JSON.parse(clean);
      parsed = Array.isArray(top?.issues) ? top.issues : (Array.isArray(top) ? top : null);
    } catch {}
    if (!parsed) {
      const idx = clean.lastIndexOf('"issues"');
      if (idx >= 0) {
        const braceIdx = clean.lastIndexOf('{', idx);
        if (braceIdx >= 0) {
          try { const t2 = JSON.parse(clean.slice(braceIdx)); if (Array.isArray(t2?.issues)) parsed = t2.issues; } catch {}
        }
      }
    }
    if (!parsed) {
      const m = clean.match(/\[[\s\S]*\]/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) throw new Error('Could not parse the flow-check response as JSON. Try again.');

    const issues = parsed
      .map(it => {
        const iStr = String(it?.i ?? '').trim();
        if (!/^\d+$/.test(iStr)) return null;
        const idx = parseInt(iStr, 10);
        if (idx < 0 || idx >= ordered.length) return null;
        const newTl = String(it?.tl ?? '').trim();
        if (!newTl) return null;
        const region = ordered[idx];
        if (newTl === region.tl) return null; // model "flagged" it but proposed no actual change
        return { region, oldTl: region.tl, newTl, why: String(it?.why ?? '').trim() };
      })
      .filter(Boolean);

    if (!issues.length) {
      toast('✓ Flow check passed — no continuity issues found.');
    } else {
      _showFlowIssuesModal(pageIdx, issues);
    }
  } catch (e) {
    toast(`Flow check failed: ${e.message}`);
  }
  if (btn) { btn.disabled = false; btn.textContent = '✓ CHECK FLOW'; }
}

/**
 * Diff-preview modal for Check Flow results: lists each flagged region's
 * old → new translation with the model's stated reason, and a single
 * "Apply all" action (per the chosen UX — batch approve rather than
 * per-line checkboxes, since flagged counts are expected to be small).
 */
function _showFlowIssuesModal(pageIdx, issues) {
  const existing = document.getElementById('flow-issues-modal');
  if (existing) existing.remove();

  const rowsHtml = issues.map((it, i) => `
    <div class="flow-issue-row">
      <div class="flow-issue-why">${esc(it.why || 'Continuity issue')}</div>
      <div class="flow-issue-diff">
        <div class="flow-issue-old"><span class="flow-issue-tag">was</span> ${esc(it.oldTl)}</div>
        <div class="flow-issue-new"><span class="flow-issue-tag">→</span> ${esc(it.newTl)}</div>
      </div>
    </div>`).join('');

  const modal = document.createElement('div');
  modal.id = 'flow-issues-modal';
  modal.className = 'flow-modal-backdrop';
  modal.innerHTML = `
    <div class="flow-modal">
      <div class="flow-modal-hdr">
        <span>✓ CHECK FLOW — ${issues.length} issue${issues.length !== 1 ? 's' : ''} found</span>
        <button class="flow-modal-close" onclick="document.getElementById('flow-issues-modal').remove()">✕</button>
      </div>
      <div class="flow-modal-body">${rowsHtml}</div>
      <div class="flow-modal-footer">
        <button class="corr-btn-close" onclick="document.getElementById('flow-issues-modal').remove()">DISMISS</button>
        <button class="corr-btn-retrans" onclick="_applyFlowIssues(${pageIdx})">✓ APPLY ALL</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  _pendingFlowIssues = issues;
}

let _pendingFlowIssues = null;

function _applyFlowIssues(pageIdx) {
  if (!_pendingFlowIssues) return;
  _pendingFlowIssues.forEach(it => { it.region.tl = it.newTl; });
  const count = _pendingFlowIssues.length;
  _pendingFlowIssues = null;
  document.getElementById('flow-issues-modal')?.remove();
  _saveCorrections(pageIdx);
  const sid = _corrSelId[pageIdx];
  if (sid != null) _renderCorrSidebar(pageIdx);
  _renderCorrOverlay(pageIdx);
  toast(`Applied ${count} flow fix${count !== 1 ? 'es' : ''}.`);
}
