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
      : info.provider === 'gemini' ? ' (paid — billing required)' : ' (~$0.02–0.05/chapter)';
    hintEl.textContent = `Get a free key at `;
    const a = document.createElement('a');
    a.id = 'ai-key-link'; a.href = info.keyUrl;
    a.target = '_blank'; a.textContent = info.keySite;
    hintEl.appendChild(a);
    hintEl.appendChild(document.createTextNode(freeNote));
  }

  // Show Vision OCR mode only for Gemini; hide entirely for DeepSeek
  const visionGroup = document.getElementById('vision-ocr-group');
  if (visionGroup) {
    const isGemini = info.provider === 'gemini';
    visionGroup.style.display = isGemini ? '' : 'none';
    // If switching TO a free-tier Gemini model, nudge toward 'smart' to protect quota —
    // but only if the user hasn't explicitly changed it from the default themselves.
    const freeTierModels2 = ['gemini|gemini-3.1-flash-lite'];
    const modeEl = document.getElementById('vision-ocr-mode');
    if (isGemini && modeEl && !localStorage.getItem('mtl_vision_mode')) {
      modeEl.value = freeTierModels2.includes(document.getElementById('ai-model')?.value || '')
        ? 'smart' : 'all';  // free-tier → 'smart' (protect quota); paid → 'all' (no quota concern)
    }
  }

  localStorage.setItem('mtl_ai_model', document.getElementById('ai-model').value);
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
  }));

  // ── OCR noise filter ─────────────────────────────────────────────────────
  // Single-character OCR detections are almost always screentone patterns,
  // stray marks, or EasyOCR false positives — not real text. Sending them to
  // the AI wastes tokens and triggers hallucinated "translations" of garbage.
  // Filter them out before the API call; their `out` slots get pre-filled
  // as { tl: '—', t: 'sfx' } below so the array length stays consistent.
  // Note: the `i` values in meaningfulItems still reference original positions
  // in `regions`, so the index-based re-mapping in the response loop is safe.
  // Upper cap (150 chars): real speech bubbles rarely exceed this. An EasyOCR
  // false-positive spanning a screentone or background pattern can produce a
  // very long string that burns tokens without being translatable.
  const meaningfulItems = items.filter(it => {
    const len = it.text.trim().length;
    return len >= 2 && len <= 150;
  });
  const sendItems = meaningfulItems.length ? meaningfulItems : items;

  // Build fetch body once — reused across all retry attempts.
  const _fetchBody = JSON.stringify({
    provider:    info.provider,
    key,
    source_lang: sourceLang,   // proxy uses this to inject lang-specific hints
    payload: {
      model:       modelId,
      temperature: 0.3,
      // DeepSeek thinking models (V4 Pro) count reasoning tokens against max_tokens,
      // so a budget of 4000 can be exhausted entirely on chain-of-thought before the
      // model ever outputs a single character of JSON.  8000 gives ample headroom for
      // both thinking (~3000–5000 tokens) and the JSON answer (~500–2000 tokens).
      // Gemini: thinking tokens are counted separately (thinkingBudget=0 suppresses
      // them entirely), so 8000 here only affects the JSON output length — safe.
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
            `Return ONLY a JSON object with a \"translations\" key containing exactly ${sendItems.length} items, ` +
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
    // Noise slots (filtered before the API call — too short < 2 or too long > 150)
    // are pre-filled as sfx so they render as small red badges rather than empty
    // speech bubbles.
    const out = regions.map((_, i) => {
      const len = items[i].text.trim().length;
      return (len < 2 || len > 150)
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

