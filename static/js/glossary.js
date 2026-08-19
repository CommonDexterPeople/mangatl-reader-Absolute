// ═══════════════════════════════════════════════════════════════
// glossary.js
// Per-series glossary: user-defined source-term → translation overrides
// (character names, honorifics, invented terms) that get appended to the
// translate system prompt so the same term comes out the same way on
// every page, instead of drifting between "Yodaka" and "Nighthawk" or
// "-senpai" and "senior" chapter to chapter.
//
// STORAGE: localStorage, same shape as cache.js's chapter cache —
// prefix + version + a hard entry-count cap with LRU-ish eviction — but
// no TTL. A chapter cache entry is disposable (cheap to regenerate by
// re-OCRing); a glossary is deliberately-typed-in user intent with no
// "regenerate" path, so it doesn't expire just because a series went
// unread for a while.
//
// KEYING: mangaId (from chapter meta) when one exists — MangaDex and
// Suwayomi chapters both carry a real, stable ID. Local-folder/CBZ
// chapters have no such ID (mangaId is always null there — see
// pipeline.js's startPipelineWithLocalSource/startPipelineWithSuwayomiSource),
// so those fall back to a slug of a user-provided/confirmed glossary
// NAME instead. See _resolveGlossaryKey below for the exact rule and
// resolveActiveGlossary() for where that confirmation prompt happens.
//
// ACTIVE KEY: a single module-level variable (_activeGlossaryKey), set
// once per chapter load — same pattern _activeChapterId already uses in
// state-and-constants.js. Needed because translateBatch() is called from
// five different places (pipeline.js, page-render.js, correction-ui.js
// x2, erase-tool.js) and most of those call sites don't have `meta` (or
// any mangaId/title) in scope at all, only whatever chapter is currently
// active — threading a key through five call signatures would be more
// fragile than resolving it once at chapter-load time, the same way
// _activeChapterId itself is handled.
// ═══════════════════════════════════════════════════════════════

import { esc, toast } from './utils.js';

export const GLOS_PREFIX  = 'mtl_glos_';
export const GLOS_NAME_PREFIX = 'mtl_glos_name_';  // key -> display name, for the modal header
export const GLOS_MAX     = 50;    // cap on distinct glossaries (series), mirrors CACHE_MAX's shape
export const GLOS_TERM_CAP = 30;   // cap on terms PER glossary — see buildGlossaryPromptBlock's
                             // comment for why this matters for token budget, not just tidiness
export const GLOS_V        = 1;

export let _activeGlossaryKey  = null;   // localStorage key suffix for the current chapter's series
export let _activeGlossaryName = '';     // display name shown in the modal header + quick-add button

