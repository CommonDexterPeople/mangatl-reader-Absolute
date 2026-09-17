# Roadmap — OCR engines & free-tier translation

Planning notes from an OCR-engine comparison session (RapidOCR vs EasyOCR,
tested against real Spanish/Portuguese/Vietnamese/Turkish manga pages) and
the decisions that came out of it. Written down so the reasoning survives
past this session — several of these are "we tried the obvious thing and
it didn't work" results that would be easy to accidentally re-try later
without this.

## 1. RapidOCR as a second local OCR engine — SHIPPED

> **Status note (2026-08-23).** This section is chronological, and its
> earlier paragraphs are superseded — read to the end before acting on
> anything in it. Both blockers are gone: the frontend engine selector is
> live (`#local-ocr-engine` in `index.html`, `local_engine` sent on every
> `/ocr` call), and the over-merge bug that gated it was subsequently
> *fixed* rather than merely accepted — see KNOWN_LIMITATION_DRAFT.md,
> "RESOLVED (measured on 15 real pages, both engines): adjacent text
> containers merged across a clean gutter", with `test_adjacent_container_gap.py`
> as the regression guard. The "do not wire the toggle live" instruction
> below and the later "accept it as a known limitation" decision are both
> historical record, not current guidance. The one genuinely open item is
> the eval script (item 3).

**Decided:** add RapidOCR as a selectable local engine alongside EasyOCR,
not a replacement for it. Testing showed no single winner:

| Language | Better engine | Why |
|---|---|---|
| Vietnamese | EasyOCR, clearly | RapidOCR systematically drops/swaps stacked tone marks; its confidence score doesn't flag this (scores 0.85–0.97 whether right or wrong) |
| Portuguese | RapidOCR | EasyOCR's own `min_conf` filter dropped ~33% of lines in testing, including several correctly-read ones |
| Spanish | Close to a tie | Different failure modes — RapidOCR: consistent `¡`→`i` misread; EasyOCR: messier casing noise |
| Turkish | Close, slight EasyOCR edge | Both handle ç/ş/ğ/ü/ö well; EasyOCR alone got the dotted/dotless İ-ı distinction right both times it came up |
| Mixed-language chapter (page's actual language ≠ chapter's declared language) | RapidOCR, structurally | RapidOCR's default engine isn't keyed to a language at all (one shared model covers es/pt/vi/tr/id together) — EasyOCR's reader is bound to whatever `_get_reader()` picked for the chapter, so it can't adapt page-to-page without real architecture work |

RapidOCR: consistently 4–7x faster, much lighter on memory (EasyOCR
OOM-killed on a full-resolution Vietnamese page in a 3.9GB/1-core test
environment; RapidOCR did not).

**Status:** backend implementation done —
`_run_rapidocr_detection()` / `_rapidocr_readtext_primary()` /
`_get_rapidocr_engine()` in `server.py`, `local_engine` request param wired
through `/ocr`, `rapidocr` added to the bootstrap installer. Verified
against real pages during this session.

**Blocked on:** a real bug found during that verification, not a
hypothetical — see KNOWN_LIMITATION_DRAFT.md, "Confirmed, blocking:
`_merge_bubble_regions` over-merges adjacent bubbles on RapidOCR's
fragment output." RapidOCR's finer per-line fragmentation exposes an
adaptive-margin merge behavior that EasyOCR's coarser fragmentation
doesn't trigger — two adjacent-but-separate bubbles got merged into one
region with interleaved text. **Do not wire the frontend engine-selection
toggle live until this is fixed and re-verified**, or a user who picks
RapidOCR gets silently garbled dialogue on some pages with no indication
anything went wrong.

