// ═══════════════════════════════════════════════════════════════
// reorder-ui.js
// Manual reading-order UI: the reorder panel and drag-to-reorder handling.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
(function init() {
  // FIX #9: check the proxy is actually running; show a persistent warning if not
  fetch('/health')
    .then(r => { if (!r.ok) throw new Error(); })
    .catch(() => toast('⚠ Proxy not detected — run manga_proxy.py first.', 15000));

  // Restore badge reading order preference
  const savedOrder = localStorage.getItem('mtl_read_order') || 'auto-rtl';
  setReadOrder(savedOrder);

  // Populate cache info on home screen
  refreshCacheUI();

  // Populate Continue Reading card / recent list on home screen
  _renderHistoryUI();

  // Restore MangaDex login state (lives in mangadex-auth.js, next to the
  // _md* state it writes — see restoreMdAuthFromStorage()'s comment).
  restoreMdAuthFromStorage();


  const legacyKey = localStorage.getItem('mtl_ai_key');
  if (legacyKey) {
    const isGemini = legacyKey.startsWith('AIza');
    localStorage.setItem(isGemini ? 'mtl_key_gemini' : 'mtl_key_deepseek', legacyKey);
    localStorage.removeItem('mtl_ai_key');
  }

  const savedModel = localStorage.getItem('mtl_ai_model');
  if (savedModel && document.querySelector(`#ai-model option[value="${savedModel}"]`)) {
    document.getElementById('ai-model').value = savedModel;
  }
  onModelChange();  // restores per-provider key + syncs placeholder + hint + vision group visibility

  // Restore the Vision-OCR-specific Gemini key (only relevant/visible when
  // DeepL is the active translator — see onModelChange()'s vision-ocr-key-wrap
  // toggle). Single persisted value, not per-provider like mtl_key_${provider}
  // above, since this key's whole purpose is to stay available regardless of
  // which translator is selected.
  const savedVisionKey = localStorage.getItem('mtl_vision_ocr_key');
  const visionKeyEl = document.getElementById('vision-ocr-key');
  if (visionKeyEl && savedVisionKey) {
    visionKeyEl.value = savedVisionKey;
  }

  // Restore Vision OCR mode — must run AFTER onModelChange so the select exists and is visible
  const savedVisionMode = localStorage.getItem('mtl_vision_mode');
  const visionEl = document.getElementById('vision-ocr-mode');
  if (visionEl && savedVisionMode) {
    visionEl.value = savedVisionMode;
  }

  // Restore local OCR engine choice (EasyOCR/RapidOCR) — same restore
  // pattern as Vision OCR mode above, independent setting.
  const savedLocalEngine = localStorage.getItem('mtl_local_ocr_engine');
  const localEngineEl = document.getElementById('local-ocr-engine');
  if (localEngineEl && savedLocalEngine) {
    localEngineEl.value = savedLocalEngine;
  }

  const savedScale = localStorage.getItem('mtl_merge_scale');
  if (savedScale) {
    document.getElementById('merge-scale').value = savedScale;
    document.getElementById('merge-scale-val').textContent = parseFloat(savedScale).toFixed(2);
  }
  document.getElementById('merge-scale').addEventListener('change', () => {
    localStorage.setItem('mtl_merge_scale', document.getElementById('merge-scale').value);
  });

  // Restore saved target language
  const savedTargetLang = localStorage.getItem('mtl_target_lang');
  if (savedTargetLang) {
    const sel = document.getElementById('target-lang');
    const exists = Array.from(sel.options).some(o => o.value === savedTargetLang);
    if (exists) {
      sel.value = savedTargetLang;
      onTargetLangChange();
    } else if (savedTargetLang !== '__custom__') {
      // Legacy plain-text value — put it in the custom field
      sel.value = '__custom__';
      document.getElementById('target-lang-custom').value = savedTargetLang;
      document.getElementById('target-lang-custom').style.display = 'block';
    }
  }

  document.getElementById('ai-key').addEventListener('blur', () => {
    const keyEl = document.getElementById('ai-key');
    const provider = keyEl.dataset.provider || getModelInfo().provider;
    const val = keyEl.value.trim();
    if (val) localStorage.setItem(`mtl_key_${provider}`, val);
  });

  document.getElementById('target-lang-custom').addEventListener('input', () => {
    localStorage.setItem('mtl_target_lang_custom', document.getElementById('target-lang-custom').value.trim());
  });

  document.getElementById('chapter-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') startPipeline();
  });
})();

// ══════════════════════════════════════════════
// MANUAL BADGE REORDER  (per-page drag UI)
// ══════════════════════════════════════════════

function toggleReorderPanel(pageIdx) {
  const panel = document.getElementById(`reorder-panel-${pageIdx}`);
  const btn   = document.getElementById(`ro-btn-${pageIdx}`);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  if (isOpen) {
    panel.style.display = 'none';
    btn?.classList.remove('active');
  } else {
    _renderReorderPage(pageIdx);
    panel.style.display = 'block';
    btn?.classList.add('active');
  }
}

