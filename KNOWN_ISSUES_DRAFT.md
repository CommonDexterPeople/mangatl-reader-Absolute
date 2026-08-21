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

---

## Fix attempt #3 for the same bug: outline tracing in `_find_bubble_components`

**Status: implemented, logic-tested, tested against synthetic image data
reproducing the reported failure's characteristics. NOT yet verified
against the real Brazil_raw.jpg page** — this environment doesn't have a
copy of it. Do not treat this as closed until that verification happens;
this file's own established bar (see fix attempt #2 above, which passed
its synthetic test and then failed on the real page) is the reason this
entry is this explicit about what has and hasn't been checked.

**Why margin-tuning (fix attempt #2, directly above) couldn't work — the
diagnosis that motivated this attempt:** fix attempt #2 proved, with a
real number from the real page, that no `HORIZONTAL_GAP_FACTOR` value can
separate the two cases it needs to separate — the real illegitimate gap
between different bubbles (1.0px) is *smaller* than the real legitimate
gap a same-bubble merge needs to preserve (5px). That's not a mistuned
constant, it's two real constraints that can't both be satisfied by one
geometric threshold. Which means the bug was never really in the merge
*margin* — it was upstream, in `_find_bubble_components`'s label map
itself reporting ONE component where the real page has two. No amount of
correct downstream logic (margin tuning, or `_crosses_bubble_boundary`'s
sampling, which was already tested and correct) can recover a boundary
that the segmentation step never detected in the first place.

**What actually causes the label map to be wrong:** `_find_bubble_components`
classifies a pixel as bubble-fill using box-filtered Laplacian variance
(9x9 kernel) thresholded at 40.0 — deliberately coarse, since it's a
page-wide, one-time flatness pass. A thin (1-3px) or low-contrast dividing
line between two adjacent, similarly-bright bubbles gets diluted by that
averaging: the 9x9 window mostly sees flat fill on both sides of the line,
so the averaged variance can land under 40.0 even directly on top of the
line. The line effectively disappears from the flatness signal, and the
two bubbles' fills read as one connected component.

**Fix:** a new function, `_bubble_outline_mask`, runs `cv2.adaptiveThreshold`
(Gaussian-weighted local mean, block_size=15, C=7) over the same grayscale
page — a genuinely different signal from the box-filtered flatness test:
instead of "how much does intensity vary in a neighbourhood," it asks "is
this pixel darker than its own local neighbourhood's mean," which is
exactly what a thin ink line is, however faint, as long as it's genuinely
darker than the paper immediately around it. The result (dilated 1px, so
it's topologically solid against 8-connected flood fill) is subtracted
from the flat+light candidate mask *before* `cv2.connectedComponents`
runs, in `_find_bubble_components`. This is purely subtractive — it can
only remove candidate pixels, never add them — so it can narrow an
existing component into two, but can never merge two components the old
flatness-only mask would have kept separate. That asymmetry means the fix
has no new failure mode symmetric to the bug it targets (it can't cause a
*new* false-merge; the worst case is over-splitting a single bubble's own
interior, checked directly below).

**block_size=15, C=7 are UNVALIDATED starting values** — same caveat as
every other constant in this file — chosen to react to a 1-3px line's own
local contrast without tripping on ordinary flat paper or scan noise, and
checked against synthetic data (below), not yet checked against a range of
real pages' actual noise floors and ink darkness.

**Verification performed — synthetic, not real pixels:** built a
two-ellipse synthetic page (`test_bubble_outline_tracing.py`) — two
"speech bubbles" with flat white fill, a soft anti-aliased stroke outline,
Gaussian-blurred to mimic scan/compression softening — with ellipse
centers placed close enough that the two strokes interact at their
closest-approach point, tuned empirically (against server.py's actual
constants, not guessed) so the OLD flatness-only mask genuinely merges
them into one component first — a companion check, matching this file's
own established pattern, confirms that premise before trusting anything
built on top of it. Against that image:

  - OLD mask (flatness+lightness only): two bubble centers resolve to the
    SAME label — reproduces the bug's mechanism, not just its symptom.
  - NEW `_find_bubble_components` (with outline carving): the same two
    centers resolve to DIFFERENT labels.
  - `_crosses_bubble_boundary`, given two fragment boxes positioned near
    the bubbles' facing edges (mimicking OCR text wrapping close to a
    bubble's inner wall, the same layout that produced the real page's
    ~1px gap): returns `True` (blocks the merge) with the NEW label map,
    `False` (does not block it) with the OLD one.
  - Full `_merge_bubble_regions`, run end-to-end with the synthetic image
    and those two fragment boxes: 2 separate regions with the NEW map; 1
    region with the OLD map, and — this is the part that actually mirrors
    the real bug, not just a label count — the OLD-map region's text is
    the two fragments' text concatenated together, the same shape of
    corruption as the real `NOZUKI, QUE ELES VÃO SEPARAR OS GAROTOS E EU
    OUVI ACAMPAMENTO ESCOLAR...` interleaving reported against the real
    page.
  - Regression checks, same synthetic setup: two fragments inside the
    SAME bubble (far apart, top vs bottom) still resolve to one component;
    a tight 5px same-bubble staggered-lettering pair — the exact
    legitimate case fix attempt #2 needed to preserve — still merges under
    the NEW map; a single isolated bubble with no second bubble anywhere
    on the page keeps its entire interior as one component across 7
    widely-spaced sample points (i.e. outline carving doesn't fragment a
    bubble's own interior when there's nothing to disambiguate against).

**What would actually confirm this fix, still not done:** re-run the real
Brazil_raw.jpg page through `_run_rapidocr_detection` with this change
applied and confirm the originally-reported two-bubble merge no longer
reproduces; re-run a handful of other pages with tightly-packed panels
(both engines) and confirm no new mega-regions appear; specifically check
a real page with genuinely tight same-bubble staggered lettering to
confirm `block_size`/`C` aren't so sensitive they start fragmenting real
bubble interiors that the synthetic single-bubble test didn't happen to
exercise. Per this file's own precedent (fix attempt #2 passed its
synthetic test and still failed on the real page for a reason the
synthetic test's geometry couldn't have caught), passing the synthetic
suite here is evidence the mechanism is sound, not proof the real page is
fixed.

