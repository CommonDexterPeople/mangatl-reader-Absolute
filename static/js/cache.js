// ═══════════════════════════════════════════════════════════════
// cache.js
// localStorage chapter cache: get/set/evict + the cache-usage UI on the home screen.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// CACHE  (regions only — page URLs always re-fetched)
// ══════════════════════════════════════════════
const CACHE_PREFIX  = 'mtl_ch_';
const CACHE_TTL     = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX     = 20;   // FIX #6: proactive entry-count cap
// Bump CACHE_V whenever the stored region format changes in a breaking way.
// Old entries without this version are silently dropped and re-fetched.
// v2: fixes badge positions — old caches may have fractional (0–1) x/y coords
//     from un-normalised Vision OCR results, causing badges to land < 1% from
//     the image edge and be invisible.  Fresh load with the fixed backend
//     normalises coords correctly.
// v4: Vision OCR prompt rewrite + removed responseMimeType:json + thinkingBudget:512
//     so Flash-Lite actually reasons about spatial positions instead of hallucinating
//     cx≈97 for every item.  Extreme right-cluster fallback redistributes badges
//     to the left margin as a last resort when coords are still unreliable.
// v5: fixes badge/box positions from flagship models (3.5 Flash, 3.1 Pro) that
//     return coords on Gemini's native 0-1000 grounding scale instead of the
//     prompt's requested 0-100 — previously fell through the A/B format checks
//     untouched and got clamped to the bottom-right corner (cx=cy=99) instead
//     of rescaled. See _ocr_gemini_vision()'s Case C in server.py.
// v6: fixes Vision OCR legibility on tall webtoon/manhwa strips — the
//     pre-encode resize used to fit every page into a flat 800x1200 box,
//     which forced an extreme-aspect-ratio strip's scale factor down to
//     whatever its 1200px height cap demanded, crushing the width along
//     with it (a 800x6000 strip came out ~160px wide). The resize now grows
//     its height budget with the page's own aspect ratio instead. See the
//     resize block at the top of _ocr_gemini_vision() in server.py.
const CACHE_V = 6;

function getCachedChapter(chapterId) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + chapterId);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    // Drop entries from older code versions (bad coordinate format)
    if ((cached.v ?? 1) < CACHE_V) {
      localStorage.removeItem(CACHE_PREFIX + chapterId);
      return null;
    }
    if (Date.now() - cached.timestamp > CACHE_TTL) {
      localStorage.removeItem(CACHE_PREFIX + chapterId);
      return null;
    }
    return cached;
  } catch { return null; }
}

function setCachedChapter(chapterId, data) {
  // FIX #6: proactively drop oldest entries when over the cap, then keep
  // evicting on quota errors until the write eventually succeeds.
  const getKeys = () => Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
  let keys = getKeys();
  while (keys.length >= CACHE_MAX) {
    if (!evictOldestCache()) break;
    keys = getKeys();
  }
  const entry = JSON.stringify({ ...data, v: CACHE_V, timestamp: Date.now() });
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      localStorage.setItem(CACHE_PREFIX + chapterId, entry);
      return;
    } catch {
      if (!evictOldestCache()) return;  // nothing left to evict
    }
  }
}

// Returns the removed key, or null if nothing to evict
function evictOldestCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
  if (!keys.length) return null;
  let oldestKey = keys[0], oldestTime = Infinity;
  keys.forEach(k => {
    try {
      const d = JSON.parse(localStorage.getItem(k));
      if ((d.timestamp ?? 0) < oldestTime) { oldestTime = d.timestamp; oldestKey = k; }
    } catch {}
  });
  localStorage.removeItem(oldestKey);
  return oldestKey;
}

// ── Cache info helpers ────────────────────────
function _getCacheKeys() {
  return Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
}

function _getCacheSize() {
  const keys = _getCacheKeys();
  let bytes = 0;
  keys.forEach(k => { try { bytes += (localStorage.getItem(k) || '').length * 2; } catch {} });
  return { count: keys.length, bytes };
}

