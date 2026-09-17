// ═══════════════════════════════════════════════════════════════
// llm-export.js
// Translate a chapter through a free chat AI instead of an API key:
// export the OCR'd text as one .md file (prompt included), paste the
// reply back, review it as a diff, apply. The panel, the review modal
// and the apply step live here; the file format and the reply parser
// live in llm-export-format.js.
// ═══════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS (ROADMAP.md §6). Everything in this app is local and free
// except the one step that isn't: translation needs an API key. A chat
// session on ChatGPT / Claude / Gemini / DeepSeek's free tier can do that
// step just as well — with BETTER context, since it sees the whole chapter
// in one prompt where the API path sees one page per call (which is why
// Check Flow exists). What a chat session can't do is talk to this tool.
// So the chapter goes out as a file and comes back as pasted text, and the
// P{page}B{n} ID on every line is what maps the reply back onto regions.
// Positions never leave; import only ever fills `tl` on an ID that already
// exists. Together with OCR-only mode in pipeline.js (a chapter opens with
// no key and gets '—' placeholders), this is the no-API-key path.
//
// The same mechanism polishes an existing translation — export `tl`
// instead of `text`, under a different prompt. Nothing else changes.
//
// WHAT IT WRITES. Applied lines go through the correction UI's own
// persistence (_corrWork + _saveCorrections → mtl_corr_<chapter>_<page>),
// so they survive a reload, feed ⬇ Export Typeset through
// getEffectivePageRegions exactly like a hand edit, and appear in ✏ CORRECT
// as the current translation. Nothing here touches the mtl_ch_* cache or
// the server — this file is purely frontend.
//
// THE EXPORT RECORD. Each download saves a small manifest,
// mtl_llmx_<chapterId>: the ID set that went out and, per ID, the page,
// the region id it was numbered from, and the exact line text. That is
// what import reconciles against ("missing" means "in the export, not in
// the reply", which is only knowable if the export was recorded), and what
// lets apply verify it is writing into the SAME region that was exported
// even after ✏ CORRECT has added or deleted regions in between — B-numbers
// shift when that happens, region ids don't. With no record (another
// browser, cleared storage) import falls back to the numbers as currently
// shown, and says so in the review.

import {
  _corrSelId,
  _corrWork,
  _initWorkingRegions,
  _renderCorrOverlay,
  _renderCorrSidebar,
  _saveCorrections,
  _updatePendingButton,
} from './correction-ui.js';
import { _sanitizeForFilename, _showDownloadGuide } from './export.js';
import { _activeGlossaryKey, buildGlossaryPromptBlock } from './glossary.js';
import { _activeHistoryEntry } from './history.js';
import {
  llmxBatches,
  llmxBuildExportFile,
  llmxEntryId,
  llmxExpectedForReply,
  llmxFlattenLine,
  llmxPageRangeLabel,
  llmxParseReply,
  llmxReconcile,
} from './llm-export-format.js';
import { _pageStore } from './ocr-client.js';
import { onAfterPageRender, renderPage } from './page-render.js';
import { _activeChapterId, _manualOrder, getLangName } from './state-and-constants.js';
import { getTargetLang } from './translate-client.js';
import { esc, onAfterClearChapterState, toast } from './utils.js';

// ── Storage keys ─────────────────────────────────────────────────────────────
const LLMX_MANIFEST_PREFIX = 'mtl_llmx_';
const LLMX_MANIFEST_MAX    = 20;        // same ceiling as the chapter cache
const LLMX_OPT_MODE_KEY    = 'mtl_llmx_mode';
const LLMX_OPT_BATCH_KEY   = 'mtl_llmx_batch';
const LLMX_OPT_SKIP_KEY    = 'mtl_llmx_skip_done';

