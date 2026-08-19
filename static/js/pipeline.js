// ═══════════════════════════════════════════════════════════════
// pipeline.js
// The main per-chapter pipeline: fetch pages -> OCR -> translate -> render,
// with concurrency, cancellation, and progress reporting.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// MAIN PIPELINE
// ══════════════════════════════════════════════

// Shared by startPipeline() (MangaDex) and the local-folder/CBZ entry point
// in local-source.js — same key, same provider, same validation either way.
// Returns the trimmed key on success (and saves it), or null after already
// showing the person a toast explaining why.
import { getCachedChapter, getEffectivePageRegions, refreshCacheUI, setCachedChapter } from './cache.js';
import { resetChapterCost } from './cost-tracker.js';
import { setActiveGlossary } from './glossary.js';
import { startHistoryTracking } from './history.js';
import { fetchAdjacentChapters, fetchChapterMeta, fetchPageUrls, parseChapterId } from './mangadex-api.js';
import {
  _ENGINE_LABEL,
  _pageStore,
  _resolveLocalEngine,
  maybeShowEngineRecommendation,
  ocrPage,
  waitForEngineRecDecision,
} from './ocr-client.js';
import { addSkeleton, renderPage, renderPageDisplay, renderPageError } from './page-render.js';
import {
  _activeChapterId,
  _sortRegions,
  abortController,
  cancelled,
  getLangName,
  setAbortController,
  setActiveChapterId,
  setCancelled,
  setNextChapterId,
  setPrevChapterId,
} from './state-and-constants.js';
import { chapterFromSuwayomi } from './suwayomi-api.js';
import { getModelInfo, getTargetLang, translateBatch } from './translate-client.js';
import {
  _clearChapterState,
  runConcurrent,
  setProgress,
  setStatus,
  show,
  toast,
  updateNavButtons,
} from './utils.js';

export function _validateApiKeyOrToast() {
  const key  = document.getElementById('ai-key').value.trim();
  const info = getModelInfo();

  if (!key) { toast(`Enter your ${info.label} API key.`); return null; }

  // Validate key format matches the selected provider
  const keyIsGemini   = key.startsWith('AIza');
  const keyIsDeepSeek = key.startsWith('sk-');
  if (info.provider === 'gemini' && keyIsDeepSeek) {
    toast('That looks like a DeepSeek key (sk-…).\nGemini keys start with AIza — get one at aistudio.google.com');
    return null;
  }
  if (info.provider === 'deepseek' && keyIsGemini) {
    toast('That looks like a Gemini key (AIza…).\nDeepSeek keys start with sk- — get one at platform.deepseek.com');
    return null;
  }
  // DeepL keys are UUID-shaped (e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  // optionally with a ":fx" Free-tier suffix — see server.py's
  // _deepl_base_url()) rather than a short distinctive prefix like Gemini/
  // DeepSeek, so this only needs to catch the wrong-key-in-this-field case,
  // not validate DeepL's own shape positively.
  if (info.provider === 'deepl' && (keyIsGemini || keyIsDeepSeek)) {
    toast(`That looks like a ${keyIsGemini ? 'Gemini' : 'DeepSeek'} key.\nDeepL keys look like a UUID (e.g. a1b2c3d4-...-1234567890), optionally ending in :fx — get one at deepl.com/en/pro#developer`);
    return null;
  }

  localStorage.setItem(`mtl_key_${info.provider}`, key);
  return key;
}

export async function startPipeline() {
  const rawUrl     = document.getElementById('chapter-url').value.trim();
  const targetLang = getTargetLang();
  const quality    = document.getElementById('quality').value;

  if (!_validateApiKeyOrToast()) return;
  if (!rawUrl) { toast('Paste a MangaDex chapter URL.'); return; }

  const chapterId = parseChapterId(rawUrl);
  if (!chapterId) {
    toast("Could not find a chapter ID.\nMake sure it's a mangadex.org/chapter/… link.");
    return;
  }
  startPipelineWithId(chapterId, quality, targetLang);
}

