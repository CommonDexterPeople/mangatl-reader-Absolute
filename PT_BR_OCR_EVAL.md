# pt-br local OCR evaluation — EasyOCR vs RapidOCR

**Verdict: RapidOCR.** It wins on every metric, on both metrics of accuracy,
and — the part that matters most — on **both series tested**, which are
different titles, different letterers, and different page resolutions.

Companion to `ES_LA_OCR_EVAL.md`. Two things prompted it:

- **`pt-br` had no recommendation at all.** `_recommend_local_engine` looks up
  the raw chapter language, so `pt-br` did not inherit `pt`'s entry — the same
  silent gap already found and fixed for `es-la`.
- **`pt`'s entry rested on a single page**, by its own code comment.

---

## Corpus and method

| | series 1 | series 2 |
|---|---|---|
| Title | *Akane-Chan e Haru-Senpai* | *Yowa Yowa Sensei* |
| Chapters | 1, 2, 3 | 1, 2 |
| Pages | 67 | 31 |
| Resolution | 1280 × 1804 | 720 × 1055 |
| Lettering | clean italic | rough, mixed |
| Ground truth | 5 pages, 45 blocks, 218 words | 2 pages, 27 blocks, 207 words |

Series 2 was added specifically to test the "one series, one font" limitation
the first round of this eval flagged. Both were run with `pt-br` passed
through as the real `lang` argument, on the app's own preprocessing, tuned
params and per-language `min_conf`.

`pt-br` resolves to `['pt']` in `_LANG_MAP`, inherits the default 0.35
`min_conf`, and is absent from `VISION_LANGS` — so it behaves identically to
`pt`, and the local engine is the entire quality story with no Vision
fallback.

**Two accuracy metrics, deliberately.** Word recall punishes a lost *space*
exactly as hard as a wrong *letter*, which would have flattened a real
distinction — see "Why two metrics" below. Character accuracy is scored per
ground-truth block against the best-matching run of consecutive fragments,
**not** per page: OCR fragment order does not follow reading order, so a
whole-page string comparison measures ordering as much as characters. (A
first attempt that did compare whole pages scored a visibly garbled page at
82% and was discarded.)

---

## Results

| | series 1 | | series 2 | |
|---|---|---|---|---|
| | **RapidOCR** | EasyOCR | **RapidOCR** | EasyOCR |
| exact word recall | **73.9%** | 55.0% | **57.3%** | 28.2% |
| per-block character accuracy | **86.1%** | 80.4% | **61.9%** | 49.1% |
| fragments dropped before any region | **0.0%** | 11.6% | **0.0%** | 20.2% |
| seconds per page | **13.7** | 25.1 | **7.2** | 10.0 |
| wrong accent marks | **0** | **0** | **0** | **0** |

RapidOCR won every one of the seven hand-read pages, on both metrics.

---

## What we learned

### 1. The result holds across series — and widens

This was the open question, and the answer is clean. RapidOCR's lead in exact
word recall goes from **+18.9pts** on series 1 to **+29.1pts** on series 2.

More informative is how each engine degrades on the harder, lower-resolution
series:

| | series 1 → series 2 |
|---|---|
| RapidOCR | 73.9% → 57.3% (**−16.6pts**) |
| EasyOCR | 55.0% → 28.2% (**−26.8pts**) |

EasyOCR loses far more when the page gets small. Its self-dropping rate moves
the same way — 11.6% → 20.2% of its own fragments discarded before reaching a
region, against RapidOCR's 0.0% on both. So the recommendation is not merely
"RapidOCR is better here"; it is **more robust to page quality**, which is the
property that matters for a tool pointed at arbitrary scanlations.

### 2. Accents are not the differentiator — unlike Spanish

The accent penalty (exact minus accent-blind recall) is ~1pt for EasyOCR and
1.4–3.9pts for RapidOCR. Small either way. Compare Spanish, where EasyOCR read
`¿` correctly **zero times in 59 pages**.

**Neither engine got a single accent wrong, in either series** — 0 wrong marks
across the board. That includes the distinctions Portuguese has and Spanish
does not: `é`/`ê`, `á`/`â`/`ã`, `ó`/`ô`/`õ`.

Worth checking specifically, because RapidOCR was seen preferring circumflexes
on Spanish (`QUÉ` → `QUÊ`). On a language where `ê` and `ô` are correct
spellings that could have masqueraded as accuracy. It did not. **Hypothesis
raised, tested, not supported.**

### 3. Series 2's source text is itself unreliable — and that matters

The *Yowa Yowa Sensei* scanlation has systematically missing accents in the
printed art:

    printed          CONCLUSAO   RELAÇOES   SO   VOCE   ESTA   JA   MEDIO   MALDIÇOES   NE?
    correct pt-br    conclusão   relações   só   você   está   já   médio   maldições   né?

