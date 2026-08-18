#!/usr/bin/env python3
"""
test_bubble_outline_tracing.py — regression test for the outline-carving fix
in _find_bubble_components() / _bubble_outline_mask() (server.py).

BACKGROUND
  See KNOWN_ISSUES_DRAFT.md, "Confirmed, blocking: _merge_bubble_regions
  over-merges adjacent bubbles on RapidOCR's fragment output", and the
  "OUTLINE-TRACING FIX ATTEMPT" note in the "Bubble contour detection"
  comment block above _find_bubble_components in server.py.

  _find_bubble_components segments a page into connected components of
  "flat, light" pixels so _crosses_bubble_boundary can refuse to merge two
  OCR fragments that sit in different bubbles. Its flatness test box-filters
  squared Laplacian over a 9x9 window before thresholding — deliberately
  coarse, tuned for classifying whole areas as bubble-fill vs textured art.
  A thin, low-contrast, or curved dividing line between two adjacent,
  similarly-bright bubbles gets diluted by that averaging: the window
  mostly sees flat fill on both sides of the line, so the averaged variance
  can land under the flatness threshold even directly on top of the line —
  silently bridging what should be two separate components into one.
  Confirmed on a real page (Brazil_raw.jpg, see KNOWN_ISSUES_DRAFT.md):
  two bubbles fused into a single connected component, and their text was
  interleaved fragment-by-fragment into one garbled region.

  A margin-based fix (splitting the merge margin into horizontal/vertical
  components, HORIZONTAL_GAP_FACTOR) was tried FIRST and proven
  mathematically unable to close this gap: on the real page, the closest
  real gap between two DIFFERENT bubbles' text (1.0px) was tighter than
  the real gap a legitimate SAME-bubble merge needs to preserve (5px), so
  no single geometric threshold can separate the two cases.

  This fix instead targets the segmentation itself: _bubble_outline_mask
  uses per-pixel adaptive thresholding (compares each pixel to its own
  local neighbourhood mean) to catch thin/faint dividing lines the
  page-wide flatness filter's averaging smooths away, and carves them out
  of the flat+light candidate mask before connected-components runs — so
  two bubbles divided by such a line get two separate labels instead of
  one, and _crosses_bubble_boundary's existing (already-correct) sampling
  logic can do its job.

WHAT THIS TESTS
  Imports server.py directly (not a copy) and runs against a SYNTHETIC
  image built with OpenCV: two ellipse "bubbles" (flat white fill, a soft
  anti-aliased stroke outline, Gaussian-blurred to mimic scan/compression
  softening) placed close enough that their stroke outlines nearly touch —
  chosen empirically so the OLD flatness-only mask actually merges them
  into one component, reproducing the real bug's mechanism (not just its
  symptom) on constructed data:

    1. Companion check: confirm the OLD (pre-fix, flatness+lightness only)
       mask really does merge the two bubbles into ONE component on this
       image — otherwise this test wouldn't be exercising the fix at all,
       just confirming a case neither version would have merged.
    2. The NEW _find_bubble_components (with outline carving) splits them
       into TWO components.
    3. _crosses_bubble_boundary, given fragment boxes positioned near the
       bubbles' facing edges (mimicking OCR text that wraps close to a
       bubble's inner wall): blocks the merge with the NEW label map,
       does NOT block it with the OLD one (reproducing the bug).
    4. End-to-end _merge_bubble_regions: with the NEW label map, the two
       fragments stay as 2 separate regions; with the OLD one, they merge
       into 1 region with concatenated (garbled, cross-bubble) text —
       reproducing the exact real-world symptom from KNOWN_ISSUES_DRAFT.md,
       not just a label-map difference.
    5. Regression: two fragments inside the SAME single bubble, far apart
       (top vs bottom), still resolve to one component / one merged region
       under the NEW map — outline carving must not fragment a bubble's
       own interior.
    6. Regression: a tight (5px) same-bubble staggered-lettering pair —
       the exact legitimate case the earlier margin-based fix needed to
       preserve — still merges under the NEW map.
    7. Regression: a single isolated bubble (no second bubble anywhere on
       the page) keeps its entire interior as one component; several
       widely-spaced interior points all resolve to the same label.

  HONESTY NOTE, per this project's own standard (see KNOWN_ISSUES_DRAFT.md
  and the "OUTLINE-TRACING FIX ATTEMPT" comment in server.py): this
  validates the mechanism against SYNTHETIC image data constructed to
  reproduce the reported failure's characteristics (a thin/low-contrast/
  curved boundary that evades the box-filtered flatness test), because
  this environment does not have a copy of the real Brazil_raw.jpg page.
  This is NOT a substitute for re-running the actual Brazil_raw.jpg page
  (and a handful of others with tightly-packed panels) through
  _run_rapidocr_detection with this change applied — that verification
  step, per this file's own established bar, still needs to happen
  against real pixels before this is trusted as fixed rather than
  "logic-tested and synthetic-image-tested."

HOW TO RUN
  python test_bubble_outline_tracing.py
  (needs opencv-python + numpy, same as server.py itself; no OCR engine
  or network access required — everything here is synthetic pixels and
  direct calls into server.py's image-processing functions)
"""

