// ═══════════════════════════════════════════════════════════════
// history.js
// "Continue reading" — remembers what was read, how far, and how to get
// back to it, across MangaDex, Suwayomi, and local/CBZ sources.
//
// WHY NOT mtl_ch_* (cache.js)?  The chapter cache is an OCR/translation
// cost-saving cache, not a reading log — its timestamp is only set on a
// FRESH translate (never touched on a plain re-visit), and entries expire
// after CACHE_TTL regardless of whether the person still wants to resume
// that chapter. Reading history needs its own storage with its own rules:
// lastReadAt updates on every visit, and entries don't expire on a timer
// (see HIST_MAX below for the actual eviction rule).
//
// RESUME BY SOURCE KIND — the three pipeline entry points in pipeline.js
// need fundamentally different information to restart:
//   mangadex  — just the chapterId (a stable MangaDex UUID); startPipelineWithId
//               re-fetches meta/pages itself, so resume.chapterId is enough.
//   suwayomi  — chapter.id is a composite `suwayomi:<mangaId>:<chapterIndex>`
//               string (see suwayomi-api.js's chapterFromSuwayomi) with no
//               separate real URL — resume needs mangaId/chapterIndex pulled
//               back out of it, then chapterFromSuwayomi() +
//               startPipelineWithSuwayomiSource() to actually restart.
//   local     — genuinely NOT resumable. A local folder/CBZ chapter is built
//               from real File/Blob handles the OS handed the browser once
//               (see local-source.js's chapterFromFileList/chapterFromCbz) —
//               there is no URL to refetch and no browser API to
//               programmatically reopen the SAME file. What we CAN do:
//               remember which kind of picker (folder vs .cbz) was used and
//               jump straight to that picker on click, saving a menu dig —
//               but the person still has to reselect the file themselves.
//               See resumeHistoryEntry()'s 'local' branch.
// ═══════════════════════════════════════════════════════════════

import { triggerLocalCbzPicker, triggerLocalFolderPicker } from './local-source.js';
import { startPipelineWithId, startPipelineWithSuwayomiSource } from './pipeline.js';
import { _activeChapterId } from './state-and-constants.js';
import { chapterFromSuwayomi } from './suwayomi-api.js';
import { esc, toast } from './utils.js';

export const HIST_PREFIX = 'mtl_hist_';
export const HIST_MAX    = 40;   // proactive entry-count cap, same shape as CACHE_MAX
export const HIST_V      = 1;

// ── Storage ───────────────────────────────────────────────────────
export function _listHistoryEntries() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(HIST_PREFIX));
  const out = [];
  for (const k of keys) {
    try {
      const d = JSON.parse(localStorage.getItem(k));
      if ((d.v ?? 1) < HIST_V || !d.resume) continue;  // corrupt/unversioned — skip
      out.push(d);
    } catch { /* skip corrupt entry */ }
  }
  out.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  return out;
}

export function _historyKey(chapterId) { return HIST_PREFIX + chapterId; }

/**
 * Write/update one history entry. Called on chapter start (page 0, so the
 * entry exists immediately rather than only appearing once a scroll event
 * fires — a person who opens a chapter and leaves within a second should
 * still see it in history) and again on every progress update.
 */
export function _saveHistoryEntry(entry) {
  const key = _historyKey(entry.chapterId);
  const getKeys = () => Object.keys(localStorage).filter(k => k.startsWith(HIST_PREFIX));
  let keys = getKeys();
  if (!keys.includes(key)) {
    // Evict the least-recently-read entry, not insertion order — unlike
    // glossary.js's eviction (no per-entry recency signal available
    // there), history always has lastReadAt, so we can evict correctly
    // rather than approximately.
    while (keys.length >= HIST_MAX) {
      let oldestKey = null, oldestTime = Infinity;
      for (const k of keys) {
        try {
          const t = JSON.parse(localStorage.getItem(k))?.lastReadAt ?? 0;
          if (t < oldestTime) { oldestTime = t; oldestKey = k; }
        } catch { oldestKey = k; break; }  // corrupt entry — evict it first
      }
      if (!oldestKey) break;
      localStorage.removeItem(oldestKey);
      keys = getKeys();
    }
  }
  try {
    localStorage.setItem(key, JSON.stringify({ ...entry, v: HIST_V }));
  } catch {
    // Quota exceeded with nothing left worth evicting — give up quietly,
    // same posture cache.js/glossary.js take rather than crash the reader
    // over a localStorage write for a non-critical feature.
  }
}

