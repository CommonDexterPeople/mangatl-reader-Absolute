"""
mtl/merge.py - grouping OCR fragment boxes into speech-bubble regions.

This is the decomposed form of what used to be one 739-line
_merge_bubble_regions() in server.py. The algorithm is unchanged; what
changed is that each stage is now a module-level function taking explicit
arguments instead of a closure over the enclosing call's locals, so the
regression tests can call any single stage directly rather than driving the
whole pipeline and inferring which stage misbehaved.

The stages, in the order _merge_bubble_regions runs them:

    compute_merge_margins        how far each box reaches, per axis
    expand_box / boxes_overlap   which pairs are even merge CANDIDATES
    pair_is_vetoed               whether a candidate pair is refused, via
      structural_veto              panel border / bubble component / waist
      gap_profile_veto             real ink in the gap between the two
    group_fragment_boxes         union-find over the surviving pairs
    filter_groups_by_confidence  optional low-confidence fragment drop
    order_fragments              reading order within a group, via
      detect_column_split          two side-by-side columns?
      line_cluster                 group into visual lines, read L-to-R
    assemble_region              fragments -> one {text, cx, cy, box, ...}

Every veto primitive consulted here lives in mtl/geometry.py. server.py
re-exports _merge_bubble_regions and each stage above, so existing callers
and tests that import them from server keep working unchanged.
"""

from mtl.geometry import (
    _bubble_territory_map,
    _crosses_border,
    _crosses_bubble_boundary,
    _different_containers_separate_boxes,
    _waist_separates_boxes,
)


# -- Calibration constants ---------------------------------------------------

# Calibration constant — NOT the user-facing slider. Chosen so that two
# adjacent same-bubble lines (combined margin = 2 x own_margin) reliably
# bridge a ~1.5x-box-height gap, which real EasyOCR output on manga-style
# bubbles showed is normal line spacing, not an outlier.
LINE_GAP_FACTOR = 1.6

# NEW — separate, tighter calibration for HORIZONTAL reach. See
# KNOWN_ISSUES_DRAFT.md, "Confirmed, blocking: _merge_bubble_regions
# over-merges adjacent bubbles on RapidOCR's fragment output" for the
# real-page bug this addresses.
#
# Until now, horizontal and vertical reach shared one LINE_GAP_FACTOR-
# derived margin. That's correct for genuine same-bubble LINE-to-LINE
# (vertical) gaps — what LINE_GAP_FACTOR was tuned against — but the
# only legitimate reason this function ever needs to bridge a HORIZONTAL
# gap is the "staggered lettering" pattern (two sub-columns of one
# sentence zigzagging down a single narrow bubble — see the stacked-pair
# comment below), and that pattern's real horizontal gap is tight
# same-bubble spacing, nothing like a full line-height. Reusing the
# line-spacing constant for horizontal reach meant it could ALSO bridge
# the real physical gap between two separate, adjacent bubbles —
# bubble-fill padding + border ink + the other bubble's own padding —
# which is exactly the confirmed RapidOCR bug. RapidOCR's smaller, more
# numerous fragments made this likelier to get hit in practice (more
# fragment pairs land near the boundary), but the underlying issue — one
# factor doing two jobs with different real-world scales — isn't
# engine-specific, so this fix applies to both engines' margins alike.
#
# NOTE: this is deliberately a GEOMETRIC fix, not a pixel-content one.
# The obvious first idea — reuse profile_confirms_gap's ink-valley
# technique for horizontal gaps the way it already works for vertical
# ones — does NOT work here: a clean whitespace gap looks pixel-
# identical whether it's a normal word-space INSIDE one bubble or page/
# panel background BETWEEN two different adjacent bubbles. Ink density
# can't tell those apart; only the gap's SIZE relative to normal
# same-bubble spacing can, which is what this constant controls.
#
# MEASURED, 2026-08-19, against 15 real pages on BOTH engines (was an
# unvalidated 0.5). Lowered to 0.3 because 0.5 was over-merging pairs of
# ADJACENT TEXT CONTAINERS across a clean whitespace gutter — the exact
# failure this constant was introduced to prevent, at a value too loose
# to actually prevent it.
#
# Three distinct real-page cases, all fixed by 0.3, all previously
# producing a single region with the two containers' lines interleaved:
#   manga page test_Untranslated.jpg  two side-by-side caption boxes
#                                     ("Y ENCIMA, EN EL CAPÍTULO…" /
#                                     "¿Y EN ESE MOMENTO…") — hit on BOTH
#                                     engines, not RapidOCR-specific.
#   Manga page test 2_Untranslated.jpg + its translated twin
#                                     two adjacent speech bubbles.
#   Brazil_raw.jpg                    "HUH?" bubble absorbed into the
#                                     neighbouring "…CHEGAMOS" bubble —
#                                     a second over-merge on the page the
#                                     waist veto was verified against,
#                                     which that verification missed
#                                     because it only checked the two
#                                     bubbles the waist fix targeted.
#
# Why the existing vetoes can't catch these: the caption boxes are ONE
# flat-light component (the gutter is pure 255 white — measured — so
# there is no ink for _crosses_bubble_boundary or the outline carving to
# find), and they are RECTANGLES, so the silhouette has no constriction
# for _waist_separates_boxes to measure (extent across the gutter runs
# 348→355→363→372→379px — monotonic, waist ratio 0.948 vs the 0.85
# threshold). Shape and ink signals are both structurally absent here;
# gap SIZE is the only thing left, which is precisely what this constant
# controls.
#
# Sweep evidence (0.5 → 0.05, merge re-run over cached OCR fragments so
# only this constant varied): every single change at every value was a
# SPLIT that inspection confirmed correct, on both engines — no page ever
# lost a region or had a line broken in half. 0.3 is the loosest value
# that fixes all three cases (RapidOCR needs ≤0.35, EasyOCR ≤0.30).
#
# STILL UNVALIDATED: the staggered/zigzag-lettering case this constant
# exists to protect. None of the 15 sample pages contains a bubble whose
# OCR fragmentsneeds horizontal merging, which is also why every reduction
# looked free. If a page shows legitimate side-by-side fragments failing
# to merge, THAT is the case to re-measure against — not this one.
HORIZONTAL_GAP_FACTOR = 0.3

