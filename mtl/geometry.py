"""
mtl/geometry.py — page geometry for bubble segmentation.

Everything here answers one shape question about a manga page: where the
panel borders are, where the flat/light bubble interiors are, and whether
two OCR fragment boxes are separated by one of those structures. Nothing
here knows about OCR text, translation, or HTTP — it takes a grayscale
array and boxes, and returns geometry.

These are the VETO primitives _merge_bubble_regions consults before it
merges any pair of fragments (see mtl/merge.py). They were split out of
server.py so the regression tests can import and call them directly:

    test_bubble_outline_tracing.py   _bubble_outline_mask, _find_bubble_components
    test_fused_bubble_waist.py       _waist_separates_boxes, _component_column_extents,
                                     _dominant_component_for_box
    test_adjacent_container_gap.py   the merge behaviour these vetoes produce

server.py re-exports every name below, so `from server import _crosses_border`
and friends keep working unchanged for any caller or test that used them
before this split.
"""

import cv2
import numpy as np


# ─── Panel border detection ───────────────────────────────────────────────────

def _find_panel_borders(gray: np.ndarray, img_w: int, img_h: int):
    """
    Detect horizontal and vertical panel border lines in a manga page.

    Strategy: morphological OPEN with a long thin kernel.  A feature only
    survives the OPEN if it spans at least 40 % of the image dimension, which
    reliably captures panel borders while ignoring speech bubble outlines,
    character art, and screentone patterns.

    Returns:
        h_borders — sorted list of y-coordinates (pixel) of horizontal borders
        v_borders — sorted list of x-coordinates (pixel) of vertical borders
    """
    _, binary = cv2.threshold(gray, 50, 255, cv2.THRESH_BINARY_INV)

    # ── Horizontal borders ────────────────────────────────────────────────────
    min_h_span = max(1, int(img_w * 0.40))
    h_kernel   = cv2.getStructuringElement(cv2.MORPH_RECT, (min_h_span, 1))
    h_img      = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)

    # ── Vertical borders ──────────────────────────────────────────────────────
    min_v_span = max(1, int(img_h * 0.40))
    v_kernel   = cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_v_span))
    v_img      = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel)

    def _cluster(indices, gap: int = 6) -> list:
        """Collapse a run of consecutive pixel indices into a single midpoint."""
        if not len(indices):
            return []
        borders, run_start, prev = [], int(indices[0]), int(indices[0])
        for idx in indices[1:]:
            idx = int(idx)
            if idx - prev > gap:
                borders.append((run_start + prev) // 2)
                run_start = idx
            prev = idx
        borders.append((run_start + prev) // 2)
        return borders

    h_rows = np.where(np.any(h_img > 0, axis=1))[0]
    v_cols = np.where(np.any(v_img > 0, axis=0))[0]

    return _cluster(h_rows), _cluster(v_cols)


def _crosses_border(
    box_a: tuple, box_b: tuple,
    h_borders: list, v_borders: list,
) -> bool:
    """
    Return True if a direct path from box_a to box_b must cross a panel border.

    We check whether any detected border line falls strictly inside the gap
    between the two boxes — not inside either box itself.
    """
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b

    # Vertical gap (potential horizontal border between them)
    gap_top    = min(ay2, by2)   # bottom of the higher box
    gap_bottom = max(ay1, by1)   # top  of the lower  box
    if gap_bottom > gap_top:
        for y in h_borders:
            if gap_top < y < gap_bottom:
                return True

    # Horizontal gap (potential vertical border between them)
    gap_left  = min(ax2, bx2)   # right edge of the left  box
    gap_right = max(ax1, bx1)   # left  edge of the right box
    if gap_right > gap_left:
        for x in v_borders:
            if gap_left < x < gap_right:
                return True

    return False


# ─── Bubble contour detection ─────────────────────────────────────────────────
#
# STATUS: validated against real pages — genuinely helps in some cases, had a
# known, understood blind spot in others that a later fix attempt (below)
# targets directly. Read this before "fixing" it.
#
# CONFIRMED WORKING: a compact dialogue region fused with a large, distant,
# differently-shaped block (e.g. a chapter title / logo bar spanning most of
# the page width) — the veto correctly separates them, with zero observed
# regressions across every other region on the same page, including a
# legitimate same-bubble "staggered lettering" region that was the main
# regression risk (two sub-columns of ONE sentence, zigzagging down a single
# narrow bubble — see _detect_column_split's docstring for that pattern).
#
# PREVIOUSLY CONFIRMED NOT WORKING (root-caused, fix attempted below — see
# "OUTLINE-TRACING FIX ATTEMPT"): two separate bubbles that are visually
# adjacent, similarly sized, and similarly shaped (e.g. two roughly-equal-
# width text columns side by side, a common two-characters-talking layout)
# — confirmed by eye against the source art to be genuinely two different
# bubbles, but the merge still fused them; the veto never fired. This is the
# same underlying gap as KNOWN_ISSUES_DRAFT.md's "Confirmed, blocking:
# _merge_bubble_regions over-merges adjacent bubbles on RapidOCR's fragment
# output" entry (Brazil_raw.jpg) — RapidOCR's denser fragmentation just made
# it easier to reach in practice; the gap itself predates RapidOCR and isn't
# engine-specific.
#
# WHY THE GAP EXISTS (confirmed, not just theorized — see below): the
# failing case and the working case differ in more than just "two bubbles vs
# one" — the working case has a large size/shape asymmetry between the two
# blocks, while the failing case has two similarly-sized adjacent blobs. Two
# same-sized bubbles sitting close together have their flat-white fill
# regions blur into the SAME connected component during segmentation —
# especially when the ink outline between them is thin or low-contrast,
# which is exactly the kind of edge the flatness box-filter (ksize 9x9) is
# prone to smoothing over: the 9x9 window mostly sees flat fill on both
# sides of a thin line, so the averaged variance can still land under
# _BUBBLE_FLATNESS_THRESHOLD directly on top of the line. This is a
# limitation of "segment the whole page into flat blobs via smoothed
# variance" as a strategy, not a bug in _crosses_bubble_boundary's sampling
# logic (that part was tested and corrected separately — see its
# docstring): the label MAP itself was wrong (one label where there should
# be two), so no amount of correct sampling of that map could recover the
# missing boundary.
#
# OUTLINE-TRACING FIX ATTEMPT (_bubble_outline_mask, called from
# _find_bubble_components): closing this gap for real meant explicitly
# detecting thin ink lines between adjacent similarly-shaped regions rather
# than tuning _BUBBLE_FLATNESS_THRESHOLD / _BUBBLE_LIGHTNESS_FLOOR — as
# anticipated below, a genuinely separate piece of image-processing work,
# not a constant to nudge. Implemented via per-pixel adaptive thresholding
# (compares each pixel to its own local neighbourhood mean, unlike the
# page-wide-calibrated flatness filter) to catch faint/thin lines the
# flatness filter's averaging smooths away, and subtracts them from the
# flat+light candidate mask before connected-components runs — carving a
# real topological gap at the boundary instead of trying to detect the
# absence of one after the fact. Margin-based fixes (HORIZONTAL_GAP_FACTOR,
# in _merge_bubble_regions) were tried FIRST and proven mathematically
# incapable of closing this gap on the real page that motivated it (the
# real illegitimate gap there, 1px, is tighter than the real legitimate
# gap a same-bubble merge needs to preserve, 5px) — this is why the fix
# lives in segmentation, not in the merge margins.
#
# STATUS OF THE FIX: implemented, and TESTED AGAINST THE REAL Brazil_raw.jpg
# PAGE — result: does NOT resolve it. The exact reported symptom still
# reproduces verbatim on that page with this fix applied (confirmed via
# byte-identical output to the fix disabled — this code is inert on that
# page, not harmful, just ineffective there). Root cause, confirmed by
# rendering the actual label map against the source art: on that page the
# two bubbles aren't divided by a thin/faint ink line this can detect —
# there is NO ink of any kind in the gap (pure 255 white, verified by
# reading the real pixels). They're drawn as one fused "double-bubble"
# silhouette with no internal dividing wall at all — a materially
# different failure mode than "a boundary too faint to detect," which is
# all adaptive thresholding (or any per-pixel ink signal) can ever help
# with. Full writeup, including a follow-up shape-based (distance-
# transform/watershed) attempt that ALSO didn't naively work and why, is
# in KNOWN_ISSUES_DRAFT.md under "Fix attempt #3 verification result."
# Left in place because it's confirmed harmless and may still help a page
# where the boundary is genuinely faint rather than absent — that case
# hasn't actually been confirmed on a real page yet, only synthesized.
# Do not describe this fix as resolving the confirmed-blocking bug; it
# does not, on the page that defines what "resolving" it means.
#
# WHAT ACTUALLY RESOLVED THAT BUG: the fused double-bubble "waist" veto —
# see the "Fused double-bubble (waist) detection" section further down
# this file, and KNOWN_ISSUES_DRAFT.md's "RESOLVED (verified on the real
# page)" entry. Short version: on that page the two bubbles are one fused
# silhouette with no separator of any kind between them, so both the
# distance-based and the ink-based approaches were looking for something
# that isn't there; the signal that works is the SHAPE's constriction
# between the two lobes. That fix is verified on the real page and
# regression-checked on 3 more pages across both engines.
#
# The correction UI (✏ CORRECT — see box-overlay.js / correction-ui.js)
# remains the fallback for what neither catches — notably vertically-
# stacked fused bubbles, which the waist veto deliberately does not
# handle (see its scope notes).
#
# Note for whoever verifies this: reading two column halves back as
# English and judging whether each "sounds like a complete sentence" is
# NOT a valid test for whether they're one bubble or two — both a genuine
# two-bubble split AND a single bubble with a two-clause sentence can read
# as fully grammatical either combined or split. This was tried during
# development here and produced confident-sounding false conclusions in
# both directions before being caught by checking the actual source art.
#
# ORIGINAL DESIGN RATIONALE (still accurate — why this exists at all):
#
# _find_panel_borders deliberately REQUIRES a feature to
# span >=40% of the image dimension before it counts as a border — that
# floor exists specifically so speech-bubble outlines (which are much
# smaller) don't get mistaken for panel borders. That means it structurally
# cannot be reused or "loosened" to find bubble outlines; lowering the 40%
# floor would start picking up character linework and screentone edges
# too. A bubble boundary needs a different detection strategy entirely.
#
# Strategy: rather than trying to trace a drawn outline (which fails for
# "borderless" bubbles — common in some art styles, where the only signal
# is a flat-white blob against textured/dark background, no ink outline at
# all), segment the page into connected components of "flat, light"
# pixels. This reuses the same flatness intuition _region_texture_variance
# already relies on elsewhere in this file (bubble fills read as low
# Laplacian-variance flat regions; screentone/gradient art does not) but
# applies it page-wide as a one-time segmentation instead of a per-box
# ring sample. Two OCR fragments are "in the same bubble" if they fall
# inside the same connected flat-light component; two fragments in
# DIFFERENT components must belong to different bubbles (or one is inside
# a bubble and the other is sitting on bare page background/art), and
# should never be merged regardless of how small the pixel gap between
# their boxes is.
#
# This deliberately does NOT try to distinguish "a real bubble" from "a
# blank panel background" or "a page gutter" by shape — it doesn't need
# to. All _crosses_bubble_boundary needs to know is "are these two
# fragments in the SAME flat-light blob or not"; a fragment sitting in
# bare white background rather than a drawn bubble will still get its own
# connected-component id, and two fragments in that same background blob
# merging is no worse than today's behaviour (today they'd merge purely
# on pixel distance with no bubble-awareness at all). The only NEW
# guarantee this adds is: fragments in two DIFFERENT flat-light blobs
# never merge, which is exactly the two-bubble-fusion bug this is meant
# to fix.
def _bubble_outline_mask(gray: np.ndarray) -> np.ndarray:
    """
    Detect thin, low-contrast ink strokes — specifically the kind of 1-3px
    dividing line that separates two adjacent, similarly-bright speech
    bubbles — using LOCAL adaptive thresholding rather than the page-wide
    flatness filter _find_bubble_components otherwise relies on.

    WHY THIS EXISTS (see KNOWN_ISSUES_DRAFT.md, "Confirmed, blocking:
    _merge_bubble_regions over-merges adjacent bubbles on RapidOCR's
    fragment output" for the full real-page writeup this fixes):
    _find_bubble_components' flatness test box-filters squared Laplacian
    over a 9x9 window before thresholding. That's deliberately coarse —
    cheap, page-wide, tuned for "is this whole area bubble fill" — but a
    thin, faint dividing line gets diluted by that averaging: the window
    mostly sees flat white fill on both sides of the line, so the averaged
    variance can land under _BUBBLE_FLATNESS_THRESHOLD even directly on
    top of the line itself. That silently bridges what should be two
    separate flat-light components into one — confirmed on Brazil_raw.jpg,
    where two bubbles fused into a single connected component despite a
    real ink line between them (closest measured real-pixel gap: 1.0px).
    Splitting the merge MARGIN (HORIZONTAL_GAP_FACTOR, in
    _merge_bubble_regions) was tried first and proven mathematically
    unable to fix this: the real illegitimate gap on that page (1px) is
    tighter than the real legitimate gap a same-bubble merge needs
    (5px), so no geometric threshold can separate the two cases. This
    function targets the actual root cause instead — the SEGMENTATION
    missing the line — rather than trying to compensate for it downstream.

    Adaptive thresholding asks a different question than the flatness
    filter: not "how much does intensity vary in a neighbourhood" but "is
    this pixel darker than its OWN local neighbourhood's mean" — which is
    exactly what an ink line is, no matter how faint, as long as it's
    genuinely darker than the paper immediately around it. This is a
    deliberately separate, more sensitive signal, used only to carve
    barriers into the flatness mask — never to replace it (large areas of
    genuine texture/screentone would trip adaptive thresholding constantly
    and are already correctly excluded by the flatness+lightness test).

    Returns a uint8 0/255 mask, same shape as `gray`: 255 = "this pixel
    sits on a locally-dark line/stroke and should never be treated as
    bubble-fill, regardless of what the flatness filter says." The mask is
    dilated by 1px so the barrier is topologically solid against
    8-connected flood fill — a bare 1-pixel-wide diagonal chain can still
    leak through 8-connectivity at the corners; dilating closes that gap
    and also bridges small anti-aliasing breaks along the line.

    UNVALIDATED STARTING VALUES (block_size=15, C=7) — same caveat as
    every other threshold in this file: chosen to react to a 1-3px line's
    own local contrast without being swamped by a whole bubble's-worth of
    surrounding white, and tested against synthetic data reproducing the
    reported line thinness/faintness (see test_bubble_outline_tracing.py),
    not yet checked against the real Brazil_raw.jpg page.
    """
    if gray.size == 0:
        return np.zeros(gray.shape, dtype=np.uint8)

    block_size = 15  # must be odd; local neighbourhood adaptiveThreshold compares each pixel against
    C          = 7   # subtracted from the local mean; small positive value so flat paper / scan noise isn't flagged as "line"

    outline = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        block_size, C,
    )

    # Close small anti-aliasing gaps along the line and guarantee the
    # barrier is solid against 8-connectivity flood fill (see docstring).
    kernel  = np.ones((3, 3), np.uint8)
    outline = cv2.dilate(outline, kernel, iterations=1)
    return outline


def _find_bubble_components(gray: np.ndarray, img_w: int, img_h: int):
    """
    Segment the page into connected components of flat, light regions —
    the same "flat bubble fill" signal _region_texture_variance samples
    locally, applied once, page-wide, as a full segmentation.

    Returns a label map: a 2-D int32 array the same shape as `gray`, where
    label_map[y, x] is the connected-component id at that pixel (0 = not
    flat/light — i.e. background art, screentone, text ink itself, or a
    detected bubble-outline stroke — see _bubble_outline_mask), or None if
    the page is too small/degenerate to segment usefully.

    Deliberately conservative about what counts as "flat": a small
    Laplacian-variance box filter, thresholded well below
    _TEXTURE_VARIANCE_THRESHOLD (which was calibrated for "flat enough to
    skip inpainting" — a looser bar than we want here, since we need
    actual bubble-interior flatness, not merely "flatter than screentone").
    A pixel also has to be light (bubble fills are white/near-white in the
    overwhelming majority of cases) to count, which is what keeps large
    flat DARK areas (e.g. a night-sky panel background, a black gutter)
    from being treated as one giant bubble blob alongside real bubbles.

    OUTLINE CARVING (see _bubble_outline_mask docstring for the full
    real-page bug this addresses): the flatness+lightness mask above is,
    on its own, blind to thin/faint dividing lines between two adjacent
    bubbles — averaging smooths them away. Before connected-components
    runs, pixels flagged by _bubble_outline_mask's more sensitive, purely
    local adaptive-threshold check are explicitly excluded from the
    candidate mask, regardless of what the flatness test alone would have
    said. This carves a real topological gap into the mask wherever a
    detectable ink line exists, so connectedComponents naturally reports
    two separate labels for two bubbles divided by a line too thin/faint
    for the flatness filter to see on its own — without needing the
    flatness thresholds themselves to be re-tuned per page.
    """
    if gray.size == 0 or img_w < 8 or img_h < 8:
        return None

    # Local flatness: box-filtered Laplacian variance, computed once for
    # the whole page (cheap — a single filter pass, not per-fragment).
    lap        = cv2.Laplacian(gray, cv2.CV_64F)
    lap_sq     = lap * lap
    local_var  = cv2.boxFilter(lap_sq, ddepth=-1, ksize=(9, 9))

    # Deliberately stricter than _TEXTURE_VARIANCE_THRESHOLD (120.0) — that
    # constant answers "flat enough to flood-fill instead of inpaint",
    # which tolerates more texture than we want here. This threshold is
    # UNVALIDATED — needs checking against a real page (see STATUS above)
    # rather than assumed correct by analogy to the inpainting constant.
    _BUBBLE_FLATNESS_THRESHOLD = 40.0
    _BUBBLE_LIGHTNESS_FLOOR    = 200  # 0-255; bubble fill treated as "light"

    flat_mask  = (local_var < _BUBBLE_FLATNESS_THRESHOLD)
    light_mask = (gray > _BUBBLE_LIGHTNESS_FLOOR)
    bubble_candidate = (flat_mask & light_mask).astype(np.uint8)

    # NEW — carve out thin/faint ink-outline barriers the coarse flatness
    # filter smooths over. See _bubble_outline_mask docstring and
    # KNOWN_ISSUES_DRAFT.md's "Confirmed, blocking" entry for the real
    # page this targets. Applied unconditionally (not opt-in) since this
    # can only ever REMOVE candidate pixels — it narrows components, it
    # can never merge two that the flatness test alone would have kept
    # separate, so there's no new failure mode symmetric to the one this
    # fixes.
    outline_mask = _bubble_outline_mask(gray)
    bubble_candidate[outline_mask > 0] = 0

    # Connected components on the flat+light mask. 8-connectivity so a
    # bubble whose fill has a few stray antialiased pixels doesn't
    # fragment into multiple components at its own edges.
    num_labels, label_map = cv2.connectedComponents(bubble_candidate, connectivity=8)
    if num_labels <= 1:
        # Nothing on the page was flat+light enough to form a component —
        # degenerate page (e.g. all-screentone, no bubbles) or the
        # thresholds above are wrong for this page's contrast/exposure.
        return None
    return label_map


def _crosses_bubble_boundary(
    box_a: tuple, box_b: tuple,
    label_map,
) -> bool:
    """
    Return True if a direct path from box_a to box_b passes through two
    DIFFERENT flat-light components (per _find_bubble_components) —
    meaning a merge between them should be refused regardless of pixel
    distance, because they belong to different bubbles.

    CORRECTED VERSION — see inline note at the bottom of this docstring
    for what was wrong with the first attempt and why; this replaces it,
    not just tunes it.

    Approach: sample a short line of points between box_a's center and
    box_b's center (not each box's own interior — see below for why), and
    look at which flat-light component each sampled point falls in.
    Points that don't land on a flat-light pixel at all (label 0 — could
    be gap background, ink, or genuine non-bubble art) are skipped, not
    treated as a bail-out signal; we only need a *few* informative points
    along the path to get a confident read on "which bubble(s) does this
    path pass through", since a path between two word-fragments crosses
    much more open bubble-fill than either fragment's own tightly-cropped
    box does.

    If the informative points along the path resolve to a SINGLE
    component throughout → same bubble → merge allowed (returns False).
    If they resolve to two or more DIFFERENT components → path leaves one
    bubble and enters another → merge refused (returns True). If there
    aren't enough informative points to say anything (e.g. the whole gap
    is dark background with no flat-light pixels at all — ambiguous, or a
    literal same-pixel/zero-length gap) → inconclusive → returns False,
    matching "no bubble-boundary signal available, fall back to today's
    pixel-distance-only behaviour" — same conservative default as before,
    just reached without the flaw described below.

    label_map is None if _find_bubble_components couldn't segment the
    page — always returns False in that case.

    WHAT WAS WRONG WITH THE FIRST VERSION, for the record: it looked at
    each box's OWN interior and required a clear majority (>=60%) of that
    interior to land in one component, treating anything less — including
    "zero flat-light pixels found at all" — as inconclusive. That sounds
    conservative, but it silently made the veto never fire in practice:
    an OCR box is snugly cropped around actual glyphs, so a realistic box
    is dominated by dark ink strokes, not the surrounding flat-white
    bubble fill. Tested against a synthetic box with just 40% ink
    coverage (a modest, realistic figure — nowhere near an extreme case),
    BOTH boxes came back with zero flat-light pixels detected at all,
    so the function bailed out to "don't block" every time — which
    matches the real-world symptom: this veto was live in the merge loop
    across several confirmed two-bubble-merge cases (ch4/NAMORADO/
    OPORTUNIDADE pages) and none of them were caught. Sampling the PATH
    BETWEEN the boxes instead of each box's own cramped interior fixes
    this, because that path passes through the actual open bubble-fill
    around each fragment (which is flat-light), not just the ink-dense
    text itself.
    """
    if label_map is None:
        return False

    h, w = label_map.shape

    def _center(box):
        x1, y1, x2, y2 = box
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    def _sample(px: float, py: float, radius: int = 3):
        """Look at a small neighbourhood around (px, py) rather than a
        single pixel, and return the most common non-zero label there (or
        None if the whole neighbourhood is label 0 / off-image). A small
        neighbourhood is far more likely to catch a flat-light pixel near
        a sampled point than the exact single pixel would, without being
        so large it blurs across a real nearby boundary."""
        ix, iy = int(round(px)), int(round(py))
        x1, y1 = max(0, ix - radius), max(0, iy - radius)
        x2, y2 = min(w, ix + radius + 1), min(h, iy + radius + 1)
        if x2 <= x1 or y2 <= y1:
            return None
        patch = label_map[y1:y2, x1:x2]
        nonzero = patch[patch > 0]
        if nonzero.size == 0:
            return None
        vals, counts = np.unique(nonzero, return_counts=True)
        return int(vals[np.argmax(counts)])

    ax, ay = _center(box_a)
    bx, by = _center(box_b)

    # Sample points along the straight line between the two centers,
    # INCLUDING the endpoints — a fragment's own center often already
    # sits in its bubble's flat fill just outside the densest ink, even
    # though the fragment's full bounding box (checked in the old,
    # replaced version) does not.
    n_samples = 9
    components_seen = []
    for k in range(n_samples):
        t = k / (n_samples - 1)
        px = ax + t * (bx - ax)
        py = ay + t * (by - ay)
        comp = _sample(px, py)
        if comp is not None:
            components_seen.append(comp)

    distinct = set(components_seen)
    if len(distinct) < 2:
        # Either everything informative along the path agreed on one
        # component (same bubble), or nothing informative was found at
        # all (ambiguous) — either way, don't block the merge.
        return False
    return True


# ─── Fused double-bubble ("waist") detection ──────────────────────────────────
#
# WHY THIS EXISTS — the case _crosses_bubble_boundary structurally cannot
# catch, confirmed against the real Brazil_raw.jpg page:
#
# _crosses_bubble_boundary answers "are these two fragments in DIFFERENT
# flat-light components". That's the right question when two adjacent
# bubbles are genuinely separated by *something* — an ink outline, panel
# background, anything that breaks the flat-light mask between them. It is
# useless when they aren't, and on real manga pages they frequently aren't:
# a very common art convention draws two adjacent speech bubbles as ONE
# fused silhouette — a single continuous outer contour pinched into a
# figure-8/peanut shape, with NO internal dividing wall at all. Verified
# directly on Brazil_raw.jpg: the pixels between the two bubbles' text are
# pure 255 white, no ink of any kind, and rendering the label map confirms
# both bubbles are one single connected component wall to wall.
#
# Two prior fix attempts failed on exactly this, and both failed for
# reasons that generalize — worth recording so neither gets retried:
#   1. Margin tuning (HORIZONTAL_GAP_FACTOR, in _merge_bubble_regions):
#      mathematically cannot work here. On this page the real gap between
#      DIFFERENT bubbles' fragments (1px) is TIGHTER than the real gap a
#      legitimate SAME-bubble merge must preserve (5px, staggered
#      lettering). No geometric distance threshold separates 1 < 5.
#   2. Ink-line detection (_bubble_outline_mask, adaptive thresholding):
#      cannot work here either. It finds faint/thin lines that exist; on
#      this shape there is no line to find. (That code is retained — it's
#      confirmed harmless and targets a different, real failure mode — but
#      it is inert on fused bubbles.)
#
# WHAT ACTUALLY SEPARATES THE TWO CASES: shape, not distance and not ink.
# A fused double-bubble has a genuine geometric CONSTRICTION (a "waist")
# between its two lobes — that's what makes it read as two bubbles to a
# human eye despite having one outline. A single bubble containing two
# columns of text (the legitimate "staggered lettering" pattern this must
# NOT break) has no such constriction: it's one convex-ish blob whose
# width profile varies smoothly.
#
# Measured on the real page, per-column vertical extent of the component:
#   fused double-bubble : 183px (left lobe) → 136px (waist) → 183px (right
#                         lobe)                        → ratio 0.74
#   five genuine single bubbles on the SAME page       → ratios 1.00-1.05
#                         (i.e. no interior local minimum at all)
# That is a clean, well-separated signal, not a marginal one.
#
# DELIBERATELY NARROW SCOPE — this is a veto that can only ever *prevent*
# merges, so a false positive splits a bubble that should have stayed
# whole, which is exactly the regression risk the whole file worries
# about. Three constraints keep the blast radius small:
#   - Only consulted for pairs already in the SAME component (different
#     components are _crosses_bubble_boundary's job, and it handles them).
#   - Only for PREDOMINANTLY HORIZONTAL pairs (|dx| > |dy|). Side-by-side
#     is the confirmed real-world case. The vertical analogue (two bubbles
#     stacked into a vertical figure-8) is deliberately NOT enabled: the
#     vertical direction is the hot path — every ordinary line-to-line
#     pair inside every normal bubble is vertically separated — so a false
#     positive there would shatter ordinary multi-line dialogue, and there
#     is no confirmed real page to validate a threshold against. Do not
#     enable it without one.
#   - The constriction is measured strictly BETWEEN the two fragments' own
#     x-centers, not "anywhere in the component" — a waist somewhere else
#     in the blob says nothing about whether THESE two fragments are in
#     different lobes.

# Ratio of (narrowest extent between the two fragments) to (the narrower
# of the two fragments' own local extents) below which the shape is
# treated as genuinely pinched. Measured separation on real pages:
# 0.74 for the confirmed fused double-bubble vs 1.00-1.05 for confirmed
# single bubbles, so this sits well clear of both. UNVALIDATED beyond the
# pages in eval_samples/ — same caveat as every other constant here.
_WAIST_RATIO_THRESHOLD = 0.85

# Below this many pixels between the two x-centers there aren't enough
# columns to read a profile from, and any "minimum" is noise.
_WAIST_MIN_SPAN_PX = 12


def _component_column_extents(label_map, comp_label: int, cache: dict):
    """
    Per-column vertical EXTENT (bottom-most minus top-most mask pixel) of
    one connected component, plus the x offset the array starts at.

    Extent, not pixel count, is the point: a bubble's interior is riddled
    with text-shaped holes (glyphs are dark, so they're excluded from the
    flat-light mask), which makes a raw per-column pixel COUNT track how
    much text is in that column rather than how tall the bubble is there.
    Extent measures the outer silhouette and ignores interior holes
    entirely, which is what "how pinched is the shape here" needs.

    Cached per component — the merge loop is O(n^2) over fragment pairs
    and many pairs share a component, so this is computed at most once per
    component per _merge_bubble_regions call.
    """
    if comp_label in cache:
        return cache[comp_label]
    blob = (label_map == comp_label)
    cols = np.where(blob.any(axis=0))[0]
    if cols.size == 0:
        cache[comp_label] = (None, 0)
        return cache[comp_label]
    x1, x2 = int(cols.min()), int(cols.max())
    sub = blob[:, x1:x2 + 1]
    any_col = sub.any(axis=0)
    first   = np.argmax(sub, axis=0)
    last    = sub.shape[0] - 1 - np.argmax(sub[::-1], axis=0)
    ext = np.where(any_col, last - first + 1, 0).astype(np.float64)
    cache[comp_label] = (ext, x1)
    return cache[comp_label]


def _dominant_component_for_box(label_map, box: tuple, pad: int = 14) -> int:
    """
    Which flat-light component does this OCR fragment sit in?

    Sampled from the box PADDED OUTWARD, not the box itself: an OCR box is
    cropped snugly around glyphs, so its interior is mostly dark ink —
    which is label 0 (excluded from the mask) — and sampling it directly
    returns "no component" for a fragment that's plainly inside a bubble.
    This is the same trap documented in _crosses_bubble_boundary's
    docstring, which is why that function samples the path BETWEEN boxes
    rather than either box's interior. Padding outward reaches the open
    bubble fill immediately around the text. Returns 0 if nothing.
    """
    h, w = label_map.shape
    x1 = max(0, int(box[0]) - pad); y1 = max(0, int(box[1]) - pad)
    x2 = min(w, int(box[2]) + pad); y2 = min(h, int(box[3]) + pad)
    if x2 <= x1 or y2 <= y1:
        return 0
    patch = label_map[y1:y2, x1:x2]
    nz = patch[patch > 0]
    if nz.size == 0:
        return 0
    vals, counts = np.unique(nz, return_counts=True)
    return int(vals[np.argmax(counts)])


def _bubble_territory_map(label_map):
    """
    Turn the bubble-fill map into a bubble-TERRITORY map by filling each
    component's interior holes.

    A bubble's letters are dark, so _find_bubble_components excludes them and
    they come out as holes punched in that bubble's light region. That makes
    the raw map answer "is this pixel bubble FILL", when the question the
    merge vetoes actually need answered is "is this pixel INSIDE a bubble" —
    and a pixel on a letter is inside one. Filling the holes makes the two the
    same question.

    Measured on eval_samples/caption_welds_to_bubble.jpg, this is the
    difference between an unusable signal and a binary one. Against the raw
    map, "how enclosed is this fragment" scores 0-14% for free-floating
    caption text and 8-71% for text inside a bubble — overlapping, so no
    threshold separates them, because a fragment in the middle of a bubble is
    ringed by its neighbouring LETTERS rather than by fill. Against the filled
    map the same measurement is 0-2% versus 100% on every fragment of both
    kinds.

    Holes are found by flood-filling the background inward from the page
    border: any background not reachable from outside is enclosed by
    something. Labels are then re-derived on the filled mask, so each
    territory carries one label — these are NOT the same label values as
    label_map's, and nothing should assume they are.
    """
    if label_map is None:
        return None
    mask = (label_map > 0).astype(np.uint8)
    h, w = mask.shape
    outside = mask.copy()
    ff_mask = np.zeros((h + 2, w + 2), np.uint8)
    # Seed at (0,0). The page corner is background on every real scan; if it
    # somehow is not, the seed fills nothing and holes stays empty, which
    # degrades to the raw mask rather than to a wrong answer.
    cv2.floodFill(outside, ff_mask, (0, 0), 2)
    holes = (outside == 0)
    filled = (mask.astype(bool) | holes).astype(np.uint8)
    n, out = cv2.connectedComponents(filled, connectivity=8)
    return out


def _box_container(territory, box: tuple):
    """
    (label, coverage) for the bubble territory this fragment sits in.

    Read from the box's OWN interior, not a padded ring — which is the whole
    point of using the filled map. Padding outward was what leaked across a
    2px gap into a neighbouring bubble; a filled territory needs no padding
    because the fragment's own pixels are already inside it.

    label 0 with coverage 0 means the fragment is on artwork, outside every
    bubble. That is a real position, not missing information.
    """
    if territory is None:
        return 0, 0.0
    h, w = territory.shape
    x1 = max(0, int(box[0])); y1 = max(0, int(box[1]))
    x2 = min(w, int(box[2])); y2 = min(h, int(box[3]))
    if x2 <= x1 or y2 <= y1:
        return 0, 0.0
    patch = territory[y1:y2, x1:x2]
    counts = np.bincount(patch.ravel(), minlength=int(territory.max()) + 1)
    counts[0] = 0
    if counts.max() == 0:
        return 0, 0.0
    return int(counts.argmax()), float(counts.max()) / patch.size


# Two thresholds with a DEAD BAND between them, not one cutoff. Confidently
# inside a bubble is >= _CONTAINER_INSIDE; confidently outside every bubble is
# <= _CONTAINER_OUTSIDE; anything between is ambiguous and this veto abstains.
#
# The single-cutoff version got this wrong and the suite caught it. A fragment
# STRADDLING a bubble's edge — synthetic staggered-lettering pair in
# test_bubble_outline_tracing.py, 47% inside — fell on the outside of one
# cutoff and its same-bubble neighbour on the inside, so a legitimate pair was
# refused and one bubble's line was cut in half. A wrongly refused merge is
# worse than the over-merge this exists to prevent, so the middle abstains.
#
# The real measurement it was derived from is strongly bimodal (0-2% for
# free-floating caption text, 100% for text in a bubble, on every fragment of
# both kinds), so the band is wide and neither number is finely tuned.
_CONTAINER_INSIDE = 0.6
_CONTAINER_OUTSIDE = 0.15


def _different_containers_separate_boxes(box_a: tuple, box_b: tuple, territory) -> bool:
    """
    Refuse a merge between text in a bubble and text outside it — or between
    text in two different bubbles.

    THE CASE THIS EXISTS FOR (real page, RapidOCR at default sensitivity): a
    narration caption drawn over artwork sat 2px from a speech bubble, and the
    two were merged into one region with their sentences interleaved line by
    line. Every other defence is structurally unable to see it: 2px is below
    the 4px minimum margin so no sensitivity separates them; the gap measures
    0 units at detect_column_split's resolution so there is no river; both
    blocks read "light" so polarity cannot tell them apart.

    _crosses_bubble_boundary cannot see it either, for a subtler reason worth
    keeping. It samples the path between the two boxes and refuses only when
    it sees two DIFFERENT components. On this pair the path reads
    [0,0,0,0,70,70,0,0,0] — one component, so no refusal. It cannot use those
    zeros, because label 0 is overloaded: it means both "artwork, outside
    every bubble" AND "inside a bubble, on a letter". Measured on the same
    page, the path between two fragments of the SAME bubble reads all zeros
    too. Zeros are genuinely uninformative there.

    Filling the holes is what disambiguates them (see _bubble_territory_map),
    and that turns "outside every bubble" into a position this can act on.
    """
    if territory is None:
        return False
    label_a, cov_a = _box_container(territory, box_a)
    label_b, cov_b = _box_container(territory, box_b)

    in_a = label_a > 0 and cov_a >= _CONTAINER_INSIDE
    in_b = label_b > 0 and cov_b >= _CONTAINER_INSIDE
    # "Outside" is about coverage, not about the label. A fragment on artwork
    # can still report a neighbouring bubble's label from the handful of its
    # pixels that clip that bubble — on the page this was built against, the
    # caption fragment nearest the bubble reports the bubble's own label at
    # 1.7% coverage. Deciding on the label alone would read it as a member.
    out_a = cov_a <= _CONTAINER_OUTSIDE
    out_b = cov_b <= _CONTAINER_OUTSIDE

    if in_a and in_b:
        return label_a != label_b          # both in bubbles, different ones
    if (in_a and out_b) or (in_b and out_a):
        return True                        # one in a bubble, one on artwork
    return False                           # ambiguous — leave it to the others


def _waist_separates_boxes(box_a: tuple, box_b: tuple, label_map, cache: dict) -> bool:
    """
    Return True if box_a and box_b sit in two different LOBES of one fused
    double-bubble — i.e. the component they share is visibly pinched
    between them — meaning the merge should be refused even though
    _crosses_bubble_boundary (correctly) reports them as one component.

    See the section comment above for why this exists, what it's measured
    against, and why it's scoped to horizontal pairs only. Returns False
    for anything it can't confidently measure — this is a veto layered on
    top of existing behaviour, so "not sure" must mean "don't block",
    matching every other conservative default in this file.
    """
    if label_map is None:
        return False

    acx = (int(box_a[0]) + int(box_a[2])) // 2
    acy = (int(box_a[1]) + int(box_a[3])) // 2
    bcx = (int(box_b[0]) + int(box_b[2])) // 2
    bcy = (int(box_b[1]) + int(box_b[3])) // 2

    # Horizontal pairs only — see section comment ("DELIBERATELY NARROW
    # SCOPE"). Vertically-separated pairs are the ordinary line-to-line
    # case and must not be touched.
    if abs(bcx - acx) <= abs(bcy - acy):
        return False
    if abs(bcx - acx) < _WAIST_MIN_SPAN_PX:
        return False

    la = _dominant_component_for_box(label_map, box_a)
    lb = _dominant_component_for_box(label_map, box_b)
    # Different components (or none) → not this function's case;
    # _crosses_bubble_boundary already decides those.
    if la == 0 or la != lb:
        return False

    ext, off = _component_column_extents(label_map, la, cache)
    if ext is None:
        return False

    i_a, i_b = sorted((acx - off, bcx - off))
    i_a = max(0, i_a)
    i_b = min(len(ext) - 1, i_b)
    if i_b - i_a < _WAIST_MIN_SPAN_PX:
        return False

    span = ext[i_a:i_b + 1]
    waist = float(span.min())
    # Compare against the narrower of the two fragments' OWN local extents,
    # not the component's global maximum: a lobe that is legitimately
    # smaller than its neighbour shouldn't read as "pinched" just for being
    # small, and a tall unrelated part of the same component elsewhere
    # shouldn't set the bar either.
    ends = min(float(ext[i_a]), float(ext[i_b]))
    if ends <= 0:
        return False
    return (waist / ends) <= _WAIST_RATIO_THRESHOLD