export function removeHistoryEntry(chapterId) {
  localStorage.removeItem(_historyKey(chapterId));
  _renderHistoryUI();
}

export function clearAllHistory() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(HIST_PREFIX));
  if (!keys.length) return;
  if (!confirm(`Clear all ${keys.length} reading history entries? This can't be undone.`)) return;
  keys.forEach(k => localStorage.removeItem(k));
  toast('Reading history cleared.');
  _renderHistoryUI();
}

// ── Active-chapter tracking ─────────────────────────────────────────
// Mirrors _activeChapterId/_activeGlossaryKey's module-level-variable
// pattern (state-and-constants.js / glossary.js) for the same reason:
// scroll/progress events fire from page-render.js and paint-brush.js-
// adjacent code with no `meta` in scope, only whichever chapter is
// currently open.
export let _activeHistoryEntry = null;   // the entry object currently being kept up to date
export let _historyObserver    = null;
export let _historySaveTimer    = null;

/**
 * Called once per chapter load from _runChapterPipeline (pipeline.js),
 * right after addSkeleton() has created every .page-card for the chapter
 * — see that call site for why this specific point (after skeletons
 * exist, before any of the three render branches run) is the one choke
 * point common to all of them.
 *
 * `resume` is the kind-specific descriptor built by whichever of
 * startPipelineWithId/startPipelineWithLocalSource/
 * startPipelineWithSuwayomiSource is currently running — see this file's
 * header comment for what each kind actually needs.
 */
export function startHistoryTracking({ chapterId, resume, title, chapterLabel, targetLang, pageCount }) {
  _stopHistoryTracking();  // tear down whatever was watching the previous chapter first

  _activeHistoryEntry = {
    chapterId, resume, title, chapterLabel, targetLang, pageCount,
    pageIdx: 0,
    lastReadAt: Date.now(),
  };
  _saveHistoryEntry(_activeHistoryEntry);   // write immediately — see _saveHistoryEntry's doc comment
  _renderHistoryUI();

  // Observe every .page-card at once — page-render.js/pipeline.js create
  // them all upfront (addSkeleton loop) regardless of which of the three
  // render branches (English-passthrough / cache-hit / full OCR) fills
  // each one in afterward, and img loading="lazy" is browser-native lazy
  // IMAGE loading, not virtual-DOM unmounting — every card stays a real,
  // observable element for the whole session. See this file's header for
  // why the reader has no existing "current page" concept to read instead.
  const cards = document.querySelectorAll('#pages-container .page-card');
  if (!cards.length) return;

  // "Most visible card" wins, not "first intersecting card" — on a fast
  // flick-scroll several cards can be simultaneously (barely) intersecting;
  // intersectionRatio picks whichever one is actually dominant on screen,
  // which is what a person would call "the page I'm on" if asked.
  _historyObserver = new IntersectionObserver(_onHistoryIntersect, {
    threshold: [0, 0.25, 0.5, 0.75, 1],
  });
  cards.forEach(c => _historyObserver.observe(c));
}

export function _stopHistoryTracking() {
  if (_historyObserver) { _historyObserver.disconnect(); _historyObserver = null; }
  if (_historySaveTimer) { clearTimeout(_historySaveTimer); _historySaveTimer = null; }
  _activeHistoryEntry = null;
}

export function _onHistoryIntersect(entries) {
  if (!_activeHistoryEntry) return;
  let best = null, bestRatio = 0;
  for (const e of entries) {
    if (e.intersectionRatio > bestRatio) { bestRatio = e.intersectionRatio; best = e.target; }
  }
  if (!best) return;
  const idx = Array.from(document.querySelectorAll('#pages-container .page-card')).indexOf(best);
  if (idx < 0 || idx === _activeHistoryEntry.pageIdx) return;
  _activeHistoryEntry.pageIdx = idx;
  // Debounced — a fast scroll through many pages would otherwise fire a
  // localStorage write per page, and localStorage writes are synchronous
  // (can janker a scroll on slower machines). 1.5s of no further scroll
  // movement is "settled enough" to count as the page someone is actually
  // reading, not just passing through.
  if (_historySaveTimer) clearTimeout(_historySaveTimer);
  _historySaveTimer = setTimeout(() => {
    if (!_activeHistoryEntry) return;
    _activeHistoryEntry.lastReadAt = Date.now();
    _saveHistoryEntry(_activeHistoryEntry);
    _renderHistoryUI();
  }, 1500);
}

