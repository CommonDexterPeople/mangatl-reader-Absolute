// ═══════════════════════════════════════════════════════════════
// downloads.js
// Home-screen chapter list + "download to computer" for cached chapters.
// Lets the person grab a translated chapter (or all of them) as a zip of
// typeset PNGs without re-opening the reader — e.g. to send to a friend.
//
// Reuses existing pieces rather than duplicating them:
//   - cache entries (mtl_ch_* in localStorage) already hold `meta` +
//     `pageRegions` per chapter (see pipeline.js / cache.js)
//   - /export-page (server.py) already turns {url, regions} into a
//     typeset PNG — the same route "Export Typeset" uses in the reader
//   - buildZip() (zip-writer.js) already builds a valid zip client-side
//
// The one thing cache entries do NOT store is page image URLs (MangaDex's
// at-home/server URLs are short-lived tokens, so there's nothing useful to
// cache there) — so downloading always starts with one fresh
// fetchPageUrls() call per chapter, same as opening it in the reader would.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// CHAPTER LIST  (home screen)
// ══════════════════════════════════════════════

import {
  CACHE_PREFIX,
  getCachedChapter,
  getEffectivePageRegions,
  onAfterCacheUIRefresh,
  refreshCacheUI,
} from './cache.js';
import { _sanitizeForFilename, _showDownloadGuide } from './export.js';
import { _dispatchResume } from './history.js';
import { fetchPageUrls } from './mangadex-api.js';
import { cancelled } from './state-and-constants.js';
import { esc, toast } from './utils.js';
import { buildZip } from './zip-writer.js';