---

## Fix attempt #3 verification result: DOES NOT RESOLVE THE REAL PAGE — root cause was misdiagnosed

**The real Brazil_raw.jpg page is now available and was tested.** Ran the
actual `_run_rapidocr_detection` pipeline, fix applied, against the real
page. The exact originally-reported symptom reproduces verbatim:

    'NOZUKI, QUE ELES VÃO SEPARAR OS GAROTOS E EU OUVI ACAMPAMENTO ESCOLAR
    QUE VAI TER? SABE O GAROTAS A NOITE.'

Confirmed not a regression — re-ran with `_bubble_outline_mask` forced to
a no-op (simulating pre-fix behaviour) against the same page: byte-
identical output, all 13 regions, including this one. The fix is inert on
this page, neither helping nor hurting.

**Why: the premise behind fix attempt #3 was wrong for this page.**
Traced the actual connected-component label map directly (not just the
merge result) and visualized it against the source art. The two bubbles
are **not** divided by a thin/faint/low-contrast ink line at all — there
is no ink of any kind between "VÃO" and "ACAMPAMENTO" (confirmed by
inspecting the real pixel values in that gap: pure 255 white, no
gradient). The two bubbles are drawn as a single fused "double-bubble"
silhouette — the kind of shape where two adjacent speech bubbles' outer
contours merge into one continuous outline with no internal dividing wall,
common enough as a manga art convention (visually similar to two soap
bubbles fused together: a waist/cusp in the outer contour near the top
and bottom, but the interior is one topologically connected region
throughout, including through the text-line area). Rendering the
connected-component label map as an image confirms this directly: both
bubbles are one single label, wall to wall, with no internal boundary
pixel anywhere — not "a boundary too faint to detect," but no boundary
pixel in the source art at all.