import importlib.util
import sys

import numpy as np
import cv2

_spec = importlib.util.spec_from_file_location("mangatl_server", "server.py")
_server = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(_server)
except ModuleNotFoundError as e:
    print(f"Could not import server.py directly ({e}).")
    print("This test needs the same environment server.py itself needs —")
    print("if you're running this somewhere without EasyOCR/RapidOCR")
    print("installed, run it from inside the project's normal environment.")
    sys.exit(1)

find_bubble_components  = _server._find_bubble_components
crosses_bubble_boundary = _server._crosses_bubble_boundary
merge                   = _server._merge_bubble_regions


def _old_flatness_only_label_map(gray: np.ndarray):
    """
    Reproduces _find_bubble_components' PRE-FIX behaviour exactly (flatness
    + lightness only, no outline carving) so tests can confirm the
    constructed image is a genuine pre-fix false-merge case, not something
    neither version would have merged. Mirrors the constants/logic in
    server.py's _find_bubble_components at the time this fix was written.
    """
    lap       = cv2.Laplacian(gray, cv2.CV_64F)
    lap_sq    = lap * lap
    local_var = cv2.boxFilter(lap_sq, ddepth=-1, ksize=(9, 9))
    flat_mask  = (local_var < 40.0)
    light_mask = (gray > 200)
    cand = (flat_mask & light_mask).astype(np.uint8)
    num_labels, label_map = cv2.connectedComponents(cand, connectivity=8)
    return None if num_labels <= 1 else label_map


def _build_two_bubbles(stroke_val=205, stroke_thickness=2, sep=172,
                        blur_sigma=1.2, axes=(90, 85), canvas=(220, 340)):
    """
    Two ellipse "speech bubbles": flat white fill, a soft anti-aliased
    stroke outline, then a mild Gaussian blur over the whole page to mimic
    scan/compression softening of a real thin ink line. `sep` is the
    horizontal distance between ellipse centers — chosen (empirically,
    against server.py's actual constants) close enough that the two
    strokes/fills interact at their closest-approach point without the
    ellipses grossly overlapping, the same geometry a curved bubble
    boundary presents in a real page.
    """
    h, w = canvas
    gray = np.full((h, w), 55, dtype=np.uint8)  # dark panel background/art
    center_a = (110, 110)
    center_b = (110 + sep, 110)
    cv2.ellipse(gray, center_a, axes, 0, 0, 360, 250, -1, lineType=cv2.LINE_AA)
    cv2.ellipse(gray, center_b, axes, 0, 0, 360, 250, -1, lineType=cv2.LINE_AA)
    cv2.ellipse(gray, center_a, axes, 0, 0, 360, stroke_val, stroke_thickness, lineType=cv2.LINE_AA)
    cv2.ellipse(gray, center_b, axes, 0, 0, 360, stroke_val, stroke_thickness, lineType=cv2.LINE_AA)
    gray_f = cv2.GaussianBlur(gray.astype(np.float64), (0, 0), blur_sigma)
    gray = np.clip(gray_f, 0, 255).astype(np.uint8)
    return gray, center_a, center_b, axes


