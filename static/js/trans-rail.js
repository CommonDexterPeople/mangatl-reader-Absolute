// ═══════════════════════════════════════════════════════════════
// trans-rail.js
// Sticky translation sidebar for the reader screen — the ONLY place
// translations are shown. No mobile/desktop split, no auto-hide, no
// bottom sheet: the sidebar (or its collapsed floating pill) is
// always there, on every screen size, until the person explicitly
// collapses it.
//
// Architecture:
//   Each page's real translation data lives in its own
//   #trans-panel-<pageIdx>, created once by renderPage() and kept
//   hidden in its normal spot in the page card (page-render.js still
//   creates it there; correction-ui.js still edits it there; reorder-
//   ui.js still reorders it there — nothing about that changed).
//
//   The sidebar does NOT move that element. It renders a live COPY
//   of whichever page is currently "docked", and a MutationObserver
//   watches the real #trans-panel-<pageIdx> directly — so ANY change
//   to it (a fresh render, a reorder, a correction closing) is
//   reflected in the sidebar automatically, from the actual DOM
//   mutation itself, not from a list of call sites this file has to
//   remember to wrap. That's what fixes the earlier bug where the
//   sidebar could show one page's translation while the in-page
//   panel already had a different (newer) one.
//
//   Two-way binding: clicking/hovering a numbered badge on the page
//   image highlights + scrolls to its translation row in the
//   sidebar, and vice versa.
//
//   Keyboard: ↑/↓ or W/S step line-by-line through the CURRENT
//   page's translation rows, rolling over to the next/previous
//   page's first/last row at the ends.
// ═══════════════════════════════════════════════════════════════

const _TRAIL_COLLAPSE_KEY = 'mtl_trail_collapsed';
let _railDockedPage  = null;  // pageIdx currently shown in the sidebar, or null
let _railCollapsed   = localStorage.getItem(_TRAIL_COLLAPSE_KEY) === '1';
let _railIO          = null;  // IntersectionObserver tracking which page-card is in view
let _railSourceMO    = null;  // MutationObserver watching the currently-docked page's real .trans-panel

// ══════════════════════════════════════════════
// Wrap the render functions once, so a fresh render always re-checks
// whether the docked page needs a re-sync — belt-and-suspenders on
// top of the MutationObserver below, and it's what handles the very
// first render (before anything exists for the observer to watch).
// ══════════════════════════════════════════════
// Re-sync the docked panel after any (re-)render, and around correction
// open/close. These used to be two IIFEs that reassigned page-render.js's and
// correction-ui.js's functions at load time; those modules now expose hooks
// instead (see onAfterPageRender / onBeforeCorrectionOpen there), because an
// ES module can't write to another module's binding. Same three call points,
// same order, just subscribed rather than monkey-patched.
onAfterPageRender(_transRailOnPageRendered);

onBeforeCorrectionOpen(pageIdx => {
  // Stop watching this page's card BEFORE it gets replaced — the
  // MutationObserver fires asynchronously, which would otherwise
  // land after _renderCorrectingNote() below and overwrite it with
  // a generic "Translating…" resync triggered by the card's old
  // .trans-panel being destroyed.
  if (_railDockedPage === pageIdx && _railSourceMO) _railSourceMO.disconnect();
});
onAfterCorrectionOpen(pageIdx => {
  if (_railDockedPage === pageIdx) _renderCorrectingNote();
});
onAfterCorrectionClose(_transRailOnPageRendered);

// Called after ANY (re-)render of a page's translation panel.
function _transRailOnPageRendered(pageIdx) {
  _refreshFabCount();
  if (_railDockedPage === pageIdx) {
    _syncFromSource();
    _watchDockedSource(); // re-arm: the previous .trans-panel node (and its watcher) may have just been destroyed by a fresh render
  } else if (_railDockedPage == null && pageIdx === 0) {
    // Nothing docked yet (fresh chapter load) — show page 1 immediately
    // rather than waiting for the IntersectionObserver's first callback,
    // which needs an actual scroll/layout event to fire.
    _dockPage(0);
  }
  // Keep the IntersectionObserver watching this card (harmless if
  // already observed — observe() on an already-observed element is a no-op).
  const card = document.getElementById(`page-${pageIdx}`);
  if (card && _railIO) _railIO.observe(card);
}

