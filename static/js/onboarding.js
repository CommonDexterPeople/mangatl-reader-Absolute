/**
 * onboarding.js — the two things a first-time user hits before they can read
 * anything, and which the UI previously left them to work out alone.
 *
 * 1. WHAT IS THIS. Section 2 asks for a "MangaDex Chapter URL" and assumes you
 *    already know the premise: this re-translates a chapter that someone has
 *    ALREADY fan-translated into some other language. Without that, the box is
 *    just a box, and the natural thing to paste is an English chapter — which
 *    displays as-is and looks broken.
 *
 * 2. THE API KEY. Section 1 asks for one and links to the provider. Getting a
 *    Gemini key is four clicks, but only if you already know it is four clicks
 *    and what an "API key" is. This is the single hardest gate for a
 *    non-technical user. It is no longer an absolute one — 🤖 LLM Export
 *    (llm-export.js) translates a chapter through a free chat AI with no key
 *    at all, and the guide says so — but the key remains the smooth path,
 *    and what keeps the tool free rather than the author paying for
 *    everyone's chapters. So it is a step to be walked through, not hidden.
 *
 * Both are DISMISSIBLE and both hide themselves once they are moot: the intro
 * disappears once you have reading history, the key guide once a key is saved.
 * Nothing here nags a returning user.
 *
 * The key guide is driven by MODEL_INFO's keyUrl/keySite rather than its own
 * copy of the provider list, so adding a provider there updates this too --
 * see test_model_registry.py for why a second list would drift.
 */

import { getModelInfo } from './translate-client.js';
import { _listHistoryEntries } from './history.js';
import { esc } from './utils.js';

const INTRO_DISMISSED_KEY = 'mtl_intro_dismissed';
const GUIDE_OPEN_KEY      = 'mtl_keyguide_open';

/** Per-provider steps. Deliberately concrete — "click X, then Y" — because a
 *  reader who needs this at all is not helped by "obtain an API key". */
const KEY_STEPS = {
  gemini: [
    'Open the link below. Sign in with any Google account.',
    'Click <b>Get API key</b>, then <b>Create API key</b>.',
    'Pick any project it offers (or let it make one).',
    'Copy the long string starting <code>AIza…</code> and paste it above.',
  ],
  deepseek: [
    'Open the link below and create an account.',
    'Go to <b>API keys</b> in the sidebar, then <b>Create new API key</b>.',
    'Add a few dollars of credit — a chapter costs roughly $0.02–0.05.',
    'Copy the key starting <code>sk-…</code> and paste it above.',
  ],
  deepl: [
    'Open the link below and sign up for <b>DeepL API Free</b>.',
    'It asks for a card to verify you, but does not charge the free tier.',
    'Open <b>Account → API keys</b> and copy your key.',
    'Paste it above — free keys end in <code>:fx</code>.',
  ],
};

/** True when the user has never successfully read anything here. Reading
 *  history is a better signal than "has a key saved": someone can paste a key
 *  and still not know what to do next, which is exactly who the intro is for. */
function isFirstTimeUser() {
  try {
    return _listHistoryEntries().length === 0;
  } catch {
    return true;   // storage unreadable — show the intro rather than assume
  }
}

function keyFieldHasValue() {
  const el = document.getElementById('ai-key');
  return !!(el && el.value.trim());
}

/** Collapse/expand the key guide, remembering the choice. */
export function toggleKeyGuide() {
  const open = localStorage.getItem(GUIDE_OPEN_KEY) === '1';
  localStorage.setItem(GUIDE_OPEN_KEY, open ? '0' : '1');
  refreshKeyGuide();
}

/** Hide the intro for good. */
export function dismissIntro() {
  localStorage.setItem(INTRO_DISMISSED_KEY, '1');
  renderIntroCard();
}

/** Re-render the key guide for the currently selected provider. Called from
 *  the model picker's onchange alongside onModelChange(), and after the key
 *  field changes, so the guide disappears the moment a key is pasted. */
export function refreshKeyGuide() {
  const host = document.getElementById('key-guide');
  if (!host) return;

  if (keyFieldHasValue()) {           // nothing left to explain
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }

  const info  = getModelInfo();
  const steps = KEY_STEPS[info.provider] || KEY_STEPS.gemini;
  const open  = localStorage.getItem(GUIDE_OPEN_KEY) === '1';

  host.style.display = '';
  host.innerHTML = `
    <button type="button" class="key-guide-toggle" onclick="toggleKeyGuide()"
            aria-expanded="${open ? 'true' : 'false'}">
      <span class="key-guide-chevron">${open ? '▾' : '▸'}</span>
      No key yet? Getting one takes about a minute
    </button>
    ${open ? `
      <div class="key-guide-body">
        <ol class="key-guide-steps">
          ${steps.map(s => `<li>${s}</li>`).join('')}
        </ol>
        <a class="key-guide-link" href="${esc(info.keyUrl)}" target="_blank" rel="noopener noreferrer">
          Open ${esc(info.keySite)} →
        </a>
        <div class="key-guide-note">
          The key is stored in this browser only, and is sent to the translation
          provider you picked — never anywhere else.
        </div>
        <div class="key-guide-note">
          <b>No key at all?</b> Open a chapter anyway — it is read (OCR) on this
          machine but not translated — then use <b>🤖 LLM Export</b> in the reader:
          it saves the text as one file you upload to ChatGPT, Claude, Gemini or
          DeepSeek, and you paste the reply back. Free tiers work.
        </div>
      </div>` : ''}
  `;
}

/** The "what is this" card. Shown only to someone with no reading history who
 *  has not dismissed it. */
export function renderIntroCard() {
  const host = document.getElementById('intro-card');
  if (!host) return;

  const dismissed = localStorage.getItem(INTRO_DISMISSED_KEY) === '1';
  if (dismissed || !isFirstTimeUser()) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }

  host.style.display = '';
  host.innerHTML = `
    <div class="intro-card-hdr">
      <span>Read manga in a language nobody has translated it into</span>
      <button type="button" class="intro-card-x" onclick="dismissIntro()" title="Dismiss">×</button>
    </div>
    <div class="intro-card-body">
      <p>
        Point this at a MangaDex chapter that <b>someone has already translated
        into some other language</b> — Vietnamese, Indonesian, Portuguese,
        anything — and it re-translates that into yours, in your browser.
      </p>
      <p class="intro-card-tip">
        <b>Finding one:</b> search a series on
        <a href="https://mangadex.org/titles" target="_blank" rel="noopener noreferrer">MangaDex</a>,
        open its chapter list, and pick a chapter whose language flag
        <i>isn't</i> the one you read. Copy that chapter's URL into step 2.
        An English chapter will simply display as-is — there is nothing to
        translate.
      </p>
    </div>
  `;
}

/** Single entry point — safe to call whenever the home screen is (re)shown. */
export function renderOnboarding() {
  renderIntroCard();
  refreshKeyGuide();
}
