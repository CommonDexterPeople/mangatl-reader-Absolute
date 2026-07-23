// ═══════════════════════════════════════════════════════════════
// utils.js
// Small shared helpers: runConcurrent (worker-pool), show/toast/status,
// esc() HTML-escaping, and top-level nav (back/prev/next).
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// CONCURRENCY  (3 pages in parallel)           // FIX #4: removed stale Gemini comment
// ══════════════════════════════════════════════
async function runConcurrent(taskFns, limit = 3) {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < taskFns.length && !cancelled) {
      const i = nextIdx++;
      await taskFns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, taskFns.length) }, worker));
}

// ══════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function toast(msg, dur = 6000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, dur);
}
function setStatus(msg) { document.getElementById('reader-status').textContent = msg; }
function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function goBack() {
  cancelled = true;
  if (abortController) abortController.abort();
  // Release per-chapter memory — OCR data, corrections, manual order.
  _pageStore.clear();
  _manualOrder.clear();
  // Local-folder/CBZ pages only exist as in-memory Blobs (see
  // local-source.js) — free them here too, same as everything else above.
  clearLocalBlobStore();
  // Detach any box-overlay controllers left over from an open Correction
  // panel — pages-container.innerHTML is cleared below without going
  // through closeCorrection(), so this is the only place that would do it.
  Object.values(_corrOverlayCtl).forEach(ctl => ctl?.detach());
  Object.keys(_corrOverlayCtl).forEach(k => delete _corrOverlayCtl[k]);
  Object.keys(_corrWork).forEach(k => delete _corrWork[k]);
  Object.keys(_corrMode).forEach(k => delete _corrMode[k]);
  Object.keys(_corrSelId).forEach(k => delete _corrSelId[k]);
  document.getElementById('pages-container').innerHTML = '';
  show('screen-home');
  refreshCacheUI();  // refresh home strip when returning
}

// ── Chapter navigation ──────────────────────
function updateNavButtons() {
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
function goToPrev() { if (prevChapterId) goToChapter(prevChapterId); }
function goToNext() { if (nextChapterId) goToChapter(nextChapterId); }
function goToChapter(chapterId) {
  if (!chapterId) return;
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.getElementById('chapter-url').value = `https://mangadex.org/chapter/${chapterId}`;
  startPipelineWithId(chapterId);
}