// ── The "open the AI" links ─────────────────────────────────────────────────
// A convenience, not the delivery mechanism: URLs cap out around 2–8K
// characters, so a chapter's text never fits in one. ChatGPT and Claude
// accept ?q= to pre-type a prompt; Gemini and DeepSeek do not reliably, so
// they just open. Either way the person still uploads the file, and the
// file carries its own instructions — this only saves typing an opener.
const LLMX_AI_PREFILL =
  "I'm about to upload a Markdown file. It starts with translation instructions, followed by " +
  'numbered lines like "P1B1: …". Follow the instructions in the file exactly and reply with ' +
  'ONLY the translated lines — one per entry, keeping every ID exactly as written.';
export const LLMX_AI_SITES = [
  { label: 'ChatGPT',  url: `https://chatgpt.com/?q=${encodeURIComponent(LLMX_AI_PREFILL)}` },
  { label: 'Claude',   url: `https://claude.ai/new?q=${encodeURIComponent(LLMX_AI_PREFILL)}` },
  { label: 'Gemini',   url: 'https://gemini.google.com/app' },
  { label: 'DeepSeek', url: 'https://chat.deepseek.com/' },
];

const LLMX_FLAG_LABEL = {
  duplicate: 'duplicate — last one kept',
  wrapped:   'joined a wrapped line — check it',
  unchanged: 'unchanged',
  changed:   'source edited since export',
  gone:      'region no longer exists',
};

// ── State ────────────────────────────────────────────────────────────────────
export let _llmxReview = null;   // pending review: { rec, mode, note, pageCount } or null
let _llmxRowsTimer = null;

export function _llmxPanelEl() { return document.getElementById('llm-export-panel'); }
function _llmxPanelOpen() { return !!_llmxPanelEl()?.classList.contains('active'); }

// ══════════════════════════════════════════════
// COLLECTING ENTRIES
// ══════════════════════════════════════════════

/** Pages of the active chapter that are ready to export, ascending, plus
 *  the chapter's page count. A page is ready once its translated region
 *  list exists (sortedRegions — set by the pipeline right after the page
 *  renders) or once ✏ CORRECT has already built a working set for it.
 *  autoRegions alone is NOT enough: it exists for a moment before
 *  sortedRegions does, and building _corrWork from it would freeze a
 *  '—' translation into the correction draft. */
export function _llmxReadyPages() {
  const idxs = [];
  let total = 0, sourceLang = '';
  const prefix = `${_activeChapterId}_`;
  for (const [k, pd] of _pageStore.entries()) {
    if (!k.startsWith(prefix)) continue;
    const i = parseInt(k.slice(prefix.length), 10);
    if (Number.isNaN(i)) continue;
    total = pd.total || total;
    sourceLang = sourceLang || pd.sourceLang || '';
    if (pd.sortedRegions || _corrWork[i]) idxs.push(i);
  }
  idxs.sort((a, b) => a - b);
  return { idxs, total, sourceLang };
}

/** The live (non-deleted) working regions for a page, in the order the
 *  badges show them — the correction draft if one is saved, else the
 *  pipeline's regions, exactly as ✏ CORRECT would load them. Honours a ⇅
 *  ORDER reorder so B-numbers match what is on screen. */
export function _llmxWorkingRegions(pageIdx) {
  if (!_corrWork[pageIdx]) _initWorkingRegions(pageIdx);
  const live = (_corrWork[pageIdx] || []).filter(r => !r.deleted);
  const order = _manualOrder.get(`${_activeChapterId}_${pageIdx}`);
  if (order && order.length === live.length) {
    const reordered = order.map(i => live[i]).filter(Boolean);
    if (reordered.length === live.length) return reordered;
  }
  return live;
}

/**
 * Every live region of the chapter as an entry, numbered by position:
 *   { id, page, n, p, rid, t, text, hasTl, exportable }
 * EVERY live region gets a number (even one with nothing to send) so IDs
 * stay stable across exports with different options — "only untranslated"
 * changes which lines are in the file, never what P3B2 refers to.
 *   mode 'translate' → text is the source; 'polish' → text is the current tl
 *   skipDone         → translate mode only: leave out regions that already
 *                      have a translation (the re-export after a partial
 *                      import)
 */
