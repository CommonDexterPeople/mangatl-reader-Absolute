// ═══════════════════════════════════════════════════════════════
// utils.js
// Small shared helpers: runConcurrent (worker-pool), show/toast/status,
// esc() HTML-escaping, and top-level nav (back/prev/next).
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// GEMINI RATE LIMITER  (sliding-window, real RPM enforcement)
// ══════════════════════════════════════════════
// WHY THIS EXISTS: runConcurrent's worker-pool `limit` bounds how many
// page-tasks are in flight at once, but that is NOT the same thing as
// bounding requests-per-minute. Each page task can fire up to two separate
// Gemini calls (Vision OCR, then translate) in sequence, and 3 concurrent
// workers each completing a page every ~2-4 real-world seconds realistically
// bursts to 30-40+ Gemini calls inside any given 60-second window — well
// past the free tier's ~15 RPM ceiling, independent of the ~1,000-1,500 RPD
// daily cap entirely. Concurrency and rate are different axes; this file
// only had a concurrency limiter before, which is why free-tier chapters
// were silently falling back from Vision to EasyOCR mid-chapter (see
// server.py's /ocr route: a 429 from Gemini triggers an immediate,
// un-retried fallback to EasyOCR for that page) even well under the daily
// request budget.
//
// This limiter is Gemini-specific, not global — DeepSeek and EasyOCR calls
// have their own, completely separate quotas (DeepSeek's own RPM limits;
// EasyOCR has none, it's local) and would be wrongly slowed down by a
// limiter that didn't distinguish. Callers opt in explicitly by calling
// waitForGeminiSlot() only at the point where a call is actually about to
// hit Gemini's API — see ocr-client.js's ocrPage() and
// translate-client.js's translateBatch() for the two call sites.
//
// RPM_LIMIT is set conservatively below the commonly-cited 15 RPM free-tier
// ceiling (not at it) because: (1) published free-tier numbers vary by
// model and have changed more than once through 2026 per multiple
// independent trackers, so treating 15 as an exact, stable number is
// itself optimistic; (2) this is a sliding window, not the fixed clock-
// minute buckets Google's own limiter almost certainly uses internally, so
// a same-day published "15 RPM" doesn't guarantee 15 successful calls in
// every possible rolling 60s window even if this limiter's math is
// otherwise correct.
import { refreshCacheUI } from './cache.js';
import { _corrMode, _corrOverlayCtl, _corrSelId, _corrWork } from './correction-ui.js';
import { _renderHistoryUI, _stopHistoryTracking, flushHistoryProgress } from './history.js';
import { clearLocalBlobStore } from './local-source.js';
import { _pageStore, hideEngineRecBanner, setChapterEngineOverride, setEngineRecShown } from './ocr-client.js';
import { startPipelineWithId } from './pipeline.js';
import {
  _manualOrder,
  abortController,
  cancelled,
  nextChapterId,
  prevChapterId,
  setCancelled,
  setToastTimer,
  toastTimer,
} from './state-and-constants.js';

export const GEMINI_RPM_LIMIT = 12;
export let _geminiCallTimestamps = [];  // ms epoch times of recent Gemini-bound calls

export async function waitForGeminiSlot() {
  const now = Date.now();
  // Drop timestamps older than the window — they no longer count against the limit.
  _geminiCallTimestamps = _geminiCallTimestamps.filter(t => now - t < 60_000);

  if (_geminiCallTimestamps.length >= GEMINI_RPM_LIMIT) {
    // Wait until the OLDEST call in the window ages out, not a flat delay —
    // this lets a slot free up as soon as it genuinely does, rather than
    // always waiting a full extra minute regardless of how close the
    // oldest call already is to expiring.
    const oldest = _geminiCallTimestamps[0];
    const waitMs = 60_000 - (now - oldest) + 250;  // +250ms safety margin
    await new Promise(r => setTimeout(r, waitMs));
    return waitForGeminiSlot();  // re-check after waiting — another task may have taken the freed slot
  }

  // Reserve this slot BEFORE the caller's fetch actually fires, not after it
  // resolves — reserving late would let a burst of already-in-flight calls
  // all pass the check simultaneously right as a slot opens up.
  _geminiCallTimestamps.push(now);
}

// ══════════════════════════════════════════════
// CONCURRENCY  (3 pages in parallel)           // FIX #4: removed stale Gemini comment
// ══════════════════════════════════════════════
// NOTE: this bounds how many pages are worked on at once, not how many
// Gemini calls happen per minute — those are enforced separately by
// waitForGeminiSlot() above, at the exact point a call is about to hit
// Gemini's API. Keeping worker concurrency at 3 is still fine with the RPM
// limiter in place: extra workers just end up waiting at
// waitForGeminiSlot() together rather than each freely bursting requests,
// so this number mostly affects how many pages are "in progress" (OCR
// done, waiting on a translate slot, etc.) rather than actual request rate.
// NOTE: isCancelled defaults to checking the reader's global `cancelled`
// flag (state-and-constants.js) — every call site before queue.js existed
// relied on exactly that default, so it's kept as the default rather than
// a required param to avoid touching every existing caller. queue.js
// passes its own per-run flag instead (see _ocrTranslatePages in
// pipeline.js for why a shared global would be wrong for a background
// queue specifically).
export async function runConcurrent(taskFns, limit = 3, isCancelled = () => cancelled) {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < taskFns.length && !isCancelled()) {
      const i = nextIdx++;
      await taskFns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, taskFns.length) }, worker));
}