export async function startPipelineWithId(chapterId, quality, targetLang) {
  quality    = quality    || document.getElementById('quality').value;
  targetLang = targetLang || getTargetLang();

  setCancelled(false);
  if (abortController) abortController.abort();
  setAbortController(new AbortController());
  const signal = abortController.signal;

  setActiveChapterId(chapterId);
  setPrevChapterId(null);
  setNextChapterId(null);
  // Release any leftover state from a PREVIOUS chapter before this one
  // starts writing into _pageStore/_manualOrder/etc. — see
  // _clearChapterState's docstring in utils.js for why this must run
  // here, not just on goBack().
  _clearChapterState();

  show('screen-reader');
  refreshCacheUI();  // update pill count when entering reader
  document.getElementById('pages-container').innerHTML = '';
  document.getElementById('manga-title').textContent   = 'Loading…';
  document.getElementById('chapter-info').textContent  = '';
  updateNavButtons();
  setProgress(0, 1);
  setStatus('Fetching chapter info…');

  try {
    // ── 1. Chapter meta ───────────────────────
    const meta       = await fetchChapterMeta(chapterId, signal);
    const sourceLang = meta.translatedLanguage;
    const isEnglish  = sourceLang === 'en';

    document.getElementById('manga-title').textContent = meta.mangaTitle;
    document.getElementById('chapter-info').textContent =
      `Ch. ${meta.chapter}${meta.chapterTitle ? ' · ' + meta.chapterTitle : ''}` +
      (meta.volume ? `  (Vol. ${meta.volume})` : '') +
      (isEnglish ? '' : `  ·  ${getLangName(sourceLang)} → ${targetLang}`);

    // Scanlation group credit
    const creditEl = document.getElementById('chapter-credit');
    if (meta.groups.length) {
      // SECURITY: g.name / g.id come straight from the MangaDex API (a
      // scanlation group's self-chosen display name) and are attacker-
      // controlled. Every other innerHTML sink in this file escapes external
      // text via esc() — this one didn't, which made it a stored-XSS gap
      // sitting right next to the API keys this app keeps in localStorage.
      const links = meta.groups.map(g =>
        `<a href="https://mangadex.org/group/${esc(g.id)}" target="_blank" rel="noopener">${esc(g.name)}</a>`
      ).join(' &amp; ');
      creditEl.innerHTML = `Translated by ${links}`;
    } else {
      creditEl.textContent = '';
    }

    // ── 2. Page URLs ──────────────────────────
    // FIX #12: urls is now [{cdn, img}] — cdn for OCR, img for <img> display
    setStatus('Loading page list…');
    const urls = await fetchPageUrls(chapterId, quality, signal);

    function resolveAdjacentChapters() {
      if (!meta.mangaId) return;
      const startedId = chapterId;
      fetchAdjacentChapters(meta.mangaId, chapterId, sourceLang, signal)
        .then(({ prev, next }) => {
          if (_activeChapterId !== startedId || cancelled) return;
          setPrevChapterId(prev); setNextChapterId(next);
          updateNavButtons();
        });
    }

    // ── 3. OCR -> translate -> render — shared with local-folder/CBZ
    //      chapters, see _runChapterPipeline below.
    await _runChapterPipeline({
      chapterId, urls, meta, sourceLang, targetLang, signal,
      resolveAdjacentChapters, cacheable: true,
      resume: { kind: 'mangadex', chapterId },
    });

  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(`Error: ${err.message}`);
    show('screen-home');
  }
}

