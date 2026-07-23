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
  if (_readOrder === 'auto-ltr') {
    // Left-to-right, then top-to-bottom (manhwa)
    return [...regions].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  } else if (_readOrder === 'auto-rtl') {
    // Right-to-left, then top-to-bottom (traditional manga)
    return [...regions].sort((a, b) => a.cy - b.cy || b.cx - a.cx);
  }
  // manual — keep raw OCR order as returned by server
  return [...regions];
}