// ══════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════
export function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
export function toast(msg, dur = 6000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  setToastTimer(setTimeout(() => { t.style.display = 'none'; }, dur));
}
export function setStatus(msg) { document.getElementById('reader-status').textContent = msg; }
export function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
}
export function esc(s) {
  // Escapes ' → &#39; too, not just " → &quot; — nothing in this codebase
  // currently interpolates esc() into a single-quoted HTML attribute
  // (grepped for `='${esc(` and found none), but this is defense-in-depth:
  // the day someone writes value='${esc(x)}' instead of "..." this stops
  // it from silently reopening the exact stored-XSS class the pipeline.js
  // scanlation-group-name fix (see that file) already had to close once.
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Release all per-chapter in-memory state — OCR data, corrections, manual
// order, in-flight local-source blobs, and any correction-UI DOM controller
// handles. Called both by goBack() (returning to the home screen) AND at
// the start of every chapter load (startPipelineWithId /
// startPipelineWithLocalSource / startPipelineWithSuwayomiSource).
//
// WHY THIS NEEDS TO RUN ON EVERY CHAPTER LOAD, NOT JUST goBack(): the
// prev/next chapter buttons (goToChapter → startPipelineWithId) and
// re-translating a pasted URL both change _activeChapterId WITHOUT ever
// calling goBack() — so before this fix, _pageStore/_manualOrder/_corrWork
// kept accumulating entries from every chapter visited in a session,
// keyed by `${chapterId}_${pageIdx}`, and were never released until the
// user explicitly went back to the home screen (if ever, in a long
// reading session). Different chapter IDs don't collide with each other
// as Map keys, so this was primarily a memory leak — BUT if the same
// chapter ID was revisited later in the same session (e.g. going forward
// through a series then using "prev" back to one already translated
// earlier), stale in-memory entries from the FIRST visit could still be
// present under that exact key, independent of whatever a fresh re-fetch
// was doing. Clearing this at the start of every chapter load, not just
// on an explicit return to the home screen, closes that gap entirely
// rather than relying on the correction-draft signature check (see
// _corrSourceSignature in correction-ui.js) to catch it after the fact.
export function _clearChapterState() {
  _pageStore.clear();
  _manualOrder.clear();
  clearLocalBlobStore();
  Object.values(_corrOverlayCtl).forEach(ctl => ctl?.detach());
  Object.keys(_corrOverlayCtl).forEach(k => delete _corrOverlayCtl[k]);
  Object.keys(_corrWork).forEach(k => delete _corrWork[k]);
  Object.keys(_corrMode).forEach(k => delete _corrMode[k]);
  Object.keys(_corrSelId).forEach(k => delete _corrSelId[k]);
  // See ocr-client.js — "switch just this chapter" from the engine
  // recommendation banner, and whether that banner has already been shown
  // once for this chapter (a multi-page chapter shouldn't re-prompt on
  // every page). Both deliberately in-memory, not localStorage — this is
  // a per-session override, not a persisted preference; "always use my
  // pick for <lang>" (mtl_local_engine_always) is the persisted one.
  setChapterEngineOverride(null);
  setEngineRecShown(false);
  hideEngineRecBanner();
}

export function goBack() {
  setCancelled(true);
  if (abortController) abortController.abort();
  flushHistoryProgress();  // save final page position before it's gone — see history.js
  _stopHistoryTracking();  // stop watching .page-card elements about to be removed below
  _clearChapterState();
  document.getElementById('pages-container').innerHTML = '';
  show('screen-home');
  refreshCacheUI();  // refresh home strip when returning
  _renderHistoryUI(); // refresh the Continue Reading card / recent list too
}

// ── Chapter navigation ──────────────────────
export function updateNavButtons() {
  const bar = document.getElementById('nav-bar');
  const p   = document.getElementById('btn-prev');
  const n   = document.getElementById('btn-next');
  const has = prevChapterId || nextChapterId;
  bar.style.display     = has ? 'flex' : 'none';
  p.style.visibility    = prevChapterId ? 'visible' : 'hidden';
  p.style.pointerEvents = prevChapterId ? 'auto'    : 'none';
  n.style.visibility    = nextChapterId ? 'visible' : 'hidden';
  n.style.pointerEvents = nextChapterId ? 'auto'    : 'none';
}
export function goToPrev() { if (prevChapterId) goToChapter(prevChapterId); }
export function goToNext() { if (nextChapterId) goToChapter(nextChapterId); }
export function goToChapter(chapterId) {
  if (!chapterId) return;
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.getElementById('chapter-url').value = `https://mangadex.org/chapter/${chapterId}`;
  startPipelineWithId(chapterId);
}


// ══════════════════════════════════════════════
// AI INPAINT SETTING  (shared read helper — export.js + erase-tool.js)
// ══════════════════════════════════════════════
// Per-request opt-in, not a server-wide config flag — see server.py's
// /export-page docstring. Two sources, same precedence pattern
// _resolveLocalEngine() already uses for OCR engine choice: an explicit
// per-page toolbar control (when present on screen — currently only the
// Erase Tool's #erase-ai-inpaint select) wins over the settings-panel
// default stored in localStorage, so a person actively looking at the
// toolbar always sees/controls exactly what they're about to send.
export function getAiInpaintSetting() {
  const toolbarEl = document.getElementById('erase-ai-inpaint');
  if (toolbarEl) return toolbarEl.value === 'on';
  return localStorage.getItem('mtl_ai_inpaint') === 'on';
}
