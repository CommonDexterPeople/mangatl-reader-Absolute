# Roadmap — OCR engines & free-tier translation

Planning notes from an OCR-engine comparison session (RapidOCR vs EasyOCR,
tested against real Spanish/Portuguese/Vietnamese/Turkish manga pages) and
the decisions that came out of it. Written down so the reasoning survives
past this session — several of these are "we tried the obvious thing and
it didn't work" results that would be easy to accidentally re-try later
without this.

## 1. RapidOCR as a second local OCR engine — IN PROGRESS, BLOCKED

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
hypothetical — see KNOWN_ISSUES_DRAFT.md, "Confirmed, blocking:
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
KNOWN_ISSUES_DRAFT.md. **Still blocked, and the fix approach itself needs
to change** — see that entry for why the real fix likely has to go back
to `_crosses_bubble_boundary`'s actual bubble-outline detection rather
than any further margin/gap-size tuning.

**Decision:** accept the merge bug as a known limitation rather than keep
gating on a full fix — it's the same pre-existing, already-documented
`_crosses_bubble_boundary` blind spot EasyOCR already has (RapidOCR just
hits it more often), and the Correction UI is already the accepted
fallback for that class of miss for EasyOCR. See KNOWN_ISSUES_DRAFT.md
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
   bubble-outline tracing (see KNOWN_ISSUES_DRAFT.md) — deliberately not
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

## 6. Export-for-external-LLM-polish feature — designed, not built

Idea: export a translated chapter as a file the user can hand to their own
free ChatGPT/Claude/Gemini web session and ask it to fix flow/consistency
— gets LLM-quality polish without spending API budget on it.

Design requirements from this session (not yet built):
- **Structured export, not a flat text wall** — stable per-bubble IDs
  (`P3B2: [text]` shape) so corrected text can be mapped back to the right
  bubble on import. Without an ID, a general-purpose chat model will
  reformat/merge/drop lines while "improving" them.
- **Bundle the exact prompt to paste**, inside the exported file itself —
  don't rely on the user knowing to say "preserve every P#B# label
  exactly." Non-technical target user won't know to ask for that
  unprompted.
- **Needs a matching import/reconciliation step** that tolerates an
  imperfect return — flag anything that doesn't cleanly parse back rather
  than silently misapplying corrected text to the wrong bubble.
  Single structured `.txt`/`.md` file, not a zip — all the major chat UIs
  take file upload directly, and multi-file zips reintroduce the exact
  friction this project has otherwise been designed to avoid.

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
