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
function _validateApiKeyOrToast() {
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

  localStorage.setItem(`mtl_key_${info.provider}`, key);
  return key;
}

async function startPipeline() {
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

async function startPipelineWithId(chapterId, quality, targetLang) {
  quality    = quality    || document.getElementById('quality').value;
  targetLang = targetLang || getTargetLang();

  cancelled = false;
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  _activeChapterId = chapterId;
  prevChapterId    = null;
  nextChapterId    = null;

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
          prevChapterId = prev; nextChapterId = next;
          updateNavButtons();
        });
    }

    // ── 3. OCR -> translate -> render — shared with local-folder/CBZ
    //      chapters, see _runChapterPipeline below.
    await _runChapterPipeline({
      chapterId, urls, meta, sourceLang, targetLang, signal,
      resolveAdjacentChapters, cacheable: true,
    });

  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(`Error: ${err.message}`);
    show('screen-home');
  }
}

/**
 * The actual OCR -> translate -> render loop, factored out of
 * startPipelineWithId() so startPipelineWithLocalSource() (local-source.js)
 * can drive the exact same pipeline. From here down, `urls[i].cdn` /
 * `urls[i].img` are treated as opaque strings — a real MangaDex CDN url, or
 * a `local-blob:<id>` reference resolved by imageRefBody() in
 * local-source.js — so this function doesn't need to know or care which
 * kind of chapter it's processing.
 *
 * `cacheable` gates the localStorage chapter cache (get + set). A local
 * chapter's page Blobs live only in memory for this browser tab — they
 * don't survive a reload — so caching its translations without the images
 * would leave a "✓ cached" entry that can never actually re-render. MangaDex
 * chapters (re-fetchable by URL at any time) stay cacheable as before.
 */
async function _runChapterPipeline({ chapterId, urls, meta, sourceLang, targetLang,
                                      signal, resolveAdjacentChapters, cacheable = true }) {
  const isEnglish = sourceLang === 'en';
  const total     = urls.length;
  if (total === 0) throw new Error('No pages found for this chapter.');

  setProgress(0, total);
  const skeletons = urls.map((_, i) => addSkeleton(i));

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
  setStatus(`0 / ${total} pages translated`);
  const pageRegions = new Array(total).fill(null);
  let doneCount     = 0;
  let _visionFallbackToasted = false;  // show at most one fallback toast per chapter

  const tasks = urls.map((url, i) => async () => {
    if (cancelled) return;
    try {
      // OCR: send the CDN url (MangaDex) or local-blob ref — ocrPage()
      // resolves either via imageRefBody() before hitting /ocr.
      const ocrData   = await ocrPage(url.cdn, sourceLang, signal);
      const ocrResult = ocrData.regions;
      if (cancelled) return;

      // Surface Vision fallback once per chapter (quota hit / network error)
      if (ocrData.visionFallback && !_visionFallbackToasted) {
        _visionFallbackToasted = true;
        const msgs = {
          quota:   '⚠ Gemini quota hit — falling back to EasyOCR for remaining pages. Quality may be lower.',
          error:   '⚠ Gemini Vision error — falling back to EasyOCR for remaining pages.',
          network: '⚠ Network error reaching Gemini — falling back to EasyOCR (offline or quota reset needed).',
          parse:   '⚠ Gemini Vision response unreadable — falling back to EasyOCR.',
        };
        toast(msgs[ocrData.visionFallback] ?? '⚠ Vision OCR fell back to EasyOCR.');
      }

      // Store raw OCR data so the correction UI can access it per-page
      _pageStore.set(`${_activeChapterId}_${i}`, {
        cdnUrl: url.cdn, imgSrc: url.img, sourceLang, total,
        rawBoxes: ocrData.rawBoxes,
        autoRegions: ocrResult,
        ocrEngine: ocrData.ocrEngine,
        hBorders: ocrData.hBorders,
        vBorders: ocrData.vBorders,
      });

      if (!ocrResult.length) {
        // Full-art page — nothing to translate
        renderPageDisplay(skeletons[i], i, total, url.img);
        pageRegions[i] = [];
      } else {
        // Translate + classify via DeepSeek (proxied)
        // Sort regions per user's reading order preference
        const sortedOcr = _sortRegions(ocrResult, ocrData.hBorders, ocrData.vBorders);
        const translated = await translateBatch(sortedOcr, sourceLang, targetLang, signal);
        // FIX #2: use translated[j].t (classified type) instead of hardcoded 'speech'
        // BUG FIX: include `text` (original OCR source) so RE-TRANSLATE works correctly
        // when this chapter is reloaded from the localStorage cache. Without it,
        // retranslatePage filters out every region (r.text.trim() === '') and silently
        // aborts with "No regions to translate." on every cached chapter.
        const regions    = sortedOcr.map((r, j) => ({
          text: r.text || '',
          t:  translated[j]?.t  || 'speech',
          x:  r.cx,
          y:  r.cy,
          box: r.box,
          tl: translated[j]?.tl || '—',
        }));
        pageRegions[i] = regions;
        renderPage(skeletons[i], i, total, url.img, regions);
        // Store translated data back into _pageStore so the correction UI
        // can show real translations instead of all-"—" fallbacks.
        const _se = _pageStore.get(`${_activeChapterId}_${i}`);
        if (_se) _se.sortedRegions = sortedOcr.map((r, j) => ({
          text: r.text || '', t: translated[j]?.t || 'speech',
          cx: r.cx, cy: r.cy, box: r.box,
          raw_box_ids: r.raw_box_ids || [],
          tl: translated[j]?.tl || '—',
        }));
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      // FIX #12: pass both cdn (for retry OCR) and img (for display)
      renderPageError(skeletons[i], i, total, url.cdn, url.img, err.message, sourceLang);
    }
    doneCount++;
    setProgress(doneCount, total);
    if (!cancelled) setStatus(`${doneCount} / ${total} pages translated`);
  });

  await runConcurrent(tasks, 3);

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
async function startPipelineWithLocalSource(localChapter, targetLang) {
  targetLang = targetLang || getTargetLang();
  if (!_validateApiKeyOrToast()) return;

  cancelled = false;
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  const chapterId  = localChapter.id;
  const sourceLang = localChapter.sourceLang;
  const isEnglish  = sourceLang === 'en';
  const total      = localChapter.pages.length;

  _activeChapterId = chapterId;
  prevChapterId    = null;   // no prev/next chapter for a local source —
  nextChapterId    = null;   // updateNavButtons() below hides the nav bar

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
async function startPipelineWithSuwayomiSource(chapter, targetLang) {
  targetLang = targetLang || getTargetLang();
  if (!_validateApiKeyOrToast()) return;

  cancelled = false;
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  const chapterId  = chapter.id;
  const sourceLang = chapter.sourceLang;
  const isEnglish  = sourceLang === 'en';
  const total      = chapter.pages.length;

  _activeChapterId = chapterId;
  prevChapterId    = null;   // no adjacent-chapter feed for Suwayomi yet —
  nextChapterId    = null;   // updateNavButtons() below hides the nav bar

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
    mangaTitle: chapter.title, mangaId: null, chapter: '', chapterTitle: '',
    volume: null, translatedLanguage: sourceLang, groups: [],
  };

  try {
    await _runChapterPipeline({
      chapterId, urls: chapter.pages, meta, sourceLang, targetLang, signal,
      resolveAdjacentChapters: () => {},  // no adjacent-chapter feed for Suwayomi yet
      cacheable: true,
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
function toggleSuwayomiSource() {
  document.getElementById('suwayomi-source-wrap')?.classList.toggle('open');
}

async function loadFromSuwayomi() {
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

