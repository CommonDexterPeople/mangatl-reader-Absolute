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
ch65 p05 for EasyOCR but not for RapidOCR, and the reason is a *different
bug at a different stage*: RapidOCR emits `...SERÁS LA CONTRA MÍ EN` as a
**single fragment box, x=1461–1976, 515px wide**, spanning both balloons.
Its detector drew one box straight across the gap and read the two bubbles'
text as one line, so the interleave exists before merging begins.

`_merge_bubble_regions` groups whole fragments and never divides one, so no
veto there can reach it. That is section G.

Note this leaves the corpus-wide picture from before unchanged: region counts
were already close (RapidOCR 556, EasyOCR 579), so this was a surviving
specific case rather than a broad regression.

---

## G. Cross-bubble text inside ONE OCR fragment — FIXED

**Status: fixed.** Three approaches failed first. Their measurements are kept
because they are the expensive part, and because two of them look obviously
correct until measured.

### The problem

Distinct from §F. There the two bubbles arrive as separate, correctly-read
fragments and the *merge* stage wrongly groups them. Here they arrive already
fused inside one fragment:

    RapidOCR fragment, x1461-1976 (515px):  "...SERÁS LA CONTRA MÍ EN"
                        left balloon ──┘     └── right balloon

Nothing downstream can undo it, so the repair has to happen before fragments
become merge input.

### Recognition was never the problem

Asking RapidOCR for `return_word_box=True` returns a box per word:

    ...SERÁS   x1461-1623      LA   x1632-1683
    CONTRA     x1701-1854      MÍ   x1872-1923      EN  x1924-1974

All five words are correct. Only the grouping is wrong. Two measurements make
this cheap to act on:

- **The flag is free** — 7.28s vs 7.87s on a real page, inside the noise.
- **The flag changes nothing else** — fragment-level `txts`, `boxes` and
  `scores` are byte-identical with and without it, verified on two pages. So
  it cannot perturb baseline OCR.

That rules out re-OCR: the text already exists, correctly, and only needs
dealing to the right side by its own x position.

### Why the split point must be a waist, not a gap

The gap between the two balloons' words is **18px**. The gap between two
words *inside* the right balloon (`CONTRA`/`MÍ`) is also **18px**. No distance
threshold separates 18 from 18 — the same impossibility already recorded for
`HORIZONTAL_GAP_FACTOR` in `mtl/merge.py`.

### Failed approach 1 — measure the waist across the fragment's own box

The obvious move, and wrong. A fragment spanning both balloons reaches the
outer edges of both, where the silhouette has already tapered **below** the
waist between them. The profile is W-shaped:

    extent at box edges:  290 and 287      waist between lobes:  402

So the minimum lands on an edge and the ratio is **1.000** — "not pinched".

### Failed approach 2 — measure between the outermost word centers

Same failure, less obviously: the right-hand word sits near the balloon edge
where extent is **372**, still below the 402 waist. Ratio **1.000** again.
No choice of two endpoint samples can read a W.

**What works for locating it: prominence.** Judge every column against the
tallest column on *each side* of it, so the taper at either end can no longer
set the bar. On the real page this reports **0.870 at x=1677** — exactly the
lobe boundary — against 0.992 and 0.998 for single-bubble spans on the same
page. This is `_waist_split_column`.

### Failed approach 3 — trust prominence

Prominence locates a real dip. It does not establish that the dip *separates
these two words*. Measured over all 59 pages: **103 proposals, 12 genuine.**
It cut inside single words:

    TEN-  ->  TE / N-          PPA  ->  P / PA          QUE ERAS -> QUE / ERAS

**Why no depth threshold rescues it.** `_component_column_extents` is a **1-D
projection**. On ch64 p07 the component is two balloons stacked *diagonally*,
fused into one blob whose union genuinely pinches — but both words are in the
upper balloon. The projection collapses precisely the vertical dimension that
distinguishes the two cases:

| | waist / text height | waist / component height | verdict |
|---|---|---|---|
| ch65 p05 (cross-bubble) | 6.8 | 0.71 | should split |
| ch64 p07 (one balloon) | 9.2 | 0.73 | must not split |
| ch65 p11 (one balloon) | 10.4 | — | must not split |

False positives score *higher* than true ones. There is no threshold here.

### Failed approach 4 — a strict column gutter

Next idea: a proposed column is a real boundary only if the page's other
lines stop at it rather than run through it. Implemented strictly — zero
crossing fragments, and fragments required on both sides — it keeps **1 of
12**. The signal eats itself: on a page whose bubbles are systematically
fused, *the other lines are cross-bubble fragments too*, so they cross the
boundary as well.

### What actually works

Relaxing that gate turns it into a usable signal. Two parameters, both swept:

| tolerated crossings | kept | correct | wrong |
|---|---|---|---|
| 0 | 1 | 1 | 0 |
| **1** | **8** | **8** | **0** |
| 2 | 15 | 11 | 4 |
| 3 | 18 | 11 | 7 |
| (no gate) | 35 | 12 | 23 |

and the margin before a neighbouring line counts as *crossing*, as a fraction
of its own height — because real left-balloon lines overrun the boundary by a
few pixels (`CASTIGADA,` and `TERMINARÁ.` overrun by 12 and 11px, and at a
tighter margin those two alone sink the page's only correct split):

| margin | correct | wrong |
|---|---|---|
| 0.20 – 0.25 × height | 8 | 0 |
| 0.28 × height and above | 8 | 1 |

**Three gates, ANDed** (`_split_fragment_at_waist`):

1. `_waist_split_column` — prominence, proposes *where*
2. `_column_respected_by_layout` — do the neighbouring lines stop there
3. `_waist_separates_boxes` — would the merge stage call the two halves
   different lobes

All three are needed. Dropping (3) and keeping (1)+(2) was measured: it adds
four more splits, **all wrong**, two of them inside a single token
(`LII"` → `LI`/`I"`, `三ネコ` → `三`/`ネ コ`).

### Result

Over all 59 pages, cached OCR so only the split varied:

**4 pages changed, 8 fragments split, 0 wrong.** Net region change −2 (halves
merging into their correct bubbles).

    ch65 p03   '..i¿"REUBI- CASCADA TÚ'      ch66 p03  'COMENZAREMOS ESCUA-'
    ch65 p03   'CANDO"?! LE LLAMAS...'       ch66 p03  'AHORA LA MISION DRON!'
    ch65 p05   '...SERÁS LA CONTRA MÍ EN'    ch66 p03  'LOS UZEN ES LA ÚNICA'
    ch66 p05   'PRIMERA VEZ PROBABLE..'      ch66 p03  'NO TIENEN HEREDERA'

### Known limits

**Four genuine cross-bubble fragments are declined** — two on ch65 p11, two
on ch65 p17. Both pages are the self-defeating case: their other lines are
themselves cross-bubble, so the layout gate sees 2–4 crossings and abstains.
They are left no worse than before.

**Precision is deliberately bought with recall.** A missed split leaves a page
exactly as it is today. A wrong split is *permanent*: `_waist_separates_boxes`
justifies the split and then also refuses to merge the halves back. That
asymmetry is why the gates are ANDed rather than scored, and why the tolerance
sits at 1 rather than 2.

**RapidOCR only.** EasyOCR reports no per-word boxes, and did not make this
error on the pages tested — its detections are narrower.

**A split column can be right about *whether* and wrong about *where*.** On
ch65 p17, `¿POR QUÉ TE VAYAMOS` is genuinely cross-bubble but the correct cut
is `¿POR QUÉ TE` | `VAYAMOS`, not `¿POR` | `QUÉ TE VAYAMOS`. That case is
declined by the layout gate here, so it does not currently bite — but the
failure mode exists and is not guarded against.

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
