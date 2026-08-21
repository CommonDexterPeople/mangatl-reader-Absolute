#!/usr/bin/env python3
"""
test_fused_bubble_waist.py — regression test for the fused double-bubble
("waist") merge veto: _waist_separates_boxes / _component_column_extents /
_dominant_component_for_box in server.py.

BACKGROUND
  See KNOWN_ISSUES_DRAFT.md ("Confirmed, blocking: _merge_bubble_regions
  over-merges adjacent bubbles on RapidOCR's fragment output", and the
  fix-attempt entries under it) and the "Fused double-bubble (waist)
  detection" section comment in server.py.

  On the real Brazil_raw.jpg page, two adjacent speech bubbles are drawn
  as ONE fused silhouette — a single continuous outer contour pinched into
  a figure-8, with no ink line and no background gap anywhere between them
  (verified against the real pixels: pure 255 white in the gap, and the
  connected-component label map reports one component wall to wall). Their
  dialogue was being merged into one garbled, interleaved region.

  Two earlier fixes failed on this, for reasons that generalize:
    1. Margin tuning (HORIZONTAL_GAP_FACTOR) — mathematically impossible
       here: the real gap between DIFFERENT bubbles' fragments (1px) is
       tighter than the gap a legitimate SAME-bubble merge must preserve
       (5px), and no distance threshold separates 1 < 5.
    2. Ink-line detection (_bubble_outline_mask) — finds faint lines that
       exist; on this shape there is no line to find, so it is inert here
       (confirmed: byte-identical pipeline output with it enabled or not).

  The signal that does separate the two cases is SHAPE: a fused
  double-bubble has a real geometric constriction between its lobes; a
  single bubble holding two columns of text does not. Measured on the real
  page: 0.74 waist ratio for the fused pair vs 1.00-1.05 for five
  confirmed single bubbles on the same page.

WHAT THIS TESTS
  Imports server.py directly (not a copy). Tests 1-3 are pure geometry on
  synthetic masks (fast, no image decoding). Test 4 runs against the real
  Brazil_raw.jpg page if it is present next to this script or in
  eval_samples/ — that is the case this fix exists for, and it is the only
  test here that proves anything about real pixels.

    1. Synthetic fused double-bubble (two overlapping ellipses forming a
       pinched figure-8, ONE connected component): two fragments in
       opposite lobes must be vetoed. A companion check confirms they
       really are in the same component, so the test is exercising the
       waist logic and not accidentally passing via the pre-existing
       different-component veto.
    2. Synthetic single bubble (one ellipse, no constriction): two
       fragments side by side inside it — the legitimate "staggered
       lettering" pattern — must NOT be vetoed.
    3. Scope guards: a vertically-separated pair must never be vetoed
       (the vertical analogue is deliberately not enabled — that is the
       hot path for ordinary multi-line dialogue), and a pair whose
       x-centers are closer than _WAIST_MIN_SPAN_PX must not be vetoed.
    4. Real page (skipped with a clear message if the image isn't
       available): the full _merge_bubble_regions pipeline over the real
       OCR fragment boxes from Brazil_raw.jpg must produce TWO regions
       whose texts match the two bubbles in the source art — and a
       companion check confirms that with the waist veto disabled the
       same input produces the ONE garbled interleaved region originally
       reported, so this is demonstrably exercising the fix.

  NOT COVERED: a vertically-stacked fused double-bubble (not enabled, no
  real sample to validate against — see the section comment in server.py),
  and any page not in the small set this was checked against. The
  full-pipeline regression runs behind this fix (RapidOCR and EasyOCR,
  4 pages each, output identical except the intended Brazil_raw.jpg split)
  are recorded in KNOWN_ISSUES_DRAFT.md, not re-run here — they need the
  OCR engines and real page images.

HOW TO RUN
  python test_fused_bubble_waist.py
"""

import importlib.util
import io
import os
import sys

import numpy as np
import cv2

_spec = importlib.util.spec_from_file_location("mangatl_server", "server.py")
_server = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(_server)
except ModuleNotFoundError as e:
    print(f"Could not import server.py directly ({e}).")
    print("Run this from inside the project's normal environment.")
    sys.exit(1)

