// ═══════════════════════════════════════════════════════════════
// page-render.js
// Rendering a single page: skeleton placeholder, bubble overlay render,
// and the retry-on-error path.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════
function addSkeleton(i) {
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
function renderPageDisplay(el, pageIdx, total, imgSrc) {
  el.innerHTML = `
    <div class="img-wrap">
      <img src="${esc(imgSrc)}" class="page-img page-img-only"
           loading="lazy" alt="Page ${pageIdx + 1}">
      <div class="pg-label">${pageIdx + 1} / ${total}</div>
    </div>`;
}

// Full render: image + numbered badges + translation panel
function renderPage(el, pageIdx, total, imgSrc, regions) {
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
function renderPageError(el, pageIdx, total, cdnUrl, imgSrc, errMsg, sourceLang) {
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

// FIX #2: regions now use translated[j].t for type (was always hardcoded 'speech')
// FIX #12: uses cdnUrl for OCR, imgSrc for display
async function retryPage(btn, el, pageIdx, total, cdnUrl, imgSrc, sourceLang) {
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
async function _ocrTranslateAndRenderPage(el, pageIdx, total, cdnUrl, imgSrc, sourceLang, visionModeOverride) {
  const targetLang = getTargetLang();
  const ocrData    = await ocrPage(cdnUrl, sourceLang, undefined, visionModeOverride);
  const ocrResult  = ocrData.regions;
  if (ocrData.visionFallback) {
    const msgs = { quota: 'Gemini quota hit', error: 'Gemini Vision error', network: 'Network error', parse: 'Vision response unreadable' };
    toast(`⚠ ${msgs[ocrData.visionFallback] ?? 'Vision OCR error'} — used EasyOCR as fallback.`);
  }
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
// from scratch in one batch call. Requires a Gemini key — DeepSeek-only
// users have no Vision OCR available server-side (see server.py's /ocr
// route: ai_key is only ever sent when provider === 'gemini').
// ══════════════════════════════════════════════
async function redoPageWithVision(pageIdx) {
  const info = getModelInfo();
  if (info.provider !== 'gemini') {
    toast('Redo with Vision needs a Gemini API key/model — switch AI Model to a Gemini option first.');
    return;
  }
  const key = document.getElementById('ai-key')?.value?.trim();
  if (!key) { toast('Enter your Gemini API key first.'); return; }

  const pd = _pageStore.get(`${_activeChapterId}_${pageIdx}`);
  if (!pd) { toast('No page data for this page yet.'); return; }

  const el  = document.getElementById(`page-${pageIdx}`);
  const btn = el?.querySelector('.btn-redo-vision');
  if (btn) { btn.disabled = true; btn.textContent = '✦ Redoing…'; }

  try {
    const { regions } = await _ocrTranslateAndRenderPage(
      el, pageIdx, pd.total, pd.cdnUrl, pd.imgSrc, pd.sourceLang, 'all'
    );
    // Clear any saved ✏ CORRECT edits for this page — they were corrections
    // against the OLD (EasyOCR) region set, which no longer exists, so
    // keeping them around would silently resurrect stale boxes the next
    // time this page is opened in the correction UI.
    try { localStorage.removeItem(`mtl_corr_${_activeChapterId}_${pageIdx}`); } catch {}
    toast(regions.length
      ? `Redone with Vision — ${regions.length} region(s).`
      : 'Vision found no text on this page.');
  } catch (err) {
    toast(`Redo with Vision failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '✦ Redo w/ Vision'; }
  }
}

