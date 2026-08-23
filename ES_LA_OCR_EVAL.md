# es-la local OCR evaluation — EasyOCR vs RapidOCR

**Verdict: RapidOCR, clearly.** It wins on every axis measured — accuracy,
speed, and noise — and it is the only one of the two engines that reads the
inverted question mark `¿` at all.

This is the real-sample eval that ROADMAP.md item 3 calls for, run for
Spanish. `_LOCAL_ENGINE_RECOMMENDATION` currently records `es` as "too close
to call on the sample tested so far". On 59 pages it is not close.

---

## Corpus and method

| | |
|---|---|
| Source | *Shinobigoto* ch. 64, 65, 66 (`.cbz`), 59 pages total |
| Language | `es-la` passed through as the real `lang` argument |
| Path | `server._run_easyocr_detection` / `_run_rapidocr_detection` — the app's own preprocessing, tuned params, and per-language `min_conf`, not library defaults |
| Merge sensitivity | 0.5 (default) |
| Ground truth | 5 pages hand-read, 30 text blocks, 177 words |

`es-la` resolves to `['es']` in `_LANG_MAP` and inherits the default 0.35
`min_conf` (there is no `es` override), so it behaves identically to `es`
throughout the pipeline. Scoring is at the fragment level for accuracy, per
`eval_ocr_engines.py`'s reasoning, with a separate region-level read below.

Two recall numbers are reported. **Exact** is accent- and punctuation-
sensitive; **accent-blind** folds diacritics and drops `¿¡`. The gap between
them isolates the Spanish-mark penalty from "could the engine read the
letters at all".

---

## Results

### Accuracy — 5 hand-read pages, 177 ground-truth words

| engine | exact | accent-blind |
|---|---|---|
| **RapidOCR** | **158 / 177 — 89.3%** | 160 / 177 — 90.4% |
| EasyOCR | 140 / 177 — 79.1% | 141 / 177 — 79.7% |

RapidOCR won every single page, by 6 to 13 points:

| page | RapidOCR | EasyOCR |
|---|---|---|
| ch64 p04 | 81.8% | 72.7% |
| ch65 p05 | 89.0% | 80.8% |
| ch66 p07 | 92.6% | 79.6% |
| ch64 p12 | 93.8% | 87.5% |
| ch66 p14 | 100% (1/1) | 0% (0/1) |

### Spanish characters — all 59 pages

| engine | `¿` | `¡` | accented chars | fragments |
|---|---|---|---|---|
| **RapidOCR** | **65** | **0** | **222** | 1603 |
| EasyOCR | **0** | **0** | 145 | 1765 |

Mark density on the hand-read pages, in the same shape as
KNOWN_LIMITATION_DRAFT.md's Vietnamese table:

| | marked chars | share |
|---|---|---|
| ground truth (hand-read) | 30 / 804 | 3.7% |
| RapidOCR | 23 / 793 | 2.9% |
| EasyOCR | 17 / 814 | 2.1% |

### Noise

| | RapidOCR | EasyOCR |
|---|---|---|
| spurious words (hand-read pages) | **12** | 38 |
| junk regions (≤2 letters) | **30** | 58 |
| vowel-less regions | **30** | 53 |

Every junk region is a wasted translation call.

### Speed — 59 pages

| engine | per page | total |
|---|---|---|
| **RapidOCR** | **21.1 s** | **20.8 min** |
| EasyOCR | 74.7 s | 73.5 min |

3.5× faster, consistent with the 4–7× the README claims.

---

## What goes wrong

### A. Neither engine reads `¡` — 0 occurrences in 59 pages

The opening exclamation is emitted **zero times by both engines**, despite
being common in this source. It degrades to `i` or `I` and fuses with the
following word, so the corruption lands *inside* a token rather than as a
dropped character:

    source     ¡ESTÁ BIEN!      ¡OP PUEDE      ¡NO ME       ¡OP RESOLVERÁ
    RapidOCR   iESTÁ BIEN!      iOP PUEDE      —            iOP RESOLVERÁ
    EasyOCR    iESTÁ BIENI      iOP PUEDE      INO Me       iOP RESOLVERÁ

Note `BIEN!` → `BIENI` — EasyOCR also reads the *closing* `!` as `I`.

This is the one failure the engine choice does not fix. It is a shared, and
currently unmitigated, es-la defect.

### B. EasyOCR does not read `¿` at all — 0 in 59 pages, vs RapidOCR's 65

    source     "¿PARA QUÉ QUIERO MI KEKKAI?"   ¿POR QUÉ   ¿LO LOGRARAN
    RapidOCR   "¿PARA QUÊ QUIERO MI KEKKAI?"   ¿POR       ¿LO LOGRARAN
    EasyOCR    "EPARA QUE QUIERO MI KEKKAI?"   EPOR       ELO / EL  (split in two)