// ══════════════════════════════════════════════
// DOCKING — the sidebar shows a live COPY of #trans-panel-<pageIdx>
// (or a "no text" / "translating" note). The real element never
// moves; it stays hidden in its normal spot in the page card so
// page-render.js / correction-ui.js / reorder-ui.js keep working on
// it exactly as before.
// ══════════════════════════════════════════════
function _dockPage(pageIdx) {
  const body = document.getElementById('trans-rail-body');
  if (!body) return;

  _railDockedPage = pageIdx;
  _syncFromSource();

  const total = document.querySelectorAll('.page-card').length || '–';
  document.querySelectorAll('.rail-page-num').forEach(el => { el.textContent = `${pageIdx + 1} / ${total}`; });

  _clearRowActive();
  _watchDockedSource();
}

// Re-render the sidebar body FROM the real source element right now.
// This is the only place that writes trans-rail-body's content, and
// it always reads the live DOM — so it can never show something
// stale relative to whatever renderPage()/reorder-ui.js last wrote.
function _syncFromSource() {
  const body = document.getElementById('trans-rail-body');
  if (!body || _railDockedPage == null) return;

  const card = document.getElementById(`page-${_railDockedPage}`);
  const source = card?.querySelector(`#trans-panel-${_railDockedPage}`) || card?.querySelector('.no-text-note');

  const prevActiveRidx = body.querySelector('.t-row.row-active')?.dataset.ridx;

  if (source) {
    // Clone rather than copy outerHTML verbatim: the source carries
    // id="trans-panel-N", and reorder-ui.js looks that ID up via
    // getElementById(), which only returns the first match in
    // document order. Two elements sharing that ID (the real hidden
    // one plus this sidebar copy) would make that lookup unpredictable
    // depending on DOM order — so the copy gets its id stripped,
    // leaving exactly one #trans-panel-N in the whole document.
    const clone = source.cloneNode(true);
    clone.removeAttribute('id');
    body.innerHTML = '';
    body.appendChild(clone);
  } else {
    body.innerHTML = `<div class="trans-rail-empty">Translating…</div>`;
  }

  const rowCount = body.querySelectorAll('.t-row').length;
  _updateFabCount(rowCount);

  // Restore the active-row highlight across the resync, if the same
  // row index still exists (a resync from a live edit shouldn't lose
  // your place, e.g. mid-keyboard-nav).
  if (prevActiveRidx != null) {
    const row = body.querySelector(`.t-row[data-ridx="${prevActiveRidx}"]`);
    if (row) row.classList.add('row-active');
  }
}

function _renderCorrectingNote() {
  const body = document.getElementById('trans-rail-body');
  if (!body) return;
  body.innerHTML = `<div class="trans-rail-empty">Editing this page in ✏ CORRECT…</div>`;
}

function _renderNoPageDocked() {
  const body = document.getElementById('trans-rail-body');
  if (!body) return;
  body.innerHTML = `<div class="trans-rail-empty">Scroll to a translated page.</div>`;
  document.querySelectorAll('.rail-page-num').forEach(el => { el.textContent = '–'; });
}

// Watch the currently-docked page's real #trans-panel-<N> for ANY
// DOM change (renderPage rebuilding it, reorder-ui rewriting its
// rows, correction closing and replacing it) and re-sync the moment
// it happens — this is what actually fixes the sidebar/in-page
// mismatch, rather than relying on this file remembering every call
// site that could change it.
function _watchDockedSource() {
  if (_railSourceMO) _railSourceMO.disconnect();
  const card = document.getElementById(`page-${_railDockedPage}`);
  if (!card) return;
  _railSourceMO = new MutationObserver(() => _syncFromSource());
  // Observe the whole card (subtree) rather than just the panel
  // itself: correction-ui.js replaces the panel via the CARD's
  // innerHTML (destroying and recreating child nodes), so a
  // MutationObserver attached to the old panel node would stop
  // seeing anything the instant that node gets destroyed.
  _railSourceMO.observe(card, { childList: true, subtree: true, characterData: true });
}