**Update:** a geometric fix was implemented and passed its own synthetic
regression test — but verification against the actual real page it was
meant to fix (`Brazil_raw.jpg`, run through the real pipeline, not the
synthetic layout) shows **the bug is still present, unchanged, verbatim**.
Traced the real cause: the closest-approach pair between the two bubbles
on this page has a genuine 1.0px gap, smaller than the `max(4, ...)`
floor's unavoidable 8px combined minimum reach — no value of the new
`HORIZONTAL_GAP_FACTOR` constant can get under that floor. More
importantly, this page's confirmed 1px illegitimate gap is *smaller* than
the 5px legitimate gap the fix is supposed to preserve merging for,
which means no single geometric threshold can separate the two cases
correctly here — not a tuning problem, a structural one. Full mechanism
and the reasoning for why this rules out further threshold-tuning is in
KNOWN_LIMITATION_DRAFT.md. **Still blocked, and the fix approach itself needs
to change** — see that entry for why the real fix likely has to go back
to `_crosses_bubble_boundary`'s actual bubble-outline detection rather
than any further margin/gap-size tuning.

**Decision:** accept the merge bug as a known limitation rather than keep
gating on a full fix — it's the same pre-existing, already-documented
`_crosses_bubble_boundary` blind spot EasyOCR already has (RapidOCR just
hits it more often), and the Correction UI is already the accepted
fallback for that class of miss for EasyOCR. See KNOWN_LIMITATION_DRAFT.md
for the full reasoning.

**Status: frontend now wired.** `#local-ocr-engine-group` in `index.html`
(EasyOCR/RapidOCR selector, honest strengths/cons copy including the
bubble-merge caveat and the ✏ Correct fallback), `local_engine` sent on
every `/ocr` call, and the per-chapter recommendation banner
(`#engine-rec-banner` + `maybeShowEngineRecommendation()` /
`_engineRecAction()` in `ocr-client.js`) — dismissible, offers
switch-this-chapter / keep / always-for-this-language, shown once per
chapter rather than once per page.

**Next concrete steps, in order — revised:**
1. Build the real eval script (item 3 below) and re-derive the
   recommendation table in section 2 from actual data instead of the
   single-page-per-language sample it's currently based on. This is now
   the main open item — the frontend is live and reading directly from
   `_LOCAL_ENGINE_RECOMMENDATION`, so a thin table means thin
   recommendations reaching real users, not just an internal caveat.
2. If real usage shows the bubble-merge limitation surfacing often enough
   that the Correction UI fallback doesn't feel sufficient, revisit actual
   bubble-outline tracing (see KNOWN_LIMITATION_DRAFT.md) — deliberately not
   attempted yet, on purpose, pending real signal rather than guessing at
   how often this actually bites.

## 2. Per-language engine recommendation — backend piece done, provisional

`_LOCAL_ENGINE_RECOMMENDATION` / `_recommend_local_engine()` in
`server.py`: surfaces a recommendation in the `/ocr` response when the
chapter's language has tested data AND the user isn't already on the
recommended engine. Currently seeded with only `vi`→easyocr and
`pt`→rapidocr (the two languages where the sample tested was decisive);
`es`/`tr`/everything else deliberately has no entry yet — too close to
call on one page each.

**This table is explicitly provisional** — based on one manually-tested
page per language, same caveat as everything else in this doc. Treat
`_LOCAL_ENGINE_RECOMMENDATION`'s contents as a starting point to replace,
not a conclusion to build more automation on top of.

**Frontend: built.**
- Settings UI: two-way choice — EasyOCR / RapidOCR (not three-way; "Both"
  is still deferred, see section 4, and isn't a real backend option to
  select) — with the actual strength/con text from the comparison table
  above, including the bubble-merge caveat and the ✏ Correct fallback, not
  marketing copy. `#local-ocr-engine-group` in `index.html`.
- Non-blocking per-chapter notification when `local_engine_recommendation`
  is present in the `/ocr` response — dismissible banner
  (`#engine-rec-banner`), not a modal: switch-this-chapter / keep /
  always-for-this-language. Shown once per chapter
  (`_engineRecShown`, reset in `_clearChapterState()`), not once per page.
  Implementation: `maybeShowEngineRecommendation()` / `_engineRecAction()`
  / `_resolveLocalEngine()` in `ocr-client.js`.
