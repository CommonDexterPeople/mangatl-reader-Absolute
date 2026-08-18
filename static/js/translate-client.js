// ═══════════════════════════════════════════════════════════════
// translate-client.js
// AI model + target-language selection, and translateBatch() — the
// multi-strategy JSON-recovery translation call into the backend.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// TRANSLATION  (multi-provider — proxied server-side)
// ══════════════════════════════════════════════

// FIX #2: valid type set used to sanitise AI classification output
const VALID_TEXT_TYPES = new Set(['speech', 'thought', 'sfx', 'narration', 'sign']);

// Model registry — value format: "provider|model-id"
const MODEL_INFO = {
  // Gemini models
  'gemini|gemini-3.5-flash':              { provider: 'gemini',   placeholder: 'AIza…', label: 'Gemini 3.5 Flash',       keyUrl: 'https://aistudio.google.com/app/apikey', keySite: 'aistudio.google.com' },
  'gemini|gemini-3.1-flash-lite':         { provider: 'gemini',   placeholder: 'AIza…', label: 'Gemini 3.1 Flash-Lite',  keyUrl: 'https://aistudio.google.com/app/apikey', keySite: 'aistudio.google.com' },
  'gemini|gemini-2.5-flash':              { provider: 'gemini',   placeholder: 'AIza…', label: 'Gemini 2.5 Flash',       keyUrl: 'https://aistudio.google.com/app/apikey', keySite: 'aistudio.google.com' },
  // Gemini models (paid flagship)
  'gemini|gemini-3.1-pro-preview':        { provider: 'gemini',   placeholder: 'AIza…', label: 'Gemini 3.1 Pro',         keyUrl: 'https://aistudio.google.com/app/apikey', keySite: 'aistudio.google.com' },
  // DeepSeek models
  'deepseek|deepseek-v4-flash':           { provider: 'deepseek', placeholder: 'sk-…',  label: 'DeepSeek V4 Flash',      keyUrl: 'https://platform.deepseek.com',          keySite: 'platform.deepseek.com' },
  'deepseek|deepseek-v4-pro':             { provider: 'deepseek', placeholder: 'sk-…',  label: 'DeepSeek V4 Pro',        keyUrl: 'https://platform.deepseek.com',          keySite: 'platform.deepseek.com' },
  // DeepL — not an LLM, see translate-client.js's DeepL section / server.py's
  // "DeepL" section comment. Free API keys end in ':fx' (DeepL's own
  // convention for distinguishing Free from Pro — see _deepl_base_url() in
  // server.py); either key type works here, the app doesn't need to ask
  // which plan the user is on.
  'deepl|deepl':                          { provider: 'deepl',    placeholder: '…:fx or a Pro key', label: 'DeepL', keyUrl: 'https://www.deepl.com/en/pro#developer', keySite: 'deepl.com/pro#developer' },
};

function getModelInfo() {
  const val = document.getElementById('ai-model')?.value || 'gemini|gemini-3.5-flash';
  return MODEL_INFO[val] || MODEL_INFO['gemini|gemini-3.5-flash'];
}

function getModelId() {
  const val = document.getElementById('ai-model')?.value || '';
  return val.split('|')[1] || 'gemini-3.5-flash';
}

