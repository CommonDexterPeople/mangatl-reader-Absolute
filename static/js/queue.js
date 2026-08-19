// ═══════════════════════════════════════════════════════════════
// queue.js
// Batch-translate several upcoming chapters unattended ("translate the
// next 5 chapters overnight") — for someone catching up on a dropped
// series who doesn't want to babysit one chapter at a time in the reader.
//
// WHAT THIS ACTUALLY DOES: runs the same OCR+translate work the reader
// does (via pipeline.js's _ocrTranslatePages — see that function's own
// doc comment for why it was extracted specifically to make this
// possible) for each queued chapter, HEADLESS — no rendering, no
// skeletons, no live reader screen involved at all — then writes the
// result straight to the chapter cache (setCachedChapter, same call
// _runChapterPipeline itself makes). The chapters just show up in the
// "Cached chapters" list (downloads.js) afterward, openable instantly —
// see openCachedChapter() there — or downloadable as a zip, exactly like
// any chapter that was read normally. This file adds no new way to VIEW
// a chapter, only a way to have the OCR/translate work already done and
// waiting by the time you want to read it.
//
// WHY NOT startPipelineWithId() IN A LOOP: that function drives the live
// reader screen (skeletons, DOM rendering, glossary/history state tied to
// "the ONE chapter currently open") — running it repeatedly in the
// background for chapters nobody is looking at would fight the reader's
// own single-active-chapter assumptions (glossary.js's
// _activeGlossaryKey, history.js's _activeHistoryEntry, _pageStore keyed
// by _activeChapterId) the moment someone actually opened a DIFFERENT
// chapter while the queue was still running. See _dispatchResume /
// startHistoryTracking for the same "reader globals are for the ONE open
// chapter" pattern this file deliberately stays out of.
//
// SEQUENTIAL, NOT PARALLEL, ACROSS CHAPTERS: _ocrTranslatePages already
// runs a chapter's own pages 3-at-a-time internally (runConcurrent). This
// file runs CHAPTERS one after another, not several chapters' page-batches
// interleaved — simpler to reason about, keeps a predictable relationship
// between "budget hit" and "which chapter it happened on", and avoids
// multiplying concurrent API load unpredictably for something meant to
// run unattended.
//
// BUDGET IS MANDATORY, NOT OPTIONAL: earlier versions let the budget field
// be left blank for "no limit". Removed — this feature exists specifically
// to run unattended overnight, and most providers (Gemini/DeepSeek
// included) do not stop billing on their own when a prepaid balance or
// card runs dry; they keep accepting and billing requests. A queue with no
// cap left running against a long series is real, uncapped financial
// exposure with nobody watching, not a convenience default worth keeping
// around. The budget check itself was also previously only evaluated
// between CHAPTERS (see startQueue's main loop below) — for a single long
// chapter that's a wide-open gap, so it's now additionally checked before
// every individual PAGE too, via the same isCancelled() hook
// _ocrTranslatePages already threads through runConcurrent for cancellation
// — see _makeBudgetAwareIsCancelled below. Neither check is a hard,
// airtight ceiling: cost is only known AFTER a call returns (real token
// usage from the response, see cost-tracker.js's recordUsage), so a call
// already in flight at the moment the budget is crossed still completes
// and still bills. Both checks only stop NEW work from being launched —
// the UI copy in openQueueSetup says this explicitly rather than implying
// a guarantee that isn't real.
import { getCachedChapter, refreshCacheUI, setCachedChapter } from './cache.js';
import { _fmtCost, _readLifetime } from './cost-tracker.js';
import { _getMangaFeed, fetchChapterMeta, fetchPageUrls, parseChapterId } from './mangadex-api.js';
import { _ocrTranslatePages, _validateApiKeyOrToast } from './pipeline.js';
import { cancelled, getLangName } from './state-and-constants.js';
import { getTargetLang } from './translate-client.js';
import { esc, toast } from './utils.js';

export const _QUEUE_DEFAULT_BUDGET = 3.00;

export let _queueRun = null;  // { items:[{chapterId,label,status,error?}], cancelled, budgetLimit (always a positive number — see _QUEUE_DEFAULT_BUDGET), startLifetimeCost }

export function _queuePanelEl() { return document.getElementById('home-queue-panel'); }

/**
 * Builds the list of chapters to queue: starting from `fromChapterId`,
 * walks forward through that manga's own chapter feed (same feed
 * fetchAdjacentChapters/mangadex-api.js already uses for prev/next nav)
 * and takes the next `count` chapters after it.
 *
 * Returns [] (with a toast explaining why) rather than throwing, for
 * every case that isn't "here's a valid list" — a bad/foreign chapter id,
 * a chapter with no manga relationship, or one already at the end of its
 * feed — so the caller (openQueueSetup below) can just check .length
 * instead of wrapping every call in try/catch.
 */