`¿` is consistently recognised as `E`, welded onto the following word. For a
language whose questions are bracketed by it, this is a systematic defect,
not an occasional miss — and it is invisible to a confidence filter, because
`EPARA` is a confidently-read wrong answer.

### C. EasyOCR drops the trailing hyphen, defeating the pipeline's own rejoin

The cleanup step that rejoins hyphen-split words only fires on a fragment
that *ends* in `-`. RapidOCR preserves it; EasyOCR often does not:

    source     ACORRA-  /  LADO AL DESERTOR.
    RapidOCR   'ACORRA-', 'LADO AL…'   → region: HAN ACORRALADO AL DESERTOR.   ✓
    EasyOCR    'ACORRA',  'LADO AL…'   → region: HAN ACORRA LADO AL DESERTOR   ✗

Corpus-wide, trailing-hyphen fragments preserved: **RapidOCR 91, EasyOCR 76**.
Each miss produces two bogus words where there should be one real one.

### D. EasyOCR corrupts leading ellipsis, accents, and case

    ...SERÁS   → ~SERÁS        ...SIN QUE → ~SIN QUE      ...ASÍ → .ASí
    CONTRA MÍ  → CONTRA Ml     SENTÍ → SENTí              AQUÍ...? → AQUL..?
    MANERA     → MANEQA        AL QUE → AL Que            REGRESAR. → REGRESAR:

RapidOCR reads all of the leading-ellipsis cases correctly.

### E. EasyOCR hallucinates numeric and 2-letter regions

`88`, `49`, `9OOL`, `Sh`, `Cu` all appear as standalone regions on the
hand-read pages. On ch65 p05 the bubble `¡NO ME CARGUES ESTO A MÍ!` shatters
into `INO | Me | CAR | 88 | Bues | ESTO | A MII` — seven fragments, two of
them invented. RapidOCR reduces the same bubble to `ESTO | AMI!`: also wrong,
but it does not manufacture content.

### F. Adjacent side-by-side bubbles still interleave at region level — FIXED

**Status: fixed.** Kept here because the measurement is the expensive part.

Both engines, worse on EasyOCR. On ch65 p05 two overlapping bubbles merged
into a single translation unit:

    EasyOCR region (before):
      CREES QUE SI PIERDES ~SERÁS LA CONTRA Ml EN ÚNICA UN COMBATE
      CASTIGADA, JUSTO.. Y ESTO TERMINARÁ

That is two separate lines of dialogue interleaved line-by-line and handed to
the translator as one string. RapidOCR interleaved the same pair less
severely (`...SERÁS LA CONTRA MÍ EN`) but did not escape it either.

**Root cause.** Not a missing mechanism — `_waist_separates_boxes` already
detects fused double-bubbles, and it *did* find this one's constriction, at
x=1677, exactly the lobe boundary. It measured a waist ratio of **0.889**
against a `_WAIST_RATIO_THRESHOLD` of **0.85** and declined to fire. The
threshold had been set from the one real fused page available at the time
(Brazil_raw.jpg, 0.74) and sat below the shallowest real case.

**Fix** (`mtl/geometry.py`): threshold raised to **0.92**, plus a
`_WAIST_MIN_INTERIOR_PX` guard requiring the narrowest column to sit clear of
both ends.

Why 0.92 is safe rather than merely untested: a single unpinched container's
extent profile is unimodal, and the minimum of a unimodal sequence over an
interval is always at an endpoint — where `waist` and `ends` are the same
number, so the ratio is exactly 1.0 *by construction*. Single containers
cannot score below 1.0. Confirmed on the real `caption_welds_to_bubble.jpg`
page: all 25 fragments, every same-component horizontal pair, exactly 1.000,
none with an interior minimum.

Measured spread:

| case | ratio | interior min |
|---|---|---|
| synthetic fused figure-8 | 0.680 | yes |
| Brazil_raw.jpg fused | 0.74 | yes |
| **ch65 p05 fused** (this bug) | **0.889** | yes |
| caption_welds_to_bubble.jpg, every pair | 1.000 | no |
| synthetic single ellipse | 1.000 | no |

**Blast radius** (sweep 0.85→0.95 over all 59 pages × both engines, merge
re-run on cached fragments so only the constant varied): 10 pages per engine
change at 0.92. Every change was inspected. All break up a confirmed
cross-bubble interleave; none breaks a correct region in half. Two pages
(EasyOCR ch64 p02, RapidOCR ch66 p05) still show a fragmented *neighbouring*
bubble after the split — but that fragmentation is pre-existing and was
merely masked by the over-merge: those pieces are separate regions at 0.85
too. 0.95 was rejected as needlessly close to the 1.00 floor.

