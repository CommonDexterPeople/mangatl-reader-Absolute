## Fixed: DeepSeek rescue Strategy A nested-object bug

**Was:** `_translate_deepseek()`, Strategy A's brace-finding used a single
`rc.rfind('{', 0, idx)`, which finds the *nearest* unmatched `{` before the
`"translations"` key — wrong whenever a nested object (e.g.
`{"model":{"name":"x"},"translations":[...]}`) sits between the true
enclosing brace and the key. Reproduced directly against that exact shape:
returned `""` from both Strategy A and B before the fix, which downstream
became an HTTP 422 telling the user to retry even though the model's
output was actually fine and rescuable.

**Fix:** replaced the single `rfind` with a backward walk from the key that
tracks brace depth (each `}` seen scanning right-to-left means one more
nested level to close before reaching our own enclosing level; each `{`
either closes one of those or — once depth is back to 0 — is the true
enclosing brace). This finds the correct brace regardless of how much
nesting sits between it and the key.

**Verified against 10 cases** in `test_deepseek_rescue.py`, run directly
against the live logic in `server.py` (not a hand-copied duplicate, so it
stays honest if the code changes later): the original failing case, the
plain/common no-nesting case (regression guard — this is the hot path and
had to keep working), doubly- and deeply-nested objects, nesting both
before and after the key, a duplicated key, an unrelated unbalanced brace
earlier in the string, and three "must correctly return nothing" negative
cases (no key present, key present but no valid JSON around it, empty
input) so the fix doesn't trade a false-negative for a false-positive.

Strategy B (the regex fallback) was left untouched — it shares the same
root cause per the original writeup, but since it only ever runs when
Strategy A finds nothing, fixing Strategy A means B no longer needs to
handle this shape at all.

---

## Known, not yet hit: one narrow edge case found in review (not fixed)

The bug below is the same *class* as the one just fixed above — a
heuristic that's correct for the case it was built against, wrong on a
narrower shape it wasn't tested on. It has not been observed in real use;
it was found by deliberately constructing the input rather than by seeing
it fail. Leaving it here rather than fixing blind, since "fix a bug you
haven't reproduced against real output" is exactly the trap the
bubble-boundary docstring above warns about — and exactly the standard the
fix above was held to before it was allowed to leave this file.

### Vision-OCR coordinate normalization: majority-vote misfires on sparse batches

**Where:** `_ocr_gemini_vision()`, the Case A/B/C normalization block
(around server.py:1630-1660), specifically the `over100_frac >= 0.5` check
for Case C (native 0-1000 scale).

**Claimed:** a majority of a batch's coordinate values being unambiguously
`>100` means the whole batch is on Gemini's native 0-1000 grounding scale,
so dividing everything by 10 is safe.