# Absolute ink/background thresholds — same convention as
# _find_panel_borders' cv2.threshold(gray, 50, ...): ink on a manga
# page is genuinely dark in absolute terms, not merely "darker than
# whatever this specific crop's own local noise floor happens to be".
# A THRESHOLD DERIVED FROM THE BAND'S OWN min/max (tried first, during
# development of this function) is unstable: a band of pure paper-grain
# noise with no real ink at all still spans a normal pixel range, and a
# midpoint- or percentile-based threshold splits that noise ~50/50,
# which reads as "every row is half-ink" — silently vetoing merges on
# perfectly ordinary blank gaps. An absolute threshold anchored to real
# page brightness conventions doesn't have this failure mode.
_GAP_INK_ABS_THRESH  = 100   # 0-255; darker than this counts as "ink" (normal polarity)
_GAP_BG_ABS_THRESH   = 155   # lighter than this counts as "ink" when polarity is inverted

# Degenerate zero/near-zero height boxes (stray noise) still get a usable
# reach rather than a margin of 0px.
_MIN_MARGIN_PX = 4

# Webtoon strips are tall and narrow; their panels stack vertically with
# gaps a normal page's margins would happily bridge.
_WEBTOON_ASPECT = 2.0
_WEBTOON_MARGIN_SCALE = 0.6


# -- Stage 1: how far each box reaches ---------------------------------------

def compute_merge_margins(boxes, img_w: int, img_h: int, margin_scale: float = 0.5):
    """
    Per-box merge reach, as two parallel lists (margins_v, margins_h) with
    one entry per box in `boxes`.

    Split out of _merge_bubble_regions so the margin math can be checked
    against a box list directly - it is the stage that decides which pairs
    are even considered for merging, so an error here is invisible in the
    final regions except as a mysteriously missing or over-eager merge.

    See LINE_GAP_FACTOR / HORIZONTAL_GAP_FACTOR above for why the two axes
    use different calibration, and _merge_bubble_regions' docstring for the
    per-box (rather than page-wide-median) rationale.
    """
    is_webtoon  = (img_h / max(img_w, 1)) > _WEBTOON_ASPECT
    webtoon_k   = _WEBTOON_MARGIN_SCALE if is_webtoon else 1.0
    eff_scale_v = margin_scale * LINE_GAP_FACTOR       * webtoon_k
    eff_scale_h = margin_scale * HORIZONTAL_GAP_FACTOR * webtoon_k

    # Per-box margin: each box reaches only as far as its OWN height implies,
    # rather than every box on the page sharing one page-wide median-derived
    # value. See docstring above for why this matters. Split into vertical/
    # horizontal components (NEW) so the two directions use their own
    # calibration; both still scale off the box's own HEIGHT in either case
    # (not width) since height is what tracks font size / line spacing
    # regardless of which direction reach is being measured in.
    margins_v = [max(_MIN_MARGIN_PX, int((boxes[i][3] - boxes[i][1]) * eff_scale_v))
                 for i in range(len(boxes))]
    margins_h = [max(_MIN_MARGIN_PX, int((boxes[i][3] - boxes[i][1]) * eff_scale_h))
                 for i in range(len(boxes))]
    return margins_v, margins_h


def expand_box(box, margin_v: int, margin_h: int) -> tuple:
    """
    A box grown by its own per-axis margin - the rect used for candidate
    overlap testing, never for output geometry.
    """
    x1, y1, x2, y2 = box[0], box[1], box[2], box[3]
    return (x1 - margin_h, y1 - margin_v, x2 + margin_h, y2 + margin_v)


