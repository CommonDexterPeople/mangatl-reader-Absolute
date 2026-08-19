// ═══════════════════════════════════════════════════════════════
// ocr-client.js
// Client-side call into the backend /ocr route for a single page.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// OCR  (runs on local proxy — no rate limit)
// ══════════════════════════════════════════════
// ── Per-page runtime store ─────────────────────────────────────────────────
// Keyed by `${chapterId}_${pageIdx}`.  Holds cdnUrl, imgSrc, sourceLang,
// rawBoxes (pre-merge fragments), and autoRegions from the last OCR run.
import { recordUsage } from './cost-tracker.js';
import { imageRefBody } from './local-source.js';
import { getModelId, getModelInfo } from './translate-client.js';
import { waitForGeminiSlot } from './utils.js';

export const _pageStore = new Map();

// ── Local OCR engine selection ──────────────────────────────────────────────
// Three layers, checked in priority order by _resolveLocalEngine():
//   1. _chapterEngineOverride — "switch just this chapter", in-memory only,
//      reset per chapter load (see _clearChapterState() in utils.js).
//   2. mtl_local_engine_always[lang] — "always use my pick for <lang>",
//      persisted, set from the recommendation banner's third button.
//   3. mtl_local_ocr_engine — the plain global default from the settings
//      dropdown (#local-ocr-engine).
// Falls back to 'easyocr' if nothing is set anywhere, matching the
// select's own default option and server.py's /ocr default — a user who's
// never touched this setting should get identical behavior whether the
// default lives client-side or server-side.
export let _chapterEngineOverride = null;
export let _engineRecShown = false;

export function _alwaysMap() {
  try { return JSON.parse(localStorage.getItem('mtl_local_engine_always') || '{}'); }
  catch { return {}; }
}

export function _resolveLocalEngine(lang) {
  if (_chapterEngineOverride) return _chapterEngineOverride;
  const always = _alwaysMap()[lang];
  if (always) return always;
  return localStorage.getItem('mtl_local_ocr_engine')
      || document.getElementById('local-ocr-engine')?.value
      || 'easyocr';
}

export const _ENGINE_LABEL = { easyocr: 'EasyOCR', rapidocr: 'RapidOCR' };

export function hideEngineRecBanner() {
  const el = document.getElementById('engine-rec-banner');
  if (el) el.style.display = 'none';
}

// Called once per chapter (guarded by _engineRecShown), the first time a
// page's /ocr response carries local_engine_recommendation — i.e. the
// chapter's language has real tested data (see server.py's
// _LOCAL_ENGINE_RECOMMENDATION) AND the user isn't already on the
// recommended engine. Deliberately a dismissible banner, not a blocking
// popup or auto-switch — see ROADMAP.md item 2 for why.
export function maybeShowEngineRecommendation(lang, rec) {
  if (!rec || _engineRecShown) return;
  _engineRecShown = true;
  const current = _resolveLocalEngine(lang);
  const recommended = rec.engine;
  if (recommended === current) return;   // already on the recommended engine

  _engineRecLang = lang;
  _engineRecTarget = recommended;

  document.getElementById('engine-rec-text').textContent =
    `This chapter's language usually does better with ${_ENGINE_LABEL[recommended]}. ${rec.reason}`;
  document.getElementById('engine-rec-switch').textContent =
    `Switch to ${_ENGINE_LABEL[recommended]}`;
  document.getElementById('engine-rec-always').textContent =
    `Always use ${_ENGINE_LABEL[recommended]} for this language`;
  document.getElementById('engine-rec-banner').style.display = 'block';
}

export let _engineRecLang = null, _engineRecTarget = null;
export let _engineRecResolve = null;   // pending waitForEngineRecDecision() resolver, if any