waist_separates   = _server._waist_separates_boxes
dominant_for_box  = _server._dominant_component_for_box
merge             = _server._merge_bubble_regions


def _fused_double_bubble_labelmap():
    """
    Two overlapping ellipses forming ONE pinched figure-8 component —
    the fused-silhouette shape, with no dividing line of any kind.
    Returns (label_map, left_center, right_center).
    """
    h, w = 260, 420
    mask = np.zeros((h, w), np.uint8)
    cv2.ellipse(mask, (140, 130), (95, 90), 0, 0, 360, 1, -1)
    cv2.ellipse(mask, (280, 130), (95, 90), 0, 0, 360, 1, -1)
    num, lm = cv2.connectedComponents(mask, connectivity=8)
    assert num == 2, f"expected exactly one component, got {num - 1}"
    return lm, (140, 130), (280, 130)


def _single_bubble_labelmap():
    """One ellipse, no constriction anywhere."""
    h, w = 260, 420
    mask = np.zeros((h, w), np.uint8)
    cv2.ellipse(mask, (210, 130), (170, 95), 0, 0, 360, 1, -1)
    num, lm = cv2.connectedComponents(mask, connectivity=8)
    assert num == 2
    return lm


def _find_real_page():
    for p in ("Brazil_raw.jpg",
              os.path.join("eval_samples", "Brazil_raw.jpg"),
              os.path.join("eval_samples", "pt_Brazil_raw.jpg")):
        if os.path.exists(p):
            return p
    return None