/**
 * The actual OCR -> translate -> build-pageRegions work for a chapter's
 * pages, extracted out of _runChapterPipeline so a headless background
 * queue (queue.js) can run the exact same translation logic the live
 * reader uses, without dragging in anything DOM/reader-specific.
 *
 * From here down, `urls[i].cdn` / `urls[i].img` are treated as opaque
 * strings — a real MangaDex CDN url, or a `local-blob:<id>` reference
 * resolved by imageRefBody() in local-source.js — so this function
 * doesn't need to know or care which kind of chapter it's processing.
 *
 * Originally this loop was inline in _runChapterPipeline and called
 * renderPage/renderPageDisplay/renderPageError and wrote directly into
 * _pageStore keyed by the reader's OWN _activeChapterId global — every one
 * of those was a hazard for a background queue: _activeChapterId changes
 * the moment a person opens ANY chapter, so a queue writing under that key
 * while someone is actively reading something else would silently
 * corrupt whichever chapter they have open. Likewise the module-level
 * `cancelled` flag (state-and-constants.js) means "the reader's current
 * chapter was cancelled" — a queue checking that same flag would stop
 * dead the moment someone hit the reader's own back button, and clicking
 * the reader's own cancel would have nothing to do with the queue's
 * intent either way.
 *
 * Both problems are solved the same way: callers pass in WHERE results
 * go (onPageDone) and HOW TO KNOW they should stop (isCancelled) instead
 * of this function reaching for reader globals itself. The live reader's
 * call site (below, in _runChapterPipeline) passes callbacks that do
 * exactly what the old inline version did (renderPage + _pageStore.set,
 * keyed by _activeChapterId, checking the global `cancelled`); queue.js
 * passes nothing for onPageDone (headless — nothing to render) and its
 * OWN per-run cancelled flag, completely decoupled from whatever the
 * reader is doing at the same time.
 *
 * Returns pageRegions: Array<Region[]|[]> — index-aligned with `urls`,
 * exactly the shape setCachedChapter()'s `pageRegions` field expects, so
 * both callers can hand this straight to the cache write with no
 * reshaping.
 */