function onModelChange() {
  const info     = getModelInfo();
  const keyEl    = document.getElementById('ai-key');
  const linkEl   = document.getElementById('ai-key-link');
  const hintEl   = document.getElementById('ai-hint');

  // Save current key under the OLD provider before switching
  if (keyEl) {
    const prevProvider = keyEl.dataset.provider;
    if (prevProvider && keyEl.value.trim()) {
      localStorage.setItem(`mtl_key_${prevProvider}`, keyEl.value.trim());
    }
  }

  // Load saved key for the NEW provider
  const savedForProvider = localStorage.getItem(`mtl_key_${info.provider}`);
  if (keyEl) {
    keyEl.placeholder       = info.placeholder;
    keyEl.dataset.provider  = info.provider;
    keyEl.value             = savedForProvider || '';
  }

  if (linkEl) { linkEl.href = info.keyUrl; linkEl.textContent = info.keySite; }

  if (hintEl) {
    const freeTierModels = ['gemini|gemini-3.1-flash-lite'];
    const modelVal = document.getElementById('ai-model')?.value || '';
    const freeNote = freeTierModels.includes(modelVal)
      ? ' (free tier — no credit card needed)'
      : info.provider === 'gemini' ? ' (paid — billing required)'
      : info.provider === 'deepl'  ? ' (free up to 1,000,000 characters TOTAL — one-time, does not reset monthly — no credit card needed; DeepL rejects requests past that until you upgrade)'
      : ' (~$0.02–0.05/chapter)';
    hintEl.textContent = `Get a free key at `;
    const a = document.createElement('a');
    a.id = 'ai-key-link'; a.href = info.keyUrl;
    a.target = '_blank'; a.textContent = info.keySite;
    hintEl.appendChild(a);
    hintEl.appendChild(document.createTextNode(freeNote));
  }

  // Vision OCR is available whenever a Gemini key exists somewhere — either
  // Gemini is the main translator (its own ai-key field IS the Gemini key),
  // Vision OCR is available whenever a Gemini key exists somewhere — either
  // Gemini is the main translator (its own ai-key field IS the Gemini key),
  // or DeepL/DeepSeek is the translator and a separate Vision-OCR-specific
  // Gemini key has been entered below.
  //
  // This used to be Gemini-only ("show Vision OCR mode only for Gemini;
  // hide entirely for DeepSeek") — that coupling meant switching away from
  // Gemini silently killed Vision OCR entirely, forcing every non-Gemini
  // user onto EasyOCR regardless of how well Vision would've read that
  // page. Vision OCR and "which service translates the text" are unrelated
  // axes — see /ocr's own docstring in server.py, it never took a
  // translator provider as input to begin with, only ai_key/ai_model for
  // Gemini specifically. DeepSeek was later folded into this same
  // treatment as DeepL, once it became clear the "hide for DeepSeek"
  // exception had no real justification of its own — DeepSeek is just as
  // capable of pairing with a separately-keyed Vision OCR pass as DeepL is.
  const visionGroup = document.getElementById('vision-ocr-group');
  const visionKeyWrap = document.getElementById('vision-ocr-key-wrap');
  if (visionGroup) {
    const isGemini = info.provider === 'gemini';
    const needsSeparateVisionKey = info.provider === 'deepl' || info.provider === 'deepseek';
    visionGroup.style.display = (isGemini || needsSeparateVisionKey) ? '' : 'none';
    if (visionKeyWrap) visionKeyWrap.style.display = needsSeparateVisionKey ? '' : 'none';
    // If switching TO a free-tier Gemini model, nudge toward 'smart' to protect quota —
    // but only if the user hasn't explicitly changed it from the default themselves.
    const freeTierModels2 = ['gemini|gemini-3.1-flash-lite'];
    const modeEl = document.getElementById('vision-ocr-mode');
    if (isGemini && modeEl && !localStorage.getItem('mtl_vision_mode')) {
      modeEl.value = freeTierModels2.includes(document.getElementById('ai-model')?.value || '')
        ? 'smart' : 'all';  // free-tier → 'smart' (protect quota); paid → 'all' (no quota concern)
    }
  }

  _updateTargetLangDeepLSupport(info.provider);

  localStorage.setItem('mtl_ai_model', document.getElementById('ai-model').value);
}

// Grays out target-language options DeepL can't translate to when DeepL is
// the active provider (re-enables them for every other provider). Uses
// _DEEPL_TARGET_LANG_MAP (translate-client.js's static map, kept in sync
// with DeepL's real supported-language list — see that map's own comment)
// rather than waiting on the live /deepl-languages fetch just to grey out a
// dropdown; translateBatchDeepL() still double-checks against the live list
// before actually sending a request, this is just an upfront UI hint so the
// user isn't surprised by an error after already correcting a chapter.
function _updateTargetLangDeepLSupport(provider) {
  const sel = document.getElementById('target-lang');
  if (!sel) return;
  const isDeepL = provider === 'deepl';
  let currentIsUnsupported = false;
  for (const opt of sel.querySelectorAll('option')) {
    if (opt.value === '__custom__') {
      // DeepL can't translate to a language the user free-typed — this app
      // has no way to know if it's one DeepL supports under a different
      // name. Disable rather than guess.
      opt.disabled = isDeepL;
      continue;
    }
    const supported = !isDeepL || !!_DEEPL_TARGET_LANG_MAP[opt.value];
    opt.disabled = !supported;
    if (isDeepL && !supported) {
      opt.title = `DeepL doesn't support ${opt.value} as a target language.`;
      if (opt.selected) currentIsUnsupported = true;
    } else {
      opt.removeAttribute('title');
    }
  }
  // If the currently-selected target language just became unsupported,
  // fall back to English (DeepL's most universally-supported target)
  // rather than leaving an invalid selection in place — translateBatch()
  // would otherwise throw on the very next translate click with no chance
  // for the user to notice the dropdown silently pointed at something
  // disabled.
  if (currentIsUnsupported) {
    sel.value = 'English';
    onTargetLangChange();
    toast('DeepL doesn\u2019t support that target language — switched to English.');
  }
}


