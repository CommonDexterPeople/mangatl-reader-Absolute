// ═══════════════════════════════════════════════════════════════
// main.js
// The application entry point — the ONE script index.html loads.
// ═══════════════════════════════════════════════════════════════
//
// Every file under static/js/ is a real ES module now: each declares what it
// exports and imports what it uses, so a module's dependencies are readable
// from its own head instead of being implied by <script> tag order. Adding a
// module no longer means finding the right slot in index.html.
//
// Two things this file exists to do:
//
// 1. THE GLOBAL BRIDGE (see below). index.html and a lot of generated markup
//    call functions straight from inline onclick="…" attributes. Those resolve
//    against the global scope at click time, and module scope is not global —
//    so without the bridge, roughly 100 handlers across the app would throw
//    ReferenceError the moment a user clicked them.
//
// 2. BOOTSTRAP. The app's startup sequence used to be an IIFE inside
//    reorder-ui.js, which ran at that module's evaluation time. Under modules
//    that is a real hazard: static/js has a 14-module import cycle, and inside
//    a cycle some modules evaluate before their dependencies, so load-time
//    calls into another module can hit a still-uninitialised binding. Running
//    bootstrap here — from the entry module, after every import has evaluated —
//    removes that class of bug entirely, and puts startup where you'd look.

import * as ns_state_and_constants from './state-and-constants.js';
import * as ns_cache from './cache.js';
import * as ns_utils from './utils.js';
import * as ns_glossary from './glossary.js';
import * as ns_history from './history.js';
import * as ns_cost_tracker from './cost-tracker.js';
import * as ns_mangadex_api from './mangadex-api.js';
import * as ns_suwayomi_api from './suwayomi-api.js';
import * as ns_chapter_source from './chapter-source.js';
import * as ns_local_source from './local-source.js';
import * as ns_ocr_client from './ocr-client.js';
import * as ns_mangadex_auth from './mangadex-auth.js';
import * as ns_translate_client from './translate-client.js';
import * as ns_page_render from './page-render.js';
import * as ns_pipeline from './pipeline.js';
import * as ns_reorder_ui from './reorder-ui.js';
import * as ns_box_overlay from './box-overlay.js';
import * as ns_correction_ui from './correction-ui.js';
import * as ns_zip_writer from './zip-writer.js';
import * as ns_export from './export.js';
import * as ns_downloads from './downloads.js';
import * as ns_queue from './queue.js';
import * as ns_paint_brush from './paint-brush.js';
import * as ns_erase_tool from './erase-tool.js';
import * as ns_merge_tuner from './merge-tuner.js';
import * as ns_trans_rail from './trans-rail.js';

import { refreshCacheUI } from './cache.js';
import { _renderHistoryUI } from './history.js';
import { restoreMdAuthFromStorage } from './mangadex-auth.js';
import { startPipeline } from './pipeline.js';
import { setReadOrder } from './state-and-constants.js';
import { getModelInfo, onModelChange, onTargetLangChange } from './translate-client.js';
import { toast } from './utils.js';

// ── The global bridge ────────────────────────────────────────────────────────
// Re-publish every module's exports onto window so inline handlers keep
// resolving. This is a COMPATIBILITY SHIM, not the intended long-term shape:
// it re-creates the flat global namespace the old <script> tags gave us.
//
// It is deliberately one Object.assign over module namespaces rather than ~100
// hand-written `window.foo = foo` lines — a hand-written list silently rots the
// first time someone adds a handler and forgets to register it, and the failure
// only shows up as a dead button in the UI.
//
// CAVEAT — this copies VALUES, not live bindings. A function export never
// changes identity, so handlers are safe; but a mutable `export let` (there are
// 64 of them) is snapshotted here at load time, and window.thatName will not
// track later reassignment. Module-to-module code is unaffected: real imports
// are live bindings and always see the current value. It only bites if an
// inline handler READS a mutable name instead of calling a function. Nothing in
// the markup does that today (checked), so keep it that way — if a handler ever
// needs mutable state, call a function that returns it rather than reading the
// variable through window.
//
// To shrink this: convert inline onclick handlers to addEventListener or event
// delegation, then drop the module from this list once nothing in the markup
// calls into it. Until then every export stays reachable — the same reachability
// the old <script> tags gave, just declared in one visible place.
Object.assign(
  window,
  ns_state_and_constants,
  ns_cache,
  ns_utils,
  ns_glossary,
  ns_history,
  ns_cost_tracker,
  ns_mangadex_api,
  ns_suwayomi_api,
  ns_chapter_source,
  ns_local_source,
  ns_ocr_client,
  ns_mangadex_auth,
  ns_translate_client,
  ns_page_render,
  ns_pipeline,
  ns_reorder_ui,
  ns_box_overlay,
  ns_correction_ui,
  ns_zip_writer,
  ns_export,
  ns_downloads,
  ns_queue,
  ns_paint_brush,
  ns_erase_tool,
  ns_merge_tuner,
  ns_trans_rail,
);