Result on the target page:

    CREES QUE SI PIERDES CONTRA MÍ EN UN COMBATE JUSTO...
    ...SERÁS LA ÚNICA CASTIGADA, Y ESTO TERMINARÁ.

Regression coverage in `test_fused_bubble_waist.py`: a synthetic shallow
waist (0.890, with a companion assertion that the ratio really does sit in
the band the old constant missed), an outline-nick case that guards the
interior margin (0.525 at column 2 of 270 — "pinched" by ratio alone), and
the real page itself, which needs
`eval_samples/es-la_shinobigoto_ch65_p05.png` and skips cleanly without it.

**What this does NOT fix — RapidOCR on this same page.** The sweep changes
ch65 p05 for EasyOCR but not for RapidOCR, and the reason is worth recording:
RapidOCR emits `...SERÁS LA CONTRA MÍ EN` as a **single fragment box,
x=1461–1976, 515px wide**, spanning both balloons (left lobe 1459–1692, right
lobe 1696–1975). Its detector drew one box straight across the gap and read
the two bubbles' text as one line.

That is a detection-level failure, and it is structurally out of the merge
stage's reach: `_merge_bubble_regions` groups whole fragments and never
splits one, so no veto — waist, border, component, or gap — can undo it.
Fixing it would mean either splitting OCR boxes on a bubble-boundary signal
before merging, or constraining the detector's box width. Neither is
attempted here.

So the honest scope of this fix: it resolves the *merge-stage* over-merge,
which is what was reproducible on 10 pages per engine. Cross-bubble text that
arrives already fused inside one OCR fragment is a separate, unfixed problem.

Note this leaves the corpus-wide picture from before unchanged: region counts
were already close (RapidOCR 556, EasyOCR 579), so this was a surviving
specific case rather than a broad regression.

### G. RapidOCR's own failures, for completeness

Real, but smaller and mostly cosmetic:

    QUÉ → QUÊ          wrong accent shape, not a dropped accent
    PERO SE → PEROSÈ   word-weld plus wrong accent
    AQUÍ → AQUI        accent dropped
    ASÍ! → ASí!        case
    DISTINGUIDAS. → DISTINGUIDASS     (EasyOCR makes this same error)
    ENTONKEKKAI?"      cross-bubble weld artifact, ch64 p04

---

## Configuration gaps this exposed

1. **`es`/`es-la` are not in `VISION_LANGS`** (server.py:329).
   The "Latin with heavy diacritics" group is `vi, pl, cs, sk, hr, ro, hu,
   lt, lv`. So on the default `smart` setting a Spanish chapter never reaches
   Gemini Vision — the local engine is the whole quality story, with no
   fallback. That makes the local-engine choice matter *more* for es-la than
   for a language that can fall through to Vision, not less.

2. **No recommendation is surfaced for Spanish** (server.py:2177).
   `_LOCAL_ENGINE_RECOMMENDATION` has no `es` entry, so
   `_recommend_local_engine` returns `None` and the banner never shows.
   Meanwhile the default engine differs by build: **EasyOCR** from source
   (first in `_LOCAL_ENGINES`), **RapidOCR** in the packaged Windows build,
   which ships RapidOCR only. An es-la reader running from source therefore
   gets the weaker engine by default, silently, with nothing offering the
   better one.

3. **`eval_ocr_engines.py` cannot express `es-la`.** `_infer_lang` matches
   `^([a-z]{2})_`, so `es-la_page.png` yields `None` and the file is skipped
   with a warning. The same applies to `pt-br` and `zh-hk`. This eval passed
   `es-la` directly instead; the harness as written can only test 2-letter
   codes.

---

## Recommended change

Add an `es`/`es-la` entry to `_LOCAL_ENGINE_RECOMMENDATION`:

```python
'es':    ('rapidocr', "EasyOCR misreads the inverted '¿' as 'E' on every "
                      "Spanish page tested (0 read correctly in 59); "
                      "RapidOCR reads it and is more accurate overall."),
'es-la': ('rapidocr', "…same reason…"),
```

`_recommend_local_engine` looks up the raw chapter language, so `es-la` needs
its own key — it will not inherit from `es`.

Two caveats worth keeping with it: neither engine reads `¡` (§A), so this is
a choice of the better engine, not a solved language; and the recommendation
is only actionable in a build that has both engines, which the Windows
installer does not — there it is already the default, and the existing
"never recommend an engine this build doesn't contain" guard applies.