// ── Target language dropdown ──────────────────
function onTargetLangChange() {
  const sel    = document.getElementById('target-lang');
  const custom = document.getElementById('target-lang-custom');
  const isCustom = sel.value === '__custom__';
  custom.style.display = isCustom ? 'block' : 'none';
  if (isCustom) { custom.focus(); }
  // Persist selection (value, not display label)
  localStorage.setItem('mtl_target_lang', sel.value);
}

// Returns the effective target language string for the AI prompt
function getTargetLang() {
  const sel = document.getElementById('target-lang');
  if (sel.value === '__custom__') {
    const customEl = document.getElementById('target-lang-custom');
    return (customEl.value.trim()) || localStorage.getItem('mtl_target_lang_custom') || 'English';
  }
  return sel.value || 'English';
}

// The API key is forwarded by the proxy and never appears in DevTools.
// translateBatch accepts regions [{text,cx,cy}] — cx/cy help the AI
// understand panel layout and infer reading order.
async function translateBatch(regions, sourceLang, targetLang, signal) {
  if (!regions.length) return [];
  const key      = document.getElementById('ai-key').value.trim();
  const info     = getModelInfo();
  const modelId  = getModelId();
  if (!key) throw new Error(`${info.label} API key not set.`);

  // Attach index so the model can return items in any order and we re-map correctly
  const items = regions.map((r, i) => ({
    i,
    text: r.text,
    cx: r.cx,   // left–right position (0 = left edge, 100 = right edge)
    cy: r.cy,   // top–bottom position (0 = top, 100 = bottom)
    confidence: r.confidence, // 0-1 recognition confidence, or null/undefined
                               // — kept on the item for display/debugging;
                               // no longer used as a noise-filter signal
                               // (see isNoise() below for why).
  }));

  // ── OCR noise filter ─────────────────────────────────────────────────────
  // Filters obvious non-text detections before sending to the AI. Reused by
  // the placeholder reconciliation further down — keeping this as ONE
  // function (rather than two copies of the same condition) means "what got
  // filtered" and "what placeholder does a filtered item get" can never
  // drift out of sync with each other.
  //
  // Text length is the only signal used. Single-character OCR detections are
  // almost always screentone patterns, stray marks, or EasyOCR false
  // positives — not real text. Upper cap (150 chars): real speech bubbles
  // rarely exceed this; a false-positive spanning a screentone/background
  // pattern can produce a very long string that burns tokens without being
  // translatable.
  //
  // REMOVED: a confidence-based signal (region.confidence <= 0.70) used to
  // sit here too. Checked against 16 real regions across two chapter pages
  // of actual manga OCR output, confidence did not track real quality at
  // all — e.g. "PapeL!" (a clean, correct single word) scored 0.352, while
  // "E SE O ALVO FIZER COM BAR Tarad?" (also fully correct) scored 0.141,
  // comparable to or lower than genuinely garbled regions. At the 0.70
  // floor, over 80% of correctly-recognised text across that sample was
  // being silently dropped before ever reaching the translator — pre-filled
  // as { tl:'—', t:'sfx' } below and never actually sent — which is what
  // produced entire pages coming back as all-SFX/untranslated. Whatever
  // this engine's confidence score measures for this content, it isn't
  // "is this readable text", so it's not a safe filter signal here. If a
  // real quality signal is added later, it should be validated against
  // actual OCR output the way the length filter below was, not asserted.
  const isNoise = it => {
    const len = it.text.trim().length;
    if (len < 2 || len > 150) return true;
    return false;
  };
  const meaningfulItems = items.filter(it => !isNoise(it));
  const sendItems = meaningfulItems.length ? meaningfulItems : items;

  // DeepL is not an LLM provider — see server.py's "DeepL" section comment
  // for the full reasoning. It gets its own request/response handling
  // (translateBatchDeepL, below) but shares the noise-filtering and
  // index-remap setup above with the LLM path, since garbage OCR fragments
  // are exactly as pointless to pay DeepL to "translate" as they are to
  // send to an LLM.
  if (info.provider === 'deepl') {
    return translateBatchDeepL(regions, items, sendItems, isNoise, key, sourceLang, targetLang, signal);
  }



  // Build fetch body once — reused across all retry attempts.
  const _fetchBody = JSON.stringify({
    provider:    info.provider,
    key,
    source_lang: sourceLang,   // proxy uses this to inject lang-specific hints
    payload: {
      model:       modelId,
      temperature: 0.3,
      // IMPORTANT: DeepSeek's V4 models (both Flash AND Pro) default to
      // thinking mode ENABLED, at "high" effort -- the model ID alone does
      // NOT control this (confirmed against DeepSeek's own Thinking Mode
      // docs, api-docs.deepseek.com/guides/thinking_mode). Previously this
      // request never set the `thinking` field at all, so "DeepSeek V4
      // Flash" silently ran in thinking mode despite the dropdown label
      // promising "non-thinking, faster" -- that's what caused 422s
      // ("finish_reason=length, no final JSON") on busy pages: reasoning
      // tokens ate the whole max_tokens budget before any JSON got written.
      //
      // Explicitly disable thinking for Flash (matches its label/intent).
      // Leave Pro's thinking ON (that's the point of picking Pro), but
      // still needs 8000 max_tokens as headroom for reasoning + answer.
      ...(info.provider === 'deepseek'
        ? { thinking: { type: modelId === 'deepseek-v4-flash' ? 'disabled' : 'enabled' } }
        : {}),
      // 8000 gives headroom for DeepSeek Pro's chain-of-thought
      // (~3000-5000 tokens) plus the JSON answer (~500-2000 tokens).
      // With thinking disabled (Flash, above), this budget is barely
      // touched -- pure upside, no downside to leaving it at 8000 for both.
      // Gemini: thinking tokens are counted separately (thinkingBudget=0
      // suppresses them entirely), so 8000 here only affects the JSON
      // output length -- safe.
      max_tokens:  8000,
      // DeepSeek JSON mode enforces a valid JSON object in the response.
      // Gemini ignores this field (the proxy strips it before forwarding).
      ...(info.provider === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        {
          role: 'system',
          content:
            `You are a manga translation expert. Translate ${sendItems.length} OCR-extracted text regions ` +
            `from ${getLangName(sourceLang)} to ${targetLang}.\n\n` +
            `SPATIAL DATA: Each item has cx (left-right % 0–100) and cy (top-bottom % 0–100).\n` +
            `Use these to reconstruct reading order. Pages often have LEFT and RIGHT column panels — ` +
            `items at similar cy but very different cx belong to DIFFERENT panels and should not be mixed.\n` +
            `Within a single panel/column, read top-to-bottom (ascending cy).\n\n` +
            `OCR ARTIFACTS TO FIX BEFORE TRANSLATING:\n` +
            `- Words split with a hyphen (e.g. "PREGI-" followed by "DENTAL") → merge into one word ("PRESIDENTIAL")\n` +
            `- A single speech bubble split into 2–3 nearby fragments → join them into one natural sentence\n` +
            `- Stray single characters or obvious OCR noise → clean up or skip\n` +
            `- ALL-CAPS OCR input is normal; translate into natural mixed-case output\n\n` +
            `For each item classify the text type:\n` +
            `  speech    — dialogue in speech bubbles\n` +
            `  thought   — internal monologue (cloud / wavy bubbles)\n` +
            `  sfx       — sound effects, onomatopoeia\n` +
            `  narration — caption boxes, story narration\n` +
            `  sign      — signs, labels, written environmental text\n\n` +
            `SFX RULE: If a region is clearly an SFX or onomatopoeia, translate it as a brief English ` +
            `sound effect wrapped in asterisks (e.g. *Rumble*, *Crash*, *Sigh*) — do NOT return \"-\" for these.\n` +
            buildGlossaryPromptBlock(_activeGlossaryKey) +
            `\nReturn ONLY a JSON object with a \"translations\" key containing exactly ${sendItems.length} items, ` +
            `preserving the original i values:\n` +
            `{\"translations\":[{\"i\":0,\"tl\":\"translated text\",\"t\":\"type\"},...]}\n` +
            `If a region is pure noise with no translatable meaning, set tl to \"-\".\n` +
            `No markdown fences, no explanation, no extra keys.`
        },
        { role: 'user', content: JSON.stringify(sendItems) }
      ]
    }
  });

  // 429 retry with exponential back-off.
  // Free-tier Gemini and DeepSeek both rate-limit at high concurrency;
  // retrying automatically is far better than dropping every page as an error card.
  // Delays: 4 s → 8 s → 16 s (3 attempts). After that, throw so the caller shows an error.
  //
  // Gemini specifically also gets a PROACTIVE wait before the first attempt
  // — see utils.js's waitForGeminiSlot() for why concurrency alone (3
  // pages in flight) doesn't bound requests-per-minute the way it looks
  // like it should. Only gated on 'gemini': DeepSeek has its own separate
  // RPM budget this limiter has no visibility into, and shouldn't be
  // slowed down by a limiter tuned for a different provider's numbers.
  if (info.provider === 'gemini') {
    await waitForGeminiSlot();
  }
  const _RETRY_DELAYS = [4000, 8000, 16000];
  let res, _attempt = 0;
  while (true) {
    res = await fetch('/translate', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: _fetchBody,
    });
    if (res.status !== 429 || _attempt >= _RETRY_DELAYS.length) break;
    const _wait = _RETRY_DELAYS[_attempt++];
    toast(`Rate limited — retrying in ${_wait / 1000}s… (${_attempt}/${_RETRY_DELAYS.length})`, _wait + 500);
    await new Promise(r => setTimeout(r, _wait));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `${info.label} error ${res.status}`);
  }

  const data  = await res.json();
  // Record cost as soon as we know usage was billed — regardless of whether
  // the JSON-recovery parsing below succeeds. The API charged for this call
  // the moment it responded; a malformed response is still a paid response.
  if (data.usage) {
    recordUsage('translate', data.usage, info.provider, getModelId());
  }
  const text  = data.choices?.[0]?.message?.content ?? '';
  const clean = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();

  // Guard: an empty response means the proxy's upstream AI produced nothing
  // (safety block, bad model ID, etc.).  Throw so the page renders as a
  // retryable error card rather than silently showing all-"—" translations.
  if (!clean) {
    throw new Error(`${info.label} returned an empty response — check your API key / model, then retry.`);
  }
  // Accept {"translations":[...]} (DeepSeek JSON mode) or a bare array (Gemini/fallback).
  // Parse strategies (tried in order; stop as soon as parsedArr is non-null):
  //   1. Full JSON.parse — handles {"translations":[...]} and bare [...] directly.
  //   2. Last-occurrence targeted — find the LAST "translations": key and slice the
  //      JSON object from there.  Using LAST (not first) is critical for thinking
  //      models that emit "translations" in their reasoning chain before the JSON.
  //   3. Backwards object scan — find the last { before "translations" and parse
  //      the whole object.  Handles "reasoning text\n{\n\"translations\":[...]}" shape.
  //   4. Generic [...] last resort — any array anywhere in the text.
  let parsedArr = null;
  try {
    const top = JSON.parse(clean);
    if (Array.isArray(top))                        parsedArr = top;
    else if (Array.isArray(top?.translations))      parsedArr = top.translations;
  } catch { /* not valid top-level JSON — fall through */ }

  // Strategy 2 — targeted, last occurrence of "translations" key
  if (!parsedArr) {
    const tlIdx = clean.lastIndexOf('"translations"');
    if (tlIdx >= 0) {
      const arrOpen = clean.indexOf('[', tlIdx);
      const arrEnd  = clean.lastIndexOf(']');
      if (arrOpen >= 0 && arrEnd > arrOpen) {
        try { parsedArr = JSON.parse(clean.slice(arrOpen, arrEnd + 1)); } catch {}
      }
    }
  }

  // Strategy 3 — backwards object scan: find the { that opens the translations object
  if (!parsedArr) {
    const tlIdx = clean.lastIndexOf('"translations"');
    if (tlIdx >= 0) {
      const braceIdx = clean.lastIndexOf('{', tlIdx);
      if (braceIdx >= 0) {
        try {
          const top2 = JSON.parse(clean.slice(braceIdx));
          if (Array.isArray(top2?.translations)) parsedArr = top2.translations;
        } catch {}
      }
    }
  }

  // Strategy 4 — generic [...] last resort
  // /\[\[\s\S]*\]/ is intentionally last: greedy, breaks on any stray "[" earlier in text.
  if (!parsedArr) {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) { try { parsedArr = JSON.parse(m[0]); } catch {} }
  }

  const fallback = () => regions.map(() => ({ tl: '\u2014', t: 'speech' }));
  if (!parsedArr) {
    // All parse strategies failed.  This is almost always a thinking-model leak:
    // the server passed the DeepSeek reasoning chain (no JSON) instead of the answer.
    // The V2 server fix intercepts this before it reaches here; this branch is the
    // final diagnostic safety net.
    const preview = clean.slice(0, 300);
    console.error('[TL] All JSON parse strategies failed. Full response:', clean);
    const isThinkingLeak = clean.length > 500 && !clean.includes('"translations"');
    throw new Error(
      'AI response could not be parsed as JSON (all 4 strategies failed).\n' +
      (isThinkingLeak
        ? 'The response is a thinking model reasoning chain — no JSON found.\n' +
          'Fix: switch to DeepSeek V4 Flash (non-thinking) or Gemini 2.5 Flash.\n'
        : 'Response preview: ' + (preview || '(empty)') + '\n') +
      'Try a different model or retry.'
    );
  }
  try {
    const parsed = parsedArr;
    if (!Array.isArray(parsed)) {
      // JSON parsed but is an object without a translations array — unexpected schema.
      console.error('[TL] Unexpected response schema (not array):', parsed);
      throw new Error(
        `AI returned unexpected JSON schema (expected array, got ${typeof parsed}). Retry the page.`
      );
    }
    // Map back to original indices so overlay positions stay correct.
    // BUG FIX: some models return "i" as a quoted string (e.g. "i":"0") rather
    // than an integer.  parseInt handles both; the old `typeof item.i === 'number'`
    // check would silently drop every item and produce all-"—" translations.
    // Noise slots (filtered before the API call — see isNoise() above: too
    // short or too long) are pre-filled as sfx so they render as small red
    // badges rather than empty speech bubbles. Reusing isNoise() here
    // (rather than recomputing the condition) is what guarantees this stays
    // consistent with the filter that decided what actually got sent.
    const out = regions.map((_, i) => {
      return isNoise(items[i])
        ? { tl: '—', t: 'sfx' }
        : { tl: '—', t: 'speech' };
    });
    // Each item is mapped independently: one malformed entry (unexpected
    // shape, a getter that throws, etc.) is skipped in place rather than
    // aborting the whole forEach and falling through to fallback(), which
    // would previously discard every other item that parsed correctly.
    let _skipped = 0;
    parsed.forEach(item => {
      try {
        if (typeof item === 'string') return; // model ignored schema — skip
        // Strict check: parseInt("3rd") === 3, which would silently accept a
        // malformed index instead of rejecting it. Require the value to be a
        // clean integer (as a number or a pure-digit string) before mapping.
        const iRaw = item.i;
        const iStr = String(iRaw ?? '').trim();
        if (!/^\d+$/.test(iStr)) return;
        const idx = parseInt(iStr, 10);
        if (idx < 0 || idx >= regions.length) return;
        out[idx] = {
          tl: String(item.tl ?? item.translation ?? item.text ?? '—'),
          t:  VALID_TEXT_TYPES.has(item.t) ? item.t : 'speech',
        };
      } catch (_itemErr) {
        _skipped++;
        console.warn('[TL] Skipped one malformed translation item:', item, _itemErr);
      }
    });
    if (_skipped > 0) {
      console.warn(`[TL] ${_skipped} of ${parsed.length} item(s) skipped due to malformed shape.`);
    }
    return out;
  } catch (_err) {
    // Only reached for genuine schema failures (e.g. parsed wasn't an array)
    // thrown above — not for per-item issues, which are now handled inline.
    console.error('[TL] Falling back to all-"—" translations for this page:', _err);
    return fallback();
  }
}