export function _llmxCollectEntries(mode, skipDone) {
  const { idxs, total, sourceLang } = _llmxReadyPages();
  const entries = [];
  for (const p of idxs) {
    _llmxWorkingRegions(p).forEach((r, j) => {
      const tl = (r.tl || '').trim();
      const hasTl = !!tl && tl !== '—' && tl !== '-';
      const text = llmxFlattenLine(mode === 'polish' ? (hasTl ? tl : '') : (r.text || ''));
      entries.push({
        id: llmxEntryId(p + 1, j + 1), page: p + 1, n: j + 1, p, rid: r.id,
        t: r.t || 'speech', text, hasTl,
        exportable: !!text && !(mode === 'translate' && skipDone && hasTl),
      });
    });
  }
  return { entries, total, sourceLang };
}

// ══════════════════════════════════════════════
// THE EXPORT RECORD (manifest)
// ══════════════════════════════════════════════

export function _llmxLoadManifest() {
  try {
    const raw = localStorage.getItem(LLMX_MANIFEST_PREFIX + _activeChapterId);
    const m = raw ? JSON.parse(raw) : null;
    return m && Array.isArray(m.entries) ? m : null;
  } catch { return null; }
}

export function _llmxSaveManifest(manifest) {
  try {
    const own = LLMX_MANIFEST_PREFIX + manifest.chapterId;
    const others = Object.keys(localStorage)
      .filter(k => k.startsWith(LLMX_MANIFEST_PREFIX) && k !== own)
      .map(k => { try { return [k, JSON.parse(localStorage.getItem(k))?.exportedAt || 0]; } catch { return [k, 0]; } })
      .sort((a, b) => a[1] - b[1]);
    while (others.length >= LLMX_MANIFEST_MAX) localStorage.removeItem(others.shift()[0]);
    localStorage.setItem(own, JSON.stringify(manifest));
  } catch (e) {
    console.warn('Could not save the LLM export record', e);
  }
}

// ══════════════════════════════════════════════
// OPTIONS (persisted; the panel's three controls)
// ══════════════════════════════════════════════

function _llmxOptions() {
  const mode  = document.getElementById('llmx-mode')?.value || localStorage.getItem(LLMX_OPT_MODE_KEY) || 'translate';
  const batch = parseInt(document.getElementById('llmx-batch')?.value ?? localStorage.getItem(LLMX_OPT_BATCH_KEY) ?? '0', 10) || 0;
  const skipEl = document.getElementById('llmx-skip-done');
  const skip  = skipEl ? skipEl.checked : localStorage.getItem(LLMX_OPT_SKIP_KEY) === '1';
  return { mode: mode === 'polish' ? 'polish' : 'translate', batch, skip };
}

export function _llmxOnOptionChange() {
  const { mode, batch, skip } = _llmxOptions();
  localStorage.setItem(LLMX_OPT_MODE_KEY, mode);
  localStorage.setItem(LLMX_OPT_BATCH_KEY, String(batch));
  localStorage.setItem(LLMX_OPT_SKIP_KEY, skip ? '1' : '0');
  const skipWrap = document.getElementById('llmx-skip-wrap');
  if (skipWrap) skipWrap.style.display = mode === 'polish' ? 'none' : '';
  _llmxRenderRows();
}

// ══════════════════════════════════════════════
// THE PANEL
// ══════════════════════════════════════════════

export function llmxToggle() {
  const panel = _llmxPanelEl();
  if (!panel) return;
  if (panel.classList.contains('active')) {
    panel.classList.remove('active');
    panel.innerHTML = '';
    return;
  }
  if (!_activeChapterId || !_llmxReadyPages().idxs.length) {
    toast('Nothing to export yet — wait for the chapter\'s OCR to finish. ' +
          '(An English chapter has nothing to translate.)');
    return;
  }
  panel.classList.add('active');
  _llmxBuildPanel();
  _llmxRenderRows();
  _llmxScrollPanelIntoView(panel);
}