// Resolves once the currently-shown banner has been acted on (any of the 3
// buttons), so a caller can hold off doing real work until the user has
// actually decided — not just until the banner has rendered. Resolves
// immediately (no-op) if no banner is currently shown, e.g. the user's
// already on the recommended engine or there's no data for this language.
// Rejects with AbortError if `signal` fires first (chapter navigated away
// from / cancelled) so an abandoned wait doesn't hang forever.
export function waitForEngineRecDecision(signal) {
  const banner = document.getElementById('engine-rec-banner');
  if (!banner || banner.style.display !== 'block') return Promise.resolve();
  return new Promise((resolve, reject) => {
    _engineRecResolve = resolve;
    if (signal) {
      if (signal.aborted) { _engineRecResolve = null; reject(new DOMException('Aborted', 'AbortError')); return; }
      signal.addEventListener('abort', () => {
        _engineRecResolve = null;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

export function _engineRecAction(action) {
  if (action === 'switch') {
    // This chapter only — remaining un-fetched pages will pick this up via
    // _resolveLocalEngine(); already-rendered pages are left as-is rather
    // than silently re-OCR'd out from under the reader.
    _chapterEngineOverride = _engineRecTarget;
  } else if (action === 'always') {
    const map = _alwaysMap();
    map[_engineRecLang] = _engineRecTarget;
    localStorage.setItem('mtl_local_engine_always', JSON.stringify(map));
    _chapterEngineOverride = _engineRecTarget;   // apply immediately too, not just future chapters
  }
  // 'keep' (and both other branches after recording the choice): just dismiss.
  hideEngineRecBanner();
  if (_engineRecResolve) { _engineRecResolve(); _engineRecResolve = null; }
}

export async function ocrPage(cdnUrl, lang, signal, visionModeOverride) {
  const marginScale = parseFloat(document.getElementById('merge-scale')?.value ?? '0.5');
  const info    = getModelInfo();
  // Pick the Gemini key/model Vision OCR should use, independent of which
  // service is actually translating the text:
  //   - Gemini is the translator            -> its own ai-key field IS a Gemini key
  //   - DeepL or DeepSeek is the translator -> ai-key holds a non-Gemini key
  //     instead, so Vision OCR needs the separate vision-ocr-key field (see
  //     translate-client.js's onModelChange() for where that field is
  //     shown/hidden) — Vision OCR always calls Gemini's API regardless of
  //     which provider translates. DeepSeek and DeepL are treated
  //     identically here: neither's key is usable for Gemini's vision
  //     endpoint, and both are full LLM-capable / real-translator
  //     providers where "read the page with Vision, translate however you
  //     like" is just as sensible a combination as it is for DeepL — the
  //     original Gemini-only gating here was really "is there a Gemini key
  //     available", not anything specific to which provider Gemini was
  //     being compared against.
  const needsSeparateVisionKey = info.provider === 'deepl' || info.provider === 'deepseek';
  const aiKey = info.provider === 'gemini'
    ? (document.getElementById('ai-key')?.value?.trim() ?? '')
    : needsSeparateVisionKey
    ? (document.getElementById('vision-ocr-key')?.value?.trim() ?? '')
    : '';
  // Model is only meaningful for the Gemini-as-translator case — Vision OCR
  // always uses a fixed default model when the key comes from the separate
  // vision-ocr-key field, since there's no "which Gemini model" dropdown for
  // that field (Vision OCR's model choice was never exposed as its own
  // setting even in the Gemini-translator case; getModelId() there is
  // really "whichever Gemini model is also doing translation").
  const aiModel = info.provider === 'gemini' ? getModelId()
    : needsSeparateVisionKey ? 'gemini-3.5-flash'
    : '';
  // vision_mode controls when Vision OCR fires:
  //   'smart' — only for languages where EasyOCR struggles
  //             (CJK, Arabic, Thai, Cyrillic, Vietnamese, and Latin heavy-diacritic languages)
  //             Best for free-tier users: saves quota while still routing the hard cases through Vision
  //   'all'   — every language
  //   'off'   — never (EasyOCR only)
  const visionMode = (info.provider === 'gemini' || (needsSeparateVisionKey && aiKey))
    ? (visionModeOverride || document.getElementById('vision-ocr-mode')?.value || 'smart')
    : 'off';

  // cdnUrl is either a real https:// MangaDex CDN url, or a local-blob:<id>
  // reference (a local-folder/CBZ page — see local-source.js). imageRefBody
  // resolves it to whichever body shape /ocr expects for that kind of page.
  //
  // Only wait for a Gemini rate-limit slot when this call will actually
  // reach Gemini — an EasyOCR-only call (vision_mode 'off', or no usable
  // key at all) has no Gemini quota to protect and shouldn't be slowed
  // down by a limiter meant for a different service entirely.
  if (visionMode !== 'off' && aiKey) {
    await waitForGeminiSlot();
  }
  const r = await fetch('/ocr', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(await imageRefBody(cdnUrl)),
      lang, margin_scale: marginScale,
      ai_key: aiKey, ai_model: aiModel, vision_mode: visionMode,
      local_engine: _resolveLocalEngine(lang),
    })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.description || `OCR error ${r.status}`);
  }
  const data = await r.json();
  // data.usage is only present when Gemini Vision actually fired for this
  // page (see server.py's ocr_page — absent entirely for plain EasyOCR
  // pages, since those never hit a paid API). Present even when Vision fell
  // back to EasyOCR for the final result (data.vision_fallback set) — a
  // "parse"/"empty" outcome still billed real tokens, see server.py's
  // _ocr_gemini_vision docstring.
  if (data.usage) {
    recordUsage('ocr', data.usage, 'gemini', data.usage_model || aiModel);
  }
  return {
    regions:       data.regions        ?? [],
    rawBoxes:      data.raw_boxes      ?? [],
    visionFallback: data.vision_fallback ?? null,  // 'quota'|'error'|'network'|'parse'|null
    ocrEngine:     data.ocr_engine     ?? "easyocr", // 'easyocr'|'rapidocr'|'vision'|'vision+easyocr'|'vision+rapidocr'
    // Panel border positions as % of page width/height — same coordinate
    // convention as region cx/cy. Used by _sortRegions for panel-aware
    // reading order instead of guessing panel membership from cy alone.
    hBorders:      data.h_borders      ?? [],
    vBorders:      data.v_borders      ?? [],
    // {engine, reason} when server.py has a real tested recommendation for
    // this chapter's language AND it differs from what was used — see
    // maybeShowEngineRecommendation(). null otherwise (no data for this
    // language yet, or already on the recommended engine).
    localEngineRecommendation: data.local_engine_recommendation ?? null,
  };
}


// Write-access for other modules — see the note on setCancelled() in
// state-and-constants.js for why these exist under ES modules.
export function setChapterEngineOverride(v) { _chapterEngineOverride = v; }
export function setEngineRecShown(v)        { _engineRecShown        = v; }