export async function _ocrTranslatePages(urls, sourceLang, targetLang, signal, opts = {}) {
  const {
    onPageDone = null,      // (i, regions, {ocrData, sortedOcr}) => void — called once per successful page
    onPageError = null,     // (i, err) => void
    onProgress = null,      // (doneCount, total) => void
    isCancelled = () => cancelled,  // defaults to the reader's global flag for the live-reader call site below
  } = opts;

  const total = urls.length;

  // Check the engine recommendation BEFORE queuing a single page's OCR
  // work — this only depends on sourceLang + the selected local engine,
  // both already known here, so there's no need to wait for a real /ocr
  // round-trip. Previously this only surfaced from inside a page task
  // AFTER that page's OCR had already run, and since runConcurrent(tasks,
  // 3) launches 3 pages at once (and keeps pulling more from the queue as
  // each finishes, with no awareness of the banner), several pages —
  // sometimes most of the chapter, if you're slow to notice — would
  // already be OCR'd on the "wrong" engine before you could click
  // "Switch". Awaiting this tiny GET (no image work, no cost) means the
  // banner can appear, and be acted on, before any page task exists yet.
  //
  // Skipped entirely for a background queue call (onPageDone is null,
  // used here as "are we headless" — see queue.js) since there's no one
  // watching the screen to click a banner button, and
  // waitForEngineRecDecision() would hang forever waiting for a click
  // that will never come.
  if (onPageDone) {
    try {
      const recRes = await fetch(
        `/ocr/recommendation?lang=${encodeURIComponent(sourceLang)}`
        + `&local_engine=${encodeURIComponent(_resolveLocalEngine(sourceLang))}`,
        { signal }
      );
      if (recRes.ok) {
        const { local_engine_recommendation } = await recRes.json();
        maybeShowEngineRecommendation(sourceLang, local_engine_recommendation);
        await waitForEngineRecDecision(signal);
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Non-critical — never block the chapter over a failed recommendation check.
    }
  }

  const pageRegions = new Array(total).fill(null);
  let doneCount = 0;
  let _visionFallbackToasted = false;  // show at most one fallback toast per chapter/queue-item

  const tasks = urls.map((url, i) => async () => {
    if (isCancelled()) return;
    try {
      // OCR: send the CDN url (MangaDex) or local-blob ref — ocrPage()
      // resolves either via imageRefBody() before hitting /ocr.
      const ocrData   = await ocrPage(url.cdn, sourceLang, signal);
      const ocrResult = ocrData.regions;
      if (isCancelled()) return;

      // Surface Vision fallback once per chapter (quota hit / network error).
      // Skipped headless (onPageDone null) — a queue running unattended has
      // no one to show a toast to, and toast() itself is a DOM call.
      if (onPageDone && ocrData.visionFallback && !_visionFallbackToasted) {
        _visionFallbackToasted = true;
        const engineLabel = _ENGINE_LABEL[ocrData.ocrEngine] || 'the local engine';
        const msgs = {
          quota:   `⚠ Gemini quota hit — falling back to ${engineLabel} for remaining pages. Quality may be lower.`,
          error:   `⚠ Gemini Vision error — falling back to ${engineLabel} for remaining pages.`,
          network: `⚠ Network error reaching Gemini — falling back to ${engineLabel} (offline or quota reset needed).`,
          parse:   `⚠ Gemini Vision response unreadable — falling back to ${engineLabel}.`,
          empty:   `⚠ Gemini Vision found no text — falling back to ${engineLabel}.`,
        };
        toast(msgs[ocrData.visionFallback] ?? `⚠ Vision OCR fell back to ${engineLabel}.`);
      }
      if (onPageDone) maybeShowEngineRecommendation(sourceLang, ocrData.localEngineRecommendation);

      if (!ocrResult.length) {
        // Full-art page — nothing to translate
        pageRegions[i] = [];
        if (onPageDone) onPageDone(i, [], { ocrData, sortedOcr: null });
      } else {
        const sortedOcr = _sortRegions(ocrResult, ocrData.hBorders, ocrData.vBorders);
        const translated = await translateBatch(sortedOcr, sourceLang, targetLang, signal);
        const regions = sortedOcr.map((r, j) => ({
          text: r.text || '',
          t:  translated[j]?.t  || 'speech',
          x:  r.cx,
          y:  r.cy,
          box: r.box,
          tl: translated[j]?.tl || '—',
        }));
        pageRegions[i] = regions;
        if (onPageDone) onPageDone(i, regions, { ocrData, sortedOcr });
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (onPageError) onPageError(i, err);
    }
    doneCount++;
    if (onProgress) onProgress(doneCount, total);
  });

  await runConcurrent(tasks, 3, isCancelled);
  return pageRegions;
}

/**
 * Renders one chapter into the live reader — English passthrough,
 * cache-hit, or a fresh OCR+translate run (delegated to
 * _ocrTranslatePages above for the actual per-page work). Shared by all
 * three source entry points (startPipelineWithId / startPipelineWithLocalSource
 * / startPipelineWithSuwayomiSource) below, each supplying their own
 * `urls`/`meta`/`resume` shape — see those functions for what differs
 * per source.
 *
 * `cacheable` gates the localStorage chapter cache (get + set). A local
 * chapter's page Blobs live only in memory for this browser tab — they
 * don't survive a reload — so caching its translations without the images
 * would leave a "✓ cached" entry that can never actually re-render. MangaDex
 * and Suwayomi chapters (both re-fetchable by id at any time) stay
 * cacheable.
 *
 * `resume`, if provided, is a source-specific descriptor handed to
 * history.js's startHistoryTracking() — see that function's own doc
 * comment for what each source needs to be resumable later.
 */
export async function _runChapterPipeline({ chapterId, urls, meta, sourceLang, targetLang,
                                      signal, resolveAdjacentChapters, cacheable = true,
                                      resume = null }) {
  const isEnglish = sourceLang === 'en';
  const total     = urls.length;
  if (total === 0) throw new Error('No pages found for this chapter.');

  // Every call site building `meta` (MangaDex fetch, local-folder/CBZ,
  // Suwayomi) already sets mangaId/mangaTitle — real values for the first
  // and third, {mangaId:null, mangaTitle:<local title>} for the second —
  // so this single call covers all three sources' glossary resolution.
  // See glossary.js's file header for why this is a module-level active
  // key rather than a parameter threaded through translateBatch() itself.
  setActiveGlossary(meta.mangaId, meta.mangaTitle);

  // New chapter starting — zero the per-chapter cost badge. Doesn't touch
  // the lifetime total. Safe even for the cache-hit path below: a fully
  // cached chapter makes no paid calls, so "this chapter: $0.00" is
  // correct either way.
  resetChapterCost();

  setProgress(0, total);
  const skeletons = urls.map((_, i) => addSkeleton(i));

  // Every .page-card now exists (regardless of which render branch below
  // fills each one in), so this is the one choke point common to all
  // three pipeline entry points — see history.js's startHistoryTracking
  // doc comment. `resume` is null only if a caller genuinely can't be
  // resumed at all (not currently the case for any of the three sources —
  // even 'local' gets tracked, just with a picker-reopen resume instead
  // of a URL — but kept optional here in case a future source can't).
  if (resume) {
    const chapterLabel = meta.chapter
      ? `Ch. ${meta.chapter}${meta.chapterTitle ? ' · ' + meta.chapterTitle : ''}`
      : '';
    startHistoryTracking({ chapterId, resume, title: meta.mangaTitle, chapterLabel, targetLang, pageCount: total });
  }

  // ── English — display only ────────────────
  if (isEnglish) {
    urls.forEach((url, i) => {
      renderPageDisplay(skeletons[i], i, total, url.img);
      setProgress(i + 1, total);
    });
    setStatus(`Done · ${total} pages`);
    resolveAdjacentChapters();
    return;
  }

  // ── Non-English — cache hit? ──────────────
  const cached = cacheable ? getCachedChapter(chapterId) : null;
  if (cached && cached.targetLang === targetLang) {
    document.getElementById('chapter-info').textContent += '  · ✓ cached';
    setStatus('Loading from cache…');
    urls.forEach((url, i) => {
      // Prefer any saved ✏ CORRECT edits over the plain pipeline regions —
      // otherwise leaving and re-entering an already-corrected chapter
      // would silently show the pre-correction version again.
      const regions = getEffectivePageRegions(chapterId, i, cached.pageRegions[i]);
      if (regions?.length) {
        // Populate _pageStore so ✏ CORRECT works on cached pages too.
        // We don't have raw OCR boxes, but sortedRegions is enough for the
        // correction sidebar to show real translations (tl / type).
        _pageStore.set(`${_activeChapterId}_${i}`, {
          cdnUrl: url.cdn, imgSrc: url.img, sourceLang, total,
          rawBoxes: [],
          autoRegions: regions.map(r => ({
            text: r.text || '', cx: r.x ?? 50, cy: r.y ?? 50,
            box:  r.box ?? [r.x-5, r.y-5, r.x+5, r.y+5],
            raw_box_ids: [],
          })),
          sortedRegions: regions.map(r => ({
            text: r.text || '', t: r.t || 'speech',
            cx: r.x ?? 50, cy: r.y ?? 50,
            box: r.box ?? [r.x-5, r.y-5, r.x+5, r.y+5],
            raw_box_ids: [], tl: r.tl || '—',
          })),
        });
        renderPage(skeletons[i], i, total, url.img, regions);
      } else {
        renderPageDisplay(skeletons[i], i, total, url.img);
      }
      setProgress(i + 1, total);
    });
    setStatus(`Done · ${total} pages · from cache`);
    resolveAdjacentChapters();
    return;
  }

  // ── Non-English — OCR + translate ─────────
  // Delegates to _ocrTranslatePages (above) — this call site supplies the
  // reader-specific glue (render each page as it finishes, write raw OCR
  // + sorted regions into _pageStore for the correction UI, update the
  // status line) via callbacks, so the actual OCR/translate logic lives
  // in exactly one place instead of being duplicated between the live
  // reader and queue.js's headless runs.
  setStatus(`0 / ${total} pages translated`);
  const pageRegions = await _ocrTranslatePages(urls, sourceLang, targetLang, signal, {
    onPageDone: (i, regions, { ocrData, sortedOcr }) => {
      const url = urls[i];
      // Store raw OCR data so the correction UI can access it per-page
      _pageStore.set(`${_activeChapterId}_${i}`, {
        cdnUrl: url.cdn, imgSrc: url.img, sourceLang, total,
        rawBoxes: ocrData.rawBoxes,
        autoRegions: ocrData.regions,
        ocrEngine: ocrData.ocrEngine,
        hBorders: ocrData.hBorders,
        vBorders: ocrData.vBorders,
      });
      // Always renderPage — it already handles the zero-region case on its
      // own (shows "— no text detected —" but still renders ✏ CORRECT and
      // ✦ Redo w/ Vision). renderPageDisplay is for the isEnglish branch
      // ABOVE this one (translation skipped entirely, by design, no OCR
      // ever ran) — using it here too, for a page OCR actually ran on but
      // came back empty, silently dropped both buttons. That left no way
      // to open Correction and manually draw boxes on exactly the page
      // that most needs it: one the OCR engine missed. Confirmed this is
      // what was happening — EasyOCR (forced whenever no separate Gemini
      // Vision key is supplied, which is the common case when DeepSeek is
      // the translation provider) misses real text far more often than
      // Gemini Vision OCR does, so this dead-end was disproportionately
      // hitting DeepSeek users, even though the bug itself has nothing to
      // do with the translation provider.
      renderPage(skeletons[i], i, total, url.img, regions);
      if (regions.length) {
        // Store translated data back into _pageStore so the correction UI
        // can show real translations instead of all-"—" fallbacks.
        // regions[j].t/.tl are exactly translated[j].t/.tl (with the same
        // 'speech'/'—' fallbacks already applied) — see _ocrTranslatePages'
        // own onPageDone call, `regions` IS that already-resolved array, so
        // reading from it here instead of re-deriving from sortedOcr avoids
        // duplicating the same fallback logic a second time.
        const _se = _pageStore.get(`${_activeChapterId}_${i}`);
        if (_se) _se.sortedRegions = sortedOcr.map((r, j) => ({
          text: r.text || '', t: regions[j].t,
          cx: r.cx, cy: r.cy, box: r.box,
          raw_box_ids: r.raw_box_ids || [],
          tl: regions[j].tl,
        }));
      }
    },
    onPageError: (i, err) => {
      const url = urls[i];
      // FIX #12: pass both cdn (for retry OCR) and img (for display)
      renderPageError(skeletons[i], i, total, url.cdn, url.img, err.message, sourceLang);
    },
    onProgress: (doneCount, pageTotal) => {
      setProgress(doneCount, pageTotal);
      if (!cancelled) setStatus(`${doneCount} / ${pageTotal} pages translated`);
    },
    isCancelled: () => cancelled,
  });


  if (!cancelled) {
    setStatus(`Done · ${total} pages`);
    if (cacheable) {
      setCachedChapter(chapterId, { meta, targetLang, pageRegions });
      refreshCacheUI();  // update pill after new chapter is cached
    }
    resolveAdjacentChapters();
  }
}

/**
 * Local-folder / .cbz entry point — the counterpart to startPipelineWithId()
 * for a chapter that never touches MangaDex or the network at all. Built by
 * local-source.js's chapterFromFileList()/chapterFromCbz(), which already
 * produce the same {cdn, img} page shape fetchPageUrls() does (cdn is a
 * local-blob:<id> reference instead of an https:// url) — so this function
 * is mostly just the MangaDex-specific setup (chapter meta, adjacent-chapter
 * lookup) stripped out, feeding the same _runChapterPipeline() above.
 */
export async function startPipelineWithLocalSource(localChapter, targetLang) {
  targetLang = targetLang || getTargetLang();
  if (!_validateApiKeyOrToast()) return;

  setCancelled(false);
  if (abortController) abortController.abort();
  setAbortController(new AbortController());
  const signal = abortController.signal;

  const chapterId  = localChapter.id;
  const sourceLang = localChapter.sourceLang;
  const isEnglish  = sourceLang === 'en';
  const total      = localChapter.pages.length;

  setActiveChapterId(chapterId);
  setPrevChapterId(null);   // no prev/next chapter for a local source —
  setNextChapterId(null);   // updateNavButtons() below hides the nav bar
  // Release any leftover state from a PREVIOUS chapter — see
  // _clearChapterState's docstring in utils.js.
  _clearChapterState();

  show('screen-reader');
  refreshCacheUI();
  document.getElementById('pages-container').innerHTML = '';
  document.getElementById('manga-title').textContent  = localChapter.title || 'Local chapter';
  document.getElementById('chapter-info').textContent =
    `${total} page${total === 1 ? '' : 's'}` +
    (isEnglish ? '' : `  ·  ${getLangName(sourceLang)} → ${targetLang}`) +
    `  ·  local (${localChapter.kind})`;
  document.getElementById('chapter-credit').textContent = '';
  updateNavButtons();
  setProgress(0, 1);
  setStatus(`Reading ${total} local page${total === 1 ? '' : 's'}…`);

  const meta = {
    mangaTitle: localChapter.title, mangaId: null, chapter: '', chapterTitle: '',
    volume: null, translatedLanguage: sourceLang, groups: [],
  };

  try {
    await _runChapterPipeline({
      chapterId, urls: localChapter.pages, meta, sourceLang, targetLang, signal,
      resolveAdjacentChapters: () => {},  // no MangaDex feed to look up — nothing to resolve
      cacheable: false,                   // see _runChapterPipeline's doc comment: blobs don't survive a reload
      // 'local' can't be resumed by re-fetching a URL (no such thing
      // exists for a folder/CBZ pick) — resumeHistoryEntry (history.js)
      // instead reopens whichever OS picker matches localChapter.kind
      // ('folder' or 'cbz'), saving a menu dig even though the person
      // still has to reselect the file themselves. See history.js's file
      // header for why that's the actual ceiling here, not a shortcut.
      resume: { kind: 'local', sourceKind: localChapter.kind },
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(`Error: ${err.message}`);
    show('screen-home');
  }
}

/**
 * Suwayomi entry point — the counterpart to startPipelineWithLocalSource()
 * above, for a chapter built by chapterFromSuwayomi() (suwayomi-api.js)
 * instead of a local folder/CBZ. Nearly identical to that function, with one
 * real difference: cacheable is true here. A local chapter's page Blobs live
 * only in memory for the tab (see startPipelineWithLocalSource's doc
 * comment above), so caching its translations without the images would
 * leave a dead "✓ cached" entry that can never re-render — but a Suwayomi
 * chapter's pages are real, re-fetchable http:// URLs against a server
 * that's expected to still be running next time, exactly like a MangaDex
 * chapter's CDN URLs are. No reason to make someone re-OCR/re-translate a
 * chapter they already did just because it came from Suwayomi instead.
 */
export async function startPipelineWithSuwayomiSource(chapter, targetLang) {
  targetLang = targetLang || getTargetLang();
  if (!_validateApiKeyOrToast()) return;

  setCancelled(false);
  if (abortController) abortController.abort();
  setAbortController(new AbortController());
  const signal = abortController.signal;

  const chapterId  = chapter.id;
  const sourceLang = chapter.sourceLang;
  const isEnglish  = sourceLang === 'en';
  const total      = chapter.pages.length;

  setActiveChapterId(chapterId);
  setPrevChapterId(null);   // no adjacent-chapter feed for Suwayomi yet —
  setNextChapterId(null);   // updateNavButtons() below hides the nav bar
  // Release any leftover state from a PREVIOUS chapter — see
  // _clearChapterState's docstring in utils.js.
  _clearChapterState();

  show('screen-reader');
  refreshCacheUI();
  document.getElementById('pages-container').innerHTML = '';
  document.getElementById('manga-title').textContent  = chapter.title || 'Suwayomi chapter';
  document.getElementById('chapter-info').textContent =
    `${total} page${total === 1 ? '' : 's'}` +
    (isEnglish ? '' : `  ·  ${getLangName(sourceLang)} → ${targetLang}`) +
    `  ·  suwayomi`;
  document.getElementById('chapter-credit').textContent = '';
  updateNavButtons();
  setProgress(0, 1);
  setStatus(`Loading ${total} page${total === 1 ? '' : 's'} from Suwayomi…`);

  const meta = {
    // chapter.mangaId is Suwayomi's own internal manga id — see
    // suwayomi-api.js's chapterFromSuwayomi. Previously hardcoded null
    // here (before that field existed), which meant every Suwayomi series
    // fell back to glossary.js's name-keyed path instead of a stable id —
    // harmless for mangaId's other current use (resolveAdjacentChapters,
    // which is a no-op stub for this source below regardless), but wrong
    // for glossary keying specifically once that feature existed.
    mangaTitle: chapter.title, mangaId: chapter.mangaId || null, chapter: '', chapterTitle: '',
    volume: null, translatedLanguage: sourceLang, groups: [],
  };

  try {
    // chapter.id is `suwayomi:<mangaId>:<chapterIndex>` (see suwayomi-api.js's
    // chapterFromSuwayomi) — parsed back apart here rather than trusting
    // chapter.mangaId (which carries a `suwayomi:` PREFIX for glossary
    // namespacing, not the raw id chapterFromSuwayomi's URL-building
    // actually needs) or a second field to stay in sync with it. The
    // composite id is the one value guaranteed to already be correct.
    const [, suwaMangaId, suwaChapterIndex] = chapterId.split(':');
    await _runChapterPipeline({
      chapterId, urls: chapter.pages, meta, sourceLang, targetLang, signal,
      resolveAdjacentChapters: () => {},  // no adjacent-chapter feed for Suwayomi yet
      cacheable: true,
      resume: { kind: 'suwayomi', mangaId: suwaMangaId, chapterIndex: suwaChapterIndex, sourceLang },
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(`Error: ${err.message}`);
    show('screen-home');
  }
}

// ── Home-screen UI glue for the Suwayomi source ─────────────────
// (chapterFromSuwayomi() itself lives in suwayomi-api.js, matching that
// file's scope: fetch + normalize only, same as mangadex-api.js — no
// UI-triggering handlers there, same split this codebase already uses.)
export function toggleSuwayomiSource() {
  document.getElementById('suwayomi-source-wrap')?.classList.toggle('open');
}

export async function loadFromSuwayomi() {
  const mangaId      = document.getElementById('suwayomi-manga-id').value.trim();
  const chapterIndex = document.getElementById('suwayomi-chapter-index').value.trim();
  const sourceLang   = document.getElementById('suwayomi-source-lang').value;

  if (!mangaId || !chapterIndex) {
    toast('Enter both a Manga ID and a Chapter Index.');
    return;
  }

  toast('Fetching from Suwayomi…', 3000);
  try {
    const chapter = await chapterFromSuwayomi(mangaId, chapterIndex, sourceLang);
    startPipelineWithSuwayomiSource(chapter);
  } catch (e) {
    toast(e.message);
  }
}