/** The panel sits at the top of the reader, under the sticky header — but
 *  the button that opens it is IN that header, reachable from anywhere in a
 *  long chapter. Opened from page 15, the panel landed thousands of pixels
 *  above the viewport and the click looked like it did nothing: no toast,
 *  no error, nothing in the console. Scroll so the panel sits just below
 *  the header instead. Instant, not smooth: page images are often still
 *  loading, and a long smooth scroll loses to scroll anchoring as they
 *  expand — measured landing 3,500 px FURTHER down on a 23-page chapter. */
function _llmxScrollPanelIntoView(panel) {
  const header = document.querySelector('.reader-header');
  const top = panel.getBoundingClientRect().top + window.scrollY - (header?.offsetHeight || 0);
  window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
}

/** The static half of the panel — controls, textarea, buttons. Built once
 *  per open; only #llmx-rows is re-rendered afterwards, so a page finishing
 *  in the background never wipes a half-pasted reply. */
function _llmxBuildPanel() {
  const panel = _llmxPanelEl();
  const links = LLMX_AI_SITES
    .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>`)
    .join(' · ');
  panel.innerHTML = `
    <div class="export-panel-header">
      <span>🤖 TRANSLATE WITH A CHAT AI — no API key needed</span>
      <button class="export-row-btn" onclick="llmxToggle()">✕ close</button>
    </div>
    <div class="llmx-body">
      <section class="llmx-step">
        <div class="llmx-step-hdr"><span class="llmx-num">1</span> EXPORT THE TEXT</div>
        <div class="llmx-controls">
          <label>Send
            <select id="llmx-mode" class="llmx-select" onchange="_llmxOnOptionChange()">
              <option value="translate">source text → translate it</option>
              <option value="polish">current translation → polish it</option>
            </select>
          </label>
          <label>Pages per file
            <select id="llmx-batch" class="llmx-select" onchange="_llmxOnOptionChange()">
              <option value="0">whole chapter</option>
              <option value="20">20</option>
              <option value="10">10</option>
              <option value="5">5</option>
            </select>
          </label>
          <label id="llmx-skip-wrap"><input type="checkbox" id="llmx-skip-done" onchange="_llmxOnOptionChange()"> only untranslated entries</label>
        </div>
        <div class="llmx-rows" id="llmx-rows"></div>
        <div class="llmx-links">
          Upload the file to ${links} — free tiers work. The instructions are inside the file;
          a smaller "pages per file" helps if a reply gets cut off.
        </div>
      </section>
      <section class="llmx-step">
        <div class="llmx-step-hdr"><span class="llmx-num">2</span> IMPORT THE REPLY</div>
        <textarea id="llmx-reply" class="llmx-reply" spellcheck="false"
          placeholder="Paste the AI's reply here — one line per entry, like:&#10;P1B1: What is this?&#10;P1B2: *BANG*"></textarea>
        <div class="llmx-import-actions">
          <label class="export-row-btn llmx-filebtn">📄 …or pick the reply as a file<input type="file" accept=".txt,.md,text/plain,text/markdown" onchange="_llmxOnReplyFile(event)"></label>
          <button class="export-row-btn llmx-primary" onclick="llmxReview()">✓ REVIEW &amp; APPLY</button>
        </div>
        <div class="export-panel-note">Only translations are filled in — positions never leave this tool.
          A partial reply is fine: import what came back, then export again with "only untranslated entries".</div>
      </section>
    </div>`;

  // Restore the persisted options into the freshly built controls.
  const savedMode  = localStorage.getItem(LLMX_OPT_MODE_KEY);
  const savedBatch = localStorage.getItem(LLMX_OPT_BATCH_KEY);
  const modeEl  = document.getElementById('llmx-mode');
  const batchEl = document.getElementById('llmx-batch');
  if (modeEl && savedMode && [...modeEl.options].some(o => o.value === savedMode)) modeEl.value = savedMode;
  if (batchEl && savedBatch && [...batchEl.options].some(o => o.value === savedBatch)) batchEl.value = savedBatch;
  const skipEl = document.getElementById('llmx-skip-done');
  if (skipEl) skipEl.checked = localStorage.getItem(LLMX_OPT_SKIP_KEY) === '1';
  const skipWrap = document.getElementById('llmx-skip-wrap');
  if (skipWrap) skipWrap.style.display = _llmxOptions().mode === 'polish' ? 'none' : '';
}

/** One row per file (batch): what it would send, how much of that range is
 *  already translated, and its download button. This is the panel's
 *  progress view too — after a partial import the counts show exactly
 *  which files still have work outstanding. */
export function _llmxRenderRows() {
  const host = document.getElementById('llmx-rows');
  if (!host) return;
  const { mode, batch, skip } = _llmxOptions();
  const { entries, total } = _llmxCollectEntries(mode, skip);
  if (!total) { host.innerHTML = '<div class="export-panel-note">No pages ready yet.</div>'; return; }

  const batches = llmxBatches(total, batch);
  host.innerHTML = batches.map((b, i) => {
    const inRange = entries.filter(e => e.page >= b.from && e.page <= b.to);
    const send    = inRange.filter(e => e.exportable).length;
    const done    = inRange.filter(e => e.hasTl).length;
    const allDone = inRange.length > 0 && done === inRange.length;
    const label   = batches.length === 1 ? `All ${total} page${total === 1 ? '' : 's'}` : llmxPageRangeLabel(b.from, b.to);
    const meta = mode === 'polish'
      ? `${send} translated entr${send === 1 ? 'y' : 'ies'} to send`
      : `${send} entr${send === 1 ? 'y' : 'ies'} to send` +
        (inRange.length ? ` · ${done}/${inRange.length} translated` : '');
    return `<div class="export-row ${allDone ? 'export-row-done' : ''}">
      <span class="export-row-icon">${allDone ? '✓' : '⬇'}</span>
      <span class="export-row-label">${esc(label)}</span>
      <span class="llmx-row-meta">${esc(meta)}</span>
      <span class="export-row-actions">
        <button class="export-row-btn" onclick="_llmxDownloadBatch(${i})" ${send ? '' : 'disabled'}>⬇ .md</button>
      </span>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════

function _llmxChapterNames() {
  const title = _activeHistoryEntry?.title
    || document.getElementById('manga-title')?.textContent?.trim()
    || 'chapter';
  const chapterLabel = _activeHistoryEntry?.chapterLabel || '';
  return { title, chapterLabel };
}

export function _llmxDownloadBatch(batchIdx) {
  const { mode, batch, skip } = _llmxOptions();
  const { entries, total, sourceLang } = _llmxCollectEntries(mode, skip);
  const batches = llmxBatches(total, batch);
  const range = batches[batchIdx];
  if (!range) return;
  const inFile = entries.filter(e => e.exportable && e.page >= range.from && e.page <= range.to);
  if (!inFile.length) { toast('Nothing to send in that range.'); return; }

  const { title, chapterLabel } = _llmxChapterNames();
  const targetName = getTargetLang();
  const text = llmxBuildExportFile({
    mode,
    sourceName:   getLangName(sourceLang),
    targetName,
    seriesTitle:  title,
    chapterLabel,
    pageCount:    total,
    pageFrom:     range.from,
    pageTo:       range.to,
    entries:      inFile,
    // Per-series terms travel with the file, same block the API prompt gets.
    glossaryBlock: buildGlossaryPromptBlock(_activeGlossaryKey),
  });

  // Record what went out — the whole export at this batch size, not just
  // this one file, so any file's reply can be reconciled later. See the
  // file header for why the record exists at all.
  const exportable = entries.filter(e => e.exportable);
  _llmxSaveManifest({
    v: 1, chapterId: _activeChapterId, mode, sourceLang, targetLang: targetName,
    pageCount: total, batchSize: batch, exportedAt: Date.now(),
    entries: exportable.map(({ id, page, n, p, rid, t, text }) => ({ id, page, n, p, rid, t, text })),
  });

  const base  = _sanitizeForFilename([title, chapterLabel].filter(Boolean).join('_'));
  const span  = batches.length === 1 ? 'all' : (range.from === range.to ? `p${range.from}` : `p${range.from}-${range.to}`);
  const fname = `${base}_${mode}_${span}.md`;
  const blob  = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast(`Downloaded ${fname} — ${inFile.length} entr${inFile.length === 1 ? 'y' : 'ies'}. Upload it to the AI, then paste the reply below.`, 8000);
  _showDownloadGuide(fname, 'llm-export-panel');
}

// ══════════════════════════════════════════════
// IMPORT — parse, reconcile, review
// ══════════════════════════════════════════════

export function _llmxOnReplyFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  file.text()
    .then(t => {
      const ta = document.getElementById('llmx-reply');
      if (ta) ta.value = t;
      llmxReview();
    })
    .catch(e => toast(`Couldn't read that file: ${e.message}`));
}