def _build_single_bubble(stroke_val=205, stroke_thickness=2, blur_sigma=1.2,
                          axes=(90, 85), canvas=(220, 220)):
    h, w = canvas
    gray = np.full((h, w), 55, dtype=np.uint8)
    center = (110, 110)
    cv2.ellipse(gray, center, axes, 0, 0, 360, 250, -1, lineType=cv2.LINE_AA)
    cv2.ellipse(gray, center, axes, 0, 0, 360, stroke_val, stroke_thickness, lineType=cv2.LINE_AA)
    gray_f = cv2.GaussianBlur(gray.astype(np.float64), (0, 0), blur_sigma)
    gray = np.clip(gray_f, 0, 255).astype(np.uint8)
    return gray, center, axes


def main():
    all_pass = True

    # ── Build the two-bubble synthetic page, used by tests 1-4 ────────────
    gray, center_a, center_b, axes = _build_two_bubbles()
    h, w = gray.shape

    # ── 1. Companion check: OLD flatness-only mask merges the two bubbles ─
    old_lbl = _old_flatness_only_label_map(gray)
    oa = old_lbl[center_a[1], center_a[0]] if old_lbl is not None else None
    ob = old_lbl[center_b[1], center_b[0]] if old_lbl is not None else None
    old_merged = old_lbl is not None and oa == ob and oa != 0
    all_pass &= old_merged
    print(f"{'PASS' if old_merged else 'FAIL <<<':8} companion: OLD flatness-only mask merges "
          f"the two bubbles into one component (labels: A={oa}, B={ob}) — confirms this "
          f"image is a genuine pre-fix false-merge case, not a vacuous test")

    # ── 2. NEW _find_bubble_components splits them into two components ────
    new_lbl = find_bubble_components(gray, w, h)
    na = new_lbl[center_a[1], center_a[0]] if new_lbl is not None else None
    nb = new_lbl[center_b[1], center_b[0]] if new_lbl is not None else None
    new_split = new_lbl is not None and na != nb and na != 0 and nb != 0
    all_pass &= new_split
    print(f"{'PASS' if new_split else 'FAIL <<<':8} fix: NEW _find_bubble_components splits "
          f"the same two bubbles into separate components (labels: A={na}, B={nb})")

    # ── 3. _crosses_bubble_boundary: blocked with NEW map, not with OLD ───
    # Fragment boxes near the bubbles' facing edges — mimicking OCR text
    # that wraps close to a bubble's inner wall, the same layout that
    # produced a ~1px real gap on the real Brazil_raw.jpg page.
    mid_x = (center_a[0] + axes[0] + center_b[0] - axes[0]) // 2
    box_a = (mid_x - 34, 100, mid_x - 4, 118, "ACAMPAMENTO")
    box_b = (mid_x + 4,  104, mid_x + 40, 120, "QUE ELES VAO")

    blocked_new = crosses_bubble_boundary(box_a[:4], box_b[:4], new_lbl)
    all_pass &= blocked_new
    print(f"{'PASS' if blocked_new else 'FAIL <<<':8} fix: _crosses_bubble_boundary blocks "
          f"the merge using the NEW label map (got {blocked_new})")

    reproduces_bug = not crosses_bubble_boundary(box_a[:4], box_b[:4], old_lbl)
    all_pass &= reproduces_bug
    print(f"{'PASS' if reproduces_bug else 'FAIL <<<':8} companion: _crosses_bubble_boundary "
          f"does NOT block the same pair using the OLD label map — confirms the veto "
          f"genuinely depends on the segmentation fix, not just on sampling logic "
          f"that was already correct")

    # ── 4. End-to-end _merge_bubble_regions: 2 regions (NEW) vs 1 (OLD) ───
    regions_new, _ = merge([box_a, box_b], w, h, bubble_label_map=new_lbl, gray=gray)
    ok_new = len(regions_new) == 2
    all_pass &= ok_new
    print(f"{'PASS' if ok_new else 'FAIL <<<':8} fix: full merge pipeline keeps the two "
          f"bubbles' text separate (got {len(regions_new)} region(s): "
          f"{[r['text'] for r in regions_new]})")

    # NOTE: the fused-double-bubble "waist" veto (_waist_separates_boxes,
    # added later — see test_fused_bubble_waist.py) independently catches
    # this synthetic layout too, since two near-touching ellipses are
    # exactly the pinched shape it looks for. It is disabled for THIS
    # companion check specifically, so the check still isolates what it is
    # meant to isolate: that the OUTLINE-MASK mechanism alone is what
    # changed the outcome. Leaving it enabled would make this assertion
    # pass or fail for reasons that have nothing to do with outline
    # carving.
    _real_waist_fn = _server._waist_separates_boxes
    try:
        _server._waist_separates_boxes = lambda *a, **k: False
        regions_old, _ = merge([box_a, box_b], w, h, bubble_label_map=old_lbl, gray=gray)
    finally:
        _server._waist_separates_boxes = _real_waist_fn
    ok_old_repro = len(regions_old) == 1
    all_pass &= ok_old_repro
    print(f"{'PASS' if ok_old_repro else 'FAIL <<<':8} companion: full merge pipeline with the "
          f"OLD label map (waist veto disabled, to isolate the outline mechanism) reproduces "
          f"the real symptom — two different bubbles' text concatenated into one garbled "
          f"region (got {len(regions_old)} region(s): {[r['text'] for r in regions_old]})")

    # ── 5. Regression: far-apart fragments in the SAME bubble still merge ─
    box_top = (mid_x - axes[0] + 25, 60,  mid_x - axes[0] + 75, 78,  "TOP")
    box_bot = (mid_x - axes[0] + 25, 145, mid_x - axes[0] + 75, 163, "BOTTOM")
    not_blocked = not crosses_bubble_boundary(box_top[:4], box_bot[:4], new_lbl)
    all_pass &= not_blocked
    print(f"{'PASS' if not_blocked else 'FAIL <<<':8} regression: top/bottom fragments inside "
          f"the SAME bubble are not treated as crossing a boundary (got "
          f"crosses={not not_blocked})")

    # ── 6. Regression: tight (5px) same-bubble staggered-lettering pair ───
    box_c = (mid_x - axes[0] + 25, 100, mid_x - axes[0] + 65, 118, "COL1")
    box_d = (mid_x - axes[0] + 70, 105, mid_x - axes[0] + 100, 122, "COL2")
    regions_stag, _ = merge([box_c, box_d], w, h, bubble_label_map=new_lbl, gray=gray)
    ok_stag = len(regions_stag) == 1
    all_pass &= ok_stag
    print(f"{'PASS' if ok_stag else 'FAIL <<<':8} regression: tight 5px same-bubble staggered-"
          f"lettering pair still merges under the NEW map (got {len(regions_stag)} "
          f"region(s): {[r['text'] for r in regions_stag]})")

    # ── 7. Regression: a single isolated bubble isn't fragmented ──────────
    solo_gray, solo_center, solo_axes = _build_single_bubble()
    sh, sw = solo_gray.shape
    solo_lbl = find_bubble_components(solo_gray, sw, sh)
    pts = [(110, 110), (80, 90), (140, 90), (80, 130), (140, 130), (110, 70), (110, 150)]
    labels_seen = {solo_lbl[y, x] for (x, y) in pts} if solo_lbl is not None else {None}
    ok_solo = solo_lbl is not None and len(labels_seen) == 1 and 0 not in labels_seen
    all_pass &= ok_solo
    print(f"{'PASS' if ok_solo else 'FAIL <<<':8} regression: a single isolated bubble's "
          f"interior stays one component across 7 widely-spaced sample points "
          f"(labels seen: {labels_seen})")

    print()
    if all_pass:
        print("ALL PASS — outline carving splits the constructed thin/low-contrast-boundary")
        print("false-merge case (companion checks confirm both that the old code genuinely")
        print("fails on it and that the new code genuinely fixes it, at the label-map,")
        print("boundary-check, and full-pipeline levels), without fragmenting legitimate")
        print("same-bubble merges (far-apart, tight-staggered, or a bubble with no neighbour")
        print("at all).")
        print()
        print("REMAINING STEP (not covered by this script, per KNOWN_ISSUES_DRAFT.md's own")
        print("verification bar): re-run the real Brazil_raw.jpg page (and a handful of")
        print("others with tightly-packed panels) through _run_rapidocr_detection with this")
        print("change applied, and confirm EasyOCR's existing behaviour on the same pages")
        print("doesn't regress. This test validates the mechanism against synthetic pixels")
        print("built to reproduce the reported failure's characteristics, not the real page.")
    else:
        print("SOME FAILED — see FAIL rows above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