def boxes_overlap(a: tuple, b: tuple) -> bool:
    """True if two (x1, y1, x2, y2) rects touch or intersect."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    return ax1 <= bx2 and bx1 <= ax2 and ay1 <= by2 and by1 <= ay2


# -- Stage 2: the vetoes -----------------------------------------------------

def profile_confirms_gap(gray, gap_box: tuple,
                         frag_a_box: tuple, frag_b_box: tuple) -> bool | None:
    """
    Look at the actual ink in the page image between two candidate
    same-bubble fragments and decide whether a real whitespace valley
    separates them — a horizontal projection profile of the gap band,
    not a box-distance heuristic.

    This exists to replace a single global LINE_GAP_FACTOR (which
    assumes one "normal" leading for every manga on every page) with a
    per-gap, ground-truth check: does this SPECIFIC gap actually look
    like the space between two lines of text, or is it dense enough
    that it's more likely still inside one run of text (e.g. a
    descender/ascender-heavy font, or two fragments of the same word
    broken by OCR) — or bridged by something that isn't either
    fragment's text at all (a stray mark, a panel-border sliver,
    unrelated art between two DIFFERENT bubbles).

    gap_box is the (x1,y1,x2,y2) band strictly between the two
    fragments; frag_a_box/frag_b_box are the two ORIGINAL fragment
    boxes themselves, used ONLY to sample polarity (see below) — never
    for geometry.

    THREE THINGS THIS GOT WRONG DURING DEVELOPMENT, kept here because
    each is a real trap worth not re-falling into:

    1. A threshold derived from the gap band's OWN min/max (tried
       first) is unstable: a band of pure paper-grain noise with no
       real ink at all still spans a normal pixel range, and a
       midpoint- or percentile-based threshold splits that noise
       ~50/50 — reading as "every row is half-ink" and vetoing merges
       on perfectly ordinary blank gaps. Fixed by using a fixed
       ABSOLUTE ink threshold instead (same convention as
       _find_panel_borders' cv2.threshold(gray, 50, ...) — ink on a
       manga page is genuinely dark/light in absolute terms).

    2. Inferring polarity from the GAP BAND's own mean brightness
       (tried second) conflates "this band is mostly dark because it's
       mostly ink" with "this band has an inverted dark background" —
       a densely-inked bridge (the exact case that should veto a
       merge) has a low mean for the same reason an inverted-fill
       bubble does, so it got misread as inverted polarity and the
       dense ink was treated as background. Fixed by sampling polarity
       from the FRAGMENT INTERIORS instead (frag_a_box/frag_b_box) —
       we already know those contain real text, so their own bulk
       brightness reveals the bubble's true fill/ink direction without
       depending on how much ink happens to be in THIS gap, which is
       exactly the unknown being measured.

    3. Picking "whichever polarity produces fewer ink pixels" (tried
       third, as a fix for #2) fails for the identical reason #2 did:
       on a densely-inked bridge, the WRONG (inverted) polarity
       produces fewer flagged pixels almost by construction, so
       minority-class selection actively prefers the wrong reading
       exactly when the right answer is "mostly ink, veto".

    4. Even with correct polarity, a single full-width ink band in the
       MIDDLE of an otherwise-clean gap (e.g. a stray screentone fleck,
       a thin panel-border sliver that slipped past _find_panel_borders,
       or real art between two unrelated bubbles) can leave a valley on
       either side individually long enough to clear the length
       threshold below — but a full-width bridge is itself conclusive
       evidence the two fragments aren't connected by clean
       whitespace, regardless of how much clear space flanks it. This
       is checked explicitly, before the valley-length search, rather
       than assumed to be ruled out by requiring one long run.

    Returns:
      True  — profile shows a clear low-ink valley spanning the gap,
              with no full-width bridge in it; genuine inter-line
              whitespace, merge is safe.
      False — either a full-width ink bridge crosses the gap, or there's
              no valley run long enough to trust; merging on distance
              alone would be risky.
      None  — inconclusive (gap too small/degenerate to profile, no
              usable fragment-polarity sample, or gray unavailable) —
              caller falls back to the existing distance-based margin,
              unchanged.

    Deliberately conservative: only used to VETO a merge that pixel
    distance would otherwise allow, never to force a merge that
    distance-overlap didn't already produce.
    """
    if gray is None:
        return None
    gh, gw = gray.shape[:2]
    gx1, gy1, gx2, gy2 = gap_box
    bx1, by1 = max(0, min(int(gx1), gw - 1)), max(0, min(int(gy1), gh - 1))
    bx2, by2 = max(0, min(int(gx2), gw)),     max(0, min(int(gy2), gh))
    if bx2 - bx1 < 4 or by2 - by1 < 2:
        return None  # band too thin/degenerate to profile meaningfully
    band = gray[by1:by2, bx1:bx2]

    def _frag_mean(box):
        fx1, fy1, fx2, fy2 = (max(0, int(v)) for v in box)
        fx2, fy2 = min(gw, fx2), min(gh, fy2)
        if fx2 <= fx1 or fy2 <= fy1:
            return None
        return float(gray[fy1:fy2, fx1:fx2].mean())

    frag_means = [m for m in (_frag_mean(frag_a_box), _frag_mean(frag_b_box)) if m is not None]
    if not frag_means:
        return None  # no usable polarity sample — inconclusive, don't veto
    frag_mean = sum(frag_means) / len(frag_means)

    # Polarity from the FRAGMENTS (known to contain real text), not
    # the gap band itself — see point 2/3 above for why that distinction
    # is load-bearing, not stylistic.
    is_ink = (band < _GAP_INK_ABS_THRESH) if frag_mean >= 128 else (band > _GAP_BG_ABS_THRESH)
    row_ink_frac = is_ink.mean(axis=1)

    # Full-width bridge veto (point 4 above) — checked before the
    # valley-length search, since it overrides a long valley on either
    # side of it.
    if (row_ink_frac > 0.6).any():
        return False

    # A genuine inter-line valley: at least one contiguous run of rows
    # with near-zero ink spanning a real fraction of the band height —
    # not just a single sparse row, which could be one thin serif/tail.
    valley_rows = row_ink_frac < 0.04
    if valley_rows.sum() == 0:
        return False  # continuous ink the whole way through — no valley at all

    best_run, cur_run = 0, 0
    for is_valley_row in valley_rows:
        cur_run = cur_run + 1 if is_valley_row else 0
        best_run = max(best_run, cur_run)
    band_h = by2 - by1
    return (best_run / band_h) >= 0.25


def vertical_gap_band(box_a: tuple, box_b: tuple) -> tuple | None:
    """
    The (x1, y1, x2, y2) band strictly between two vertically-stacked,
    genuinely separated boxes - or None if this pair has no such band and
    the profile check should be skipped entirely.

    # Projection-profile veto: only meaningful for a
    # vertically-stacked, genuinely SEPARATED pair (one box
    # cleanly above the other with a real gap between them) —
    # that's the case LINE_GAP_FACTOR's fixed multiplier was
    # approximating with a single constant. Side-by-side
    # fragments on the same line have no "inter-line gap" to
    # profile, so skip those entirely rather than force a
    # vertical-band reading onto a horizontal relationship.
    #
    # CRITICAL, found via testing against a real manga page
    # (not synthetic data — see devlog/session notes): OCR line
    # boxes commonly OVERLAP slightly in y even for genuinely
    # separate, correctly-read lines — tight kerning, a
    # descender/ascender, or a few degrees of page skew are
    # enough. An earlier version of this check had no branch
    # for that case: it always picked SOME pair of edges to
    # treat as "the gap" (via sorted((ay2,by1)) vs
    # sorted((by2,ay1))), and when the boxes overlapped, that
    # produced a band spanning almost the FULL combined height
    # of both boxes — including their actual text ink — rather
    # than a real inter-line gap. The profile check then
    # correctly found "continuous ink" in that band (because it
    # WAS looking at real letters, not whitespace) and vetoed a
    # merge that should have gone through, since there was
    # never a real gap to evaluate. Confirmed on a real page:
    # two lines of one sentence ("PASE DEL" / "PUESTO 188",
    # y-ranges [1042,1079] and [1075,1111] — overlapping by 4px)
    # got permanently split into separate regions this way.
    #
    # Fix: require ay2 <= by1 (or by2 <= ay1) — a genuine,
    # non-overlapping vertical separation — before computing a
    # gap band at all. Overlapping pairs skip the profile check
    # entirely and fall through to the existing distance/border
    # checks only, exactly matching behaviour from before this
    # veto existed for the pairs where a "gap" reading was
    # never a coherent question to ask in the first place.
    """
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    stacked = (min(ax2, bx2) - max(ax1, bx1)) > 0  # meaningful x-overlap
    a_above_b = ay2 <= by1
    b_above_a = by2 <= ay1
    if not (stacked and (a_above_b or b_above_a)):
        return None
    gap_y1, gap_y2 = (ay2, by1) if a_above_b else (by2, ay1)
    gap_x1, gap_x2 = max(ax1, bx1), min(ax2, bx2)
    if gap_y2 <= gap_y1:
        return None
    return (gap_x1, gap_y1, gap_x2, gap_y2)


def gap_profile_veto(gray, box_a: tuple, box_b: tuple) -> bool:
    """
    True if the real pixels between two candidate fragments refuse a merge
    that the distance math already approved.

    # Continuous ink across the gap band, or a
    # full-width bridge inside it (see
    # profile_confirms_gap docstring point 4) —
    # distance math said "close enough" but the
    # actual pixels show no clean line break here.
    # Note: we only ever reach this branch for
    # pairs that already passed overlaps(exp[i],
    # exp[j]) above, i.e. pairs within the
    # margin-expanded distance threshold — a gap
    # too large to plausibly be the same bubble
    # never reaches this profile check at all, so
    # there's no separate "is the gap small
    # enough" condition to enforce here; that
    # gating already happened via LINE_GAP_FACTOR
    # margins before this loop runs.

    Returns False (no veto) whenever the question does not apply: no gray
    image, no coherent vertical gap band for this pair, or a profile verdict
    of True/None. Only an explicit False from profile_confirms_gap vetoes -
    see its docstring for why an inconclusive read must not block.
    """
    if gray is None:
        return False
    band = vertical_gap_band(box_a, box_b)
    if band is None:
        return False
    return profile_confirms_gap(gray, band, box_a, box_b) is False


class VetoSet:
    """
    The three structural veto functions, bundled so a caller can swap one out.

    This exists for the "companion" half of the regression tests: each veto
    fix is only meaningful if the symptom it prevents actually reproduces
    with that veto disabled, so those tests need to turn exactly one veto off
    and re-run the real pipeline.

    They used to do that by monkeypatching server._waist_separates_boxes.
    That cannot work once merging lives in its own module: `from mtl.geometry
    import _waist_separates_boxes` binds the function into THIS module's
    namespace at import time, so rebinding server's alias leaves this call
    site pointing at the original. Worse, it would still appear to work in
    the single-file dist build, where build.py flattens every module into one
    shared namespace and server's alias IS this call site -- a test that
    passes in one build and silently tests nothing in the other.

    An explicit parameter has neither problem: it reads the same in both
    builds, needs no try/finally to restore global state, and makes "this
    test runs with the waist veto off" visible at the call site.
    """

    __slots__ = ("crosses_border", "crosses_bubble_boundary", "waist_separates",
                 "different_containers")

    def __init__(self, crosses_border=None, crosses_bubble_boundary=None,
                 waist_separates=None, different_containers=None):
        self.crosses_border          = crosses_border or _crosses_border
        self.crosses_bubble_boundary = crosses_bubble_boundary or _crosses_bubble_boundary
        self.waist_separates         = waist_separates or _waist_separates_boxes
        self.different_containers    = different_containers or _different_containers_separate_boxes


DEFAULT_VETOES = VetoSet()


def structural_veto(box_a: tuple, box_b: tuple,
                    h_borders: list, v_borders: list,
                    bubble_label_map=None, waist_cache: dict | None = None,
                    vetoes: "VetoSet | None" = None, territory=None) -> bool:
    """
    The three SHAPE-based refusals, checked against the original
    (un-expanded) boxes. True if any one of them blocks the merge.

    Even if expanded boxes overlap, refuse to merge them if a
    panel border separates the original (un-expanded) boxes,
    OR if they sit in two different flat-light bubble
    components — see _crosses_bubble_boundary docstring — OR
    if they sit in two different LOBES of one fused
    double-bubble (two adjacent bubbles drawn as a single
    pinched silhouette with no dividing wall, which the
    component check structurally cannot catch since there IS
    only one component — see the "Fused double-bubble (waist)
    detection" section comment). All three are independent
    vetoes over the same candidate merge; any one blocks it.

    `vetoes` overrides which functions implement those three checks; see
    VetoSet. Defaults to the real ones.
    """
    if waist_cache is None:
        waist_cache = {}
    v = vetoes or DEFAULT_VETOES
    return (v.crosses_border(box_a, box_b, h_borders, v_borders)
            or v.crosses_bubble_boundary(box_a, box_b, bubble_label_map)
            or v.waist_separates(box_a, box_b, bubble_label_map, waist_cache)
            or v.different_containers(box_a, box_b, territory))


def pair_is_vetoed(box_a: tuple, box_b: tuple,
                   h_borders: list, v_borders: list,
                   bubble_label_map=None, waist_cache: dict | None = None,
                   gray=None, vetoes: "VetoSet | None" = None, territory=None) -> bool:
    """
    True if this candidate pair must NOT be merged despite their expanded
    boxes overlapping. Structural (shape) vetoes are checked first because
    they are pure geometry; the pixel-reading profile veto runs only for
    pairs that survive them - same order as the original inline code, which
    matters because the profile check is the only one that touches the image.
    """
    if structural_veto(box_a, box_b, h_borders, v_borders,
                       bubble_label_map, waist_cache, vetoes, territory):
        return True
    return gap_profile_veto(gray, box_a, box_b)


# -- Stage 3: union-find grouping --------------------------------------------

class _UnionFind:
    """Disjoint-set over box indices, with path halving."""

    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        parent = self.parent
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x         = parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def group_fragment_boxes(boxes, img_w: int, img_h: int,
                         margin_scale: float = 0.5,
                         h_borders: list | None = None,
                         v_borders: list | None = None,
                         bubble_label_map=None, gray=None,
                         vetoes: "VetoSet | None" = None) -> dict:
    """
    Group box indices that belong to the same bubble: {root_index: [idx, ...]}.

    This is steps 1-2 of _merge_bubble_regions' documented algorithm -
    everything up to and including the union-find, with no text joining,
    confidence filtering, or region assembly. Groups are keyed by union-find
    root, which is an arbitrary but stable member index.
    """
    h_borders = h_borders or []
    v_borders = v_borders or []
    n = len(boxes)
    # Built once per page, not per pair: it is a flood fill plus a relabel over
    # the whole map, cheap relative to OCR but not something to repeat O(n^2)
    # times inside the pair loop below.
    territory = _bubble_territory_map(bubble_label_map)
    margins_v, margins_h = compute_merge_margins(boxes, img_w, img_h, margin_scale)
    exp = [expand_box(boxes[i], margins_v[i], margins_h[i]) for i in range(n)]

    # Per-component extent profiles for the fused-double-bubble ("waist")
    # veto below. Built lazily and reused across all pairs sharing a
    # component — see _component_column_extents.
    waist_cache: dict = {}
    uf = _UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            if not boxes_overlap(exp[i], exp[j]):
                continue
            if pair_is_vetoed(boxes[i][:4], boxes[j][:4],
                              h_borders, v_borders,
                              bubble_label_map, waist_cache, gray, vetoes,
                              territory):
                continue
            uf.union(i, j)

    groups: dict = {}
    for i in range(n):
        groups.setdefault(uf.find(i), []).append(i)
    return groups


def filter_groups_by_confidence(groups: dict, confidences=None,
                                min_conf=None, clustered_floor: float = 0.0) -> dict:
    """
    Drop low-confidence fragments, sparing those clustered with a confident
    neighbour. A no-op unless BOTH confidences and min_conf were supplied -
    see _merge_bubble_regions' 'Confidence-aware filtering' section for the
    full rationale.
    """
    # ── Confidence-aware filtering (only if the caller opted in) ───────────────
    # See docstring "Confidence-aware filtering" section for the full rationale.
    if confidences is not None and min_conf is not None:
        filtered_groups: dict = {}
        for root, indices in groups.items():
            has_confident_member = any(confidences[i] >= min_conf for i in indices)
            floor = clustered_floor if has_confident_member else min_conf
            kept = [i for i in indices if confidences[i] >= floor]
            if kept:
                filtered_groups[root] = kept
        groups = filtered_groups
    return groups


# -- Stage 4: reading order within a group -----------------------------------

def line_cluster(boxes, idxs: list) -> list:
    """
    Fragment indices ordered top-to-bottom by visual line, left-to-right
    within each line.
    """
    # Sort fragments into reading order by first clustering them into
    # visual LINES (by vertical overlap), then ordering lines top-to-
    # bottom and fragments left-to-right within each line.
    #
    # A naive sort by raw (y1, x1) alone is fragile: two words on the
    # same visual line can have slightly different y1 (detection noise,
    # or a short word's box simply not spanning the same vertical range
    # as a taller neighbour), which can push a word out of sequence
    # relative to where it actually reads — e.g. "un" placed after
    # "paseo tranquilo." even though "un" comes first in the sentence,
    # because "un"'s y1 happened to be a few px lower than its
    # same-line neighbour's. Clustering by vertical overlap first is
    # robust to that: two boxes are "the same line" if they share
    # significant vertical extent, regardless of small y1 differences.
    items = sorted(idxs, key=lambda i: boxes[i][1])  # seed by top-y
    lines: list[list[int]] = []
    for i in items:
        y1, y2 = boxes[i][1], boxes[i][3]
        placed = False
        for line in lines:
            # Compare against the line's current vertical extent
            ly1 = min(boxes[k][1] for k in line)
            ly2 = max(boxes[k][3] for k in line)
            overlap = min(y2, ly2) - max(y1, ly1)
            min_h   = min(y2 - y1, ly2 - ly1)
            if min_h > 0 and overlap / min_h > 0.4:
                line.append(i)
                placed = True
                break
        if not placed:
            lines.append([i])
    lines.sort(key=lambda line: min(boxes[k][1] for k in line))
    ordered = []
    for line in lines:
        line.sort(key=lambda i: boxes[i][0])  # left-to-right within line
        ordered.extend(line)
    return ordered


def detect_column_split(boxes, idxs, min_overlap_frac=0.70, min_fragments=2):
    """
    Detect whether a merged region's fragments actually form TWO
    side-by-side columns of text rather than one multi-line paragraph.

    line_cluster (above) groups fragments into visual "lines" by
    y-overlap, then reads each line left-to-right — which silently
    assumes single-column text. A genuine two-column bubble (e.g. a
    short aside next to a longer main line of dialogue, both inside
    one speech bubble) breaks that assumption: each column's line N
    sits at roughly the same height as the other column's line N, so
    line_cluster groups them into the same "row" and interleaves the
    two independent columns word-by-word instead of reading one
    column fully before the other.

    Detection strategy ("vertical river" + "parallel Y-overlap"):
      1. Project all fragment x-ranges onto a 1D axis and find the
         widest completely-empty gap ("river"). No gap of meaningful
         width (>=3% of the region's own width) → not two columns.
      2. Split fragments into left/right of that gap's center. Each
         side needs >= min_fragments fragments, or this is more likely
         noise/a single stray fragment than a real column.
      3. THE KEY CHECK: rather than requiring the shorter side to span
         some fraction of the region's total height (which incorrectly
         rejects a real but short second column — e.g. a 2-line aside
         next to an 8-line main column), check how much of the SHORTER
         side's own height overlaps vertically with the TALLER side's
         height range. A genuine side-by-side column runs parallel to
         its neighbour regardless of how short it is, so this overlap
         is high (near 100%) even for a very short real column. A
         stray trailing line at the bottom of a paragraph, by
         contrast, sits BELOW the paragraph's bottom edge with little
         or no y-overlap — this check correctly rejects that case
         without needing to know anything about its absolute height.

    Returns (left_idxs, right_idxs) if a genuine split is detected,
    else None (caller falls through to normal single-column handling).
    """
    if len(idxs) < min_fragments * 2:
        return None

    region_x0 = min(boxes[i][0] for i in idxs)
    region_x1 = max(boxes[i][2] for i in idxs)
    if region_x1 <= region_x0:
        return None

    # Coarse x-axis occupancy scan to find the widest empty gap.
    RES = 200
    scale = RES / (region_x1 - region_x0)
    occupied = [False] * (RES + 1)
    for i in idxs:
        x1, _, x2, _, _ = boxes[i]
        a = max(int((x1 - region_x0) * scale), 0)
        b = min(int((x2 - region_x0) * scale), RES)
        for k in range(a, b + 1):
            occupied[k] = True

    best_gap = (0, 0)
    run_start = None
    for k in range(RES + 1):
        if not occupied[k]:
            if run_start is None:
                run_start = k
        else:
            if run_start is not None and (k - run_start) > (best_gap[1] - best_gap[0]):
                best_gap = (run_start, k)
            run_start = None
    if run_start is not None and (RES + 1 - run_start) > (best_gap[1] - best_gap[0]):
        best_gap = (run_start, RES + 1)

    if (best_gap[1] - best_gap[0]) < RES * 0.03:
        return None  # no meaningful gap — this is one column

    gap_x = region_x0 + (best_gap[0] + best_gap[1]) / 2 / scale
    left  = [i for i in idxs if (boxes[i][0] + boxes[i][2]) / 2 <  gap_x]
    right = [i for i in idxs if (boxes[i][0] + boxes[i][2]) / 2 >= gap_x]
    if len(left) < min_fragments or len(right) < min_fragments:
        return None

    l_min_y = min(boxes[i][1] for i in left);  l_max_y = max(boxes[i][3] for i in left)
    r_min_y = min(boxes[i][1] for i in right); r_max_y = max(boxes[i][3] for i in right)
    l_h, r_h = l_max_y - l_min_y, r_max_y - r_min_y
    if l_h <= r_h:
        shorter_min, shorter_max, shorter_h = l_min_y, l_max_y, l_h
        taller_min,  taller_max              = r_min_y, r_max_y
    else:
        shorter_min, shorter_max, shorter_h = r_min_y, r_max_y, r_h
        taller_min,  taller_max              = l_min_y, l_max_y

    overlap = max(0, min(shorter_max, taller_max) - max(shorter_min, taller_min))
    if shorter_h <= 0 or (overlap / shorter_h) < min_overlap_frac:
        return None  # shorter side doesn't run parallel to the taller one

    return (left, right)


def order_fragments(boxes, idxs: list) -> list:
    """
    Fragment indices in reading order.

    # If this region's fragments genuinely form two side-by-side
    # columns (see detect_column_split docstring), cluster+order each
    # column independently and read left column fully, then right
    # column, rather than letting line_cluster interleave them line
    # by line. Otherwise (the common case), treat as one column as before.
    """
    column_split = detect_column_split(boxes, idxs)
    if column_split:
        left_idxs, right_idxs = column_split
        return line_cluster(boxes, left_idxs) + line_cluster(boxes, right_idxs)
    return line_cluster(boxes, idxs)


# -- Stage 5: group -> region ------------------------------------------------

def assemble_region(boxes, indices: list, img_w: int, img_h: int,
                    confidences=None) -> dict:
    """
    One merged region from one group's fragment indices, which must already
    be in reading order (see order_fragments).

    Geometry is emitted as PERCENTAGES of the page, not pixels, so the
    frontend can overlay correction boxes without knowing the raw image
    dimensions.
    """
    # Re-join fragments split across lines with a trailing hyphen.
    # e.g. ["SHUN-", "PEI."] → "SHUNPEI."
    texts  = [boxes[i][4] for i in indices]
    joined: list[str] = []
    for fragment in texts:
        if joined and joined[-1].endswith('-'):
            joined[-1] = joined[-1][:-1] + fragment
        else:
            joined.append(fragment)
    merged_text = " ".join(joined)
    mx1 = min(boxes[i][0] for i in indices)
    my1 = min(boxes[i][1] for i in indices)
    mx2 = max(boxes[i][2] for i in indices)
    my2 = max(boxes[i][3] for i in indices)

    # Region-level confidence — the MIN across every surviving fragment in
    # this group, not the average. A merged region is only as trustworthy
    # as its weakest fragment: a bubble that reads "PRESIDENTIAL" cleanly
    # except for one garbled "-DENTAL" fragment should still be flagged as
    # low-confidence overall, which an average would dilute away. None
    # when the caller didn't opt into confidence tracking at all (keeps
    # this field absent/None for any caller that never passes `confidences`).
    region_conf = (
        round(min(confidences[i] for i in indices), 3)
        if confidences is not None else None
    )

    return {
        "text": merged_text,
        "cx":   round((mx1 + mx2) / 2 / img_w * 100, 1),
        "cy":   round((my1 + my2) / 2 / img_h * 100, 1),
        # Percentage bounding box so the frontend can overlay correction
        # boxes on the image without knowing the raw pixel dimensions.
        "box":  [
            round(mx1 / img_w * 100, 1), round(my1 / img_h * 100, 1),
            round(mx2 / img_w * 100, 1), round(my2 / img_h * 100, 1),
        ],
        # Recognition confidence, 0-1, min-across-fragments. None if this
        # region's boxes were merged without confidence data (a caller
        # that never passed `confidences`). See translate-client.js's
        # noise filter for how this gates translation.
        "confidence": region_conf,
    }


# -- Orchestrator ------------------------------------------------------------

def _merge_bubble_regions(
    boxes,
    img_w: int,
    img_h: int,
    h_borders:    list | None  = None,
    v_borders:    list | None  = None,
    margin_scale: float        = 0.5,
    confidences:  list | None  = None,
    min_conf:     float | None = None,
    clustered_floor: float     = 0.0,
    bubble_label_map            = None,
    gray                        = None,
    vetoes                      = None,
):
    """
    Group OCR bounding boxes that belong to the same speech bubble, then merge
    each group into a single region with combined text.

    Algorithm (each step is its own function now — named in brackets, and
    individually testable; see this module's docstring for the full map):
      1. Expand every box by its own per-axis margin. [compute_merge_margins,
         expand_box]
      2. Any two expanded boxes that overlap → same bubble (union-find),
         UNLESS a panel border line falls in the gap between them, or one of
         the other vetoes objects. [boxes_overlap, pair_is_vetoed,
         group_fragment_boxes]
      3. If confidences/min_conf were supplied, drop low-confidence boxes
         UNLESS they share a group with at least one confident box (see
         "Confidence-aware filtering" below) — otherwise keep everything
         (caller is responsible for pre-filtering, as before).
         [filter_groups_by_confidence]
      4. Within each group sort fragments top-to-bottom then left-to-right
         (natural reading order inside the bubble) and join their text.
         [order_fragments → detect_column_split, line_cluster]
      5. Return one {text, cx, cy, box, confidence} per group, centred on the
         merged bounding box. `confidence` is the min recognition confidence
         across the group's fragments (None if `confidences` wasn't supplied).
         [assemble_region]

    The sections below document the PARAMETERS and the reasoning behind the
    constants. They are kept here, on the entry point, because that is where
    a caller looks first; the stage functions carry the mechanism details.

    Confidence-aware filtering (confidences / min_conf / clustered_floor):
      `confidences` is a list PARALLEL to `boxes` (confidences[i] is boxes[i]'s
      recognition confidence), not embedded in the box tuple itself — this is
      deliberate. Extending the 5-element box tuple to 6 elements would silently
      break any existing `x1, y1, x2, y2, text = box`-style unpacking elsewhere
      in this function (there's one such line) or anywhere a caller does the
      same; a parallel list sidesteps that entirely since every other access
      pattern in this function already reads boxes[i][idx], which tolerates
      unrelated data living alongside it in a separate list just fine.

      When both `confidences` and `min_conf` are given, a box normally needs
      confidences[i] >= min_conf to survive — UNLESS it shares a merge group
      with at least one box that clears min_conf on its own, in which case
      confidences[i] >= clustered_floor is enough. Rationale: a low-confidence
      fragment adjacent to (and merging with) confident neighbours in the same
      bubble is much more likely to be real, correctly-recognised text that
      merely scored low (seen in practice with stylised mixed-case manga
      fonts) than an isolated low-confidence fragment with no such support,
      which is more likely genuine noise. clustered_floor still guards against
      pure noise happening to fall inside a real bubble's expanded margin.

      If `confidences` is None (the default), no confidence filtering happens
      here at all — behaves exactly as before for any caller that doesn't
      pass it.

    bubble_label_map (NEW, UNVALIDATED — see "Bubble contour detection"
      section above _find_bubble_components): output of
      _find_bubble_components, a page-wide connected-components label map
      over flat/light regions. When supplied, two boxes whose expanded
      rects overlap are STILL refused a merge if _crosses_bubble_boundary
      says they sit in two different flat-light components — this is
      checked alongside (not instead of) the existing _crosses_border
      panel-border veto. None (the default) disables this check entirely
      and behaves exactly as before for any caller that doesn't pass it —
      same opt-in pattern as `confidences`.

    MERGE_MARGIN is content-adaptive and computed PER-BOX, not page-wide:
      margin(i) = height(box i) x margin_scale

      Each box is expanded using its OWN height, not a single page-wide
      median. Two boxes are candidates to merge if their expanded rects
      overlap — which succeeds if EITHER box's own margin is enough to
      bridge the gap, so a box only needs to "reach" as far as its own
      text size implies is reasonable for its own line spacing.

      This fixes a real bug in the old page-wide-median approach: a page
      mixing small incidental text (SFX, panel labels — low height) with
      one or more large, wide-line-spacing bubbles would compute a small
      global margin from the page's small-text median, which was then far
      too small to bridge the large bubble's own (proportionally larger)
      line gaps — silently splitting one bubble's sentence into multiple
      disconnected regions with no error or warning anywhere downstream.
      Per-box margins mean a bubble's own line height governs whether its
      own lines merge, independent of what else is on the page.

      margin_scale (default 0.5) is the user-tunable sensitivity knob.

      Webtoon strips (img_h / img_w > 2) use 60 % of the normal scale to
      avoid bridging vertically-stacked panels on tall narrow canvases.

      A small absolute floor still applies (4px) so degenerate zero/near-zero
      height boxes (stray noise) don't get an unreasonably tiny margin.

      Line-height note: the gap BETWEEN two lines of text ("leading") is
      typically wider than either line's own glyph height — measured
      against real EasyOCR output on manga-style multi-line bubbles, gaps
      of ~1.5x the box height are normal, not an outlier. A margin of
      0.5x each box's height (i.e. 1.0x combined between two adjacent
      boxes) was found to still be too small to bridge genuine same-bubble
      line gaps, so the per-box margin is scaled by a LINE_GAP_FACTOR on
      top of margin_scale — margin_scale remains the user-facing slider
      (unchanged range/meaning), LINE_GAP_FACTOR is the calibration
      constant that makes the default (1.0) actually bridge normal
      same-bubble line spacing.

      LINE_GAP_FACTOR is a FIRST-PASS distance estimate only, not the
      final word on whether two vertically-stacked fragments merge — it
      decides which pairs are even considered (via expanded-box overlap).
      For any pair that clears that bar, profile_confirms_gap additionally
      checks the real pixels in the gap band: a horizontal ink-density
      profile that shows continuous ink (no whitespace valley) vetoes the
      merge even though the fixed multiplier said "close enough". This
      means a manga with unusually tight or loose leading is no longer
      solely at the mercy of one global constant — LINE_GAP_FACTOR only
      needs to be generous enough to admit true same-bubble pairs as
      CANDIDATES; the profile check is what actually confirms or rejects
      each one against that page's real spacing. The veto is one-directional
      (can only block a distance-approved merge, never force one distance
      would refuse) — see profile_confirms_gap's docstring for why that's
      the safe default when the profile itself is inconclusive.

      HORIZONTAL_GAP_FACTOR (NEW) is the horizontal counterpart to
      LINE_GAP_FACTOR — margin(i) is now actually TWO values per box,
      margin_v(i) = height(i) x margin_scale x LINE_GAP_FACTOR and
      margin_h(i) = height(i) x margin_scale x HORIZONTAL_GAP_FACTOR,
      expanding each box by margin_v vertically and margin_h horizontally
      rather than one shared value in every direction. HORIZONTAL_GAP_FACTOR
      is deliberately much smaller than LINE_GAP_FACTOR: the only legitimate
      same-bubble reason to bridge a horizontal gap is staggered/zigzag
      lettering inside one narrow bubble, whose real gap is tight same-
      bubble spacing, not line-height. Unlike the vertical case,
      profile_confirms_gap's ink-valley technique CANNOT do double duty
      here as a secondary check — a clean gap reads identically whether
      it's a normal word-space inside one bubble or open panel background
      between two different bubbles — so horizontal reach has to stay
      tight geometrically instead of leaning on a pixel-content veto to
      catch mistakes after the fact. See the constant's own comment above
      for the specific bug this fixes and its current (unvalidated)
      starting value.

    vetoes (VetoSet | None):
      Swap out which functions implement the three structural vetoes. None
      (the default) uses the real ones. Exists so a test can disable exactly
      one veto and confirm the symptom it prevents still reproduces without
      it — see VetoSet's docstring for why monkeypatching cannot do this job
      once merging lives in its own module.

    Panel border guard (h_borders / v_borders):
      Even if two expanded boxes overlap, they will NOT be merged if a detected
      panel border line lies in the gap between them.  This prevents speech
      bubbles from adjacent panels being collapsed into one region, which is the
      most common cause of incoherent translations.
    """
    if not boxes:
        return [], []

    groups = group_fragment_boxes(boxes, img_w, img_h, margin_scale,
                                  h_borders, v_borders, bubble_label_map, gray,
                                  vetoes)
    groups = filter_groups_by_confidence(groups, confidences, min_conf,
                                         clustered_floor)

    regions      = []
    group_raw_ids = []   # parallel list: raw box indices per merged region
    for indices in groups.values():
        indices = order_fragments(boxes, indices)
        regions.append(assemble_region(boxes, indices, img_w, img_h, confidences))
        group_raw_ids.append(list(indices))

    # Sort final regions top-to-bottom, keeping group_raw_ids in sync.
    if regions:
        paired = sorted(zip(regions, group_raw_ids),
                        key=lambda p: (p[0]["cy"], p[0]["cx"]))
        regions, group_raw_ids = map(list, zip(*paired))
    return regions, group_raw_ids