/** Called from goBack() (utils.js) and the beforeunload safety net below —
 * flushes the current page position immediately rather than waiting for
 * the debounce timer, so leaving right after a scroll doesn't lose the
 * last few pages of progress. */
export function flushHistoryProgress() {
  if (!_activeHistoryEntry) return;
  if (_historySaveTimer) { clearTimeout(_historySaveTimer); _historySaveTimer = null; }
  _activeHistoryEntry.lastReadAt = Date.now();
  _saveHistoryEntry(_activeHistoryEntry);
}
window.addEventListener('beforeunload', flushHistoryProgress);

// ── Resume ────────────────────────────────────────────────────────
/**
 * Entry point for every history click (home strip, home library list,
 * reader-header dropdown — see the three render functions below). Reads
 * resume.kind and does whatever that source needs; see this file's header
 * comment for the constraints behind each branch, especially 'local'.
 */
export function resumeHistoryEntry(chapterId) {
  const raw = localStorage.getItem(_historyKey(chapterId));
  if (!raw) { toast('That history entry is gone.'); _renderHistoryUI(); return; }
  let entry;
  try { entry = JSON.parse(raw); } catch { toast('That history entry is corrupted.'); return; }
  _dispatchResume(entry.resume, entry);
}

/**
 * The actual "reopen this chapter" logic, factored out of
 * resumeHistoryEntry() so downloads.js's cached-chapters list (a
 * DIFFERENT localStorage store — mtl_ch_*, not mtl_hist_*, see cache.js)
 * can resume a chapter the exact same way without a second copy of this
 * branching. Takes `resume`/`entry` directly rather than a chapterId —
 * resumeHistoryEntry loads them from mtl_hist_*; openCachedChapter
 * (downloads.js) builds an equivalent pair on the fly from mtl_ch_*'s own
 * stored `meta`, since a cache entry was never written through
 * startHistoryTracking() and may not have a matching history entry at all
 * (e.g. history was cleared, or CACHE_TTL/HIST_MAX evicted one but not
 * the other — the two stores are independent, see this file's header for
 * why history isn't just built on top of the cache).
 */
export function _dispatchResume(r, entry) {
  if (r.kind === 'mangadex') {
    startPipelineWithId(r.chapterId, null, entry.targetLang);
  } else if (r.kind === 'suwayomi') {
    toast('Fetching from Suwayomi…', 3000);
    chapterFromSuwayomi(r.mangaId, r.chapterIndex, r.sourceLang)
      .then(chapter => startPipelineWithSuwayomiSource(chapter, entry.targetLang))
      .catch(e => toast(e.message));
  } else if (r.kind === 'local') {
    // Genuinely can't reopen the same file — see header comment. Best
    // available: jump straight to the right OS picker (folder vs .cbz)
    // instead of making the person hunt through the collapsed "Local
    // Folder / CBZ" section themselves.
    toast(`Reselect "${entry.title}" (${entry.chapterLabel || 'saved chapter'}) to resume — ` +
          `browsers can't reopen a local file automatically.`, 5000);
    document.getElementById('local-source-wrap')?.classList.add('open');
    if (r.sourceKind === 'cbz') triggerLocalCbzPicker();
    else triggerLocalFolderPicker();
  } else {
    toast('Unrecognized history entry.');
  }
}

// ── UI: home "Continue Reading" card (single most-recent entry) ────
export function _renderContinueReadingCard() {
  const wrap = document.getElementById('continue-reading-card');
  if (!wrap) return;
  const [latest] = _listHistoryEntries();
  if (!latest) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }

  const pct = latest.pageCount > 1
    ? Math.round(((latest.pageIdx + 1) / latest.pageCount) * 100) : null;
  wrap.style.display = '';
  wrap.innerHTML = `
    <div class="continue-reading-inner" onclick="resumeHistoryEntry('${esc(latest.chapterId)}')">
      <div class="continue-reading-label">CONTINUE READING</div>
      <div class="continue-reading-title">${esc(latest.title)}</div>
      <div class="continue-reading-sub">
        ${esc(latest.chapterLabel || '')}
        ${pct !== null ? ` &nbsp;·&nbsp; page ${latest.pageIdx + 1}/${latest.pageCount} (${pct}%)` : ''}
        &nbsp;·&nbsp; ${_fmtRelativeTime(latest.lastReadAt)}
      </div>
      ${pct !== null ? `<div class="continue-reading-bar"><div style="width:${pct}%"></div></div>` : ''}
    </div>`;
}

