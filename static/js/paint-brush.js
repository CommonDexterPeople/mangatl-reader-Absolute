// ═══════════════════════════════════════════════════════════════
// paint-brush.js
// White-brush touchup for the standalone Erase Tool. Generalised to run in
// two places:
//
//   PRE-erase ("paint before erasing") — paints directly on the ORIGINAL,
//   not-yet-erased page, layered over the source <img> in the box-draw
//   canvas. Useful when a drawn box is too small/misaligned to cleanly
//   cover a bubble (or the "box" is really just a stray smudge sitting
//   outside any bubble) — painting first means the server's erase step
//   either has nothing left to fix, or (if the painted box is flagged
//   pre_painted) is skipped for that box entirely. See eraseRunErase()
//   in erase-tool.js for how the painted regions are packaged and sent.
//
//   POST-erase (unchanged from the original design) — touches up whatever
//   the server's inpaint/flatten left behind (a tilted bubble, a glyph
//   descender poking past the box edge, etc.), entirely client-side, no
//   server round-trip needed for a stray pixel.
//
// Design note: painting happens directly on a <canvas> layered on top of
// the target <img> (same position/size, absolutely positioned). The canvas
// is sized to the image's *natural* pixel resolution so strokes stay full
// quality regardless of on-screen zoom, but is stretched to the same
// on-screen box via CSS so it lines up with the displayed image pixel for
// pixel. Strokes are drawn straight onto this canvas with no intermediate
// encode step — encoding (canvas.toBlob) only happens once, on demand, via
// getFinalErasedBlob() / getPrePaintPatches(), not per stroke.
// ═══════════════════════════════════════════════════════════════

let _brushCanvas = null;    // visible <canvas>, drawn at natural image resolution
let _brushCtx = null;
let _brushActive = false;   // paint mode toggled on/off
let _brushSize = 24;        // brush diameter in *displayed* px (scaled to natural px when painting)
let _brushDirty = false;    // true once at least one stroke has been painted
let _brushDrawing = false;
let _brushMode = 'post';    // 'post' (touch up erase result) | 'pre' (paint before erase)

// ── PRE-erase brush state ─────────────────────────────────────────────────
// Unlike post-erase (one canvas over one final result), pre-erase painting
// happens on the source page while multiple boxes exist at once — strokes
// just accumulate on one full-page canvas positioned over erase-img, and
// get diffed out per-box at export time (see getPrePaintPatches).
let _preBrushDirty = false;

/**
 * Call once the erased-page preview is showing (end of _showErasePreview).
 * Builds a canvas at the image's natural resolution, pre-filled with the
 * current erase result, layered on top of the image, and shows the brush
 * toolbar. Safe to call again on a fresh erase result — resets brush state.
 */
function initPaintBrush() {
  const img = document.getElementById('erase-img');
  const imgWrap = document.getElementById('erase-img-wrap');
  if (!img || !imgWrap || !_eraseResultBlob) return;

  _brushMode = 'post';
  _brushDirty = false;
  _brushActive = false;

  const setup = () => {
    _brushCanvas = document.createElement('canvas');
    _brushCanvas.id = 'brush-canvas';
    _brushCanvas.width = img.naturalWidth;
    _brushCanvas.height = img.naturalHeight;
    _brushCtx = _brushCanvas.getContext('2d');
    _brushCtx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
    // Layered exactly over the image, same box, scaled by CSS to match
    // the image's on-screen size regardless of its natural resolution.
    _brushCanvas.style.cssText =
      'position:absolute; inset:0; width:100%; height:100%; display:block;';
    imgWrap.appendChild(_brushCanvas);
    _updateBrushCursor(); // explicit: starts inactive (pointer-events:none), matches _brushActive=false above
    _mountBrushToolbar();
  };

  // naturalWidth/Height are only reliable once the image has actually
  // loaded the new blob URL — img.src was just reassigned by the caller.
  if (img.complete && img.naturalWidth) setup();
  else img.addEventListener('load', setup, { once: true });
}