// ── Bootstrap ────────────────────────────────────────────────────────────────
// Moved verbatim from reorder-ui.js's init IIFE — same order, same behaviour,
// just run after all modules are live rather than partway through loading them.
function boot() {

  // FIX #9: check the proxy is actually running; show a persistent warning if not
  fetch('/health')
    .then(r => { if (!r.ok) throw new Error(); })
    .catch(() => toast('⚠ Proxy not detected — run manga_proxy.py first.', 15000));

  // Restore badge reading order preference
  const savedOrder = localStorage.getItem('mtl_read_order') || 'auto-rtl';
  setReadOrder(savedOrder);

  // Populate cache info on home screen
  refreshCacheUI();

  // Populate Continue Reading card / recent list on home screen
  _renderHistoryUI();

  // Restore MangaDex login state (lives in mangadex-auth.js, next to the
  // _md* state it writes — see restoreMdAuthFromStorage()'s comment).
  restoreMdAuthFromStorage();


  const legacyKey = localStorage.getItem('mtl_ai_key');
  if (legacyKey) {
    const isGemini = legacyKey.startsWith('AIza');
    localStorage.setItem(isGemini ? 'mtl_key_gemini' : 'mtl_key_deepseek', legacyKey);
    localStorage.removeItem('mtl_ai_key');
  }

  const savedModel = localStorage.getItem('mtl_ai_model');
  if (savedModel && document.querySelector(`#ai-model option[value="${savedModel}"]`)) {
    document.getElementById('ai-model').value = savedModel;
  }
  onModelChange();  // restores per-provider key + syncs placeholder + hint + vision group visibility

  // Restore the Vision-OCR-specific Gemini key (only relevant/visible when
  // DeepL is the active translator — see onModelChange()'s vision-ocr-key-wrap
  // toggle). Single persisted value, not per-provider like mtl_key_${provider}
  // above, since this key's whole purpose is to stay available regardless of
  // which translator is selected.
  const savedVisionKey = localStorage.getItem('mtl_vision_ocr_key');
  const visionKeyEl = document.getElementById('vision-ocr-key');
  if (visionKeyEl && savedVisionKey) {
    visionKeyEl.value = savedVisionKey;
  }

  // Restore Vision OCR mode — must run AFTER onModelChange so the select exists and is visible
  const savedVisionMode = localStorage.getItem('mtl_vision_mode');
  const visionEl = document.getElementById('vision-ocr-mode');
  if (visionEl && savedVisionMode) {
    visionEl.value = savedVisionMode;
  }

  // Restore local OCR engine choice (EasyOCR/RapidOCR) — same restore
  // pattern as Vision OCR mode above, independent setting.
  const savedLocalEngine = localStorage.getItem('mtl_local_ocr_engine');
  const localEngineEl = document.getElementById('local-ocr-engine');
  if (localEngineEl && savedLocalEngine) {
    localEngineEl.value = savedLocalEngine;
  }

  const savedScale = localStorage.getItem('mtl_merge_scale');
  if (savedScale) {
    document.getElementById('merge-scale').value = savedScale;
    document.getElementById('merge-scale-val').textContent = parseFloat(savedScale).toFixed(2);
  }
  document.getElementById('merge-scale').addEventListener('change', () => {
    localStorage.setItem('mtl_merge_scale', document.getElementById('merge-scale').value);
  });

  // Restore saved target language
  const savedTargetLang = localStorage.getItem('mtl_target_lang');
  if (savedTargetLang) {
    const sel = document.getElementById('target-lang');
    const exists = Array.from(sel.options).some(o => o.value === savedTargetLang);
    if (exists) {
      sel.value = savedTargetLang;
      onTargetLangChange();
    } else if (savedTargetLang !== '__custom__') {
      // Legacy plain-text value — put it in the custom field
      sel.value = '__custom__';
      document.getElementById('target-lang-custom').value = savedTargetLang;
      document.getElementById('target-lang-custom').style.display = 'block';
    }
  }

  document.getElementById('ai-key').addEventListener('blur', () => {
    const keyEl = document.getElementById('ai-key');
    const provider = keyEl.dataset.provider || getModelInfo().provider;
    const val = keyEl.value.trim();
    if (val) localStorage.setItem(`mtl_key_${provider}`, val);
  });

  document.getElementById('target-lang-custom').addEventListener('input', () => {
    localStorage.setItem('mtl_target_lang_custom', document.getElementById('target-lang-custom').value.trim());
  });

  document.getElementById('chapter-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') startPipeline();
  });
}

boot();
