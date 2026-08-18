// ═══════════════════════════════════════════════════════════════
// export.js
// "Export Typeset" — burns the translations already produced by the
// reader onto flattened page images (original text erased, translation
// drawn in its place) and downloads them as a zip. Does no OCR/translate
// work itself — it only re-packages whatever the pipeline (and, if used,
// the correction UI) already put in _pageStore/localStorage.
// ═══════════════════════════════════════════════════════════════

// Loaded after pipeline.js and correction-ui.js: reads _pageStore,
// _activeChapterId, and the DOM elements those modules already render
// (manga-title/chapter-info) rather than tracking its own copy of state.

/**
 * Build the region list to export for one page, preferring saved
 * correction-UI edits (mtl_corr_<chapterId>_<pageIdx> in localStorage) over
 * the pipeline's own sortedRegions, since a corrected page is the "more
 * true" version of what the reader actually wants exported. Falls back to
 * sortedRegions/autoRegions if the page was never opened in the correction
 * UI. Filters out regions the correction UI marked deleted.
 */
function _exportRegionsForPage(pageIdx) {
  const pd = _pageStore.get(`${_activeChapterId}_${pageIdx}`);
  const base = pd?.sortedRegions || pd?.autoRegions || [];
  const fallback = base.map(r => ({
    t: r.t || 'speech',
    x: r.cx, y: r.cy,
    box: r.box,
    tl: r.tl || '—',
  }));
  // getEffectivePageRegions (cache.js) checks mtl_corr_<chapterId>_<pageIdx>
  // first and only falls back to `fallback` if no correction was saved.
  return getEffectivePageRegions(_activeChapterId, pageIdx, fallback);
}

/**
 * Gather { url, regions } for every page of the currently-open chapter.
 * Returns null if there's nothing to export — e.g. an English chapter
 * (never translated, so nothing was ever stored) or a chapter whose pages
 * haven't finished loading yet.
 */
function _collectChapterExportPayload() {
  if (!_activeChapterId) return null;

  // Find total page count + each page's CDN url from whichever _pageStore
  // entries exist for this chapter (populated for every non-English page,
  // cached or freshly-translated — see pipeline.js).
  let total = null;
  const cdnByIndex = new Map();
  for (const [k, v] of _pageStore.entries()) {
    if (!k.startsWith(`${_activeChapterId}_`)) continue;
    const idx = parseInt(k.slice(`${_activeChapterId}_`.length), 10);
    if (Number.isNaN(idx)) continue;
    cdnByIndex.set(idx, v.cdnUrl);
    if (total == null) total = v.total;
  }

  if (total == null) return null; // nothing stored — likely an English chapter

  const pages = [];
  for (let i = 0; i < total; i++) {
    const url = cdnByIndex.get(i);
    if (!url) continue; // page errored out / never loaded — skip, don't fail the whole export
    pages.push({ url, regions: _exportRegionsForPage(i) });
  }
  return pages.length ? pages : null;
}

function _sanitizeForFilename(s) {
  return (s || 'chapter').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'chapter';
}

// ══════════════════════════════════════════════
// EXPORT STATE — one entry per page in the currently-open export run.
// status: 'pending' | 'working' | 'done' | 'error'
// ══════════════════════════════════════════════
let _exportRun = null; // { label, items: [{pageIdx, url, regions, status, blob, error}] }

function _exportPanelEl() { return document.getElementById('export-panel'); }

function _renderExportPanel() {
  const panel = _exportPanelEl();
  if (!panel || !_exportRun) return;

  const doneCount = _exportRun.items.filter(i => i.status === 'done').length;
  const errCount  = _exportRun.items.filter(i => i.status === 'error').length;
  const total     = _exportRun.items.length;

  const rows = _exportRun.items.map(item => {
    const icon = { pending: '⏳', working: '⏳', done: '✓', error: '✗' }[item.status];
    const cls  = `export-row export-row-${item.status}`;
    const retryBtn = (item.status === 'error' || item.status === 'done')
      ? `<button class="export-row-btn" onclick="_retryExportPage(${item.pageIdx})">↻ retry</button>` : '';
    const fixBtn = item.status === 'error'
      ? `<button class="export-row-btn" onclick="_jumpToCorrection(${item.pageIdx})">✏ fix</button>` : '';
    const errMsg = item.status === 'error'
      ? `<span class="export-row-err" title="${esc(item.error || '')}">${esc((item.error || '').slice(0, 60))}</span>` : '';
    return `<div class="${cls}">
      <span class="export-row-icon">${icon}</span>
      <span class="export-row-label">Page ${item.pageIdx + 1}</span>
      ${errMsg}
      <span class="export-row-actions">${retryBtn}${fixBtn}</span>
    </div>`;
  }).join('');

  const stillWorking = _exportRun.items.some(i => i.status === 'pending' || i.status === 'working');

  panel.innerHTML = `
    <div class="export-panel-header">
      <span>${doneCount}/${total} done${errCount ? `, ${errCount} failed` : ''}</span>
      <button class="export-row-btn" onclick="_downloadExportZip()" ${doneCount === 0 ? 'disabled' : ''}>
        ⬇ Download zip (${doneCount} ready)
      </button>
      <button class="export-row-btn" onclick="_closeExportPanel()">✕ close</button>
    </div>
    <div class="export-panel-rows">${rows}</div>
    ${stillWorking ? '<div class="export-panel-note">Processing — you can keep reading while this runs.</div>' : ''}
  `;
}