function _refreshFabCount() {
  if (_railDockedPage == null) return;
  const card = document.getElementById(`page-${_railDockedPage}`);
  const rows = card?.querySelectorAll('.trans-panel .t-row').length || 0;
  _updateFabCount(rows);
}
function _updateFabCount(n) {
  const el = document.getElementById('trans-fab-count');
  if (el) el.textContent = String(n);
}

// ══════════════════════════════════════════════
// SCROLL TRACKING — anchor-line approach: the docked page is
// whichever page-card's top edge is the last one to have scrolled
// above a fixed line near the top of the viewport. This only
// changes when a page BOUNDARY crosses that line — never mid-page
// from one tall page's visible-area merely fluctuating, which a
// "most visible ratio" approach is prone to on any page tall/dense
// enough for its own ratio to dip while scrolling through it.
// Once past the last page, the sidebar stays docked to that last
// page rather than clearing — it never auto-hides.
// ══════════════════════════════════════════════
function _initScrollTracking() {
  if (_railIO) _railIO.disconnect();

  const ANCHOR_FRACTION = 0.25; // 25% down from the top of the viewport

  const evaluate = () => {
    const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reader-hdr-h')) || 118;
    const viewportH = window.innerHeight - headerH;
    const anchorY = headerH + viewportH * ANCHOR_FRACTION;

    const cards = Array.from(document.querySelectorAll('.page-card'));
    if (!cards.length) return;

    let candidate = cards[0];
    for (const card of cards) {
      const top = card.getBoundingClientRect().top;
      if (top <= anchorY) candidate = card; // last card whose top has passed the anchor
      else break; // cards are in document order, so we can stop here
    }
    const idx = +candidate.dataset.page;
    if (!Number.isNaN(idx) && idx !== _railDockedPage) _dockPage(idx);
  };

  _railIO = new IntersectionObserver(() => evaluate(), {
    threshold: [0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1],
    rootMargin: '0px',
  });

  document.querySelectorAll('.page-card').forEach(c => _railIO.observe(c));
}

// page-render.js's addSkeleton() creates .page-card elements with
// id="page-<i>" but no data-page attribute — patch that in once
// per chapter load, right after the skeletons go up, so the
// IntersectionObserver above can read dataset.page.
function _tagPageCards() {
  document.querySelectorAll('#pages-container .page-card').forEach(card => {
    if (card.dataset.page !== undefined) return;
    const m = card.id.match(/^page-(\d+)$/);
    if (m) card.dataset.page = m[1];
  });
}

// Re-tag + re-observe whenever the page list is rebuilt for a new
// chapter. pipeline.js clears #pages-container synchronously before
// appending skeletons, so a MutationObserver catches every load,
// local-folder/CBZ included, without needing a hook in pipeline.js.
const _pagesContainerWatcher = new MutationObserver(() => {
  _tagPageCards();
  _initScrollTracking();
  const dockedCardGone = _railDockedPage != null && !document.getElementById(`page-${_railDockedPage}`);
  if (dockedCardGone || !document.querySelector('.page-card')) {
    _railDockedPage = null;
    if (_railSourceMO) _railSourceMO.disconnect();
    _renderNoPageDocked();
  }
});

// ══════════════════════════════════════════════
// TWO-WAY BADGE <-> ROW BINDING
// ══════════════════════════════════════════════
function _clearRowActive() {
  document.querySelectorAll('.t-row.row-active').forEach(r => r.classList.remove('row-active'));
  document.querySelectorAll('.badge.badge-active').forEach(b => b.classList.remove('badge-active'));
}