// ── Key resolution ────────────────────────────────────────────────
// mangaId when present (MangaDex/Suwayomi) -> "id:<mangaId>".
// Local/CBZ (mangaId null) -> "name:<slug of a user-confirmed name>",
// defaulting to the chapter/file's own title. Slugged so trivial
// differences (case, extra whitespace) from re-picking "the same" local
// folder twice don't silently fork into two glossaries.
export function _slugifyGlossaryName(name) {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

export function _glossaryKeyFor(mangaId, fallbackName) {
  if (mangaId) return `id:${mangaId}`;
  return `name:${_slugifyGlossaryName(fallbackName)}`;
}

// Called once per chapter load (pipeline.js's _runChapterPipeline, and
// erase-tool.js's loadEraseChapter / _loadEraseLocalChapter) with
// whatever {mangaId, mangaTitle} that source already has on hand — every
// pipeline entry point already builds an object with exactly these two
// fields (real values for MangaDex/Suwayomi, {mangaId:null, mangaTitle:
// <local title>} for local/CBZ — see pipeline.js), so this needs no new
// data threaded in from anywhere.
//
// For the local/CBZ case specifically, this does NOT silently start
// writing to a name-derived key the user never saw — see
// maybeConfirmGlossaryName() below, called separately from the modal
// open path, for that one-time confirmation moment. Until confirmed,
// local/CBZ chapters still resolve to the default name-derived key (so
// quick-add from Correct UI works immediately without forcing a modal
// detour first); confirming just lets the user rename it before terms
// pile up under a name they didn't choose.
export function setActiveGlossary(mangaId, mangaTitle) {
  _activeGlossaryKey  = _glossaryKeyFor(mangaId, mangaTitle);
  _activeGlossaryName = (mangaId ? mangaTitle : localStorage.getItem(GLOS_NAME_PREFIX + _activeGlossaryKey))
                        || mangaTitle || 'Untitled';
}

// ── Storage ───────────────────────────────────────────────────────
export function _getGlossaryTerms(key) {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(GLOS_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if ((parsed.v ?? 1) < GLOS_V) return [];   // reserved for a future format bump, same as CACHE_V
    return Array.isArray(parsed.terms) ? parsed.terms : [];
  } catch { return []; }
}

export function _setGlossaryTerms(key, terms, displayName) {
  if (!key) return;
  const capped = terms.slice(0, GLOS_TERM_CAP);
  const getKeys = () => Object.keys(localStorage).filter(k => k.startsWith(GLOS_PREFIX));
  let keys = getKeys();
  // Only evict if this is a NEW glossary pushing us over the cap — editing
  // an existing one should never evict itself or anything else.
  if (!keys.includes(GLOS_PREFIX + key)) {
    while (keys.length >= GLOS_MAX) {
      const oldest = keys[0];  // no per-entry timestamp kept (see file header) — oldest by
      if (!oldest) break;      // insertion order is the best available signal, same tradeoff
      localStorage.removeItem(oldest);                                   // cache.js accepts
      localStorage.removeItem(GLOS_NAME_PREFIX + oldest.slice(GLOS_PREFIX.length));
      keys = getKeys();
    }
  }
  try {
    localStorage.setItem(GLOS_PREFIX + key, JSON.stringify({ v: GLOS_V, terms: capped }));
    if (displayName) localStorage.setItem(GLOS_NAME_PREFIX + key, displayName);
  } catch {
    // Quota exceeded and nothing left worth evicting for a single glossary
    // write — same "give up quietly, don't crash the reader over a
    // localStorage write" posture cache.js's setCachedChapter takes after
    // its own 10-attempt eviction loop fails.
  }
}

// ── Prompt injection ─────────────────────────────────────────────
// Returns '' when there's nothing to add, so callers can unconditionally
// concatenate this onto the system prompt with no branching — a chapter
// with no glossary produces a byte-identical prompt to today, same
// "zero cost/behavior change if you never touch this feature" contract
// AI inpaint and Vision OCR both already follow elsewhere in this app.
export function buildGlossaryPromptBlock(key) {
  const terms = _getGlossaryTerms(key);
  if (!terms.length) return '';
  // Capped at GLOS_TERM_CAP terms (enforced at write time in
  // _setGlossaryTerms, not re-checked here) — this block is added to
  // EVERY page's translate call for the chapter, so an unbounded list
  // would scale token cost with glossary size on every single request,
  // not just once. 30 terms is generous for a cast+honorifics list and
  // still cheap per-call.
  const lines = terms
    .filter(t => (t.src || '').trim() && (t.tl || '').trim())
    .map(t => `${t.src.trim()} → ${t.tl.trim()}${t.note ? ` (${t.note.trim()})` : ''}`);
  if (!lines.length) return '';
  return `\n\nGLOSSARY — use these exact translations whenever the source term appears; ` +
         `do not substitute a synonym or re-translate it differently:\n${lines.join('\n')}`;
}

// ── One-time local/CBZ name confirmation ─────────────────────────
// Local/CBZ sources have no stable ID, so their glossary key is derived
// from a name the user never explicitly chose (see _glossaryKeyFor
// above). Rather than silently accumulate terms under an unconfirmed
// name-slug, the FIRST time the glossary modal is opened for a
// name-keyed chapter this session, ask once. Declining just keeps the
// default (chapter/file title) — this is a rename prompt, not a gate;
// quick-add from Correct UI never blocks on it.
export const _glossaryNameConfirmedThisSession = new Set();

export function maybeConfirmGlossaryName() {
  if (!_activeGlossaryKey || !_activeGlossaryKey.startsWith('name:')) return;
  if (_glossaryNameConfirmedThisSession.has(_activeGlossaryKey)) return;
  _glossaryNameConfirmedThisSession.add(_activeGlossaryKey);
  const existingTerms = _getGlossaryTerms(_activeGlossaryKey);
  if (existingTerms.length) return;  // already in use under this name — don't re-prompt to rename mid-use
  const picked = prompt(
    `This chapter has no MangaDex/Suwayomi ID, so its glossary is matched by name.\n` +
    `Glossary name (used to find this series' terms again later):`,
    _activeGlossaryName
  );
  if (picked === null) return;  // cancelled — keep default
  const trimmed = picked.trim();
  if (!trimmed || trimmed === _activeGlossaryName) return;
  const newKey = _glossaryKeyFor(null, trimmed);
  // Carry over anything already saved under the OLD default-name key —
  // rare (existingTerms.length was just checked above) but cheap to handle.
  const carry = _getGlossaryTerms(_activeGlossaryKey);
  if (newKey !== _activeGlossaryKey) {
    localStorage.removeItem(GLOS_PREFIX + _activeGlossaryKey);
    localStorage.removeItem(GLOS_NAME_PREFIX + _activeGlossaryKey);
  }
  _activeGlossaryKey  = newKey;
  _activeGlossaryName = trimmed;
  if (carry.length) _setGlossaryTerms(newKey, carry, trimmed);
  else localStorage.setItem(GLOS_NAME_PREFIX + newKey, trimmed);
}

// ── Modal UI ──────────────────────────────────────────────────────
// Vanilla-DOM backdrop+card modal, same construction pattern as
// correction-ui.js's _showFlowIssuesModal (build one <div>, innerHTML a
// card into it, append to body, close via .remove()) — reuses that
// modal's CSS classes (.flow-modal-backdrop etc.) rather than inventing
// parallel ones, since the visual language is already established and
// this doesn't need anything a flow-modal doesn't already support
// (header + scrollable body + footer actions).
//
// prefill: optional {src, tl} to seed a new blank row with — used by the
// "+ Glossary" quick-add button in correction-ui.js's sidebar.
export function openGlossaryModal(prefill) {
  if (!_activeGlossaryKey) { toast('Load a chapter first.'); return; }
  maybeConfirmGlossaryName();

  const existing = document.getElementById('glossary-modal');
  if (existing) existing.remove();

  const terms = _getGlossaryTerms(_activeGlossaryKey).slice();
  if (prefill && (prefill.src || prefill.tl)) {
    terms.push({ src: (prefill.src || '').trim(), tl: (prefill.tl || '').trim(), note: '' });
  }
  _renderGlossaryModal(terms);
}

export function _renderGlossaryModal(terms) {
  const rowsHtml = terms.map((t, i) => `
    <div class="flow-issue-row glossary-row">
      <input class="corr-textarea glossary-input" data-i="${i}" data-f="src"
             placeholder="Source term (e.g. 夜鷹)" value="${esc(t.src || '')}">
      <span class="glossary-arrow">→</span>
      <input class="corr-textarea glossary-input" data-i="${i}" data-f="tl"
             placeholder="Translation (e.g. Yodaka)" value="${esc(t.tl || '')}">
      <input class="corr-textarea glossary-input glossary-note" data-i="${i}" data-f="note"
             placeholder="Note (optional)" value="${esc(t.note || '')}">
      <button class="flow-modal-close" title="Remove" onclick="_removeGlossaryRow(${i})">✕</button>
    </div>`).join('');

  const modal = document.createElement('div');
  modal.id = 'glossary-modal';
  modal.className = 'flow-modal-backdrop';
  modal.innerHTML = `
    <div class="flow-modal glossary-modal">
      <div class="flow-modal-hdr">
        <span>📖 GLOSSARY — ${esc(_activeGlossaryName)}
          <span style="opacity:0.6;font-weight:normal">(${terms.length}/${GLOS_TERM_CAP})</span>
        </span>
        <button class="flow-modal-close" onclick="document.getElementById('glossary-modal').remove()">✕</button>
      </div>
      <div class="flow-modal-body" id="glossary-rows">${rowsHtml ||
        '<div class="corr-empty-hint">No terms yet — add a character name or honorific below.</div>'}</div>
      <div class="flow-modal-footer">
        <button class="corr-btn-close" onclick="_addGlossaryRow()"
          ${terms.length >= GLOS_TERM_CAP ? 'disabled title="Term cap reached"' : ''}>+ ADD TERM</button>
        <button class="corr-btn-retrans" onclick="_saveGlossaryModal()">✓ SAVE</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

export function _readGlossaryModalRows() {
  const rows = Array.from(document.querySelectorAll('#glossary-rows .glossary-row'));
  return rows.map(row => {
    const get = f => row.querySelector(`[data-f="${f}"]`)?.value ?? '';
    return { src: get('src'), tl: get('tl'), note: get('note') };
  });
}

export function _addGlossaryRow() {
  const terms = _readGlossaryModalRows();
  if (terms.length >= GLOS_TERM_CAP) { toast(`Glossary cap is ${GLOS_TERM_CAP} terms.`); return; }
  terms.push({ src: '', tl: '', note: '' });
  _renderGlossaryModal(terms);
}

export function _removeGlossaryRow(i) {
  const terms = _readGlossaryModalRows();
  terms.splice(i, 1);
  _renderGlossaryModal(terms);
}

export function _saveGlossaryModal() {
  const terms = _readGlossaryModalRows().filter(t => t.src.trim() || t.tl.trim());
  _setGlossaryTerms(_activeGlossaryKey, terms, _activeGlossaryName);
  document.getElementById('glossary-modal')?.remove();
  toast(`Glossary saved — ${terms.length} term${terms.length !== 1 ? 's' : ''}.`);
}