- Recommendation isn't always "switch to the other solo engine" — for
  Vietnamese specifically, even EasyOCR alone was dropping real content to
  its own confidence filter, so the honest recommendation there may end up
  being "switch to Both" once that mode exists, not just "switch to
  EasyOCR." Not yet handled specially in the banner text — worth revisiting
  once "Both" exists as a real option to recommend.

**Known gap, deliberately not solved yet:** this only fires once per
chapter, at chapter-open, using the chapter's *declared* language. It does
NOT catch a page mid-chapter silently switching language while the
chapter stays declared as something else — which is a real scenario we
constructed a test case for (a Portuguese page inside a nominally-Spanish
chapter). Catching that needs a reactive check after first-pass OCR (e.g.
noticing accented characters specific to a different language showing up
unexpectedly) — treat as its own follow-up item, not something the
chapter-level check accidentally covers.

## 3. Needed before any of the above ships: a real eval script

Everything in the recommendation table above and in
`_LOCAL_ENGINE_RECOMMENDATION` comes from one page per language, tested
manually in one session. That's real signal, not nothing — but it's not
enough to hang a user-facing "we recommend X" claim on.

**To build:** a script in the same shape as `test_deepseek_rescue.py` /
`test_ssrf_guard.py` — runs both engines against a real folder of sample
pages per language, applies the app's actual preprocessing +
tuned params + real `min_conf` filtering (not library defaults — this
mattered a lot in testing; stock-defaults comparisons gave a
meaningfully different, less accurate picture), and reports accept/drop
counts and accuracy per language. Store the resulting numbers as a data
file (same pattern as `rates.json`) rather than hardcoding a table in app
code, so it can be regenerated later without a code change.

## 4. "Both" (parallel OCR + LLM reconciliation) — deliberately deferred

Considered running RapidOCR + EasyOCR together per page and having an LLM
reconcile disagreements per bubble (rather than picking whichever engine's
self-reported confidence number is higher — see below for why that
specific version doesn't work).

**Why deferred rather than built now:** going back through every test in
this session, there's no case where it would have won. Vietnamese — the
one language where the two engines clearly diverged — is a case where
EasyOCR alone was already the better answer; RapidOCR wasn't offering good
text to reconcile *with*, it was offering confidently wrong text.
Reconciliation earns its cost when both engines are independently right
about *different parts* of the same line; that pattern wasn't observed
anywhere in this domain. It also adds a real LLM call per bubble on top of
the existing translation call, aimed at exactly the audience most likely
to be budget-conscious about API spend.

**Revisit when:** there's a real case where the single-best-engine router
(section 1/2) genuinely isn't good enough for something specific — build
the more expensive version to solve a confirmed problem, not preemptively.

**If/when it is built:** do NOT pick a winner by comparing the two
engines' raw confidence scores — confirmed directly against real Vietnamese
test output that this reliably picks RapidOCR's wrong answer over
EasyOCR's correct one (RapidOCR scored 0.92–0.93 on wrong transcriptions
that EasyOCR got right at 0.70–0.91 confidence). The two engines'
confidence values aren't calibrated against each other and there's no
sound way to manually rescale one against the other — RapidOCR's
Vietnamese confidence doesn't track correctness at all, so no rescaling
of it recovers signal that isn't there. The right approach for "Both" is
what was actually proposed in the second half of the original idea: give
an LLM both raw candidate transcriptions per bubble and let it adjudicate
using language understanding, not a numeric comparison. Box-matching
between the two engines' differently-shaped fragment sets is a
prerequisite for this and is its own real piece of work — same shape of
problem `_match_vision_to_easyocr()` already solves for Vision, extended
to two local engines instead of one local + one Vision.

## 5. Free-tier translation model — NLLB rejected, use MADLAD-400 or OPUS-MT

NLLB-200 was the original plan for a fully-free OCR+translate pipeline
(paired with RapidOCR/EasyOCR, no paid API). **Rejected**: NLLB is
CC-BY-NC 4.0 — non-commercial only — which conflicts with the goal of
sharing this tool with other people, not just running it personally.