…while other words on the same pages are correctly accented (`ESTÁ`,
`ESFORÇO`, `COMEÇAR`, `TAMBÉM`, `ALGUÉM`). One page even carries a
Spanish-style `¡¡KYA AAA!!`, suggesting the chapter was relayed through a
Spanish edition.

**Ground truth therefore records what is printed, not correct Portuguese.**
An engine that "helpfully" restored the missing accents would be scored wrong,
correctly — the pipeline's job is to read the page, and the translator
downstream is what handles bad source text. This also means series 2's accent
counts say more about the scanlator than about either engine, which is why the
accent conclusion above rests on the wrong-mark count (0 everywhere) rather
than on mark density.

### 4. EasyOCR's failure mode is character garbling and case instability

    ground truth   ORA, ORA, VEJA SE NÃO É O HARU!
    RapidOCR       ORA, ORA, | VEJA SE NÃO | É O HARU!
    EasyOCR        ora; orA; | VEJA SE Não | F 0 HAPU!

    ground truth   QUE COINCIDÊNCIA ESTARMOS VOLTANDO PELO MESMO CAMINHO.
    RapidOCR       QUE COINCI- | DÊNCIA ESTARMOS | VOLTANDO PELO | MESMO CAMINHO.
    EasyOCR        QUE COICh | DÊNCIA [STARMOS | voltanvo pELo | MESMO CAMIHo .

EasyOCR gets `DÊNCIA` and `Não` right — it is not accent-blind. It loses on
`É`→`F`, `O`→`0`, `R`→`P`, `D`→`V`, dropped letters (`CAMIHo`), and case that
flips mid-word.

### 5. Why two metrics, and why it matters

On white-on-dark caption text the engines degrade *differently*:

    ground truth   A VERDADE É QUE EU NÃO QUERO PASSAR TODO O INTERVALO
    RapidOCR       AVERDADEE | QUEEUNAOQUERO | PASSAR TODOO | INTERVALO
    EasyOCR        AlrV?4db6 | QUeeunÃoQuro | BASSArTodoo | ntervalo

RapidOCR keeps the letters and loses the spaces; EasyOCR loses the letters.
Word recall scores both near zero and calls that the same failure. It is not:
one is recoverable by a reader in context, the other is not.

**RapidOCR wins on both metrics in both series**, so the conclusion does not
depend on the choice — but the two numbers differ in a way worth knowing
(+18.9 vs +5.7pts on series 1). EasyOCR's errors are distributed such that
they break a larger share of whole words than of characters.

### 6. The reason recorded for `pt` did not reproduce

The old `pt` entry said *"EasyOCR's own confidence filter dropped some
correctly-read lines."* The filter does drop a great deal — 11.6% and 20.2% of
EasyOCR's own fragments, against RapidOCR's 0.0% in both series — but
inspection says those droppings are garbled reads, not correct lines:

    'TnaBlya'   'COMeahL'   'QQNE'   'ARAbC'   'HARU-SEPAD'   'Veo EstUvar'

The filter is doing its job. EasyOCR simply produces that much more noise for
it to catch. The **conclusion** (RapidOCR) is corroborated; the **reason** was
wrong and has been corrected in `_LOCAL_ENGINE_RECOMMENDATION`.

### 7. RapidOCR's speed advantage is real but not a fixed multiple

**1.8×** on series 1, **1.4×** on series 2, against **3.5×** on the Spanish
corpus — whose pages were 2160×3157 with dense lettering. The README's
"4–7× faster" and the es-la report's 3.5× are real measurements of particular
corpora, not a constant. RapidOCR is consistently faster; the multiplier
tracks page size and text density.

---

## Known limits

- **Both series are 4-koma-ish school comedies**, and neither has the dense,
  effect-heavy lettering of an action title. The Spanish corpus did, and both
  engines scored better there than on series 2 — so page quality, not genre,
  looks like the driver, but that is not isolated here.
- **Absolute scores on series 2 are low for both engines** (57.3% / 28.2%).
  At 720×1055 this is near the floor of what either engine can do. The
  comparison between engines is still valid — they saw identical pixels — but
  these numbers should not be read as "expected pt-br accuracy".
- **Ground truth is 7 pages across both series.** Enough to separate two
  engines that differ by 19–29 points; not enough to characterise either
  engine's absolute accuracy precisely.
- **`¡`/`¿` findings do not transfer.** Portuguese has neither, so §A and §B
  of the es-la report say nothing about this language — despite the stray
  `¡¡KYA AAA!!` noted above.
