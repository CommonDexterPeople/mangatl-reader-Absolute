// ═══════════════════════════════════════════════════════════════
// cost-tracker.js
// Turns each paid API call's token usage (or, when a provider doesn't
// return usage, a character/image-count estimate) into a dollar figure,
// and keeps a running per-chapter + lifetime total.
//
// Every call site that hits a paid endpoint (/translate, /ocr when Vision
// fires, /vision-crop) calls recordUsage() once per response — see the end
// of this file for the exact shape callers pass in. Adding a 4th paid
// feature later means one recordUsage() call at that new call site, not
// touching this file (unless it's a genuinely new provider, in which case
// see "Adding a provider" below).
//
// Rates come from /rates (rates.json on disk — see that file's own header
// comment for the full rationale on why prices live in an editable file
// rather than being hardcoded here). Fetched once per page load and
// cached in memory; a session-only override table (edited via the Cost
// Settings modal — see cost-settings-ui section below) layers on top
// without touching rates.json itself.
// ═══════════════════════════════════════════════════════════════

// ── Rate table loading ────────────────────────────────────────────

import { esc, toast } from './utils.js';

export let _ratesCache   = null;   // parsed rates.json, or null if unavailable
export let _ratesPromise = null;   // in-flight fetch, so concurrent callers share one request

