// ═══════════════════════════════════════════════════════════════
// box-overlay.js
// Shared percentage-box draw/select/render engine used by both the
// standalone Erase Tool (erase-tool.js) and the manual Correction UI
// (correction-ui.js). Both used to hand-roll their own copy of this —
// mousedown/mousemove/mouseup drag-to-draw, box rendering, click-to-remove —
// which meant every fix (touch support, cleanup-on-rebuild, drag math)
// had to be made twice and could quietly drift apart.
//
// This module owns none of the domain logic (what happens when a box is
// drawn — OCR call, vision call, just storing a rect, etc.) — that stays
// in the caller via callbacks. It only owns the shared mechanics: turning
// pointer events into a % box, previewing the drag, rendering existing
// boxes as overlay divs, and click-to-select/remove.
// ═══════════════════════════════════════════════════════════════

/**
 * Convert a pointer/mouse event position into percentage coordinates
 * relative to `imgEl`'s rendered box, clamped to [0,100].
 */
export function _imgPct(e, imgEl) {
  const r = imgEl.getBoundingClientRect();
  return [
    Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)),
    Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100)),
  ];
}

/**
 * Create a box-overlay controller bound to one overlay element + one image
 * element. Call `.attach()` once after both exist in the DOM; call
 * `.detach()` before the overlay/img are removed/replaced (e.g. when a
 * card's innerHTML is rebuilt) to avoid leaking document-level listeners.
 *
 * options:
 *   getImg()        → returns the current <img> element (re-queried each
 *                     time, since callers often rebuild innerHTML and the
 *                     element identity changes even though the id doesn't)
 *   getOverlay()     → returns the current overlay <div>
 *   isDrawEnabled()  → return true if the current mode should start a drag
 *                     (lets callers gate drawing behind a "mode" toggle,
 *                     e.g. correction-ui's select/draw/delete/reorder modes)
 *   onDrawEnd(box)   → called with a finalized [x1,y1,x2,y2] % box once a
 *                     drag completes (only if it's bigger than a stray click)
 *   onDragMove(box)  → optional, called continuously while dragging with the
 *                     live [x1,y1,x2,y2] box (used for e.g. vision-draw's
 *                     live "this region will be replaced" highlight)
 *   previewClass     → optional extra class to add to the live preview div
 *                     (e.g. 'vision-mode') — recomputed via previewClassFn
 *   previewClassFn()  → optional, return current extra class name for the
 *                     drag preview (evaluated per drag-start/move, since
 *                     mode can change without recreating the controller)
 *
 * Returns { attach, detach, drawPreview } — `drawPreview` is exposed in
 * case a caller wants to force-clear/redraw it, but normally you won't
 * need to call it directly.
 */
export function createBoxOverlay(options) {
  const {
    getImg,
    getOverlay,
    isDrawEnabled = () => true,
    onDrawEnd,
    onDragMove = null,
    previewClassFn = null,
  } = options;

  let dragState = { active: false };
  let mmoveHandler = null;
  let mupHandler = null;
  let boundOverlay = null;

  function _drawPreview() {
    const ov = getOverlay();
    if (!ov) return;
    const d = dragState;
    const x1 = Math.min(d.x1, d.x2), y1 = Math.min(d.y1, d.y2);
    const x2 = Math.max(d.x1, d.x2), y2 = Math.max(d.y1, d.y2);
    let p = ov.querySelector('.draw-preview');
    if (!p) {
      p = document.createElement('div');
      p.className = 'draw-preview';
      ov.appendChild(p);
    }
    if (previewClassFn) {
      p.className = 'draw-preview';
      const extra = previewClassFn();
      if (extra) p.classList.add(extra);
    }
    p.style.cssText = `left:${x1}%;top:${y1}%;width:${x2 - x1}%;height:${y2 - y1}%`;
  }

  function _clearPreview() {
    getOverlay()?.querySelector('.draw-preview')?.remove();
  }

  function attach() {
    detach(); // idempotent: clears any previous listeners bound by this controller
    const ov = getOverlay();
    const img = getImg();
    if (!ov || !img) return;
    boundOverlay = ov;
    dragState = { active: false };

    ov.addEventListener('mousedown', e => {
      if (!isDrawEnabled()) return;
      e.preventDefault();
      const curImg = getImg();
      if (!curImg) return;
      const [x, y] = _imgPct(e, curImg);
      dragState = { active: true, x1: x, y1: y, x2: x, y2: y };
      _drawPreview();
    });

    mmoveHandler = e => {
      if (!dragState.active) return;
      const curImg = getImg();
      if (!curImg) return;
      const [x, y] = _imgPct(e, curImg);
      dragState.x2 = x; dragState.y2 = y;
      _drawPreview();
      if (onDragMove) {
        const x1 = Math.min(dragState.x1, x), y1 = Math.min(dragState.y1, y);
        const x2 = Math.max(dragState.x1, x), y2 = Math.max(dragState.y1, y);
        onDragMove([x1, y1, x2, y2]);
      }
    };

    mupHandler = () => {
      if (!dragState.active) return;
      dragState.active = false;
      _clearPreview();
      const d = dragState;
      const x1 = Math.min(d.x1, d.x2), y1 = Math.min(d.y1, d.y2);
      const x2 = Math.max(d.x1, d.x2), y2 = Math.max(d.y1, d.y2);
      if ((x2 - x1) < 1 || (y2 - y1) < 1) return; // ignore accidental clicks
      onDrawEnd && onDrawEnd([x1, y1, x2, y2]);
    };

    document.addEventListener('mousemove', mmoveHandler);
    document.addEventListener('mouseup', mupHandler);
  }

  function detach() {
    if (mmoveHandler) document.removeEventListener('mousemove', mmoveHandler);
    if (mupHandler) document.removeEventListener('mouseup', mupHandler);
    mmoveHandler = null;
    mupHandler = null;
    boundOverlay = null;
  }

  return { attach, detach, drawPreview: _drawPreview };
}

/**
 * Render a simple list of removable boxes (used by the Erase Tool, and
 * usable anywhere that just needs "boxes you can click to delete" without
 * the Correction UI's richer select/split/merge sidebar).
 *
 * boxes: [{ id, box:[x1,y1,x2,y2] }]
 * onRemove(id): called when a box is clicked
 * extraClass: optional class added to every rendered box div
 */
export function renderRemovableBoxes(overlayEl, boxes, onRemove, extraClass = '') {
  if (!overlayEl) return;
  overlayEl.querySelectorAll('.corr-rbox').forEach(el => el.remove());
  boxes.forEach((b, i) => {
    const [x1, y1, x2, y2] = b.box;
    const el = document.createElement('div');
    el.className = `corr-rbox${extraClass ? ' ' + extraClass : ''}`;
    el.style.cssText = `left:${x1}%;top:${y1}%;width:${x2 - x1}%;height:${y2 - y1}%`;
    el.innerHTML = `<span class="rbox-num">${i + 1}</span>`;
    el.title = 'Click to remove';
    el.addEventListener('click', e => {
      e.stopPropagation();
      onRemove(b.id);
    });
    overlayEl.appendChild(el);
  });
}