/**
 * Call when a page is loaded into the Erase Tool, BEFORE any erase has
 * run, to enable "paint white before erasing". Builds a canvas layered
 * over the source erase-img (the original, un-erased page) so painting
 * here edits the pixels the server will read when erase runs.
 *
 * This canvas is transparent everywhere except where painted — strokes are
 * white circles, same as post-erase, but composited over the *original*
 * image rather than replacing it, so box-drawing on erase-overlay (which
 * sits above this canvas — see z-index in style.css) still works normally
 * whenever the brush itself isn't active.
 */
function initPrePaintBrush() {
  const img = document.getElementById('erase-img');
  const imgWrap = document.getElementById('erase-img-wrap');
  if (!img || !imgWrap) return;

  _brushMode = 'pre';
  _preBrushDirty = false;
  _brushActive = false;

  const setup = () => {
    _brushCanvas = document.createElement('canvas');
    _brushCanvas.id = 'brush-canvas';
    _brushCanvas.width = img.naturalWidth;
    _brushCanvas.height = img.naturalHeight;
    _brushCtx = _brushCanvas.getContext('2d');
    // Transparent canvas — we're painting ON TOP of the still-visible
    // source image, not replacing it, so leave unpainted areas alone.
    _brushCanvas.style.cssText =
      'position:absolute; inset:0; width:100%; height:100%; display:block;';
    imgWrap.appendChild(_brushCanvas);
    _updateBrushCursor();
    _mountBrushToolbar();
  };

  if (img.complete && img.naturalWidth) setup();
  else img.addEventListener('load', setup, { once: true });
}

function _mountBrushToolbar() {
  const wrap = document.getElementById('erase-canvas-wrap');
  if (!wrap) return;
  let bar = document.getElementById('brush-toolbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'brush-toolbar';
    bar.className = 'brush-toolbar';
    wrap.parentElement.insertBefore(bar, wrap.nextSibling);
  }
  const dirty = _brushMode === 'pre' ? _preBrushDirty : _brushDirty;
  const label = _brushMode === 'pre' ? 'Paint white (pre-erase)' : 'White brush';
  bar.innerHTML = `
    <button id="brush-toggle" class="export-row-btn${_brushActive ? ' active' : ''}"
      onclick="toggleBrushMode()" title="Paint white directly over the page — no erase/inpaint needed for the painted area">
      🖌 ${_brushActive ? 'Painting (on)' : label}
    </button>
    <span class="brush-size-row" ${_brushActive ? '' : 'style="display:none"'}>
      <label for="brush-size-slider">size</label>
      <input id="brush-size-slider" type="range" min="4" max="80" step="1" value="${_brushSize}">
      <span id="brush-size-label">${_brushSize}px</span>
    </span>
    <button id="brush-reset" class="export-row-btn" ${dirty ? '' : 'style="display:none"'}
      onclick="resetBrushStrokes()" title="Discard all painted strokes">
      ↺ undo all painting
    </button>`;

  document.getElementById('brush-size-slider')?.addEventListener('input', e => {
    _brushSize = +e.target.value;
    const lbl = document.getElementById('brush-size-label');
    if (lbl) lbl.textContent = `${_brushSize}px`;
  });
}

function toggleBrushMode() {
  _brushActive = !_brushActive;
  _mountBrushToolbar();
  _attachOrDetachBrushEvents();
  _updateBrushCursor();
  // erase-overlay (the box-draw layer) normally owns all mouse events on
  // the image (see box-overlay.js / CSS .erase-overlay { position:absolute;
  // inset:0 }). While painting, a brush stroke shouldn't *also* start
  // dragging out a new erase box underneath — detach the box-draw
  // controller while brush mode is on, reattach when it turns off.
  if (_brushActive) {
    _eraseOverlayCtl?.detach();
  } else if (_eraseOverlayCtl) {
    _eraseOverlayCtl.attach();
  }
}

let _brushMoveHandler = null;
let _brushUpHandler = null;

