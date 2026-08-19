// ═══════════════════════════════════════════════════════════════
// state-and-constants.js
// Global state, language-name table, read-order helpers.
// Loaded first: every other module reads these globals.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let cancelled        = false;
let abortController  = null;
let toastTimer       = null;
let prevChapterId    = null;
let nextChapterId    = null;
let _activeChapterId = null;

// ── Badge reading order ────────────────────────
// 'auto-rtl' = right-to-left then top-to-bottom (manga default)
// 'auto-ltr' = left-to-right then top-to-bottom (manhwa / webtoon)
// 'manual'   = keep raw OCR order; per-page drag reorder available
let _readOrder = localStorage.getItem('mtl_read_order') || 'auto-rtl';

// Per-page manual order overrides: Map<"chId_pageIdx", number[]> (indices into original regions)
const _manualOrder = new Map();

// ══════════════════════════════════════════════
// LANGUAGE NAMES
// ══════════════════════════════════════════════
const LANG_NAMES = {
  vi: 'Vietnamese', it: 'Italian',    pt: 'Portuguese',
  'pt-br': 'Portuguese (BR)',                           // FIX #7
  ru: 'Russian',    fr: 'French',     es: 'Spanish',   de: 'German',
  pl: 'Polish',     nl: 'Dutch',      tr: 'Turkish',   id: 'Indonesian',
  ko: 'Korean',     ja: 'Japanese',   zh: 'Chinese',   'zh-hk': 'Chinese (Trad.)',
  th: 'Thai',       ar: 'Arabic',     uk: 'Ukrainian', cs: 'Czech',
  hu: 'Hungarian',  ro: 'Romanian',   sv: 'Swedish',   da: 'Danish',
  fi: 'Finnish',    no: 'Norwegian',  ms: 'Malay',     hr: 'Croatian',
  sk: 'Slovak',     bg: 'Bulgarian',  lt: 'Lithuanian', lv: 'Latvian',
  en: 'English',
};
function getLangName(code) {
  return LANG_NAMES[code?.toLowerCase()] ?? (code?.toUpperCase() ?? 'Unknown');
}

// ── Reading order control ─────────────────────
function setReadOrder(mode) {
  _readOrder = mode;
  localStorage.setItem('mtl_read_order', mode);
  ['auto-rtl', 'auto-ltr', 'manual'].forEach(m => {
    document.getElementById('ro-' + m)?.classList.toggle('active', m === mode);
  });
}

function _sortRegions(regions) {
  if (_readOrder === 'manual') {
    // manual — keep raw OCR order as returned by server
    return [...regions];
  }

  // Y-TOLERANCE BANDING, not a flat cy-primary sort.
  //
  // A flat sort by (cy, then cx) looks reasonable but is wrong for real
  // manga/manhwa pages: cy is a bubble's vertical CENTER, and two bubbles
  // in different side-by-side panels essentially never share an identical
  // cy — a bubble near the bottom of a short left panel can easily have a
  // smaller cy than a bubble near the top of a taller right panel next to
  // it. Since cy was the PRIMARY sort key, that one comparison decided
  // their order regardless of which panel either bubble was actually in —
  // the cx tiebreaker (which is what LTR/RTL is supposed to control) was
  // only ever reached on an exact cy tie, which real pages essentially
  // never produce. Net effect: flipping the LTR/RTL toggle barely changed
  // anything, because cx was rarely the deciding factor to begin with.
  //
  // Fix: treat any two bubbles whose cy values are within Y_BAND_PCT of
  // each other as being on the same visual "row" and sort THOSE by cx
  // (reading direction). Only fall back to pure cy ordering once bubbles
  // are far enough apart vertically that they're clearly different rows.
  // This isn't full geometric panel-detection (no panel-border data is
  // available client-side) but band-tolerance handles the common case —
  // side-by-side panels of roughly similar height — correctly, and
  // degrades gracefully (falls back toward top-to-bottom) on layouts it
  // doesn't fully understand, rather than confidently mis-clustering them.
  const Y_BAND_PCT = 8; // cy values within 8% of page height count as "same row"

  const dir = _readOrder === 'auto-ltr' ? 1 : -1; // +1 = left-to-right, -1 = right-to-left

  return [...regions].sort((a, b) => {
    const dy = a.cy - b.cy;
    if (Math.abs(dy) < Y_BAND_PCT) {
      return dir * (a.cx - b.cx);
    }
    return dy;
  });
}


// ══════════════════════════════════════════════
// STATE SETTERS
// ══════════════════════════════════════════════
// ES modules make imported bindings read-only: `import { cancelled }` gives
// you a live view of this module's variable, but `cancelled = true` from
// another module is a hard error ("Cannot assign to import"). Under the old
// plain-<script> setup every file shared one global scope, so pipeline.js and
// utils.js just assigned these directly.
//
// Reads still work exactly as before — live bindings mean an importer always
// sees the current value, so only the WRITES needed a door. These are that
// door. Deliberately one setter per variable rather than a single mutable
// state object, because that keeps every existing read site (`if (cancelled)`)
// untouched; a state object would have meant rewriting far more code than the
// 27 assignments that actually had to change.
function setCancelled(v)        { cancelled        = v; }
function setAbortController(v)  { abortController  = v; }
function setToastTimer(v)       { toastTimer       = v; }
function setPrevChapterId(v)    { prevChapterId    = v; }
function setNextChapterId(v)    { nextChapterId    = v; }
function setActiveChapterId(v)  { _activeChapterId = v; }