export async function resolveNextChapters(fromChapterId, count, signal) {
  let meta;
  try {
    meta = await fetchChapterMeta(fromChapterId, signal);
  } catch (e) {
    toast(`Could not look up that chapter: ${e.message}`);
    return [];
  }
  if (!meta.mangaId) {
    toast('Could not resolve this chapter to a manga — cannot find its next chapters.');
    return [];
  }

  let feed;
  try {
    feed = await _getMangaFeed(meta.mangaId, meta.translatedLanguage, signal);
  } catch (e) {
    toast(`Could not load the chapter feed: ${e.message}`);
    return [];
  }

  const idx = feed.findIndex(ch => ch.id === fromChapterId);
  if (idx === -1) {
    toast('Could not find this chapter in its own manga feed (unusual — try again?).');
    return [];
  }
  const upcoming = feed.slice(idx + 1, idx + 1 + count);
  if (!upcoming.length) {
    toast(`"${meta.mangaTitle}" has no chapters after this one in ${getLangName(meta.translatedLanguage)}.`);
    return [];
  }

  return upcoming.map(ch => ({
    chapterId: ch.id,
    label: `${meta.mangaTitle} · Ch. ${ch.attributes?.chapter ?? '?'}`,
    mangaId: meta.mangaId,
    sourceLang: meta.translatedLanguage,
  }));
}

// ── Setup panel: pick count + optional budget, before anything runs ──
/**
 * Small setup step rather than firing the queue immediately on button
 * click — a person needs to see (and possibly correct) how many chapters
 * and what budget before several dollars of API calls start unattended.
 * Reuses the .flow-modal-backdrop/.flow-modal shell (see glossary.js's
 * openGlossaryModal for the same pattern) rather than a full new modal
 * system for a two-field form.
 */