function _attachOrDetachBrushEvents() {
  // The brush canvas is the topmost layer while active (see z-index in
  // style.css), so it receives events directly — no need to listen on
  // erase-overlay/erase-img.
  if (!_brushCanvas) return;

  _brushCanvas.onmousedown = null;
  if (_brushMoveHandler) document.removeEventListener('mousemove', _brushMoveHandler);
  if (_brushUpHandler) document.removeEventListener('mouseup', _brushUpHandler);
  _brushMoveHandler = null;
  _brushUpHandler = null;

  if (!_brushActive) return;

  _brushCanvas.onmousedown = e => {
    e.preventDefault();
    _brushDrawing = true;
    _paintAt(e);
  };
  _brushMoveHandler = e => { if (_brushDrawing) _paintAt(e); };
  _brushUpHandler = () => { _brushDrawing = false; };
  document.addEventListener('mousemove', _brushMoveHandler);
  document.addEventListener('mouseup', _brushUpHandler);
}

/** Paint one white circle at the event's position, mapped from displayed
 * (CSS-scaled) canvas coordinates to the canvas's own natural-resolution
 * drawing coordinates. Drawn straight onto the live canvas — no encode
 * step, so this is cheap enough to call on every mousemove sample. */
function _paintAt(e) {
  if (!_brushCtx || !_brushCanvas) return;
  const r = _brushCanvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width * _brushCanvas.width;
  const py = (e.clientY - r.top) / r.height * _brushCanvas.height;
  // Scale brush radius by the same displayed->natural ratio so the visual
  // circle size (what the user sees under their cursor) matches what
  // actually gets painted, regardless of how much the image is scaled down
  // on screen. Width-based scale only (not height) is correct here since
  // the image/canvas always preserves aspect ratio (CSS: width:100%,
  // height:auto on the underlying img) — never stretched non-uniformly.
  const scale = _brushCanvas.width / r.width;
  const radius = (_brushSize / 2) * scale;

  _brushCtx.fillStyle = '#ffffff';
  _brushCtx.beginPath();
  _brushCtx.arc(px, py, radius, 0, Math.PI * 2);
  _brushCtx.fill();

  const wasDirty = _brushMode === 'pre' ? _preBrushDirty : _brushDirty;
  if (!wasDirty) {
    if (_brushMode === 'pre') _preBrushDirty = true; else _brushDirty = true;
    const resetBtn = document.getElementById('brush-reset');
    if (resetBtn) resetBtn.style.display = '';
  }
}

function _updateBrushCursor() {
  if (!_brushCanvas) return;
  _brushCanvas.style.cursor = _brushActive ? 'cell' : 'crosshair';
  _brushCanvas.style.pointerEvents = _brushActive ? 'auto' : 'none';
}

/** Discard all painted strokes. Post-erase: redraws the untouched server
 * erase result. Pre-erase: just clears the (transparent) overlay canvas,
 * since there's no separate "before" image to restore from — the source
 * <img> underneath was never modified. */
function resetBrushStrokes() {
  if (!_brushCanvas || !_brushCtx) return;

  if (_brushMode === 'pre') {
    _brushCtx.clearRect(0, 0, _brushCanvas.width, _brushCanvas.height);
    _preBrushDirty = false;
    const resetBtn = document.getElementById('brush-reset');
    if (resetBtn) resetBtn.style.display = 'none';
    return;
  }

  if (!_eraseResultBlob) return;
  const tmp = new Image();
  tmp.onload = () => {
    _brushCtx.clearRect(0, 0, _brushCanvas.width, _brushCanvas.height);
    _brushCtx.drawImage(tmp, 0, 0, _brushCanvas.width, _brushCanvas.height);
    _brushDirty = false;
    const resetBtn = document.getElementById('brush-reset');
    if (resetBtn) resetBtn.style.display = 'none';
    URL.revokeObjectURL(tmp.src);
  };
  tmp.src = URL.createObjectURL(_eraseResultBlob);
}