function _closeExportPanel() {
  _exportRun = null;
  const panel = _exportPanelEl();
  if (panel) { panel.innerHTML = ''; panel.classList.remove('active'); }
}

function _jumpToCorrection(pageIdx) {
  const card = document.getElementById(`page-${pageIdx}`);
  if (!card) {
    toast(`Page ${pageIdx + 1} isn't rendered on screen — scroll to it first, then use ✏ CORRECT.`);
    return;
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  openCorrection(pageIdx);
}

/** Run one page through /export-page, updating its status in _exportRun in place. */
async function _runExportItem(item, label) {
  item.status = 'working';
  _renderExportPanel();
  try {
    const resp = await fetch('/export-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(await imageRefBody(item.url)),
        regions: item.regions,
        erase_mode: 'auto',
        ai_inpaint: getAiInpaintSetting(),
      }),
    });
    if (!resp.ok) {
      const msg = await resp.text().catch(() => '');
      throw new Error(msg || `HTTP ${resp.status}`);
    }
    item.blob  = await resp.blob();
    item.status = 'done';
    item.error = null;
  } catch (err) {
    item.status = 'error';
    item.error  = err.message || String(err);
  }
  _renderExportPanel();
}

async function _retryExportPage(pageIdx) {
  if (!_exportRun) return;
  const item = _exportRun.items.find(i => i.pageIdx === pageIdx);
  if (!item) return;
  // Re-read regions fresh (in case the person just fixed this page in the
  // correction UI) rather than reusing the stale copy from the original run.
  item.regions = _exportRegionsForPage(pageIdx);
  await _runExportItem(item, _exportRun.label);
}

function _downloadExportZip() {
  if (!_exportRun) return;
  const done = _exportRun.items.filter(i => i.status === 'done');
  if (!done.length) { toast('No pages finished yet.'); return; }

  const files = done.map(i => ({
    name: `${_exportRun.label}_${String(i.pageIdx + 1).padStart(3, '0')}.png`,
    data: i.blobBytes,
  }));
  const zipBytes = buildZip(files);
  const zipName = `${_exportRun.label}_typeset.zip`;
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast(`Downloaded ${done.length}/${_exportRun.items.length} page(s).`);
  _showDownloadGuide(zipName);
}

// ══════════════════════════════════════════════
// POST-DOWNLOAD GUIDE
// A browser download doesn't open a folder or say where it went, and
// that's the single most common "now what?" moment for anyone exporting
// for the first time — so spell it out once per session, dismissible.
// ══════════════════════════════════════════════
let _downloadGuideDismissed = false;

function _showDownloadGuide(filename, panelId = 'export-panel') {
  if (_downloadGuideDismissed) return;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const shortcut = isMac ? '⌥⌘L (Option+Cmd+L)' : 'Ctrl+J';
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const guide = document.createElement('div');
  guide.className = 'download-guide';
  guide.innerHTML = `
    <div class="download-guide-body">
      <strong>${esc(filename)}</strong> went to your browser's default
      <strong>Downloads</strong> folder — not to any folder inside this app.
      <div class="download-guide-tips">
        Find it via your browser's downloads list (${esc(shortcut)}), or check:
        <code>Downloads/${esc(filename)}</code> &nbsp;/&nbsp; on phones, usually
        <em>Files</em> or <em>My Files &rarr; Download</em>.
      </div>
    </div>
    <button class="download-guide-close" onclick="this.parentElement.remove()" title="Dismiss">✕</button>`;
  panel.appendChild(guide);
  _downloadGuideDismissed = true; // only show once per session — don't nag on every retry-download
}

async function exportTypesetChapter() {
  const pages = _collectChapterExportPayload();
  if (!pages) {
    toast('Nothing to export yet — this chapter has no stored translations ' +
          '(English chapters have nothing to typeset; otherwise, wait for translation to finish).');
    return;
  }

  const label = _sanitizeForFilename(
    (document.getElementById('manga-title')?.textContent || '') + '_' +
    (document.getElementById('chapter-info')?.textContent || '')
  );

  _exportRun = {
    label,
    items: pages.map((p, pageIdx) => ({
      pageIdx, url: p.url, regions: p.regions,
      status: 'pending', blob: null, blobBytes: null, error: null,
    })),
  };
  const panel = _exportPanelEl();
  if (panel) panel.classList.add('active');
  _renderExportPanel();

  // Sequential, one page at a time — this is the whole point: never hold
  // more than one inpaint job in flight, so a big chapter can't overwhelm
  // the machine, and the person can keep reading between pages since each
  // request is short instead of one long blocking batch call.
  for (const item of _exportRun.items) {
    if (!_exportRun) return; // panel was closed mid-run — stop
    await _runExportItem(item);
    if (item.status === 'done') {
      item.blobBytes = new Uint8Array(await item.blob.arrayBuffer());
    }
  }

  if (_exportRun) {
    const failed = _exportRun.items.filter(i => i.status === 'error').length;
    toast(failed
      ? `Export finished with ${failed} page(s) failed — retry or fix them below.`
      : `Export finished — ${_exportRun.items.length} page(s) ready to download.`);
  }
}