**This means no amount of ink-detection sensitivity can fix this case.**
Adaptive thresholding (or any other per-pixel "is this darker than its
surroundings" signal) can only find a line that exists, however faint.
Here there is nothing to find — the fix's entire mechanism doesn't apply.
This is a materially different failure mode from what fix attempts #2 and
#3 were both built against (a real but hard-to-detect boundary); the
codebase's own prior diagnosis ("especially if the ink outline between
them is thin or low-contrast") undersold how bad this can get — on this
page it isn't thin or low-contrast, it's **absent**.

**Investigated next: shape-based splitting (distance transform +
watershed)** — the standard CV technique for separating two touching/
overlapping blobs with no boundary line between them (the classic
"separate touching coins" problem). Tried directly against the real
merged component: `cv2.distanceTransform` on the blob, thresholded at
30-70% of its own peak to find seed regions for `cv2.watershed`.

**Result: does not naively work either, for a page-specific reason worth
recording.** The two dominant distance-transform peaks found were NOT
centered in the left bubble vs. right bubble as hoped — they landed near
the TOP-middle and BOTTOM-middle of the merged shape (visually, right at
the waist cusps themselves). Root cause: these two bubbles are packed
with multi-line dialogue text covering most of their interior area, and
each glyph is itself a "hole" carved out of the flat+light candidate mask
(text is dark, excluded from the mask). With that much of the interior
occupied by text-shaped holes, the actual open flat-light area isn't two
big round lobes with two deep centers — it's a network of thin corridors
threading between lines and around letters, PLUS two genuinely open
margins above the first line and below the last line, which (having no
nearby text holes) register as the widest, most "interior" points by
distance-transform — and those margins span horizontally across BOTH
bubbles, since there's no dividing wall there either. A naive raw-
distance-transform watershed seeds on those margins and would cut the
shape top/bottom, not left/right — the wrong axis for separating "this
bubble's text" from "that bubble's text." Not pursued further as a raw
geometric approach; a workable version would need seeds informed by where
the OCR fragments themselves cluster, not blind distance-transform peaks
on the pixel mask alone — untried, and a bigger lift than either fix
attempt #2 or #3.

**Decision: not resolved. Documenting instead of shipping a third
unvalidated heuristic.** Per this file's own standard (do not fix blind,
do not claim done without checking the real page), the honest state is:
the confirmed-blocking bug from the original entry is still confirmed-
blocking on the real page that motivated it. Fix attempt #3's outline-
carving code remains in `server.py` (harmless — confirmed byte-identical
output where it doesn't apply, and it may still help pages where a real
but faint line — as opposed to no line — is the actual cause; that
scenario hasn't been found on a real page yet either, only synthesized).
The Correction UI (✏ Correct) remains the load-bearing fallback for this
exact page and this exact bubble pair, same as it already is for every
other case in this failure class.

**Real next step, if this gets picked up again:** a fragment-cluster-
aware split — use the OCR fragments' own natural left/right grouping
(e.g. k=2 clustering on fragment centroids, or seeding the watershed from
each existing OCR-fragment bounding box's centroid rather than from raw
distance-transform peaks) instead of trying to read bubble identity out
of the pixel mask alone. Untried. Would need the same bar as everything
else here: verified against Brazil_raw.jpg specifically, then checked for
regressions against pages with genuinely single, undivided bubbles (so it
doesn't start splitting real single-bubble multi-paragraph regions in two
just because their fragments form two loose clusters).

---

## RESOLVED (verified on the real page): fused double-bubble "waist" veto

**Status: FIXED and verified against the real Brazil_raw.jpg page**, plus
regression-checked on 3 other real pages across BOTH engines. This is the
first fix for this bug that has actually been confirmed on real pixels
rather than constructed ones — the previous two attempts both passed
synthetic tests and then failed here.

**What the earlier attempts got wrong, and what the real signal turned
out to be.** Attempts #2 (margin tuning) and #3 (ink-line detection) were
both looking for the wrong thing:

  - #2 assumed the bubbles were separated by DISTANCE. Disproved with real
    numbers: 1px between different bubbles vs 5px inside one bubble. No
    threshold separates 1 < 5.
  - #3 assumed they were separated by faint INK. Disproved by reading the
    real pixels: the gap is pure 255 white, no ink at all, and the label
    map shows one component wall to wall.

  Both assumed a *separator* exists and is merely hard to detect. On this
  page there is no separator. The two bubbles are drawn as one fused
  silhouette — a single continuous outer contour pinched into a figure-8.
  That is a common manga convention, not an oddity of this page.

  The signal that does distinguish them is **shape**: a fused
  double-bubble has a genuine geometric CONSTRICTION between its lobes.
  A single bubble containing two columns of text — the legitimate
  "staggered lettering" pattern every earlier fix had to avoid breaking —
  has no constriction; it's one convex-ish blob.

**Measured, on the real page** (per-column vertical extent of the
component, i.e. outer-silhouette height at each x — extent rather than
pixel count specifically because a bubble's interior is full of
text-shaped holes that would otherwise dominate a raw count):

| component | profile | waist ratio |
|---|---|---|
| fused double-bubble (Eu ouvi / Nozuki) | 183px → **136px** → 183px | **0.743** |
| AINDA BEM (single) | no interior minimum | 1.000 |
| ISSO SIGNIFICA (single) | no interior minimum | 1.021 |
| VOCÊ DEVIA (single) | no interior minimum | 1.006 |
| TEM ALGUMA (single) | no interior minimum | 1.000 |
| EU ACHO QUE (single) | no interior minimum | 1.048 |

Well-separated, not marginal. `_WAIST_RATIO_THRESHOLD = 0.85` sits clear
of both clusters.

**Implementation** (`_waist_separates_boxes`, `_component_column_extents`,
`_dominant_component_for_box` in server.py): a THIRD independent veto in
`_merge_bubble_regions`'s pair loop, alongside `_crosses_border` and
`_crosses_bubble_boundary`. For a candidate pair already in the same
component, it measures the narrowest silhouette extent strictly BETWEEN
the two fragments' own x-centers and compares it to the narrower of the
two fragments' own local extents; a ratio at or below the threshold means
they sit in different lobes and the merge is refused.

Deliberately narrow scope, since a false positive here splits a bubble
that should have stayed whole:
  - Only for pairs already in the SAME component (different components
    are `_crosses_bubble_boundary`'s job and it handles them correctly).
  - **Horizontal pairs only** (`|dx| > |dy|`). The vertical analogue is
    NOT enabled: vertical is the hot path — every ordinary line-to-line
    pair in every normal bubble is vertically separated — so a false
    positive there would shatter ordinary multi-line dialogue, and there
    is no confirmed real page to tune a threshold against. Do not enable
    it without one.
  - Measured between the two fragments' own centers, not "anywhere in the
    component" — a waist elsewhere in the blob says nothing about whether
    THESE two fragments are in different lobes.
  - Returns False (don't block) on anything it can't confidently measure:
    no label map, too-short span, fragment not resolvable to a component.

**Verification — real pages, both engines.** RapidOCR on Brazil_raw.jpg
now produces the two bubbles correctly and in correct reading order:

    'NOZUKI, SABE O ACAMPAMENTO ESCOLAR QUE VAI TER?'
    'EU OUVI QUE ELES VÃO SEPARAR OS GAROTOS E GAROTAS A NOITE.'

Both match the source art exactly (checked against the page, not inferred
from whether they read as grammatical Portuguese — see the standing
warning about that trap in the "Bubble contour detection" comment).

Regression run, each page processed with the veto disabled and enabled and
the region texts diffed:

| page | RapidOCR | EasyOCR |
|---|---|---|
| Brazil_raw.jpg | 13 → 14 regions (**only** the intended split) | identical |
| Another manga untranslated page.jpg | identical | identical |
| Manga page test 2_Untranslated.jpg | identical | identical |
| This is for testing also_untranslated.png | identical | identical |

The EasyOCR column is the check this file has repeatedly called for and
that fix attempt #2's writeup explicitly flagged as mandatory: this is
shared code, so a fix validated on one engine only is exactly the
"fixed A, silently broke B" failure this file exists to prevent. EasyOCR
output is byte-identical on all four pages, including Brazil_raw.jpg
(EasyOCR's coarser fragmentation didn't produce the cross-bubble pair in
the first place, so there is nothing there for the veto to change).

**Test:** `test_fused_bubble_waist.py` — synthetic geometry for the
mechanism and its scope guards, plus a real-page test that runs the actual
merge over the real OCR fragment boxes from Brazil_raw.jpg when the image
is available (it skips with an explicit message when it isn't, rather than
silently passing on synthetic evidence alone). Includes companion checks
that both fragments really are in the same component (so the test can't
pass via the pre-existing different-component veto) and that disabling the
veto reproduces the original garbled region.

**Note on fix attempt #3's outline-carving code:** retained. It is
confirmed harmless (byte-identical pipeline output on all four pages) and
targets a genuinely different failure mode — two bubbles divided by a
real-but-faint ink line, which the coarse flatness filter smooths over.
That scenario still has not been confirmed on a real page, only
synthesized, so its value remains unproven; it is not what fixed this bug.

**Remaining known gaps in this area** (unchanged, still real):
  - Vertically-stacked fused double-bubbles — not handled, see scope note.
  - A fused double-bubble whose lobes are so similar in size and so
    shallowly pinched that the ratio stays above 0.85 — would still merge.
    No such page has been seen; if one shows up, the threshold is the
    thing to revisit, and it should be re-measured against the table
    above rather than nudged blind.
  - The Correction UI (✏ Correct) remains the fallback for both.

---

## RESOLVED (measured on 15 real pages, both engines): adjacent text containers merged across a clean gutter

**Status: FIXED.** `HORIZONTAL_GAP_FACTOR` lowered from an unvalidated 0.5 to
a measured 0.3. Found while probing a *different* hypothesis (below), which
is worth recording: the check that found this was looking for something else
entirely and came up empty.

**Symptom — same class as the fused double-bubble bug, different cause.**
Two adjacent text containers separated only by whitespace merged into one
region with their lines interleaved. On `manga page test_Untranslated.jpg`:

    Y ENCIMA, EN EL CAPÍTULO T¿Y EN ESE MOMENTO 2, CUANDO AKAYA, QUE DEJÓ
    AKAYA TAMPOCO SE ESTÁ EL TENIS DE MESA EN LA COLUMPIANDO, SOLO ESTÁ …

which is two side-by-side caption boxes read as one. **Present on BOTH
engines** — this is not RapidOCR-specific, and EasyOCR's own output on the
same page showed the identical interleaving (`Y Encima, En El Capitulo AKAYA
Tampoco SE ESTÁ i2y En ESe Momento 2,Cuanvo …`). Two further real cases:
adjacent speech bubbles on `Manga page test 2_Untranslated.jpg` (and its
translated twin), and — notably — a *second* over-merge on `Brazil_raw.jpg`
itself, where the small `HUH?` bubble was absorbed into the neighbouring
`…CHEGAMOS` bubble. That one had been on the page all along; the waist-veto
verification missed it because it only checked the two bubbles that fix
targeted.

**Why none of the three existing vetoes can catch it.** Measured, not
assumed:

  - `_crosses_bubble_boundary`: both containers resolve to ONE flat-light
    component. The gutter is pure 255 white across its full width (sampled
    x=1000–1013, min=255, zero dark pixels), and white is flat+light, so
    `_find_bubble_components` includes the gutter IN the mask rather than
    treating it as a boundary. There is no boundary pixel to find.
  - `_bubble_outline_mask` (fix attempt #3): same reason — it detects faint
    ink lines, and there is no ink here at all.
  - `_waist_separates_boxes`: in scope (the pairs are horizontal) and
    correctly reports no constriction. These are RECTANGLES, and two adjacent
    rectangles produce a constant-height silhouette. Per-column extent across
    the gutter runs 348→355→363→372→379px — monotonically increasing, no dip.
    Waist ratio 0.948 against the 0.85 threshold.

  Shape and ink signals are both *structurally* absent for this container
  shape. Gap SIZE is the only remaining signal — exactly what this file's
  earlier entry predicted ("only the gap's SIZE relative to normal
  same-bubble spacing can" distinguish the two cases).

**The actual mechanism.** Only three fragment pairs bridge the gutter, the
widest lines in each box, at 13–16px horizontal gaps. With ~37px line
heights, `margin_h = height x margin_scale x HORIZONTAL_GAP_FACTOR` gave
each box 9.25px of reach at 0.5 — 18.5px combined, enough to bridge 13–16px.
At 0.3 the combined reach is 11.1px, which is not.

**Sweep evidence.** OCR was run once per page per engine and the fragments
cached, then only `_merge_bubble_regions` was re-run across
`HORIZONTAL_GAP_FACTOR` ∈ {0.5, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05},
so nothing but this constant varied.

| factor | RapidOCR pages changed | EasyOCR pages changed |
|---|---|---|
| 0.5 (old) | baseline | baseline |
| 0.4  | 1 | 0 |
| 0.35 | 3 | 2 (Brazil noise SFX regroup only) |
| **0.3** | **5** | **3** |
| 0.25 | 5 | 3 |
| 0.2  | 5 | — |
| 0.15–0.05 | 6 (plateau) | — |

Every single change at every value, on both engines, was a SPLIT that
inspection confirmed correct — no page ever lost a region, and no line was
broken in half. Beyond the three target cases, lower values additionally
separated SFX from adjacent dialogue (`かい CHATTER` from `AINDA BEM.`,
`Flinch` from `EVEN THOUGH I DON'T REALLY GET…`), which are also correct.
0.3 is the loosest value that fixes all three target cases: RapidOCR needs
≤0.35, EasyOCR needs ≤0.30.

EasyOCR's only non-target change at 0.3 is on Brazil, where the SFX region
`78 DUn` becomes `DUn` — a noise fragment separating from another noise
fragment, region count unchanged at 14. Worth noting because the waist-veto
entry above established "EasyOCR byte-identical" as the bar; this clears the
bar on region counts and on every real dialogue region, but not literally
byte-for-byte.

**Test:** `test_adjacent_container_gap.py` — synthetic geometry using the
real page's measured numbers (37px line height, 14px gutter, one continuous
component spanning both containers). Verified to fail at the old 0.5,
reproducing the interleaving, and pass at 0.3. It also asserts the constant
stays ≤0.35, so it cannot drift back up unnoticed.

**STILL UNVALIDATED — the case this constant exists to protect.** None of
the 15 sample pages contains a bubble whose OCR fragments actually need
horizontal merging (staggered/zigzag lettering split into side-by-side
fragments). That absence is also why every reduction looked free all the way
down to 0.05. If a page turns up where legitimate side-by-side fragments
fail to merge, THAT is the page to re-measure against — and the answer may
be that gap size alone is insufficient and this needs to become adaptive
(gap relative to the page's own median intra-bubble spacing) rather than a
fixed multiplier.

---

## NOT REPRODUCIBLE on 15 real pages: the waist veto's horizontal-only scope

Recorded so it is not re-investigated from scratch. `_waist_separates_boxes`
only considers pairs where `|dx| > |dy|`, so a diagonally-offset pair
spanning two lobes of a fused double-bubble should escape it. Confirmed
reachable **in synthetic geometry**: same component, same measurable
constriction (waist ratio 0.646, well under the 0.85 threshold), vetoed when
the pair is horizontal and not vetoed when the same pair is offset
diagonally — the merge then goes through.

**On real pages it does not happen.** Every call into the veto was
instrumented across all 15 sample pages on BOTH engines, recording any pair
that (a) reached the veto, meaning its expanded boxes already overlapped,
(b) was skipped by the `|dx| > |dy|` guard, and (c) would have been vetoed
without that guard. **Zero such pairs, on either engine, on any page.**

The reason is geometric: the anisotropic margins make it very hard to hit.
Horizontal reach is `0.25 x height` (now `0.15 x height`) while vertical
reach is `0.8 x height`, so a pair far enough apart horizontally to span two
lobes is almost never also close enough vertically — unless the fragments
are unusually TALL, which in practice means vertical CJK text. Those
languages are all in `VISION_LANGS` and route to Gemini Vision by default,
though the local engine still runs for box positions, so the path is not
fully unreachable.

Not fixed. Widening the scope to vertical pairs is explicitly warned against
in the waist-veto entry above (ordinary line-to-line pairs are the hot path;
a false positive there shatters normal dialogue), and there is no real page
to tune against. If a vertical-CJK page with a fused double-bubble ever
turns up, this is the entry to start from.

---

## MEASURED, BUILT, THEN DELIBERATELY NOT KEPT: hybrid two-engine detection for Vietnamese

**Status: not in the codebase.** A working implementation was built and
measured against three real Vietnamese pages, then removed on a cost/benefit
call. The measurements are kept here because they are the expensive part and
they stand on their own — anyone revisiting this should start from these
numbers rather than re-deriving them.

**What was measured.** `_LOCAL_ENGINE_RECOMMENDATION` already recorded that
RapidOCR mishandles Vietnamese diacritics; the size of the gap is now known:

| | tone/vowel-marked chars | share of text |
|---|---|---|
| ground truth (hand-read) | 72 / 310 | 23.2% |
| RapidOCR | 41 / 515 | 8.0% |
| EasyOCR | 76 / 483 | 15.7% |

RapidOCR drops roughly two thirds of the marks. Real line from
`Vietnam page.png`, source reads `LẦN DUY NHẤT TÔI TỪNG CHỐNG ĐỐI BỐ MẸ...`:

    RapidOCR   LÂN DUY NHÃT TÔI TUNG CHONG DI B ME...
    EasyOCR    LẪ DUY NHÁT Tôl TÙNG CHỐNG pỐl BỐMẸ _

**EasyOCR alone is not the answer either** — the non-obvious result worth
keeping. Scored against hand-read ground truth for the page's seven text
containers, EasyOCR comes out BELOW RapidOCR overall (0.759 vs 0.789) despite
reading characters better, because it GROUPS worse: on that page it split one
caption across two regions, so no single region matches the full ground-truth
string. RapidOCR's boxes give the right grouping; EasyOCR's recognition gives
the right characters.

**The hybrid that was built** took boxes from RapidOCR and text from EasyOCR,
pairing fragments by box IoU rather than text similarity (matching corrupted
text *by* that corrupted text is circular — the whole reason the thing exists
is that the text is wrong). It beat both engines:

| variant | mean similarity to ground truth | diacritic density |
|---|---|---|
| RapidOCR only | 0.789 | 8.0% |
| EasyOCR only | 0.759 | 15.7% |
| hybrid | **0.835** | **14.2%** |
| (ground truth) | 1.000 | 23.2% |

Reproduced on the other two pages: 7.9% → 13.2%, 10.3% → 17.7%, with 84-92%
of RapidOCR's fragments matched.

**Why it was not kept, despite working.**

  1. `vi` is in `VISION_LANGS`, so the DEFAULT Vietnamese path is Gemini
     Vision, not local OCR. On that path `/ocr` still runs a local engine —
     but purely for POSITIONS, discarding its text in favour of Vision's. A
     hybrid there pays two full inference passes and throws away the very
     text it ran the second pass to get. On the most common path it is
     strictly worse than not having it.
  2. That leaves a narrow audience: Vietnamese readers with no Gemini key
     (notably DeepSeek-only users, who never get Vision OCR at all — see the
     README). Real, but small.
  3. The gain, while measurable, is modest on text that stays visibly wrong
     either way, and it feeds an LLM translator that is fairly tolerant of
     OCR noise. **Whether better OCR changes the translation was never
     measured** — that is the number that would actually settle this, and it
     is the first thing to get if this is revisited.
  4. Two full-page inference passes is real cost on the low-end hardware this
     app targets.

**What was kept from the work.** The shared-stage refactor it forced:
`_run_easyocr_detection` and `_run_rapidocr_detection` each carried their own
copy of the decode / panel-border / bubble-component / CLAHE prologue and of
the raw-box / merge / border-percentage epilogue — the RapidOCR copy's own
comment said "byte-for-byte identical to `_run_easyocr_detection`'s". Both now
share `_prepare_page_for_detection`, `_{easyocr,rapidocr}_fragment_boxes` and
`_finish_local_detection`, verified byte-identical across 8 page/engine
combinations. That refactor is independently worthwhile and also makes a
third engine cheap to add, should this be revisited.

**If revisited, in order:**
  1. Measure whether OCR quality at this level changes the TRANSLATION output.
     If it does not, stop — nothing else matters.
  2. Make the local detection call position-aware, so the Vision path can ask
     for boxes only and never pay for a second recogniser pass.
  3. Only then re-add the two-engine path, gated to languages with measured
     before/after — not on the assumption that more engines is better. For
     Spanish the trade runs the other way: EasyOCR's text there is visibly
     worse (`vesgarravora` for `desgarradora`, `Columpianvo` for
     `columpiando`).

The implementation is recoverable from git history if wanted.

---

## Confirmed, unfixed: outlined caption text welds to an adjacent bubble because their light regions touch

**Reported** 2026-08-21 from real reading, on the page kept as
`eval_samples/caption_welds_to_bubble.jpg`. Reproduced at DEFAULT settings —
RapidOCR, merge sensitivity 0.5.

**Symptom.** The free-floating narration caption and the speech bubble beside
it come out as ONE region with their sentences interleaved line by line:

```
REFUERZOSY IUNO DOS TENGO SEGURO LO SIENTO, PERO NO ES.UNEX MÉDICO. MIEMBRO DEL ESCUADRÓN-1
```

instead of `DOS REFUERZOS Y UNO ES UN EX MIEMBRO DEL ESCUADRÓN 1` and
`LO SIENTO, PERO NO TENGO SEGURO MÉDICO.`

**Engine-dependent, and that is a clue rather than a get-out.** EasyOCR reads
this page correctly at 0.5 — its caption boxes stop at x=270 against the
bubble's x=282, a 12px gap that survives — and only welds at sensitivity >= 0.7,
via a different 12px diagonal bridge (`TENGO SEGURO` <-> `ESCUADRÓN -1`).
RapidOCR's boxes close that to **2px** and it welds at every sensitivity value
tried (0.3 through 0.7).

**Root cause, measured.** The caption's own white letter OUTLINE physically
touches the bubble's white fill, so `_find_bubble_components` — which segments
flat/light regions — merges the two into a single connected component (label
70, spanning x[272,486]). The caption's ink genuinely reaches x=278. They are
not merely close; they are one light region.

**Why every existing defence is structurally unable to see it.** All four were
measured on the real fragments, not reasoned about:

| defence | why it cannot fire |
| --- | --- |
| margin tuning | the gap is 2px, below `_MIN_MARGIN_PX` (4). No sensitivity value separates them — confirmed across 0.3-0.7. |
| `detect_column_split` | needs a river >= 3% of region width. 2px over a 443px span measures **0 units** at its 200-step resolution. |
| `_crosses_bubble_boundary` | it samples the path BETWEEN the boxes, which leaves dark artwork (no component) and enters exactly ONE component. "Outside, then into a bubble" reads as same-bubble, not as a crossing. |
| polarity | both blocks read light: caption 156-181 mean, bubble 173-199. The caption's outline is thick enough to fill its own box. Ranges overlap; no threshold separates them. |

**Two fixes attempted and disproved — do not retry these blind.**

1. *Per-side component membership.* Replace `_dominant_component_for_box`'s
   single padded rectangle with four per-side strips, and veto when one
   fragment is confidently enclosed by a bubble component and the other
   touches none. Implemented and measured: it **produced false splits inside
   real bubbles** — `TENGO SEGURO` reported as outside its own bubble, so
   `PERO NO <-> TENGO SEGURO` was vetoed, cutting one sentence in half. Two
   independent reasons, both fatal: adjacent text lines fill the side strips
   with glyph ink (the strip above `TENGO SEGURO` is only 37% component), and
   the caption box **already overlaps the bubble component by 7px before any
   padding is applied**, so no sampling radius can separate them.

2. *Tighten the OCR boxes to real ink.* Assumed RapidOCR pads its detection
   boxes. Measured: it does not. Slack between box edge and rightmost real ink
   is **1px** on all three caption fragments (5px on the bubble's). The boxes
   are accurate; the text really is that close.

**The one idea not yet tried.** The bubble has a drawn black border, and it
runs between the caption and the bubble interior. If `_find_bubble_components`
carved along that stroke reliably here, the caption's outline would land
outside the bubble's component and `_crosses_bubble_boundary` would fire
unaided. It currently does not — component 70 spans right across. Whether that
is a threshold in `_bubble_outline_mask` or the outline being genuinely broken
where the caption overlaps it has not been established. Establish that first;
it is the only remaining signal that is about the page's real structure rather
than about distance, and distance has been ruled out by measurement.

**Not a fix, but worth knowing:** switching the local engine to EasyOCR reads
this page correctly at default sensitivity.