/** Read every cached chapter into a display-ready list, newest first. */
export function _listCachedChapters() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
  const out = [];
  for (const k of keys) {
    try {
      const d = JSON.parse(localStorage.getItem(k));
      if (!d?.meta || !d?.pageRegions) continue; // corrupt/partial entry — skip
      const pageCount = d.pageRegions.length;
      const translatedCount = d.pageRegions.filter(r => r && r.length).length;
      out.push({
        chapterId: k.slice(CACHE_PREFIX.length),
        title: d.meta.mangaTitle || 'Unknown Manga',
        chapter: d.meta.chapter || '?',
        chapterTitle: d.meta.chapterTitle || '',
        targetLang: d.targetLang || '',
        pageCount, translatedCount,
        timestamp: d.timestamp || 0,
        // Kept (previously discarded here) so openCachedChapter() below
        // can build a resume descriptor without a second read of the raw
        // cache entry — see that function's doc comment for why a cached
        // chapter needs the same {kind, mangaId/sourceLang} split
        // history.js's resume descriptors already use.
        mangaId: d.meta.mangaId || null,
        sourceLang: d.meta.translatedLanguage || '',
      });
    } catch { /* skip corrupt entry */ }
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

export function _renderChapterList() {
  const wrap = document.getElementById('home-chapter-list');
  const dlAllBtn = document.getElementById('btn-download-all');
  if (!wrap) return;

  const chapters = _listCachedChapters();
  if (dlAllBtn) dlAllBtn.disabled = chapters.length === 0;

  if (!chapters.length) {
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';

  wrap.innerHTML = chapters.map(ch => `
    <div class="chlist-row hist-row" id="chrow-${ch.chapterId}" onclick="openCachedChapter('${ch.chapterId}')">
      <div class="chlist-info">
        <div class="chlist-title">${esc(ch.title)}</div>
        <div class="chlist-sub">Ch. ${esc(ch.chapter)}${ch.chapterTitle ? ' · ' + esc(ch.chapterTitle) : ''}
          &nbsp;·&nbsp; ${ch.translatedCount}/${ch.pageCount} pages &nbsp;·&nbsp; ${esc(ch.targetLang)}</div>
      </div>
      <button class="chlist-dl-btn" id="chdl-btn-${ch.chapterId}"
              onclick="event.stopPropagation(); downloadCachedChapter('${ch.chapterId}')" title="Download this chapter">
        ⬇
      </button>
    </div>
  `).join('');
}

/**
 * Opens a cached chapter straight into the reader — click anywhere on its
 * row except the ⬇ button (which still just downloads, unchanged).
 *
 * Builds a one-off {resume, entry}-shaped pair from THIS chapter's own
 * cache data and hands it to history.js's _dispatchResume() — the exact
 * same dispatcher resuming from actual reading history uses — rather
 * than a second copy of the mangadex/suwayomi/local branching. See
 * _dispatchResume's doc comment for why cached chapters need their own
 * on-the-fly pair instead of just reading a matching mtl_hist_* entry
 * (there may not be one — the two stores are independent, can each
 * evict/expire on their own, and a chapter can be cached without ever
 * having been opened as a fresh read in this browser, e.g. after
 * "download all" for a chapter list).
 *
 * kind is inferred from chapterId's own shape rather than stored
 * separately: Suwayomi's composite id (`suwayomi:<mangaId>:<index>`,
 * see suwayomi-api.js's chapterFromSuwayomi) always contains a colon; a
 * MangaDex chapter id is a plain UUID and never does. Local/CBZ chapters
 * are never cached at all (pipeline.js passes cacheable:false for that
 * source specifically — blobs don't survive a reload, see
 * _runChapterPipeline's own doc comment), so 'local' never needs to be
 * handled here.
 */
export function openCachedChapter(chapterId) {
  const parts = chapterId.split(':');
  const resume = (parts.length === 3 && parts[0] === 'suwayomi')
    ? { kind: 'suwayomi', mangaId: parts[1], chapterIndex: parts[2], sourceLang: '' }
    : { kind: 'mangadex', chapterId };

  const cached = getCachedChapter(chapterId);
  if (!cached?.meta) { toast('That cached chapter is gone or has expired.'); refreshCacheUI(); return; }
  if (resume.kind === 'suwayomi') resume.sourceLang = cached.meta.translatedLanguage || 'ja';

  _dispatchResume(resume, {
    title: cached.meta.mangaTitle || 'Unknown Manga',
    targetLang: cached.targetLang || document.getElementById('target-lang')?.value || 'en',
  });
}

// ══════════════════════════════════════════════
// DOWNLOAD STATE  (small inline progress, mirrors the reader's export-panel look)
// ══════════════════════════════════════════════
export let _dlRun = null; // { kind:'single'|'all', label, items:[{label,status}], cancelled }

export function _dlPanelEl() { return document.getElementById('home-download-panel'); }

export function _renderDlPanel() {
  const panel = _dlPanelEl();
  if (!panel) return;
  if (!_dlRun) { panel.innerHTML = ''; panel.classList.remove('active'); return; }

  panel.classList.add('active');
  const doneCount = _dlRun.items.filter(i => i.status === 'done').length;
  const errCount  = _dlRun.items.filter(i => i.status === 'error').length;
  const total     = _dlRun.items.length;
  const working   = _dlRun.items.some(i => i.status === 'pending' || i.status === 'working');

  const rows = _dlRun.items.map(item => {
    const icon = { pending: '⏳', working: '⏳', done: '✓', error: '✗' }[item.status];
    return `<div class="export-row export-row-${item.status}">
      <span class="export-row-icon${item.status === 'working' ? ' spin' : ''}">${icon}</span>
      <span class="export-row-label">${esc(item.label)}</span>
      ${item.status === 'error' ? `<span class="export-row-err" title="${esc(item.error || '')}">${esc((item.error || '').slice(0, 60))}</span>` : ''}
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="export-panel-header">
      <span>${working ? '⏳ ' : ''}${doneCount}/${total} chapter${total !== 1 ? 's' : ''} ready${errCount ? `, ${errCount} failed` : ''}</span>
      <button class="export-row-btn" onclick="_cancelDownload()">${working ? '✕ cancel' : '✕ close'}</button>
    </div>
    <div class="export-panel-rows">${rows}</div>
    ${working ? '<div class="export-panel-note">Fetching pages and erasing/typesetting each one — this can take a bit for long chapters.</div>' : ''}
  `;
}

export function _cancelDownload() {
  if (_dlRun) _dlRun.cancelled = true;
  _dlRun = null;
  _renderDlPanel();
}

/** Turn one cached chapter into [{name, data}] PNG entries, ready for buildZip(). */
export async function _buildChapterZipEntries(chapterId, cached, folderPrefix = '') {
  const urls = await fetchPageUrls(chapterId, 'data'); // full quality for exports
  const label = _sanitizeForFilename(
    `${cached.meta.mangaTitle || 'chapter'}_Ch${cached.meta.chapter || ''}`
  );
  const entries = [];
  for (let i = 0; i < urls.length; i++) {
    // Prefer any saved ✏ CORRECT edits over the plain cached regions, same
    // as the in-reader "Export Typeset" button does — otherwise downloaded
    // chapters would always contain the pre-correction translations.
    const regions = getEffectivePageRegions(chapterId, i, cached.pageRegions[i]);
    const name = `${folderPrefix}${label}_${String(i + 1).padStart(3, '0')}.png`;
    if (!regions || !regions.length) {
      // Nothing was translated on this page (full-art / OCR-empty) — include
      // the original page as-is so the zip is still a complete chapter.
      const r = await fetch(urls[i].img);
      if (!r.ok) throw new Error(`page ${i + 1}: failed to fetch original`);
      entries.push({ name, data: new Uint8Array(await r.arrayBuffer()) });
      continue;
    }
    const resp = await fetch('/export-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urls[i].cdn, regions, erase_mode: 'inpaint' }),
    });
    if (!resp.ok) {
      const msg = await resp.text().catch(() => '');
      throw new Error(`page ${i + 1}: ${msg || `HTTP ${resp.status}`}`);
    }
    entries.push({ name, data: new Uint8Array(await resp.arrayBuffer()) });
  }
  return { entries, label };
}

export function _triggerZipDownload(zipBytes, filename) {
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  // Reuses the same dismissible "where did my file go" guide the reader's
  // Export Typeset button shows — defined in export.js, shown at most once
  // per session either way.
  if (typeof _showDownloadGuide === 'function') _showDownloadGuide(filename, 'home-download-panel');
}

/** Download a single cached chapter as its own zip. */
export async function downloadCachedChapter(chapterId) {
  const raw = localStorage.getItem(CACHE_PREFIX + chapterId);
  if (!raw) { toast('That chapter is no longer cached.'); return; }
  let cached;
  try { cached = JSON.parse(raw); } catch { toast('Cached chapter data is corrupt.'); return; }

  const chLabel = `${cached.meta.mangaTitle || 'Manga'} Ch. ${cached.meta.chapter || '?'}`;
  _dlRun = { kind: 'single', cancelled: false, items: [{ label: chLabel, status: 'working' }] };
  _renderDlPanel();

  const btn = document.getElementById(`chdl-btn-${chapterId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    const { entries, label } = await _buildChapterZipEntries(chapterId, cached);
    if (_dlRun?.cancelled) return;
    const zipBytes = buildZip(entries);
    _triggerZipDownload(zipBytes, `${label}.zip`);
    _dlRun.items[0].status = 'done';
    toast(`Downloaded "${chLabel}" — ${entries.length} page(s).`);
  } catch (err) {
    if (_dlRun) {
      _dlRun.items[0].status = 'error';
      _dlRun.items[0].error = err.message || String(err);
    }
    toast(`Download failed: ${err.message || err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇'; }
    _renderDlPanel();
  }
}

/** Download every cached chapter as one zip, subfoldered per chapter. */
export async function downloadAllCachedChapters() {
  const chapters = _listCachedChapters();
  if (!chapters.length) { toast('No cached chapters to download.'); return; }

  _dlRun = {
    kind: 'all', cancelled: false,
    items: chapters.map(c => ({
      label: `${c.title} Ch. ${c.chapter}`, status: 'pending', chapterId: c.chapterId,
    })),
  };
  _renderDlPanel();

  const allEntries = [];
  for (const item of _dlRun.items) {
    if (!_dlRun || _dlRun.cancelled) return;
    item.status = 'working';
    _renderDlPanel();
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + item.chapterId);
      const cached = JSON.parse(raw);
      const { entries, label } = await _buildChapterZipEntries(item.chapterId, cached, '');
      // Subfolder per chapter inside the combined zip so files from
      // different chapters (which may reuse page numbers like 001.png)
      // never collide.
      for (const e of entries) allEntries.push({ name: `${label}/${e.name}`, data: e.data });
      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      item.error = err.message || String(err);
    }
    _renderDlPanel();
  }

  if (!_dlRun || _dlRun.cancelled) return;
  if (!allEntries.length) {
    toast('All chapters failed to download — see the panel for details.');
    return;
  }
  const zipBytes = buildZip(allEntries);
  _triggerZipDownload(zipBytes, `MangaTL_all_chapters.zip`);
  const failed = _dlRun.items.filter(i => i.status === 'error').length;
  toast(failed
    ? `Downloaded with ${failed} chapter(s) failed — see the panel for details.`
    : `Downloaded all ${_dlRun.items.length} chapter(s) as one zip.`);
}

// Hook the chapter list into the existing cache-UI refresh cycle so it
// stays in sync with clearCache() / setCachedChapter() without those
// functions needing to know this file exists.
onAfterCacheUIRefresh(_renderChapterList);