Apache 2.0 alternatives, both cover the tested languages (es/pt/vi/tr):
- **MADLAD-400 (Google, 3B params)** — closest match to what NLLB would
  have been: one unified model, 400+ languages, quality described as
  comparable to NLLB-200 at similar size. Full precision needs real GPU
  memory; a quantized GGUF build (~1.6GB) is the realistic path for
  budget CPU-only hardware — GGUF/llama.cpp-style inference is
  specifically built for that, more so than a raw PyTorch deployment
  would have been. **Preferred starting point.**
- **OPUS-MT (Helsinki-NLP)** — different shape: many small per-language-pair
  models instead of one big multilingual one. Only load the specific pair
  a chapter needs (e.g. just `vi-en`), so likely the lighter footprint of
  the two in practice, at the cost of more pair-to-pair quality variance.
  Fallback if MADLAD's footprint proves too heavy on real target hardware.

Same caveat either NLLB would have had: both are sentence-level, 512-token
capped, no document-level coherence — that's inherent to this whole class
of dedicated MT model, not something NLLB specifically had and these
don't. The flow/coherence gap is what item 6 is for.

## 6. Export-for-external-LLM translation — SHIPPED

> **Status note (2026-09-18).** Built as designed below, as `static/js/llm-export.js`
> (panel, review modal, apply) plus `static/js/llm-export-format.js` (the file
> format and reply parser, kept import-free so `test_llm_export_format.mjs` can
> run it under Node — the design said one file; the parser earned its own so it
> could be tested). Two things the design below treats as given had to be made
> true first: the pipeline now opens a chapter with **no key** in OCR-only mode
> (regions stored with a `—` placeholder; `_validateApiKeyOrToast` confirms
> instead of refusing), and local folder/CBZ loading — broken since the
> per-chapter state clear started emptying the blob store — was fixed so the
> key-free path has a source to read from. One addition beyond the design: an
> export record (`mtl_llmx_<chapterId>`) that maps each exported ID to its
> region *id*, so import still lands correctly after ✏ CORRECT has added or
> deleted regions (B-numbers shift, region ids don't); a stale record shows as
> "source edited since export" / "region no longer exists" flags in the review.
> The rest of this section is the design of record and still describes what
> shipped. v2 (page images alongside the text) remains unbuilt.

Idea, as originally recorded: export a translated chapter as a file the user
hands to their own free ChatGPT/Claude/Gemini/DeepSeek session for polish.

**Reframed: this is a translation path, not a polish path.** Export the OCR'd
*source* text and let the chat session do the whole translation. That makes
the tool usable with **no API key at all** — the single largest gap against
manga-image-translator's offline stack, closed without shipping a 500 MB
model. Polish is the same mechanism with `translation` exported instead of
`text`, so it comes free once this exists.

It also gets *better* context than the API path, not worse: the API path
translates per page (which is why Check Flow exists), while a whole chapter
in one prompt lets the model see the entire conversation.

Nearly everything is already built — OCR with positions, the chapter cache,
the correction UI that edits region text, the typeset export that draws
`translation` at `box`. The new work is serialise → parse → apply, and it is
**purely frontend**: one new file, `static/js/llm-export.js`, and zero
changes to `server.py`.

### Not language-specific

The tool is not a Japanese tool. Source is whatever the chapter declares
(`sourceLang`, usually a fan-translation language — es-la, pt-br, vi, id,
ko…); target is whatever the user chose (`targetLang`, or
`target_lang_custom` when set; most often `en`). The prompt is a template,
resolved with `getLangName()` from `state-and-constants.js` at export time.
Nothing in the format or parser depends on either language.

### Export format

Plain `.md`, not JSON. Chat models mangle JSON far more than labelled
lines, every chat UI accepts a `.md` upload, and the user can read it. One
self-contained file — the prompt is the first thing the model sees.

```markdown
# Translate this manga chapter

You are translating dialogue from a manga chapter. Rules:

1. Translate from {source_name} to {target_name}.
2. Output ONE line per entry, in this exact form:  P3B2: translated text
3. Keep every ID exactly as written (P3B2, not "Page 3 Bubble 2"). Never
   renumber, merge, split, skip, or reorder entries.
4. Output ONLY the translated lines. No introduction, no notes, no code
   fences, no commentary.
5. Entries tagged [sfx] are sound effects — give a {target_name}
   onomatopoeia or keep the original if none fits. [sign] is text on an
   object or wall. [narration] is a caption box, not speech.
6. Keep each speaker's tone. Entries are in reading order; use earlier
   lines as context for later ones.

{glossary block — buildGlossaryPromptBlock(key), omitted when empty}

## Chapter: {series} ch.{n} — {pages} pages, {count} entries

P1B1: ¿Qué es esto?
P1B2 [sfx]: ¡PUM!
P1B3: Gracias
P2B1: ¡Espera!
P2B2 [sign]: Estación Central
...
P24B4: Hasta mañana

## Reply with exactly {count} lines, P1B1 through P{last}B{last}.
```

Decisions baked in:

- **`P{page}B{n}`, plain integers, 1-based.** No zero-padding — `P03` vs
  `P3` is a mismatch the parser would have to normalise away anyway. Don't
  invite it.
- **Type tag on the export line, optional on return.** `[sfx]`, `[sign]`
  and `[narration]` genuinely change how a line should be translated; the
  parser ignores the tag coming back, so the model may keep or drop it.
- **Count stated twice**, header and footer. "Reply with exactly N lines"
  is the single most effective instruction against a model that trails off
  at line 60, and it gives the parser a number to check.
- **Glossary travels with the file** via the existing
  `buildGlossaryPromptBlock`, so the user's per-series terms apply.
- **Batching option: N pages per file**, default ~10, each file
  self-contained with its own prompt and glossary. Free tiers cap message
  length and daily use; a 40-page chapter as one file gets cut off.
  Whole-chapter stays the default because it gives the best context.
- **Single file, not a zip** — every major chat UI takes one file upload;
  multi-file bundles reintroduce the friction this project avoids. (v2 with
  images is the exception; see below.)

### The "link to the AI" is a convenience, not the delivery mechanism

ChatGPT and Claude accept `?q=` to pre-fill a prompt; Gemini and DeepSeek
do not reliably. URLs cap out around 2-8K characters, so a chapter's text
never fits in one. The link can open the site with the *instructions*
pre-typed; the user still uploads the file. Bundling the prompt inside the
file is the robust path, since it works on every AI with no URL games.

### Return format

`P3B2: translated text` — same ID, colon, text. That is the entire
contract. Positions never left the tool, so nothing about positions comes
back.

### Parser rules — ordered; earlier rules shape what later rules see

1. **Strip fences.** Drop any line that is only ``` or ```markdown. Models
   wrap output in fences despite being told not to; `_translate_deepseek`
   already does this exact strip at `server.py:1639`.

2. **Match the ID generously, but require both numbers.**

   ```regex
   ^\s*(?:[-*•]\s*|\d+[.)]\s*)?          # optional bullet or list number
   P\s*(\d+)\s*[-._ ]?\s*B\s*(\d+)       # P3B2, P3-B2, P 3 B 2, P3.B2
   (?:\s*\[[^\]]*\])?                    # optional [sfx] tag, ignored
   \s*[:：\-–]\s*                        # colon, fullwidth colon, or dash
   (.*)$                                 # translation
   ```

   Also accept the spelled-out form — `Page 3, Bubble 2:` — because that is
   the commonest way a model "helpfully" rewrites the ID. Both normalise to
   `(3, 2)`.

3. **Ignore every line that matches nothing.** "Here's your translation:",
   "Let me know if you'd like changes", blank lines. This is the rule that
   lets the parser survive preamble and trailing notes without failing.

4. **Continuation lines append to the previous entry, and flag it.** A
   non-matching, non-blank line directly after a matched line is probably a
   translation that wrapped. Append it; mark the entry *needs review*. A
   blank line ends continuation, so a closing paragraph of commentary does
   not glue itself to the last bubble. Erring toward inclusion is correct:
   the diff UI makes over-inclusion visible, dropped text would be silent.

5. **Reconcile against the export's ID set.** Five buckets, all reported:

   | bucket | condition | action |
   | --- | --- | --- |
   | matched | in export and in return | apply, pending approval |
   | missing | in export, not in return | leave untranslated, list them |
   | unknown | in return, not in export | discard, list them |
   | duplicate | same ID twice | take the **last**, flag — models correct themselves mid-output |
   | unchanged | translation identical to source | apply, flag — usually an SFX kept as-is, sometimes a skip |

   Empty text after the colon counts as missing.

6. **Whole-import sanity flags — warn, never block.**
   - missing > 50% → "looks partial — free-tier cutoff? Import what's here
     and re-run the rest."
   - unknown > matched → "these IDs don't match this chapter — wrong file?"
   - any page number > chapter length → "wrong chapter?"
   - line count ≠ stated count → shown, not fatal.

7. **Import only ever fills `translation` on existing IDs.** Never creates
   a region, never moves one, never touches `box`. This is the invariant
   that keeps a bad file from doing damage.

8. **Show as a diff, approve line-by-line.** Same component as Check Flow,
   flagged rows highlighted. *Apply* writes through the existing
   correction-persistence path, so it survives reload and feeds the typeset
   export like any other correction.

**Partial import is a first-class outcome, not an error.** Free tiers cut
responses off. Import what came back, leave the rest marked untranslated,
let the user export the remaining pages as a second file. The export panel
already models this state (⏳ / ✓ / ✗ per page).

### What a messy return looks like, and what survives it

````
Sure! Here's the translation:

```
P1B1: What is this?
P1B2: *BANG*
Page 1, Bubble 3: Thank you
P2B1: Wait!
P2B1: Hold on!
P2B2 [sign]: Central Station
This is a sign on the station building in the background.
P24B4: See you tomorrow
```

Note: I kept the place names as they were.
````

Result: 7 matched (`P1B3` normalised from the spelled-out form; `P2B1`
takes "Hold on!" and flags duplicate; `P2B2` absorbs the continuation line
and flags for review), fences and both commentary lines ignored, missing
list shows `P1B4`…`P24B3`, sanity flag fires for >50% missing. The user
sees exactly what happened and approves the six good rows.

### v2 — include page images

Same `.md` inside a zip with the page images for that batch, plus one
prompt line: *"the images are context only; output text for the IDs
listed."* The model must never OCR on its own — its text would not map to
the tool's positions. Limits are real and outside our control (Claude ~20
images per message, ChatGPT ~10 and tier-dependent, Gemini varies), and
images cannot be delivered by link at all, so v2 is drag-and-drop by
nature. Ship v1 text-only first; it captures most of the value and works on
every free tier.

### Precedent

BallonsTranslator ships Word import/export for this exact workflow. Known
pattern, not an experiment.

## Open questions carried forward, not resolved here

- Whether `easy_regions`/similar EasyOCR-specific variable names in the
  `/ocr` route should be renamed now that they may hold RapidOCR output —
  left as-is for this pass to avoid touching more of the route than
  necessary while the merge bug is still open; worth a cleanup pass once
  RapidOCR is actually shipped.
- Whether `_run_easyocr_detection`'s and `_run_rapidocr_detection`'s
  shared steps (panel border detection, CLAHE preprocess, box-building)
  should get factored into one shared helper instead of living as two
  parallel functions — deliberately kept as two functions for this pass,
  matching this file's existing precedent (`_easyocr_readtext_primary` is
  shared as a small primitive; the orchestration around it isn't). Revisit
  if a third local engine ever gets added — two parallel copies is
  reasonable, three starts to smell like it wants a real refactor.