export async function openQueueSetup() {
  if (_queueRun) { toast('A queue is already running — cancel it first to start a new one.'); return; }
  const rawUrl = document.getElementById('chapter-url').value.trim();
  if (!rawUrl) { toast('Paste a MangaDex chapter URL first — the queue starts from there.'); return; }
  const chapterId = parseChapterId(rawUrl);
  if (!chapterId) { toast("Could not find a chapter ID. Make sure it's a mangadex.org/chapter/… link."); return; }
  if (!_validateApiKeyOrToast()) return;

  const existing = document.getElementById('queue-setup-modal');
  if (existing) existing.remove();

  const lifetimeNow = _readLifetime().total;
  const modal = document.createElement('div');
  modal.id = 'queue-setup-modal';
  modal.className = 'flow-modal-backdrop';
  modal.innerHTML = `
    <div class="flow-modal">
      <div class="flow-modal-hdr">
        <span>⏩ QUEUE UPCOMING CHAPTERS</span>
        <button class="flow-modal-close" onclick="document.getElementById('queue-setup-modal').remove()">✕</button>
      </div>
      <div class="flow-modal-body">
        <div class="form-group">
          <label class="form-label" for="queue-count">How many chapters (starting after this one)</label>
          <input id="queue-count" class="form-input" type="number" min="1" max="30" step="1" value="5">
        </div>
        <div class="form-group" style="margin-top:0.8rem">
          <label class="form-label" for="queue-budget">
            Stop if lifetime API cost would exceed
          </label>
          <input id="queue-budget" class="form-input" type="number" min="0.01" step="0.5"
                 value="${_QUEUE_DEFAULT_BUDGET.toFixed(2)}">
          <div style="font-size:0.65rem;opacity:0.55;margin-top:0.3rem;font-family:'Share Tech Mono',monospace">
            Currently at ${_fmtCost(lifetimeNow)} lifetime. Required — most providers (Gemini/DeepSeek
            included) keep billing even after a prepaid balance runs out, so an unattended overnight run
            needs a real cap, not an optional one. Checked before every page, not just every chapter — but
            a call already in flight when the limit is crossed still finishes and still gets billed, so the
            final total can land a little over, never a little under.
          </div>
        </div>
      </div>
      <div class="flow-modal-footer">
        <button class="corr-btn-close" onclick="document.getElementById('queue-setup-modal').remove()">Cancel</button>
        <button class="corr-btn-retrans" onclick="_confirmStartQueue('${esc(chapterId)}')">▶ Start Queue</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

export function _confirmStartQueue(fromChapterId) {
  const count  = Math.max(1, Math.min(30, parseInt(document.getElementById('queue-count').value, 10) || 5));
  const budgetRaw = document.getElementById('queue-budget').value.trim();
  const budgetLimit = parseFloat(budgetRaw);
  // No blank/"no limit" path any more — see this file's header for why.
  // Anything missing, unparseable, or <= 0 is treated as a mistake to
  // correct, not a request to remove the cap.
  if (!budgetRaw || isNaN(budgetLimit) || budgetLimit <= 0) {
    toast('Enter a budget limit greater than $0 — unattended runs always need one.');
    return;
  }
  document.getElementById('queue-setup-modal')?.remove();
  startQueue(fromChapterId, count, budgetLimit);
}

// ── The actual run ───────────────────────────────────────────────
export async function startQueue(fromChapterId, count, budgetLimit) {
  const targetLang = getTargetLang();
  const controller = new AbortController();

  toast(`Looking up the next ${count} chapter${count !== 1 ? 's' : ''}…`, 3000);
  const items = await resolveNextChapters(fromChapterId, count, controller.signal);
  if (!items.length) return;  // resolveNextChapters already toasted why

  _queueRun = {
    items: items.map(it => ({ ...it, status: 'pending' })),
    cancelled: false,
    controller,
    budgetLimit,
    // Snapshotted once, at queue start — see this file's header for why
    // per-chapter cost has to be measured against the LIFETIME total
    // rather than cost-tracker.js's per-chapter counter: that counter is
    // shared, reader-global state that _runChapterPipeline itself zeroes
    // via resetChapterCost() every time ANY chapter opens in the reader —
    // if the person opens something to read while this queue is running
    // in the background, that reset would corrupt the queue's own cost
    // measurement too. The lifetime total is never reset by anything, so
    // diffing against a snapshot of it is the only safe way to measure
    // "how much did THIS queue run cost" independent of whatever the
    // reader is doing at the same time.
    startLifetimeCost: _readLifetime().total,
  };
  _renderQueuePanel();

  for (const item of _queueRun.items) {
    if (!_queueRun || _queueRun.cancelled) return;
    if (_isQueueBudgetExceeded()) { _stopQueueOnBudget(); return; }

    item.status = 'working';
    _renderQueuePanel();

    try {
      await _runQueueItem(item, targetLang, controller.signal);
      if (!_queueRun || _queueRun.cancelled) return;  // cancelled mid-item — don't overwrite status below
      // The budget can also have tipped over DURING this chapter — the
      // per-page isCancelled hook inside _runQueueItem stops new pages
      // from launching, but _ocrTranslatePages still returns normally
      // (its own tasks just stopped early), so _runQueueItem's own
      // setCachedChapter call above already ran with a partial
      // pageRegions array. Check here so the item is correctly reported
      // as budget-stopped rather than silently marked 'done' with fewer
      // pages translated than it looks like from the status alone.
      if (_isQueueBudgetExceeded()) { item.status = 'done'; _stopQueueOnBudget(); return; }
      item.status = 'done';
    } catch (err) {
      if (err.name === 'AbortError') return;
      item.status = 'error';
      item.error  = err.message || String(err);
    }
    _renderQueuePanel();
  }

  toast(`Queue finished — ${_queueRun.items.filter(i => i.status === 'done').length}/${_queueRun.items.length} chapters translated.`);
}

// True once this queue run's own spend (lifetime total minus the snapshot
// taken at queue start — see startQueue's startLifetimeCost comment for
// why it's measured this way) has reached its budgetLimit. Cheap/sync —
// _readLifetime() is a plain localStorage read — so this is safe to call
// as often as once per page, not just once per chapter.
export function _isQueueBudgetExceeded() {
  if (!_queueRun) return false;
  const spentSoFar = _readLifetime().total - _queueRun.startLifetimeCost;
  return spentSoFar >= _queueRun.budgetLimit;
}

// Marks every not-yet-finished item explicitly as 'skipped' rather than
// leaving them at 'pending' forever, which would look like the queue hung
// rather than that it deliberately stopped — same reasoning as the
// pre-existing per-chapter check this replaces/extends.
export function _stopQueueOnBudget() {
  if (!_queueRun) return;
  for (const rest of _queueRun.items) {
    if (rest.status === 'pending' || rest.status === 'working') rest.status = 'skipped';
  }
  _renderQueuePanel();
  toast(`Queue stopped — budget of ${_fmtCost(_queueRun.budgetLimit)} reached.`);
}

/**
 * One chapter's worth of work: fetch pages, skip if already cached at
 * this targetLang (no point re-spending on something already done — same
 * check _runChapterPipeline's cache-hit branch makes, just without any
 * rendering since nothing needs to be shown), otherwise run
 * _ocrTranslatePages headless (no onPageDone/onPageError/onProgress —
 * see that function's own doc comment for what "headless" skips: the
 * engine-recommendation banner wait and per-page toasts, both of which
 * assume someone is watching the screen) and write the result to the
 * cache exactly like the live reader does.
 *
 * isCancelled here does double duty: cancelled (person clicked stop) OR
 * budget exceeded (see _isQueueBudgetExceeded) both stop new page tasks
 * from being launched by runConcurrent's worker-pool loop (utils.js) —
 * checked before EVERY page, not just between chapters, since a single
 * long chapter run against a per-chapter-only check could already blow
 * well past a budget before the next chapter boundary ever came up. This
 * still isn't a hard ceiling: a page task already in flight when the
 * budget tips over keeps running and still gets billed on completion —
 * see this file's header for why that's true of any client-side budget,
 * not something a tighter check here could fully close.
 */
export async function _runQueueItem(item, targetLang, signal) {
  const meta = await fetchChapterMeta(item.chapterId, signal);
  const sourceLang = meta.translatedLanguage;

  if (sourceLang === 'en') {
    // Nothing to translate — still worth a cache entry so it shows up as
    // "ready" rather than silently vanishing from the queue's own list.
    setCachedChapter(item.chapterId, { meta, targetLang, pageRegions: [] });
    return;
  }

  const existing = getCachedChapter(item.chapterId);
  if (existing && existing.targetLang === targetLang) return;  // already done — nothing to spend

  const urls = await fetchPageUrls(item.chapterId, 'data', signal);
  const pageRegions = await _ocrTranslatePages(urls, sourceLang, targetLang, signal, {
    isCancelled: () => !_queueRun || _queueRun.cancelled || _isQueueBudgetExceeded(),
  });
  setCachedChapter(item.chapterId, { meta, targetLang, pageRegions });
}

export function cancelQueue() {
  if (_queueRun) _queueRun.cancelled = true;
  if (_queueRun?.controller) _queueRun.controller.abort();
  _queueRun = null;
  _renderQueuePanel();
  refreshCacheUI();  // reflect whatever DID finish before cancelling
}

// ── UI: progress panel (mirrors downloads.js's _renderDlPanel) ──────
export function _renderQueuePanel() {
  const panel = _queuePanelEl();
  if (!panel) return;
  if (!_queueRun) { panel.innerHTML = ''; panel.classList.remove('active'); return; }

  panel.classList.add('active');
  const doneCount    = _queueRun.items.filter(i => i.status === 'done').length;
  const errCount     = _queueRun.items.filter(i => i.status === 'error').length;
  const skippedCount = _queueRun.items.filter(i => i.status === 'skipped').length;
  const total        = _queueRun.items.length;
  const working      = _queueRun.items.some(i => i.status === 'pending' || i.status === 'working');
  const spentSoFar    = _readLifetime().total - _queueRun.startLifetimeCost;

  const rows = _queueRun.items.map(item => {
    const icon = { pending: '⏳', working: '⏳', done: '✓', error: '✗', skipped: '⊘' }[item.status];
    return `<div class="export-row export-row-${item.status === 'skipped' ? 'pending' : item.status}">
      <span class="export-row-icon${item.status === 'working' ? ' spin' : ''}">${icon}</span>
      <span class="export-row-label">${esc(item.label)}${item.status === 'skipped' ? ' (budget reached)' : ''}</span>
      ${item.status === 'error' ? `<span class="export-row-err" title="${esc(item.error || '')}">${esc((item.error || '').slice(0, 60))}</span>` : ''}
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="export-panel-header">
      <span>${working ? '⏳ ' : ''}${doneCount}/${total} chapter${total !== 1 ? 's' : ''} translated${errCount ? `, ${errCount} failed` : ''}${skippedCount ? `, ${skippedCount} skipped` : ''}
        &nbsp;·&nbsp; ${_fmtCost(spentSoFar)} spent / ${_fmtCost(_queueRun.budgetLimit)} budget
      </span>
      <button class="export-row-btn" onclick="cancelQueue()">${working ? '✕ cancel' : '✕ close'}</button>
    </div>
    <div class="export-panel-rows">${rows}</div>
    ${working ? '<div class="export-panel-note">Running in the background — translated chapters appear in "Recently read" / "Cached chapters" as each one finishes, ready to open instantly.</div>' : ''}
  `;
}
