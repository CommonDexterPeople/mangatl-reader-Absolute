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
const _pageStore = new Map();

async function ocrPage(cdnUrl, lang, signal, visionModeOverride) {
  const marginScale = parseFloat(document.getElementById('merge-scale')?.value ?? '0.5');
  const info    = getModelInfo();
  // Pass the Gemini key + model so the proxy can use Vision OCR.
  // For DeepSeek users with no Gemini key, Vision OCR is skipped and
  // EasyOCR is used as normal.
  const aiKey   = info.provider === 'gemini'
    ? (document.getElementById('ai-key')?.value?.trim() ?? '')
    : '';
  const aiModel = info.provider === 'gemini' ? getModelId() : '';
  // vision_mode controls when Vision OCR fires:
  //   'smart' — only for languages where EasyOCR struggles
  //             (CJK, Arabic, Thai, Cyrillic, Vietnamese, and Latin heavy-diacritic languages)
  //             Best for free-tier users: saves quota while still routing the hard cases through Vision
  //   'all'   — every language
  //   'off'   — never (EasyOCR only)
  // DeepSeek users always get 'off' regardless of the select value.
  // visionModeOverride lets a caller force a specific mode for one call
  // (e.g. "redo this page with Vision only" always wants 'all') without
  // touching the person's saved dropdown preference for every other page.
  const visionMode = info.provider === 'gemini'
    ? (visionModeOverride || document.getElementById('vision-ocr-mode')?.value || 'smart')
    : 'off';

  // cdnUrl is either a real https:// MangaDex CDN url, or a local-blob:<id>
  // reference (a local-folder/CBZ page — see local-source.js). imageRefBody
  // resolves it to whichever body shape /ocr expects for that kind of page.
  const r = await fetch('/ocr', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(await imageRefBody(cdnUrl)),
      lang, margin_scale: marginScale,
      ai_key: aiKey, ai_model: aiModel, vision_mode: visionMode,
    })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.description || `OCR error ${r.status}`);
  }
  const data = await r.json();
  return {
    regions:       data.regions        ?? [],
    rawBoxes:      data.raw_boxes      ?? [],
    visionFallback: data.vision_fallback ?? null,  // 'quota'|'error'|'network'|'parse'|null
    ocrEngine:     data.ocr_engine     ?? "easyocr", // 'easyocr'|'vision'|'vision+easyocr'
    // Panel border positions as % of page width/height — same coordinate
    // convention as region cx/cy. Used by _sortRegions for panel-aware
    // reading order instead of guessing panel membership from cy alone.
    hBorders:      data.h_borders      ?? [],
    vBorders:      data.v_borders      ?? [],
  };
}