export function llmxReview() {
  const raw = document.getElementById('llmx-reply')?.value || '';
  if (!raw.trim()) { toast('Paste the AI\'s reply first.'); return; }

  const parsed = llmxParseReply(raw);
  if (!parsed.entries.length) {
    toast('No "P3B2: text" lines found in that. Make sure you copied the AI\'s answer, not the file you uploaded.', 8000);
    return;
  }

  // What was exported — from the record if there is one, else from the
  // chapter as it stands now (positional numbering, source text).
  const manifest = _llmxLoadManifest();
  const mode = manifest?.mode === 'polish' ? 'polish' : 'translate';
  const current = _llmxCollectEntries(mode, false);
  const pageCount = manifest?.pageCount || current.total;
  let expected, note = '';
  if (manifest) {
    expected = llmxExpectedForReply(manifest.entries, parsed.entries, manifest.batchSize, manifest.pageCount);
    const when = new Date(manifest.exportedAt).toLocaleString();
    note = `Checked against the export made ${when}` +
           (manifest.batchSize && manifest.batchSize < manifest.pageCount
             ? ` (${manifest.batchSize} pages per file — measured against the file${expected.length === manifest.entries.length ? 's' : ''} this reply covers).`
             : '.');
  } else {
    expected = current.entries.filter(e => e.text);
    note = 'No export record for this chapter in this browser — matching by the P/B numbers as currently shown.';
  }

  const rec = llmxReconcile(parsed, expected, { pageCount });

  // Resolve every matched row to the live region it was exported from, and
  // say if that region has moved on since. Region id, not B-number: ✏
  // CORRECT can add or delete regions after the export, which renumbers
  // everything after them on that page.
  for (const row of rec.rows) {
    const { p, rid } = row.expected;
    if (!_corrWork[p] && _pageStore.has(`${_activeChapterId}_${p}`)) _initWorkingRegions(p);
    const region = (_corrWork[p] || []).find(r => r.id === rid && !r.deleted) || null;
    row.region = region;
    if (!region) {
      row.flags.push('gone');
    } else {
      const liveText = llmxFlattenLine(mode === 'polish' ? region.tl : region.text);
      if (liveText !== llmxFlattenLine(row.expected.text)) row.flags.push('changed');
      row.currentTl = region.tl || '';
    }
    row.selected = !!region;
  }

  _llmxReview = { rec, mode, note, pageCount };
  _llmxRenderReviewModal();
}