export async function _loadRates() {
  if (_ratesCache) return _ratesCache;
  if (_ratesPromise) return _ratesPromise;
  _ratesPromise = (async () => {
    try {
      const res = await fetch('/rates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _ratesCache = await res.json();
    } catch (e) {
      console.warn('[cost] rates.json unavailable — falling back to estimates only:', e.message);
      _ratesCache = { deepseek: {}, gemini: {} };
    }
    return _ratesCache;
  })();
  return _ratesPromise;
}

// Session-only rate overrides (Cost Settings modal). Kept separate from
// _ratesCache so "reset to defaults" is just "clear this object" rather
// than needing to re-fetch rates.json.
export function _getRateOverrides() {
  try {
    const raw = localStorage.getItem('mtl-cost-rate-overrides');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function _setRateOverride(provider, model, field, value) {
  const overrides = _getRateOverrides();
  overrides[provider] ??= {};
  overrides[provider][model] ??= {};
  overrides[provider][model][field] = value;
  localStorage.setItem('mtl-cost-rate-overrides', JSON.stringify(overrides));
}

export function _clearRateOverrides() {
  localStorage.removeItem('mtl-cost-rate-overrides');
}

// Merges rates.json's entry for a model with any session override,
// override fields winning field-by-field (so overriding just "output"
// doesn't blow away "input").
export function _effectiveRate(provider, model) {
  const base      = _ratesCache?.[provider]?.[model];
  const overrides = _getRateOverrides()?.[provider]?.[model];
  if (!base && !overrides) return null;
  return { ...(base || {}), ...(overrides || {}) };
}

// ── Cost calculation ──────────────────────────────────────────────

/**
 * Turn a usage object into a dollar figure using the rate table.
 * usage: {prompt_tokens, completion_tokens, total_tokens} — already
 *   normalized to this shape server-side regardless of provider (see
 *   server.py's _translate_deepseek / _translate_gemini / _ocr_gemini_vision
 *   / vision_crop — every one of them returns this exact field set).
 *   For DeepSeek, usage may additionally include prompt_cache_hit_tokens /
 *   prompt_cache_miss_tokens (passed through as-is from DeepSeek's own
 *   response) — used here when present for the cache-discounted rate.
 * provider: 'deepseek' | 'gemini'
 * model: the raw model id, e.g. 'deepseek-v4-flash', 'gemini-3.1-pro-preview'
 * Returns: { cost: number, exact: boolean, breakdown: string }
 *   exact=false means no rate entry was found and cost is 0 — caller
 *   should fall back to _estimateCost() instead of trusting this.
 */
export function _tokenCost(usage, provider, model) {
  const rate = _effectiveRate(provider, model);
  if (!rate) return { cost: 0, exact: false, breakdown: '' };

  const promptTok = usage.prompt_tokens ?? 0;
  const compTok   = usage.completion_tokens ?? 0;

  // Threshold-priced models (currently just Gemini 3.1 Pro: different
  // rate above 200k prompt tokens — see rates.json's own note on this).
  let inputRate  = rate.input;
  let outputRate = rate.output;
  if (rate.threshold_tokens != null && promptTok > rate.threshold_tokens) {
    inputRate  = rate.input_above  ?? inputRate;
    outputRate = rate.output_above ?? outputRate;
  }

  let inputCost;
  if (rate.cache_hit != null && usage.prompt_cache_hit_tokens != null) {
    // DeepSeek cache split: hit tokens at the discounted rate, miss tokens
    // at the normal input rate. Falls back to flat promptTok*inputRate if
    // the response didn't include the cache breakdown for some reason.
    const hit  = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? (promptTok - hit);
    inputCost = (hit / 1_000_000) * rate.cache_hit + (miss / 1_000_000) * inputRate;
  } else {
    inputCost = (promptTok / 1_000_000) * inputRate;
  }
  const outputCost = (compTok / 1_000_000) * outputRate;
  const cost = inputCost + outputCost;

  return {
    cost,
    exact: true,
    breakdown: `${promptTok.toLocaleString()} in / ${compTok.toLocaleString()} out tokens`,
  };
}

/**
 * DeepL-specific cost calculation — separate from _tokenCost() because
 * DeepL bills per CHARACTER, not per token (see rates.json's header
 * comment on the 'deepl' section for the full rationale). There's no
 * prompt/completion split to compute here, just one character count.
 *
 * charCount: total characters sent in this DeepL request (the frontend
 *   already knows this exactly — it built the request — so this is a real
 *   count, not a fallback estimate like _estimateCost()'s charCount param).
 * Returns: same {cost, exact, breakdown} shape as _tokenCost(), so
 *   recordUsage() can treat both the same way downstream.
 */
export function _deepLCost(charCount) {
  const rate = _effectiveRate('deepl', 'deepl');
  if (!rate) return { cost: 0, exact: false, breakdown: '' };
  const cost = (charCount / 1_000_000) * rate.per_million_chars;
  return {
    cost,
    exact: true,
    breakdown: `${charCount.toLocaleString()} chars`
              + (rate.free_chars_per_month
                  ? ` (DeepL Free tier: ${rate.free_chars_per_month.toLocaleString()} chars/month free — this figure assumes paid-rate pricing throughout; see rates.json)`
                  : ''),
  };
}

/**
 * Rough fallback when a provider/model has no usage data at all (shouldn't
 * happen for the three call sites wired up today, since server.py always
 * threads usage through when the API returned it — but kept as a safety
 * net for any future call site that forgets, or a provider response shape
 * that changes upstream) or no rates.json entry exists for the model.
 * Deliberately conservative/rough — labelled "~estimate" in the UI, never
 * shown as if it were an exact figure.
 */
export function _estimateCost(charCount, imageCount, provider) {
  // Very rough blended $/1K-characters figures based on this app's own
  // cheapest current models (DeepSeek V4 Flash / Gemini 3.1 Flash-Lite) —
  // deliberately on the low side so the estimate undersells rather than
  // overstates cost when we're guessing.
  const perKChar = provider === 'deepseek' ? 0.0002 : 0.0003;
  return (charCount / 1000) * perKChar;
}

// ── Storage: per-chapter + lifetime totals ────────────────────────
// localStorage, matching how this app already stores API keys (see
// translate-client.js / ocr-client.js) — same trust boundary as the data
// this feature is measuring, and consistent with this being a
// single-browser personal tool rather than needing server-side accounts.

export const _LIFETIME_KEY  = 'mtl-cost-lifetime';
export const _CHAPTER_KEY   = 'mtl-cost-current-chapter';

export function _readLifetime() {
  try {
    const raw = localStorage.getItem(_LIFETIME_KEY);
    return raw ? JSON.parse(raw) : { total: 0, byModel: {}, since: Date.now() };
  } catch { return { total: 0, byModel: {}, since: Date.now() }; }
}

export function _writeLifetime(state) {
  try { localStorage.setItem(_LIFETIME_KEY, JSON.stringify(state)); } catch {}
}

export function _readChapterTotal() {
  try {
    const raw = localStorage.getItem(_CHAPTER_KEY);
    return raw ? JSON.parse(raw) : { total: 0, calls: [] };
  } catch { return { total: 0, calls: [] }; }
}

export function _writeChapterTotal(state) {
  try { localStorage.setItem(_CHAPTER_KEY, JSON.stringify(state)); } catch {}
}

/**
 * Called from goBack() / whenever a new chapter starts loading (pipeline.js,
 * erase-tool.js's loadEraseChapterFromSource, etc.) — resets the per-chapter
 * counter to zero without touching the lifetime total. Safe to call even
 * if no chapter was in progress (e.g. app just opened).
 */
export function resetChapterCost() {
  _writeChapterTotal({ total: 0, calls: [] });
  _renderCostBadges();
}

/**
 * The one function every call site calls. See the bottom of this file for
 * the exact call shape from each of translate-client.js / ocr-client.js /
 * correction-ui.js / erase-tool.js.
 *
 * feature: 'translate' | 'ocr' | 'vision-crop' — for the per-chapter
 *   breakdown; purely a label, doesn't affect the dollar math.
 * usage: the {prompt_tokens, completion_tokens, ...} object from the
 *   server response, or null if the response had none (estimate fallback).
 * provider/model: which rate table entry to use.
 * fallbackChars/fallbackImages: used only when usage is null AND provider
 *   isn't 'deepl' (see deepLChars below).
 * deepLChars: total characters sent in a DeepL request. Only meaningful
 *   when provider === 'deepl' — DeepL has no token concept at all, so it
 *   can never populate the `usage` param the way Gemini/DeepSeek do; this
 *   is DeepL's equivalent of `usage`, not a fallback like fallbackChars is
 *   for the other two providers (see _deepLCost() — this is an exact
 *   count, not an estimate).
 */
export async function recordUsage(feature, usage, provider, model, fallbackChars = 0, fallbackImages = 0, deepLChars = 0) {
  await _loadRates();

  let cost, exact, breakdown;
  if (provider === 'deepl') {
    ({ cost, exact, breakdown } = _deepLCost(deepLChars));
  } else if (usage) {
    ({ cost, exact, breakdown } = _tokenCost(usage, provider, model));
    if (!exact) {
      // Had usage but no rate entry for this model — still better to
      // estimate from the real token counts than from character count.
      const rate = provider === 'deepseek' ? 0.0000002 : 0.0000003; // per-token, rough
      cost = ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) * rate;
      breakdown = `${breakdown || 'no rate entry for ' + model} (~estimate)`;
    }
  } else {
    cost = _estimateCost(fallbackChars, fallbackImages, provider);
    exact = false;
    breakdown = `~estimate, no usage data returned`;
  }

  const entry = { feature, provider, model, cost, exact, breakdown, ts: Date.now() };

  const chapterState = _readChapterTotal();
  chapterState.total += cost;
  chapterState.calls.push(entry);
  _writeChapterTotal(chapterState);

  const lifetimeState = _readLifetime();
  lifetimeState.total += cost;
  lifetimeState.byModel[model] = (lifetimeState.byModel[model] || 0) + cost;
  _writeLifetime(lifetimeState);

  _renderCostBadges();
  return entry;
}

// ── UI: chapter badge + lifetime badge ────────────────────────────
// Small, unobtrusive — sits near the existing chapter-credit line
// (pipeline.js) rather than a full dashboard. Deliberately just numbers +
// a link to the settings modal, not graphs/charts — this is a self-hosted
// personal tool, not an analytics product.

export function _fmtCost(n) {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function _renderCostBadges() {
  const chapterEl      = document.getElementById('cost-badge-chapter');
  const chapterEraseEl = document.getElementById('cost-badge-chapter-erase');
  const lifetimeEl     = document.getElementById('cost-badge-lifetime');
  const lifetimeHomeEl = document.getElementById('cost-badge-lifetime-home');
  const { total: chapterTotal, calls } = _readChapterTotal();
  const anyEstimate = calls.some(c => !c.exact);
  const chapterText = `This chapter: ${_fmtCost(chapterTotal)}${anyEstimate ? '*' : ''}`;
  const chapterTitle = anyEstimate
    ? 'Includes at least one ~estimated call (no exact usage data returned). Click for details.'
    : 'Exact, from provider-reported token usage. Click for details.';
  if (chapterEl)      { chapterEl.textContent = chapterText; chapterEl.title = chapterTitle; }
  if (chapterEraseEl) { chapterEraseEl.textContent = chapterText; chapterEraseEl.title = chapterTitle; }

  const { total: lifetimeTotal } = _readLifetime();
  if (lifetimeEl)     lifetimeEl.textContent     = `Lifetime: ${_fmtCost(lifetimeTotal)}`;
  if (lifetimeHomeEl) lifetimeHomeEl.textContent  = `Lifetime API cost: ${_fmtCost(lifetimeTotal)}`;
}

// ── UI: Cost Settings modal ───────────────────────────────────────
// Reuses the flow-modal-backdrop/flow-modal styling already defined for
// Check Flow's diff-preview modal (style.css) rather than inventing a new
// modal style — see correction-ui.js's _showFlowIssuesModal for the
// pattern this mirrors.

export async function showCostSettings() {
  await _loadRates();
  const existing = document.getElementById('cost-settings-modal');
  if (existing) existing.remove();

  const overrides = _getRateOverrides();
  const lifetime   = _readLifetime();
  const chapter    = _readChapterTotal();

  const modelRow = (provider, model, info) => {
    const eff = _effectiveRate(provider, model) || {};
    const isOverridden = !!(overrides[provider]?.[model]);
    const fields = ['input', 'output']
      .concat(info.cache_hit != null ? ['cache_hit'] : [])
      .map(field => `
        <label class="cost-rate-field">
          <span>${esc(field.replace('_', ' '))}</span>
          <input type="number" step="0.0001" min="0"
                 data-provider="${esc(provider)}" data-model="${esc(model)}" data-field="${esc(field)}"
                 value="${esc(eff[field] ?? '')}" class="form-input cost-rate-input">
        </label>`).join('');
    return `
      <div class="cost-rate-row${isOverridden ? ' cost-rate-overridden' : ''}">
        <div class="cost-rate-label">${esc(info.label || model)}${isOverridden ? ' <span class="cost-rate-tag">edited</span>' : ''}</div>
        <div class="cost-rate-fields">${fields}</div>
      </div>`;
  };

  let rowsHtml = '';
  for (const [provider, models] of Object.entries(_ratesCache || {})) {
    if (provider.startsWith('_')) continue; // skip _comment
    for (const [model, info] of Object.entries(models)) {
      rowsHtml += modelRow(provider, model, info);
    }
  }
  if (!rowsHtml) {
    rowsHtml = `<div class="cost-rate-empty">rates.json unavailable — cost tracking is running on rough estimates only. Check the server console, or that rates.json exists next to server.py.</div>`;
  }

  const modal = document.createElement('div');
  modal.id = 'cost-settings-modal';
  modal.className = 'flow-modal-backdrop';
  modal.innerHTML = `
    <div class="flow-modal">
      <div class="flow-modal-hdr">
        <span>💰 COST TRACKING</span>
        <button class="flow-modal-close" onclick="document.getElementById('cost-settings-modal').remove()">✕</button>
      </div>
      <div class="flow-modal-body">
        <div class="cost-summary-row">
          <div><strong>This chapter:</strong> ${_fmtCost(chapter.total)} <span class="cost-rate-hint">(${chapter.calls.length} call${chapter.calls.length !== 1 ? 's' : ''})</span></div>
          <div><strong>Lifetime:</strong> ${_fmtCost(lifetime.total)} <button class="cost-reset-btn" onclick="_confirmResetLifetime()">reset</button></div>
        </div>
        <div class="cost-rate-hint" style="margin: 0.6rem 0 1rem">
          Rates are $ per 1,000,000 tokens, loaded from <code>rates.json</code>. Edit a field to override it
          for this browser only — rates.json itself is untouched. Providers change prices without much
          notice, so double-check against the provider's own pricing page if a number here looks stale.
        </div>
        <div id="cost-rate-rows">${rowsHtml}</div>
      </div>
      <div class="flow-modal-footer">
        <button class="corr-btn-close" onclick="_resetRateOverrides()">RESET RATES TO DEFAULTS</button>
        <button class="corr-btn-retrans" onclick="_saveRateOverrides()">✓ SAVE</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

export function _saveRateOverrides() {
  document.querySelectorAll('.cost-rate-input').forEach(input => {
    const { provider, model, field } = input.dataset;
    const val = parseFloat(input.value);
    if (!isNaN(val)) _setRateOverride(provider, model, field, val);
  });
  document.getElementById('cost-settings-modal')?.remove();
  toast('Rate overrides saved.');
  _renderCostBadges();
}

export function _resetRateOverrides() {
  _clearRateOverrides();
  document.getElementById('cost-settings-modal')?.remove();
  toast('Rates reset to rates.json defaults.');
  _renderCostBadges();
  showCostSettings();
}

export function _confirmResetLifetime() {
  if (!confirm('Reset your lifetime cost total to $0? This only clears the local tracker — it does not refund anything or affect your actual API usage.')) return;
  _writeLifetime({ total: 0, byModel: {}, since: Date.now() });
  document.getElementById('cost-settings-modal')?.remove();
  toast('Lifetime total reset.');
  _renderCostBadges();
}

// Re-render on load in case another tab/reload changed localStorage —
// mirrors how other localStorage-backed UI in this app (e.g. the MangaDex
// login state) re-syncs on page load rather than assuming in-memory state
// is still current.
document.addEventListener('DOMContentLoaded', _renderCostBadges);