function _activateRow(pageIdx, ridx, { scrollRow = true, scrollBadge = false, flash = false } = {}) {
  if (_railDockedPage !== pageIdx) _dockPage(pageIdx);
  _clearRowActive();

  const body = document.getElementById('trans-rail-body');
  const row = body?.querySelector(`.t-row[data-ridx="${ridx}"]`);
  if (row) {
    row.classList.add('row-active');
    if (flash) { row.classList.add('row-flash'); setTimeout(() => row.classList.remove('row-flash'), 900); }
    if (scrollRow) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const card = document.getElementById(`page-${pageIdx}`);
  const badge = card?.querySelector(`.badge[data-ridx="${ridx}"]`);
  if (badge) {
    badge.classList.add('badge-active');
    if (scrollBadge) badge.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return { row, badge };
}

// Badge hover/click → highlight + scroll to its row (delegated;
// badges are created/recreated across many renders, so a single
// document-level listener avoids re-binding per page).
document.addEventListener('mouseover', e => {
  const badge = e.target.closest?.('.badge');
  if (!badge) return;
  const card = badge.closest('.page-card');
  const pageIdx = card ? +card.dataset.page : NaN;
  const ridx = +badge.dataset.ridx;
  if (Number.isNaN(pageIdx) || Number.isNaN(ridx)) return;
  _activateRow(pageIdx, ridx, { scrollRow: true, scrollBadge: false });
});
document.addEventListener('click', e => {
  const badge = e.target.closest?.('.badge');
  if (!badge) return;
  const card = badge.closest('.page-card');
  const pageIdx = card ? +card.dataset.page : NaN;
  const ridx = +badge.dataset.ridx;
  if (Number.isNaN(pageIdx) || Number.isNaN(ridx)) return;
  _activateRow(pageIdx, ridx, { scrollRow: true, scrollBadge: false, flash: true });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const badge = document.activeElement?.classList?.contains('badge') ? document.activeElement : null;
  if (!badge) return;
  e.preventDefault();
  badge.click();
});

// Row click → highlight + scroll to its badge on the image.
function _bindRowClicks(container) {
  if (!container) return;
  container.addEventListener('click', e => {
    const row = e.target.closest?.('.t-row');
    if (!row || !container.contains(row)) return;
    const ridx = +row.dataset.ridx;
    if (Number.isNaN(ridx) || _railDockedPage == null) return;
    _activateRow(_railDockedPage, ridx, { scrollRow: false, scrollBadge: true, flash: true });
  });
}

// ══════════════════════════════════════════════
// KEYBOARD NAV — ↑/↓ or W/S step line-by-line through the CURRENTLY
// DOCKED page's rows, then roll over into the next/prev page's
// first/last row once you're past either end. Ignored while the
// person is typing in any input/textarea/select, or while a page
// is open in ✏ CORRECT (which has its own key handling).
// ══════════════════════════════════════════════
function _isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function _currentRowIndex() {
  const active = document.querySelector('.t-row.row-active');
  if (!active) return -1;
  return +active.dataset.ridx;
}

function _rowsForPage(pageIdx) {
  const card = document.getElementById(`page-${pageIdx}`);
  return card ? card.querySelectorAll('.badge').length : 0;
}

// Synchronous "what's most visible right now" check, independent of
// the async IntersectionObserver. Used as a keyboard-nav-only
// fallback so a fast scroll immediately followed by a keypress
// doesn't act on a page the observer hasn't caught up to yet.
function _mostVisiblePageNow() {
  const vh = window.innerHeight;
  let best = null, bestVisible = -1;
  document.querySelectorAll('.page-card').forEach(card => {
    const r = card.getBoundingClientRect();
    const visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (visible > bestVisible) { bestVisible = visible; best = card; }
  });
  return best ? +best.dataset.page : null;
}

function _stepLine(dir) {
  // dir: +1 = next line, -1 = prev line
  if (document.getElementById('screen-reader')?.classList.contains('active') !== true) return;
  if (document.querySelector('.page-card.correcting')) return; // correction UI owns keys while open

  let ridx = _currentRowIndex();
  let pageIdx;
  if (ridx === -1) {
    // No line currently active (first press, or just rolled/scrolled) —
    // trust what's actually on screen right now over the (possibly
    // stale) async-observer-driven _railDockedPage.
    pageIdx = _mostVisiblePageNow();
    if (pageIdx == null) pageIdx = _railDockedPage;
  } else {
    pageIdx = _railDockedPage;
  }
  if (pageIdx == null) return;

  const rowCount = _rowsForPage(pageIdx);

  if (rowCount === 0) {
    // No text on this (docked) page — just roll to the neighbor page.
    _rollToPage(pageIdx + dir, dir);
    return;
  }

  if (ridx === -1) {
    ridx = dir > 0 ? 0 : rowCount - 1;
    _activateRow(pageIdx, ridx, { scrollRow: true, scrollBadge: true });
    return;
  }

  const next = ridx + dir;
  if (next < 0 || next >= rowCount) {
    _rollToPage(pageIdx + dir, dir);
    return;
  }
  _activateRow(pageIdx, next, { scrollRow: true, scrollBadge: true });
}

function _rollToPage(targetIdx, dir) {
  const card = document.getElementById(`page-${targetIdx}`);
  if (!card) return; // start/end of chapter — nothing further to roll to
  card.scrollIntoView({ block: dir > 0 ? 'start' : 'end', behavior: 'smooth' });
  _dockPage(targetIdx);
  const rowCount = _rowsForPage(targetIdx);
  if (rowCount > 0) {
    _activateRow(targetIdx, dir > 0 ? 0 : rowCount - 1, { scrollRow: true, scrollBadge: true });
  }
}

document.addEventListener('keydown', e => {
  if (_isTypingTarget(e.target)) return;
  const k = e.key.toLowerCase();
  if (k === 'arrowdown' || k === 's') { e.preventDefault(); _stepLine(1); }
  else if (k === 'arrowup' || k === 'w') { e.preventDefault(); _stepLine(-1); }
});

// ══════════════════════════════════════════════
// COLLAPSE / EXPAND (sidebar <-> floating pill) — the only way the
// sidebar's visibility ever changes; no auto-show/auto-hide tied to
// scroll position or screen width.
// ══════════════════════════════════════════════
function _applyCollapsedState() {
  const rail = document.getElementById('trans-rail');
  const fab  = document.getElementById('trans-fab');
  if (!rail || !fab) return;
  rail.hidden = _railCollapsed;
  fab.hidden  = !_railCollapsed;
  if (!_railCollapsed && _railDockedPage != null) _syncFromSource();
}
function transRailCollapse() {
  _railCollapsed = true;
  localStorage.setItem(_TRAIL_COLLAPSE_KEY, '1');
  _applyCollapsedState();
}
function transRailExpand() {
  _railCollapsed = false;
  localStorage.setItem(_TRAIL_COLLAPSE_KEY, '0');
  _applyCollapsedState();
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
(function _initTransRail() {
  _applyCollapsedState();
  _bindRowClicks(document.getElementById('trans-rail-body'));

  const pagesContainer = document.getElementById('pages-container');
  if (pagesContainer) {
    _pagesContainerWatcher.observe(pagesContainer, { childList: true });
  }
  _tagPageCards();
  _initScrollTracking();

  // Measure the sticky reader-header's real height so the sidebar's
  // sticky offset / max-height always clears it exactly, even if the
  // header wraps to more lines on a narrower desktop width.
  const header = document.querySelector('.reader-header');
  if (header && 'ResizeObserver' in window) {
    const ro = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--reader-hdr-h', header.offsetHeight + 'px');
      const rail = document.getElementById('trans-rail');
      if (rail) rail.style.top = header.offsetHeight + 'px';
    });
    ro.observe(header);
  }
})();