**Actually happens:** "majority" is measured as a fraction of *individual
values* (`cx`/`cy` pairs flattened), not a per-page confidence signal, so it
degenerates badly on a page with very few detected regions. Verified
directly: a single-region batch with one genuinely out-of-bounds coordinate
(e.g. `cx=105` from ordinary model noise, `cy=40` perfectly normal) hits
`over100_frac = 0.5` and the whole point gets divided by 10 — turning a
mostly-correct coordinate into a definitely-wrong one (`10.5, 4.0`). The
same happens with a 2-region batch where only 2 of 4 values are OOB. A
larger batch is naturally protected (one stray value can't reach 50%), so
this only bites on pages where Vision detected very few regions in the
first place.

**Not disclosed anywhere in the existing coordinate-normalization comment**
(server.py:1579-1622), which documents Cases A/B/C thoroughly but doesn't
flag that C's own detection rule has a small-n blind spot.

**Likely real-world trigger:** a mostly-empty or text-sparse page (title
page, a page with one big SFX and nothing else) combined with an ordinary
single hallucinated coordinate from the model — not a scale-format issue at
all, just normal noise landing on an unlucky page.

**Possible fix, not yet tried against real output:** require a minimum
region count (e.g. only trust the Case C majority-vote when `len(out) >= 4`
or similar) before applying it, falling back to the existing per-item
straggler logic (Case B) or leaving sparse batches unnormalized otherwise.
Needs checking against a handful of real sparse-page Vision responses to
pick a sane threshold rather than guessing one.

---

Both fixes above are sketched, not implemented — deliberately, since
neither bug has a confirmed real trigger yet, and this file's whole point
(per the bubble-boundary precedent) is that a heuristic fix aimed at a
constructed case rather than an observed one is as likely to cause a new
regression as to help. If either of these actually shows up — a page that
comes back with `finish_reason` errors it shouldn't, or a sparse page with
one badge scattered oddly — that's the point to come back here, confirm
the mechanism against the real response, and only then patch it.

---

## Confirmed, blocking: `_merge_bubble_regions` over-merges adjacent bubbles on RapidOCR's fragment output

Unlike the two entries above, this one **was** reproduced directly against
real output — see below — not constructed. Flagged here rather than fixed
inline because the actual fix needs the same thing every threshold in this
file needs: tuning against a real sample set, not one page.

**Symptom:** running `_run_rapidocr_detection` against a real page
(`Brazil_raw.jpg` — the Portuguese page from the OCR-engine comparison
testing) produced a region whose text was:

    NOZUKI, QUE ELES VÃO SEPARAR OS GAROTOS E EU OUVI ACAMPAMENTO ESCOLAR
    QUE VAI TER? SABE O GAROTAS A NOITE.

which is two separate speech bubbles' dialogue interleaved fragment-by-
fragment into one region. The actual page has two adjacent bubbles in the
same panel:

  - "Nozuki, sabe o acampamento escolar que vai ter?"
  - "Eu ouvi que eles vão separar os garotos e garotas a noite."

**Confirmed not an extraction bug:** printed `_rapidocr_readtext_primary`'s
raw output before it reaches the merge step — every individual fragment is
correct (`'QUE ELES VÃO'` at y=126–146, `'EU OUVI'` at y=114–131, `'SABE O'`
at y=109–127, etc. — all separately correct, sensibly-boxed, line-level
fragments). The corruption happens inside `_merge_bubble_regions`, after
correct input.

**Likely cause:** `_merge_bubble_regions`'s per-box adaptive `MERGE_MARGIN`
(see its docstring — "content-adaptive, computed PER-BOX, not page-wide")
was tuned against EasyOCR's typical fragment granularity. RapidOCR
produces meaningfully more, smaller, line-level fragments per bubble than
EasyOCR does for the same page (compare: EasyOCR tends toward fewer,
denser per-bubble fragments in our earlier comparison testing). More
fragments packed into the same physical space means more expanded-box
pairs land close enough to overlap — and when two *different* bubbles
happen to sit close together in the same panel (no panel-border line
between them for the merge guard to catch), that overlap is enough to
union-find them into one group.

**Not fixed here because:** the correct fix is almost certainly an
engine-aware `MERGE_MARGIN` (or an engine-aware call into whatever computes
it) rather than a single shared constant — but picking the right value (or
formula) requires testing across a real sample of pages with
closely-spaced bubbles, the same way every other threshold in this file
was tuned, not guessing a smaller number and hoping. Until this is
resolved, RapidOCR should not be exposed as a casually-selectable option
in the frontend — see ROADMAP.md's RapidOCR section for what's gating that.

**What would confirm the fix:** re-running this exact page (and a handful
of others with tightly-packed panels) through both engines after the
change and checking that (a) RapidOCR no longer merges these two bubbles,
and (b) EasyOCR's existing, currently-correct behavior on the same pages
doesn't regress — this constant is shared code, so a fix for one engine
that isn't checked against the other is exactly the kind of "fixed A,
silently broke B" this file exists to prevent.

---

**Fix implemented, NOT yet verified against real pages** — status is
"code written and logic-tested," not "fixed." Do not treat this as closed
until the verification step below has actually happened.

The originally-suspected root cause above (per-box margin tuned for
EasyOCR's coarser fragmentation) turned out to be real but incomplete.
Two things worth recording so neither has to be re-discovered:

1. `_crosses_bubble_boundary` — the mechanism that in principle should
   catch exactly this ("two different bubbles, don't merge") — already
   has a documented blind spot for precisely this shape of case: two
   similarly-sized adjacent bubbles whose flat-white fills blur into one
   connected component when the ink outline between them is thin (see the
   STATUS block above `_find_bubble_components`, "CONFIRMED NOT WORKING").
   That gap predates RapidOCR entirely and isn't engine-specific; RapidOCR
   just made it easier to hit by putting more fragment pairs within
   bridging distance of the boundary in the first place.

2. The obvious next idea — extend `_profile_confirms_gap`'s ink-valley
   check to horizontal gaps, mirroring how it already works for vertical
   ones — was tried on paper and rejected: a clean whitespace gap looks
   pixel-identical whether it's a normal word-space inside one bubble or
   open panel background between two different bubbles. Ink density
   cannot distinguish those two cases; only the gap's SIZE relative to
   normal same-bubble spacing can. So this had to be a geometric fix, not
   a pixel-content one, unlike the vertical case.

**Fix actually applied:** `_merge_bubble_regions`'s per-box margin is now
two values, not one — `margin_v` (vertical reach, unchanged, still
`height x margin_scale x LINE_GAP_FACTOR`) and `margin_h` (horizontal
reach, new, `height x margin_scale x HORIZONTAL_GAP_FACTOR` with
`HORIZONTAL_GAP_FACTOR = 0.5`, deliberately much smaller than
`LINE_GAP_FACTOR = 1.6`). Rationale: the only legitimate reason this
function ever needs to bridge a horizontal gap at all is staggered/zigzag
lettering inside one narrow bubble, and that pattern's real gap is tight
same-bubble spacing — nothing like the padding-plus-border gap between two
separate bubbles. `expanded()` now expands each box by `margin_h`
horizontally and `margin_v` vertically instead of one shared value in
every direction. `HORIZONTAL_GAP_FACTOR = 0.5` is an unvalidated starting
point, same caveat as everything else in this file.

**Logic-tested, not page-tested:** `test_side_by_side_bubble_merge.py`
constructs a synthetic layout modeled on this page's own y-ranges (SABE O
/ EU OUVI, 20px real gap) and confirms (a) it no longer merges under the
new split margin, (b) it WOULD have merged under the old shared margin —
so the test is actually exercising the fix, not a case neither version
would have merged — and (c) a tight 5px same-bubble staggered-lettering
case and a normal 10px vertical line gap both still merge correctly
(regression guards). All passing. This validates the arithmetic, not real
pixels or real OCR output.

**Verification result: FIX DOES NOT RESOLVE THE REAL CASE.** Re-ran
`Brazil_raw.jpg` through the actual `_run_rapidocr_detection` pipeline
(not the synthetic test) with the fix applied. The exact originally-
reported symptom reproduces verbatim:

    'NOZUKI, QUE ELES VÃO SEPARAR OS GAROTOS E EU OUVI ACAMPAMENTO ESCOLAR
    QUE VAI TER? SABE O GAROTAS A NOITE.'

Traced the actual mechanism rather than re-guessing: pulled every raw
fragment's real pixel coordinates and checked every cross-bubble pair.
The closest-approach pair is `'ACAMPAMENTO'` (bubble A) and
`'QUE ELES VÃO'` (bubble B) — **1.0px real horizontal gap**, with several
other cross-bubble pairs at 6–11px. This is why the synthetic test's 20px
model didn't catch it: it was built around one representative pair
(`SABE O`/`EU OUVI`, genuinely ~20px), but two adjacent curved speech
bubbles don't have a uniform gap along their whole facing edge — the
closest-approach point between them can be far tighter than the gap the
test happened to sample.

**Root cause is more specific than "HORIZONTAL_GAP_FACTOR is still too
large":** it's the `max(4, ...)` floor, inherited unchanged from the
original single-margin code and now applied to `margins_h` as well as
`margins_v`. For the actual box heights involved here (20–22px),
`margin_h` computes to 5px per box even at the current
`HORIZONTAL_GAP_FACTOR = 0.5` — the height-scaled term already exceeds
the floor, so the floor isn't even the active constraint in this specific
case, but it doesn't matter: 5+5=10px combined reach against a 1.0px real
gap. Shrinking `HORIZONTAL_GAP_FACTOR` toward 0 doesn't help either —
once the height-scaled term drops below 4, the `max(4, ...)` floor takes
over and holds combined reach at a minimum of 8px regardless. **No
positive value of `HORIZONTAL_GAP_FACTOR` can produce a combined reach
under 8px** while this floor exists, and this real page has confirmed
gaps as small as 1px between genuinely different bubbles.

**This is a structural problem, not a mistuned constant — worth being
precise about why, since it forecloses just trying a smaller number
next.** `test_side_by_side_bubble_merge.py`'s own legitimate case (tight
staggered-lettering, same bubble) uses 5px as the gap that must still
merge. This page's confirmed illegitimate case (different bubbles) is
1px — *smaller* than the gap the fix is supposed to preserve merging for.
Any threshold permissive enough to bridge a legitimate 5px gap will
trivially also bridge an illegitimate 1px gap, since 1 < 5. There is no
single geometric threshold that can separate these two cases correctly
on this page — not "we haven't found the right number yet," but "no
number does this correctly, given these two real constraints coexist."