/**
 * Returns the blob to actually download/export: the painted canvas result
 * if any strokes have been made, otherwise the original server erase blob
 * unchanged. Async because canvas.toBlob is async — this is the ONLY place
 * an encode happens, once, on demand, rather than per-stroke. Only
 * meaningful in 'post' mode.
 */
function getFinalErasedBlob() {
  return new Promise(resolve => {
    if (_brushMode !== 'post' || !_brushDirty || !_brushCanvas) { resolve(_eraseResultBlob); return; }
    _brushCanvas.toBlob(blob => resolve(blob || _eraseResultBlob), 'image/png');
  });
}

/**
 * Extract this pre-paint canvas's content, cropped to one box, as a base64
 * PNG data URL — the shape typeset_manual_page's `pre_paint` field expects
 * (see server.py). box is [x1,y1,x2,y2] in 0-100% page coordinates.
 * Returns null if there's no pre-paint canvas, or if that crop is fully
 * transparent (nothing was actually painted inside this specific box —
 * common when someone paints one bubble but not every box on the page).
 */
function getPrePaintPatchForBox(box) {
  if (_brushMode !== 'pre' || !_brushCanvas || !_preBrushDirty) return null;
  const [x1pct, y1pct, x2pct, y2pct] = box;
  const w = _brushCanvas.width, h = _brushCanvas.height;
  const x1 = Math.max(0, Math.round(x1pct / 100 * w));
  const y1 = Math.max(0, Math.round(y1pct / 100 * h));
  const x2 = Math.min(w, Math.round(x2pct / 100 * w));
  const y2 = Math.min(h, Math.round(y2pct / 100 * h));
  const bw = x2 - x1, bh = y2 - y1;
  if (bw <= 0 || bh <= 0) return null;

  // Check whether anything was actually painted in this crop before paying
  // for a full canvas alloc + toDataURL — getImageData's alpha channel
  // tells us in one pass.
  const srcCtx = _brushCanvas.getContext('2d');
  const data = srcCtx.getImageData(x1, y1, bw, bh).data;
  let painted = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) { painted = true; break; }
  }
  if (!painted) return null;

  // Composite onto a solid white background — pre_paint patches on the
  // server side are pasted as opaque RGB, so any still-transparent pixel
  // inside this box (painted stroke didn't fully cover it) should read as
  // white, not black/transparent.
  const out = document.createElement('canvas');
  out.width = bw; out.height = bh;
  const outCtx = out.getContext('2d');
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, bw, bh);
  outCtx.drawImage(_brushCanvas, x1, y1, bw, bh, 0, 0, bw, bh);
  return out.toDataURL('image/png');
}

/** True if the pre-paint canvas has any strokes on it at all (used to
 * decide whether it's worth checking individual boxes for patches). */
function hasPrePaintStrokes() {
  return _brushMode === 'pre' && _preBrushDirty;
}

/** Called by _renderEraseCanvas/openEraseTool to fully reset brush state
 * when navigating away from the current page or reloading the tool —
 * avoids carrying stale canvas/strokes over onto a different page's
 * image, and removes the injected <canvas>/toolbar DOM nodes themselves
 * (they're not part of _renderEraseCanvas's own innerHTML rebuild, since
 * the canvas is a sibling inside erase-img-wrap and the toolbar is a
 * sibling of erase-canvas-wrap — neither gets cleared automatically). */
function teardownPaintBrush() {
  _brushCanvas?.remove();
  _brushCanvas = null;
  _brushCtx = null;
  _brushActive = false;
  _brushDirty = false;
  _preBrushDirty = false;
  _brushDrawing = false;
  _brushMode = 'post';
  if (_brushMoveHandler) document.removeEventListener('mousemove', _brushMoveHandler);
  if (_brushUpHandler) document.removeEventListener('mouseup', _brushUpHandler);
  _brushMoveHandler = null;
  _brushUpHandler = null;
  document.getElementById('brush-toolbar')?.remove();
}