def main():
    all_pass = True

    # ── 1. Fused double-bubble: opposite lobes must be vetoed ─────────────
    lm, lc, rc = _fused_double_bubble_labelmap()
    box_left  = (lc[0] - 45, lc[1] - 10, lc[0] + 45, lc[1] + 10, "LEFT")
    box_right = (rc[0] - 45, rc[1] - 10, rc[0] + 45, rc[1] + 10, "RIGHT")

    la = dominant_for_box(lm, box_left[:4])
    lb = dominant_for_box(lm, box_right[:4])
    same_comp = (la == lb and la != 0)
    all_pass &= same_comp
    print(f"{'PASS' if same_comp else 'FAIL <<<':8} companion: both fragments really are in "
          f"the SAME component (labels {la}/{lb}) — confirms this test exercises the waist "
          f"logic, not the pre-existing different-component veto")

    vetoed = waist_separates(box_left[:4], box_right[:4], lm, {})
    all_pass &= vetoed
    print(f"{'PASS' if vetoed else 'FAIL <<<':8} fix: fragments in opposite lobes of a fused "
          f"double-bubble are vetoed (got {vetoed})")

    # ── 2. Single bubble: side-by-side fragments must NOT be vetoed ───────
    lm_single = _single_bubble_labelmap()
    box_c = (120, 120, 200, 140, "COL1")
    box_d = (215, 120, 295, 140, "COL2")
    not_vetoed = not waist_separates(box_c[:4], box_d[:4], lm_single, {})
    all_pass &= not_vetoed
    print(f"{'PASS' if not_vetoed else 'FAIL <<<':8} regression: side-by-side fragments inside "
          f"ONE unpinched bubble (staggered-lettering pattern) are not vetoed")

    # ── 3. Scope guards ───────────────────────────────────────────────────
    box_top = (lc[0] - 45, lc[1] - 60, lc[0] + 45, lc[1] - 40, "TOP")
    box_bot = (lc[0] - 45, lc[1] + 40, lc[0] + 45, lc[1] + 60, "BOT")
    vert_skipped = not waist_separates(box_top[:4], box_bot[:4], lm, {})
    all_pass &= vert_skipped
    print(f"{'PASS' if vert_skipped else 'FAIL <<<':8} scope: a vertically-separated pair is "
          f"never vetoed (vertical analogue deliberately not enabled — ordinary multi-line "
          f"dialogue is the hot path there)")

    near_a = (200, 120, 240, 140, "A")
    near_b = (244, 120, 284, 140, "B")   # x-centers ~44px apart but same lobe region
    close_a = (200, 120, 240, 140, "A")
    close_b = (205, 120, 245, 140, "B")  # x-centers 5px apart — under the span floor
    span_guard = not waist_separates(close_a[:4], close_b[:4], lm, {})
    all_pass &= span_guard
    print(f"{'PASS' if span_guard else 'FAIL <<<':8} scope: a pair whose x-centers are closer "
          f"than the minimum measurable span is not vetoed")

    none_map = not waist_separates(box_left[:4], box_right[:4], None, {})
    all_pass &= none_map
    print(f"{'PASS' if none_map else 'FAIL <<<':8} scope: label_map=None (segmentation "
          f"unavailable) never vetoes — falls back to prior behaviour")

    # ── 4. The real page ──────────────────────────────────────────────────
    page = _find_real_page()
    if page is None:
        print()
        print("SKIPPED (not a failure): the real Brazil_raw.jpg page isn't next to this")
        print("script or in eval_samples/, so the only test here that proves anything about")
        print("real pixels did not run. Tests 1-3 above are synthetic geometry. Put the page")
        print("in eval_samples/ and re-run to actually verify the fix.")
    else:
        from PIL import Image
        pil  = Image.open(page).convert("RGB")
        w, h = pil.size
        gray = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2GRAY)
        label_map = _server._find_bubble_components(gray, w, h)

        # Real RapidOCR fragment boxes from this page, as reported by
        # _run_rapidocr_detection. Bubble A = "Eu ouvi...", B = "Nozuki...".
        frags = [
            (632,  92, 687, 116, "NOZUKI,"),
            (635, 109, 688, 127, "SABE O"),
            (611, 121, 710, 143, "ACAMPAMENTO"),
            (616, 139, 706, 156, "ESCOLAR QUE"),
            (631, 153, 692, 170, "VAI TER?"),
            (534, 114, 590, 131, "EU OUVI"),
            (514, 126, 610, 146, "QUE ELES VÃO"),
            (521, 143, 605, 160, "SEPARAR OS"),
            (523, 155, 601, 175, "GAROTOS E"),
            (524, 171, 602, 191, "GAROTAS A"),
            (539, 186, 584, 204, "NOITE."),
        ]
        expect_a = "EU OUVI QUE ELES VÃO SEPARAR OS GAROTOS E GAROTAS A NOITE."
        expect_b = "NOZUKI, SABE O ACAMPAMENTO ESCOLAR QUE VAI TER?"

        regions, _ = merge(frags, w, h, bubble_label_map=label_map, gray=gray)
        texts = sorted(r["text"] for r in regions)
        ok_real = texts == sorted([expect_a, expect_b])
        all_pass &= ok_real
        print(f"{'PASS' if ok_real else 'FAIL <<<':8} REAL PAGE: the two fused bubbles split "
              f"into two correctly-ordered regions")
        for t in texts:
            print(f"             {t!r}")

        # Companion: with the veto disabled, the same input must reproduce
        # the originally-reported single garbled region.
        # Disabled via an explicit VetoSet rather than by monkeypatching
        # _server._waist_separates_boxes. Since merging moved to mtl/merge.py,
        # that module imported the veto into its own namespace, so rebinding
        # server's alias no longer reaches the call site — and would still
        # have appeared to work in the flattened single-file build, where the
        # two names are the same object. See VetoSet's docstring.
        vetoes_off = _server.VetoSet(waist_separates=lambda *a, **k: False)
        regions_off, _ = merge(frags, w, h, bubble_label_map=label_map,
                               gray=gray, vetoes=vetoes_off)
        ok_repro = len(regions_off) == 1
        all_pass &= ok_repro
        print(f"{'PASS' if ok_repro else 'FAIL <<<':8} companion: with the waist veto disabled "
              f"the same real fragments reproduce the reported single garbled region "
              f"(got {len(regions_off)})")
        if regions_off:
            print(f"             {regions_off[0]['text']!r}")

    print()
    if all_pass:
        print("ALL PASS")
    else:
        print("SOME FAILED — see FAIL rows above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