// ══════════════════════════════════════════════
// DEEPL  (not an LLM — see server.py's "DeepL" section comment for the
// full reasoning on why this is a separate code path rather than a third
// branch inside translateBatch()'s LLM-shaped request/response handling)
// ══════════════════════════════════════════════

// DeepL's supported target languages, fetched from its own /v2/languages
// endpoint (server.py proxies this as /deepl-languages) rather than
// hardcoded here — DeepL adds languages over time (Thai and Vietnamese are
// both fairly recent additions), so a hardcoded list would silently go
// stale. Cached per API key for the session: the list is identical for
// every request with the same key and essentially never changes within a
// single sitting, so there's no reason to refetch it every translateBatch()
// call — same "fetch once per session, not once per call" pattern
// _loadRates() already uses in cost-tracker.js.
let _deepLLangCache = null;   // { key: apiKey, languages: [{code,name}, …] } | null
let _deepLLangPromise = null; // in-flight fetch, shared across concurrent callers

async function _loadDeepLLanguages(key) {
  if (_deepLLangCache && _deepLLangCache.key === key) return _deepLLangCache.languages;
  if (_deepLLangPromise) return _deepLLangPromise;
  _deepLLangPromise = (async () => {
    try {
      const res = await fetch('/deepl-languages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Same two-shape situation as translateBatchDeepL() below — this
        // app's own errors use 'description', DeepL's own use 'message'.
        throw new Error(err?.description || err?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      _deepLLangCache = { key, languages: data.languages || [] };
      return _deepLLangCache.languages;
    } finally {
      _deepLLangPromise = null;
    }
  })();
  return _deepLLangPromise;
}

// Maps this app's free-text target-language names (see the <select> in
// index.html — "Portuguese (Brazil)", "Chinese (Simplified)", etc, plus
// anything the user types into the custom-language box) onto DeepL's ISO
// codes. Only the app's OWN dropdown values are mapped here — DeepL's full
// live list (fetched above) is still what actually gets validated against,
// so a language DeepL adds later works automatically once it's added to
// index.html's dropdown too, without needing a new line here.
//
// Values verified directly against developers.deepl.com/docs/getting-started/supported-languages
// (fetched 2026-08-01) — the API's full language table, not DeepL's
// consumer Translator product page, which lists a different (larger) set
// under different assumptions. Getting this from the API-specific docs
// mattered: an earlier pass at this map, sourced from general web search
// results about "DeepL supported languages" without checking which product
// surface they described, wrongly excluded Malay, Filipino, Hindi, Bengali,
// Tamil, Burmese, Persian, and Swahili — all of which the actual
// /v2/translate API supports fine. Only Khmer is genuinely absent from
// DeepL's API language table as of this check.
const _DEEPL_TARGET_LANG_MAP = {
  // 'EN' (bare, no regional variant) is NOT what DeepL's own
  // /v2/languages?type=target endpoint actually lists — it lists EN-GB and
  // EN-US as concrete target variants. Using bare 'EN' here made the live-
  // list check below always fail and throw "DeepL doesn't support English"
  // even though DeepL obviously translates to English fine; the code was
  // just never going to exact-match anything in the live list. EN-US is a
  // concrete code guaranteed to be present in that list.
  'English':                    'EN-US',
  'Malay':                      'MS',
  'Indonesian':                 'ID',
  'Filipino':                   'TL', // DeepL's API calls this "Tagalog" (code TL), same language the dropdown means by "Filipino"
  'Japanese':                   'JA',
  'Chinese (Simplified)':       'ZH-HANS',
  'Chinese (Traditional)':      'ZH-HANT',
  'Korean':                     'KO',
  'Thai':                       'TH',
  'Vietnamese':                 'VI',
  'Hindi':                      'HI',
  'Bengali':                    'BN',
  'Tamil':                      'TA',
  'Burmese':                    'MY',
  'Spanish':                    'ES',
  'French':                     'FR',
  'German':                     'DE',
  'Portuguese':                 'PT-PT',
  'Portuguese (Brazil)':        'PT-BR',
  'Italian':                    'IT',
  'Russian':                    'RU',
  'Polish':                     'PL',
  'Dutch':                      'NL',
  'Turkish':                    'TR',
  'Ukrainian':                  'UK',
  'Czech':                      'CS',
  'Romanian':                   'RO',
  'Hungarian':                  'HU',
  'Swedish':                    'SV',
  'Danish':                     'DA',
  'Norwegian':                  'NB',
  'Finnish':                    'FI',
  'Greek':                      'EL',
  'Arabic':                     'AR',
  'Persian':                    'FA',
  'Hebrew':                     'HE',
  'Swahili':                    'SW',
  // Deliberately NOT mapped — genuinely absent from DeepL's API language
  // table as of this recheck: Khmer. Any custom-typed language is also
  // excluded (see _updateTargetLangDeepLSupport() — this app has no way to
  // know if a free-typed name matches one of DeepL's ~100 codes, so it
  // doesn't try to guess). Selecting either while DeepL is the active
  // provider throws a clear error below rather than silently mistranslating
  // or failing with an opaque DeepL 400.
};

/**
 * DeepL request/response handling — called from translateBatch() when
 * info.provider === 'deepl'. Shares items/sendItems/isNoise (built by the
 * caller) so noise filtering can't drift between the two provider paths.
 *
 * Output contract matches translateBatch()'s LLM path exactly: an array
 * parallel to `regions` of { tl, t } objects. DeepL cannot classify text
 * type (speech/thought/sfx/sign — that's an LLM-only capability, DeepL is
 * a plain translation API), so every non-noise region is typed 'speech'
 * unconditionally — same simple default the LLM path already falls back
 * to for any region an LLM failed to classify.
 *
 * GLOSSARY NOT APPLIED HERE: glossary.js's per-series terms (see
 * buildGlossaryPromptBlock) work by appending instruction text to an LLM
 * system prompt — DeepL's API takes plain source strings with no prompt/
 * instruction concept at all, so there's no equivalent hook to apply
 * glossary overrides through. A person using DeepL with an active
 * glossary gets DeepL's own (unmodified) translation for every term,
 * silently — no error, since this isn't a failure, it's a real capability
 * gap between provider shapes. Worth surfacing in the glossary modal's
 * copy if DeepL users report this as confusing in practice.
 */
async function translateBatchDeepL(regions, items, sendItems, isNoise, key, sourceLang, targetLang, signal) {
  const deepLTarget = _DEEPL_TARGET_LANG_MAP[targetLang];
  if (!deepLTarget) {
    throw new Error(
      `DeepL doesn't support "${targetLang}" as a target language. ` +
      `Switch to Gemini or DeepSeek for this language, or pick a different target language.`
    );
  }

  // Validate against DeepL's actual live list too, not just this app's own
  // map — catches the case where DeepL quietly drops support for something
  // this map hasn't been updated to reflect yet.
  try {
    const liveLanguages = await _loadDeepLLanguages(key);
    if (liveLanguages.length && !liveLanguages.some(l => l.code === deepLTarget)) {
      throw new Error(
        `DeepL no longer lists "${targetLang}" (${deepLTarget}) as a supported target language ` +
        `— this may have changed since this app's language map was last updated. ` +
        `Switch to Gemini or DeepSeek for this language.`
      );
    }
  } catch (langErr) {
    // If the language-list check itself fails (network hiccup, key not yet
    // valid, etc.) don't block translation entirely on that — fall through
    // and let the actual /translate-deepl call surface any real problem.
    // Only a genuine "DeepL doesn't support this" mismatch (thrown above,
    // inside the try) should stop the request before it's even sent.
    if (langErr.message.includes('no longer lists')) throw langErr;
    console.warn('[TL] DeepL language-list check failed (continuing anyway):', langErr.message);
  }

  const texts = sendItems.map(it => it.text);
  let totalChars = 0;
  for (const t of texts) totalChars += t.length;

  const res = await fetch('/translate-deepl', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      texts,
      target_lang: deepLTarget,
      source_lang: sourceLang,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Two possible shapes here: this app's own Flask abort() errors use
    // {"description": "..."} , but DeepL's own error responses (passed
    // through as-is when DeepL itself rejects the request — see
    // server.py's translate_deepl()) use {"message": "..."} instead, per
    // DeepL's own API error format. Checking both means a real DeepL
    // rejection reason (bad language code, bad key, etc.) actually reaches
    // the user instead of collapsing into a generic "DeepL error 400".
    throw new Error(err?.description || err?.message || `DeepL error ${res.status}`);
  }

  const data = await res.json();
  // DeepL has no usage/token object in its response at all (it's not an
  // LLM — see the module comment above) — record the exact character
  // count we already know we sent instead. This is deepLChars, not
  // fallbackChars: it's an exact figure, not an estimate (see
  // recordUsage()'s own parameter docs in cost-tracker.js).
  recordUsage('translate', null, 'deepl', 'deepl', 0, 0, totalChars);

  const translations = data.translations || [];
  // Pre-fill every slot the same way the LLM path does: noise-filtered
  // regions get 'sfx' (renders as a small badge, not an empty bubble),
  // everything else defaults to 'speech' since DeepL can't classify.
  const out = regions.map((_, i) => (
    isNoise(items[i]) ? { tl: '—', t: 'sfx' } : { tl: '—', t: 'speech' }
  ));
  // sendItems is a filtered subset of items/regions in the same relative
  // order (see translateBatch() above) — translations[] from DeepL comes
  // back in that same order, one-to-one, since DeepL's /v2/translate
  // preserves input array order exactly (unlike the LLM path, there's no
  // "i" index to remap by — DeepL has no way to reorder or drop items).
  sendItems.forEach((it, sendIdx) => {
    if (sendIdx >= translations.length) return; // fewer results than sent — leave placeholder
    out[it.i] = { tl: translations[sendIdx] || '—', t: 'speech' };
  });

  return out;
}