// ── UI: home "Recently read" list (a handful of entries, chlist-row styling) ──
export function _renderHistoryLibraryList() {
  const wrap = document.getElementById('home-history-list');
  const header = document.getElementById('home-history-header');
  if (!wrap) return;
  const entries = _listHistoryEntries().slice(0, 8);  // most-recent-first, capped for home-screen scan-ability
  if (!entries.length) {
    wrap.innerHTML = ''; wrap.style.display = 'none';
    if (header) header.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  if (header) header.style.display = '';
  wrap.innerHTML = entries.map(e => {
    const pct = e.pageCount > 1 ? Math.round(((e.pageIdx + 1) / e.pageCount) * 100) : null;
    return `
    <div class="chlist-row hist-row" onclick="resumeHistoryEntry('${esc(e.chapterId)}')">
      <div class="chlist-info">
        <div class="chlist-title">${esc(e.title)}</div>
        <div class="chlist-sub">${esc(e.chapterLabel || '')}
          ${pct !== null ? `&nbsp;·&nbsp; ${pct}% read` : ''}
          &nbsp;·&nbsp; ${_fmtRelativeTime(e.lastReadAt)}</div>
      </div>
      <button class="chlist-dl-btn" title="Remove from history"
        onclick="event.stopPropagation(); removeHistoryEntry('${esc(e.chapterId)}')">✕</button>
    </div>`;
  }).join('');
}

// ── UI: reader-header "Recent" dropdown ─────────────────────────────
export function toggleRecentDropdown() {
  const existing = document.getElementById('recent-dropdown');
  if (existing) { existing.remove(); return; }

  const entries = _listHistoryEntries().slice(0, 8);
  const dd = document.createElement('div');
  dd.id = 'recent-dropdown';
  dd.className = 'recent-dropdown';
  dd.innerHTML = entries.length
    ? entries.map(e => {
        const pct = e.pageCount > 1 ? Math.round(((e.pageIdx + 1) / e.pageCount) * 100) : null;
        const isCurrent = e.chapterId === _activeChapterId;
        return `
        <div class="recent-dropdown-row${isCurrent ? ' current' : ''}"
          onclick="${isCurrent ? '' : `resumeHistoryEntry('${esc(e.chapterId)}'); toggleRecentDropdown();`}">
          <div class="chlist-title">${esc(e.title)}${isCurrent ? ' <span style="opacity:0.6">(current)</span>' : ''}</div>
          <div class="chlist-sub">${esc(e.chapterLabel || '')}
            ${pct !== null ? `&nbsp;·&nbsp; ${pct}%` : ''}</div>
        </div>`;
      }).join('')
    : '<div class="corr-empty-hint">No reading history yet.</div>';
  document.body.appendChild(dd);

  // Position under the trigger button, dismiss on outside click — same
  // lightweight anchored-panel pattern as nothing else in this codebase
  // quite needed yet (existing overlays are either full modals or fixed
  // toolbars), so this is new but intentionally minimal: no library, just
  // a positioned div + one document-level click listener that removes
  // itself once fired.
  const btn = document.getElementById('btn-recent');
  if (btn) {
    const r = btn.getBoundingClientRect();
    dd.style.top  = `${r.bottom + window.scrollY + 6}px`;
    dd.style.right = `${window.innerWidth - r.right}px`;
  }
  setTimeout(() => {
    document.addEventListener('click', function onDocClick(ev) {
      if (!dd.contains(ev.target) && ev.target.id !== 'btn-recent') {
        dd.remove();
        document.removeEventListener('click', onDocClick);
      }
    });
  }, 0);
}

export function _renderHistoryUI() {
  _renderContinueReadingCard();
  _renderHistoryLibraryList();
}

// ── Small formatting helper ──────────────────────────────────────
export function _fmtRelativeTime(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7)   return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}