**This confirms — with a real number now, not just a suspicion — the
diagnosis already written above:** `_crosses_bubble_boundary`'s documented
blind spot (two adjacent bubbles' fills blurring into one connected
component when the ink outline between them is thin) is the actual
mechanism that needs fixing. Gap-size heuristics, geometric or ink-based,
have now been tried and both hit real limits on this exact page. The
outline itself — actually detecting where one bubble's boundary ends and
the panel background or the next bubble begins — is the only signal left
that isn't already shown to fail here.

**Regression check:** ran the full `eval_samples/` batch through the
fixed code — no crashes, no new pages showing an implausible single
mega-region. The fix isn't harmful, it's just not sufficient for the
case it was built to fix. `HORIZONTAL_GAP_FACTOR`'s existence as a
separate, tighter constant is still probably correct groundwork for
whatever the real fix ends up being — this isn't "revert it," it's "it
alone isn't the fix."

**Decision: accept this as a known limitation, same as EasyOCR's own
pre-existing blind spot in `_crosses_bubble_boundary` already is — not
worth blocking RapidOCR's launch on.** This bug is that same predating,
already-documented blind spot (see the STATUS block above
`_find_bubble_components`: "two separate bubbles that are visually
adjacent, similarly sized, and similarly shaped... the veto never
fired"), reached more often via RapidOCR's fragment spacing than via
EasyOCR's, but not a new category of failure. The codebase already made
this call once for EasyOCR ("a strict improvement with a known,
human-correctable blind spot is a reasonable place to stop") — the
Correction UI (✏ Correct) is the existing, working fallback for exactly
this class of miss, and RapidOCR inherits that same fallback rather than
needing its own.

**Frontend engine-selection toggle: now wired live**, with this
limitation disclosed directly in the settings copy rather than silently
shipped — see `#local-ocr-engine-group` in `index.html`: *"Rarely,
RapidOCR may merge two adjacent speech bubbles into one — use ✏ Correct
to split them back apart if that happens."* If this turns out to be
common enough in practice that the Correction UI's fallback role feels
like it isn't holding — not "one confirmed page," but a pattern showing
up across real reading sessions — that's the point to revisit and
actually invest in real bubble-outline tracing (the bigger fix described
above, still not attempted).

---

**Process note (2026-08-05): docs/code desync, now corrected.** The
`margin_h`/`margin_v` split and `HORIZONTAL_GAP_FACTOR` described above as
"implemented, logic-tested, verified against the real page" had only ever
been applied in a separate working copy (`server_py_changes.diff`,
generated from a `/home/claude/mangatl_orig` vs `/home/claude/mangatl`
comparison) — it was never actually present in this repo's `server.py`,
in any commit or in the working tree, until just now. The verification
writeup above is still accurate (it was run against the diff applied
elsewhere), but for a stretch of time this file described a fix as live
that the shipped code didn't contain, which meant the real merge-bug
surface was at least as bad as documented and possibly worse (fully
shared margins, not even the tighter-but-insufficient split). The diff
has now been applied to `server.py` directly (confirmed via
`test_side_by_side_bubble_merge.py` — all cases pass, including the
20px constructed case that was failing before) and the stray
`server_py_changes.diff` file removed. Lesson: this file's own standard
for trustworthy claims — test the *live* logic, not a hand-copied
duplicate — needs to extend to "and confirm that logic actually made it
back into the tracked source," not just that it was tested somewhere at
some point.