function _fmtBytes(b) {
  if (b < 1024)       return b + ' B';
  if (b < 1024*1024)  return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

function _refreshCacheUICore() {
  const { count, bytes } = _getCacheSize();

  // ── Reader header pill ──
  const lbl = document.getElementById('reader-cache-label');
  const clrBtn = document.getElementById('reader-cache-clear-btn');
  if (lbl) {
    lbl.innerHTML = count > 0
      ? `<span>${count}</span> chapter${count !== 1 ? 's' : ''} · ${_fmtBytes(bytes)}`
      : `<span style="color:var(--dim);font-weight:normal">empty</span>`;
  }
  if (clrBtn) clrBtn.style.display = count > 0 ? '' : 'none';

  // ── Home screen strip ──
  const info   = document.getElementById('home-cache-info');
  const btn    = document.getElementById('btn-clear-cache-home');
  if (info) {
    if (count === 0) {
      info.innerHTML = '<span class="cache-empty">No chapters cached yet</span>';
    } else {
      info.innerHTML =
        `💾 <strong>${count}</strong> chapter${count !== 1 ? 's' : ''} cached` +
        ` &nbsp;·&nbsp; <strong>${_fmtBytes(bytes)}</strong>`;
    }
  }
  if (btn) btn.disabled = count === 0;
}

function clearCache() {
  const keys = _getCacheKeys();
  keys.forEach(k => localStorage.removeItem(k));
  const n = keys.length;
  toast(`Cleared ${n} cached chapter${n !== 1 ? 's' : ''}.`);
  refreshCacheUI();
}

function clearCacheFromHome()   { clearCache(); }
function clearCacheFromReader() {
  clearCache();
  // Also show confirmation near the pill
  const lbl = document.getElementById('reader-cache-label');
  if (lbl) {
    lbl.innerHTML = '<span style="color:var(--ui)">cleared ✓</span>';
    setTimeout(refreshCacheUI, 1800);
  }
}

function updatePageInCache(pageIdx, regions) {
  if (!_activeChapterId) return;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + _activeChapterId);
    if (!raw) return;
    const cached = JSON.parse(raw);
    if (cached.pageRegions?.[pageIdx] !== undefined) {
      cached.pageRegions[pageIdx] = regions;
      localStorage.setItem(CACHE_PREFIX + _activeChapterId, JSON.stringify(cached));
    }
  } catch {}
}

// ══════════════════════════════════════════════
// CORRECTED-REGIONS LOOKUP  (shared by pipeline/downloads/export)
// ══════════════════════════════════════════════
// The Correction UI (correction-ui.js) saves its own edits separately, under
// mtl_corr_<chapterId>_<pageIdx>, rather than overwriting the mtl_ch_* cache
// entry directly. That keeps the correction draft isolated from the auto
// pipeline, but it also means every place that reads "the regions for this
// page" has to know to check the correction draft FIRST and only fall back
// to the plain (uncorrected) regions if no correction was ever saved.
// Centralised here so pipeline.js / downloads.js / export.js all agree —
// previously pipeline.js and downloads.js skipped this check entirely,
// which made a fresh chapter-open (or a home-screen download) silently
// revert to the pre-correction version even though the corrected data was
// safely sitting in localStorage the whole time.
function getEffectivePageRegions(chapterId, pageIdx, fallbackRegions) {
  try {
    const raw = localStorage.getItem(`mtl_corr_${chapterId}_${pageIdx}`);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved?.regions?.length) {
        return saved.regions
          .filter(r => !r.deleted)
          .map(r => ({
            t: r.t || 'speech',
            x: r.cx, y: r.cy,
            box: r.box,
            tl: r.tl || '—',
            text: r.text || '',
          }));
      }
    }
  } catch { /* fall through to fallbackRegions below */ }
  return fallbackRegions;
}

// ══════════════════════════════════════════════
// CACHE-UI REFRESH HOOKS
// ══════════════════════════════════════════════
// downloads.js used to reassign refreshCacheUI to append its chapter-list
// render. Same ES-module problem, same inversion as page-render.js's hooks:
// this module owns the seam, downloads.js subscribes to it. clearCache() and
// setCachedChapter() still call refreshCacheUI() without knowing downloads.js
// exists, which was the point of the original wrapper.
const _afterCacheUIRefreshHooks = [];

function onAfterCacheUIRefresh(fn) { _afterCacheUIRefreshHooks.push(fn); }

function refreshCacheUI() {
  _refreshCacheUICore();
  for (const fn of _afterCacheUIRefreshHooks) fn();
}