function _renderReorderPage(pageIdx) {
  const panel = document.getElementById(`reorder-panel-${pageIdx}`);
  if (!panel) return;
  const card = document.getElementById(`page-${pageIdx}`);
  const regions = card?._regions || [];
  const moKey = `${_activeChapterId}_${pageIdx}`;
  const order = _manualOrder.get(moKey) || regions.map((_, i) => i);

  const items = order.map((origIdx, pos) => {
    const r = regions[origIdx] || {};
    const tag = (r.t || 'speech').toLowerCase();
    const preview = (r.tl || '—').slice(0, 48) + ((r.tl || '').length > 48 ? '…' : '');
    return `<li class="reorder-item" draggable="true"
                data-pos="${pos}" data-orig="${origIdx}">
      <span class="reorder-drag-handle" title="Drag to reorder">⠿</span>
      <span class="reorder-badge-num t-${tag}">${pos + 1}</span>
      <span class="reorder-item-text" title="${esc(r.tl || '—')}">${esc(preview)}</span>
      <div class="reorder-arrow-btns">
        <button onclick="_roMove(${pageIdx},${pos},-1)" ${pos === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button onclick="_roMove(${pageIdx},${pos},1)"  ${pos === order.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      </div>
    </li>`;
  }).join('');

  panel.innerHTML = `
    <div class="reorder-panel-hdr">
      <span class="reorder-panel-title">⇅ Badge Reading Order</span>
      <span class="reorder-hint">Drag or use ↑↓ — badge 1 reads first</span>
    </div>
    <ul class="reorder-list" id="ro-list-${pageIdx}">${items}</ul>
    <button class="btn-apply-order" onclick="_applyReorder(${pageIdx})">✓ APPLY ORDER</button>`;

  _initDragReorder(pageIdx);
}

function _roMove(pageIdx, pos, dir) {
  const moKey  = `${_activeChapterId}_${pageIdx}`;
  const card   = document.getElementById(`page-${pageIdx}`);
  const regions = card?._regions || [];
  const order  = [...(_manualOrder.get(moKey) || regions.map((_, i) => i))];
  const newPos = pos + dir;
  if (newPos < 0 || newPos >= order.length) return;
  [order[pos], order[newPos]] = [order[newPos], order[pos]];
  _manualOrder.set(moKey, order);
  _renderReorderPage(pageIdx);
  // Keep panel open
  const panel = document.getElementById(`reorder-panel-${pageIdx}`);
  if (panel) panel.style.display = 'block';
}

function _applyReorder(pageIdx) {
  const moKey  = `${_activeChapterId}_${pageIdx}`;
  const card   = document.getElementById(`page-${pageIdx}`);
  const regions = card?._regions || [];
  const order  = _manualOrder.get(moKey) || regions.map((_, i) => i);

  // Re-render the translation panel with new order
  const transPanelEl = document.getElementById(`trans-panel-${pageIdx}`);
  const imgWrap = card?.querySelector('.img-wrap');
  if (!transPanelEl || !imgWrap) return;

  // Update badge numbers on image
  const badges = imgWrap.querySelectorAll('.badge');
  // Rebuild badge map: origIdx -> badge element
  const badgeByOrig = {};
  Array.from(badges).forEach((b, i) => { badgeByOrig[i] = b; });
  // Re-number badges per new order (data-ridx tracks POSITION, same as
  // before reorder — only the visible number + row pairing changes)
  order.forEach((origIdx, newPos) => {
    const b = badgeByOrig[origIdx];
    if (b) { b.textContent = String(newPos + 1); b.dataset.ridx = String(newPos); }
  });

  // Rebuild translation rows
  let rowsHtml = '';
  order.forEach((origIdx, newPos) => {
    const r = regions[origIdx] || {};
    const tag = (r.t || 'speech').toLowerCase();
    rowsHtml += `<div class="t-row" data-ridx="${newPos}">
      <span class="t-num">${newPos + 1}</span>
      <span class="t-tag ${tag}">${tag}</span>
      <span class="t-text">${esc(r.tl || '—')}</span>
    </div>`;
  });
  transPanelEl.innerHTML = rowsHtml;
  // (trans-rail.js's MutationObserver on the page card catches this
  // innerHTML rewrite automatically and re-syncs the sidebar — no
  // explicit call needed.)

  toast('Badge order updated ✓');
  // Close panel
  const panel = document.getElementById(`reorder-panel-${pageIdx}`);
  if (panel) panel.style.display = 'none';
  document.getElementById(`ro-btn-${pageIdx}`)?.classList.remove('active');
}

function _initDragReorder(pageIdx) {
  const list = document.getElementById(`ro-list-${pageIdx}`);
  if (!list) return;
  let draggedItem = null;

  list.addEventListener('dragstart', e => {
    draggedItem = e.target.closest('.reorder-item');
    if (draggedItem) {
      draggedItem.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  list.addEventListener('dragend', () => {
    draggedItem?.classList.remove('dragging');
    list.querySelectorAll('.reorder-item').forEach(i => i.classList.remove('drag-over'));
    draggedItem = null;
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('.reorder-item');
    if (!target || target === draggedItem) return;
    list.querySelectorAll('.reorder-item').forEach(i => i.classList.remove('drag-over'));
    target.classList.add('drag-over');
  });
  list.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('.reorder-item');
    if (!target || !draggedItem || target === draggedItem) return;
    const fromPos = +draggedItem.dataset.pos;
    const toPos   = +target.dataset.pos;

    const moKey   = `${_activeChapterId}_${pageIdx}`;
    const card    = document.getElementById(`page-${pageIdx}`);
    const regions = card?._regions || [];
    const order   = [...(_manualOrder.get(moKey) || regions.map((_, i) => i))];

    const [moved] = order.splice(fromPos, 1);
    order.splice(toPos, 0, moved);
    _manualOrder.set(moKey, order);
    _renderReorderPage(pageIdx);
    // Keep panel open
    const panel = document.getElementById(`reorder-panel-${pageIdx}`);
    if (panel) panel.style.display = 'block';
  });
}