function _llmxSelectedCount() {
  return _llmxReview ? _llmxReview.rec.rows.filter(r => r.selected && r.region).length : 0;
}

function _llmxUpdateApplyButton() {
  const btn = document.getElementById('llmx-apply-btn');
  if (!btn) return;
  const n = _llmxSelectedCount();
  btn.disabled = n === 0;
  btn.textContent = `✓ APPLY ${n} SELECTED`;
}

/** Same component as Check Flow (flow-modal), with a checkbox per row so
 *  approval is line-by-line rather than all-or-nothing. Flagged rows are
 *  highlighted, rows whose region is gone are disabled. */
export function _llmxRenderReviewModal() {
  document.getElementById('llmx-review-modal')?.remove();
  const rv = _llmxReview;
  if (!rv) return;
  const { rec, mode, note } = rv;

  const rowsHtml = rec.rows.map((r, i) => {
    const chips = r.flags.map(f =>
      `<span class="llmx-chip ${f === 'gone' ? 'danger' : ''}">${esc(LLMX_FLAG_LABEL[f] || f)}</span>`).join('');
    const cur = (r.currentTl || '').trim();
    const showOld = cur && cur !== '—' && cur !== '-' && cur !== r.text;
    return `<label class="llmx-row ${r.flags.length ? 'flagged' : ''} ${r.region ? '' : 'gone'}">
      <input type="checkbox" ${r.selected ? 'checked' : ''} ${r.region ? '' : 'disabled'}
             onchange="_llmxToggleRow(${i}, this.checked)">
      <div class="llmx-row-main">
        <div class="llmx-row-head"><span class="llmx-id">${esc(r.id)}</span><span>page ${r.page}</span>${chips}</div>
        ${mode === 'translate' ? `<div class="llmx-src">${esc(r.expected.text)}</div>` : ''}
        <div class="llmx-diff">${showOld ? `<span class="llmx-old">${esc(cur)}</span>` : ''}<span class="llmx-new">${esc(r.text)}</span></div>
      </div>
    </label>`;
  }).join('');

  const list = (title, ids) => ids.length
    ? `<details class="llmx-list"><summary>${esc(title)} (${ids.length})</summary><code>${esc(ids.join(', '))}</code></details>`
    : '';
  const warnings = rec.warnings.map(w => `<div class="llmx-warn">⚠ ${esc(w)}</div>`).join('');
  const gone = rec.rows.filter(r => !r.region).length;

  const modal = document.createElement('div');
  modal.id = 'llmx-review-modal';
  modal.className = 'flow-modal-backdrop';
  modal.innerHTML = `
    <div class="flow-modal llmx-modal">
      <div class="flow-modal-hdr">
        <span>🤖 IMPORT — ${rec.rows.length} of ${rec.expectedCount} entr${rec.expectedCount === 1 ? 'y' : 'ies'} matched</span>
        <button class="flow-modal-close" onclick="_llmxCloseReview()">✕</button>
      </div>
      <div class="flow-modal-body">
        <div class="llmx-summary">
          <span><b>${rec.rows.length}</b> matched</span>
          <span><b>${rec.missing.length}</b> missing</span>
          <span><b>${rec.unknown.length}</b> unknown</span>
          <span><b>${rec.duplicates.length}</b> duplicate</span>
          <span><b>${rec.unchanged.length}</b> unchanged</span>
          ${gone ? `<span><b>${gone}</b> region gone</span>` : ''}
          <span>${rec.lineCount} line${rec.lineCount === 1 ? '' : 's'} read, ${rec.expectedCount} expected</span>
        </div>
        ${warnings}
        <div class="llmx-note">${esc(note)} Flagged rows are worth a look before applying.</div>
        <div class="llmx-select-row">
          <button class="export-row-btn" onclick="_llmxSelectAll(true)">select all</button>
          <button class="export-row-btn" onclick="_llmxSelectAll(false)">select none</button>
        </div>
        ${rowsHtml || '<div class="llmx-note">No line in the reply matched an entry of this export.</div>'}
        ${list('Missing — still untranslated', rec.missing)}
        ${list('Unknown IDs — ignored', rec.unknown)}
        ${list('Empty in the reply — treated as missing', rec.empty)}
      </div>
      <div class="flow-modal-footer">
        <button class="corr-btn-close" onclick="_llmxCloseReview()">DISMISS</button>
        <button class="corr-btn-retrans" id="llmx-apply-btn" onclick="_llmxApply()">✓ APPLY</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  _llmxUpdateApplyButton();
}

export function _llmxToggleRow(i, checked) {
  const row = _llmxReview?.rec.rows[i];
  if (row && row.region) row.selected = !!checked;
  _llmxUpdateApplyButton();
}

export function _llmxSelectAll(on) {
  if (!_llmxReview) return;
  _llmxReview.rec.rows.forEach(r => { if (r.region) r.selected = !!on; });
  document.querySelectorAll('#llmx-review-modal .llmx-row input[type=checkbox]:not(:disabled)')
    .forEach(cb => { cb.checked = !!on; });
  _llmxUpdateApplyButton();
}

export function _llmxCloseReview() {
  document.getElementById('llmx-review-modal')?.remove();
  _llmxReview = null;
}

// ══════════════════════════════════════════════
// APPLY
// ══════════════════════════════════════════════

/** Re-render one page after its translations changed — the same thing
 *  ✏ CORRECT does on close, or its own overlay/sidebar refresh if that page
 *  is currently open in correction mode. */
export function _llmxRefreshPage(pageIdx) {
  const card = document.getElementById(`page-${pageIdx}`);
  if (!card) return;
  if (card.classList.contains('correcting')) {
    _renderCorrOverlay(pageIdx);
    if (_corrSelId[pageIdx] != null) _renderCorrSidebar(pageIdx);
    _updatePendingButton(pageIdx);
    return;
  }
  const pd = _pageStore.get(`${_activeChapterId}_${pageIdx}`);
  if (!pd) return;
  const display = (_corrWork[pageIdx] || [])
    .filter(r => !r.deleted)
    .map(r => ({ t: r.t || 'speech', x: r.cx, y: r.cy, box: r.box, tl: r.tl || '—' }));
  renderPage(card, pageIdx, pd.total, pd.imgSrc, display);
}

/** Write the approved rows into their regions and persist through the
 *  correction UI's own path. Only ever sets `tl` on a region that already
 *  exists — never creates, moves or deletes one. */
export function _llmxApply() {
  const rv = _llmxReview;
  if (!rv) return;
  const dirty = new Set();
  let applied = 0;
  for (const row of rv.rec.rows) {
    if (!row.selected || !row.region) continue;
    row.region.tl = row.text;
    dirty.add(row.expected.p);
    applied++;
  }
  if (!applied) { toast('Nothing selected.'); return; }
  for (const p of dirty) {
    _saveCorrections(p);
    _llmxRefreshPage(p);
  }
  _llmxCloseReview();

  // What is still untranslated now — counted from the regions themselves,
  // not from the reply's missing list, since an unticked row leaves its
  // region untranslated too. After a partial import, the natural next
  // export is "just what's left", so pre-tick that option.
  const left = _llmxCollectEntries('translate', false).entries.filter(e => e.text && !e.hasTl).length;
  if (left && rv.mode === 'translate') {
    const skipEl = document.getElementById('llmx-skip-done');
    if (skipEl) skipEl.checked = true;
    localStorage.setItem(LLMX_OPT_SKIP_KEY, '1');
  }
  _llmxRenderRows();
  toast(`Applied ${applied} translation${applied === 1 ? '' : 's'} on ${dirty.size} page${dirty.size === 1 ? '' : 's'}.` +
        (left ? ` ${left} entr${left === 1 ? 'y is' : 'ies are'} still untranslated — export again to send just those.` : ''), 8000);
}

// ══════════════════════════════════════════════
// LIFECYCLE
// ══════════════════════════════════════════════

/** Per-chapter state has to go when the chapter does. */
export function llmxResetForChapter() {
  _llmxCloseReview();
  const panel = _llmxPanelEl();
  if (panel) { panel.classList.remove('active'); panel.innerHTML = ''; }
}

onAfterClearChapterState(llmxResetForChapter);

// Keep the file rows current while pages finish behind an open panel.
// Deferred, not inline: this hook fires from inside renderPage(), and the
// pipeline assigns a page's sortedRegions right AFTER renderPage() returns
// — see _llmxReadyPages for why the rows must not be built before then.
onAfterPageRender(() => {
  if (!_llmxPanelOpen()) return;
  clearTimeout(_llmxRowsTimer);
  _llmxRowsTimer = setTimeout(_llmxRenderRows, 150);
});
