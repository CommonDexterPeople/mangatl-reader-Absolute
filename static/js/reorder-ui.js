// ═══════════════════════════════════════════════════════════════
// reorder-ui.js
// Manual reading-order UI: the reorder panel and drag-to-reorder handling.
// ═══════════════════════════════════════════════════════════════

import { refreshCacheUI } from './cache.js';
import { _renderHistoryUI } from './history.js';
import { restoreMdAuthFromStorage } from './mangadex-auth.js';
import { startPipeline } from './pipeline.js';
import { _activeChapterId, _manualOrder, setReadOrder } from './state-and-constants.js';
import { getModelInfo, onModelChange, onTargetLangChange } from './translate-client.js';
import { esc, toast } from './utils.js';

// ══════════════════════════════════════════════
// MANUAL BADGE REORDER  (per-page drag UI)
// ══════════════════════════════════════════════

export function toggleReorderPanel(pageIdx) {
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

export function _renderReorderPage(pageIdx) {
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

export function _roMove(pageIdx, pos, dir) {
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

export function _applyReorder(pageIdx) {
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

export function _initDragReorder(pageIdx) {
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

