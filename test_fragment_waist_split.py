#!/usr/bin/env python3
"""
test_fragment_waist_split.py — regression test for splitting a single OCR
fragment that a detector drew straight across two fused bubbles:
_waist_split_column / _column_respected_by_layout (mtl/geometry.py) and
_split_fragment_at_waist (server.py).

BACKGROUND
  See ES_LA_OCR_EVAL.md section F. On Shinobigoto ch65 p05 RapidOCR emits
  ONE detection box, x1461-1976, 515px wide, reading

      "...SERÁS LA CONTRA MÍ EN"

  which is the left balloon's line and the right balloon's line
  concatenated, then handed to the translator as one string.

  This is NOT the bug test_fused_bubble_waist.py covers. That one is a
  MERGE-stage fault — two correct fragments wrongly grouped — fixable by
  refusing the merge. This one arrives already fused inside a single
  fragment, and _merge_bubble_regions groups whole fragments and never
  divides one, so no veto there can reach it. Test 6's companion check
  pins that down.

  Recognition is not what failed: all five words were read correctly. Only
  the grouping was. RapidOCR reports a box per word when asked
  (return_word_box=True, measured free and byte-identical at the fragment
  level), so the fix deals each word to the correct side by its own x
  position — no re-OCR.

THE TWO GATES, AND WHY BOTH
  Measured over 59 real pages, the shape signal ALONE proposed 103 splits
  of which only 12 were genuine — it cut inside single words ("TEN-" ->
  "TE"/"N-"), because a 1-D extent profile cannot tell two balloons side by
  side from two balloons stacked diagonally with both words in the upper
  one. Depth thresholds do not rescue it: real false positives score 9-10
  on every depth measure while real true positives score 6-7.

  Adding the layout gate — do the page's other lines stop at this column,
  or run through it — took the same corpus to 8 correct splits and 0
  incorrect. Tests 3 and 4 are those two halves.

  Precision is the bar, not recall. A missed split leaves a page no worse
  than today; a wrong split is permanent, because _waist_separates_boxes
  then also refuses to merge the halves back.

WHAT THIS TESTS
  Imports server.py directly (not a copy). Tests 1-5 are synthetic; test 6
  runs against the real page if present, and is the only one here that
  proves anything about real pixels.
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
    with io.StringIO():
        _spec.loader.exec_module(_server)
except Exception as e:
    print(f"Could not import server.py directly ({e}).")
    sys.exit(1)

split_column     = _server._waist_split_column
layout_respects  = _server._column_respected_by_layout
split_fragment   = _server._split_fragment_at_waist


def _fused_labelmap():
    """Two overlapping ellipses: ONE component pinched into a figure-8."""
    h, w = 300, 560
    mask = np.zeros((h, w), np.uint8)
    lc, rc = (200, 150), (360, 150)
    cv2.ellipse(mask, lc, (105, 95), 0, 0, 360, 1, -1)
    cv2.ellipse(mask, rc, (105, 95), 0, 0, 360, 1, -1)
    num, lm = cv2.connectedComponents(mask, connectivity=8)
    assert num == 2, f"expected one component, got {num - 1}"
    return lm, lc, rc


def _single_labelmap():
    """One ellipse — no constriction anywhere."""
    h, w = 300, 560
    mask = np.zeros((h, w), np.uint8)
    cv2.ellipse(mask, (280, 150), (240, 110), 0, 0, 360, 1, -1)
    num, lm = cv2.connectedComponents(mask, connectivity=8)
    assert num == 2
    return lm


def _words(spans, y1=138, y2=168):
    """[(text, x1, x2), …] -> the (text, conf, box) shape the splitter takes."""
    return [(t, 0.99, (float(x1), float(y1), float(x2), float(y2)))
            for t, x1, x2 in spans]


def _find_real_page():
    for p in ("es-la_shinobigoto_ch65_p05.png",
              os.path.join("eval_samples", "es-la_shinobigoto_ch65_p05.png")):
        if os.path.exists(p):
            return p
    return None


def main():
    all_pass = True
    lm, lc, rc = _fused_labelmap()
    frag = (120.0, 138.0, 440.0, 168.0, "LEFTA LEFTB RIGHTA RIGHTB")
    words = _words([("LEFTA", 120, 190), ("LEFTB", 200, 270),
                    ("RIGHTA", 300, 370), ("RIGHTB", 380, 440)])

    # ── 1. The waist column is found, and it is between the lobes ─────────
    col = split_column(lm, (110, 138, 450, 168), 150, 410, {})
    mid = (lc[0] + rc[0]) // 2
    ok = col is not None and abs(col - mid) <= 20
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} waist column found at x={col} "
          f"(lobe centers {lc[0]}/{rc[0]}, midpoint {mid})")

    single = split_column(_single_labelmap(), (110, 138, 450, 168), 150, 410, {})
    ok = single is None
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} an unpinched single ellipse yields no split "
          f"column (got {single})")

    # ── 2. The W-shape: why endpoint sampling can't do this job ──────────
    lab = _server._dominant_component_for_box(lm, (110, 138, 450, 168))
    ext, off = _server._component_column_extents(lm, lab, {})
    i_a, i_b = 110 - off, 450 - off
    span = ext[i_a:i_b + 1]
    endpoint_ratio = float(span.min()) / min(float(ext[i_a]), float(ext[i_b]))
    edge_col = split_column(lm, (110, 138, 450, 168), 110, 450, {})
    ok = endpoint_ratio > _server._WAIST_RATIO_THRESHOLD and edge_col is not None
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} W-shape: judged from the span's own endpoints "
          f"the ratio is {endpoint_ratio:.3f} (above {_server._WAIST_RATIO_THRESHOLD}, i.e. "
          f"'not pinched'), but prominence still finds the waist at x={edge_col}")

    # ── 3. The layout gate, on its own ───────────────────────────────────
    # One neighbouring line crossing the column is tolerated (on a page of
    # fused bubbles the other lines are cross-bubble fragments too); two is
    # not. Both are checked, because the tolerance is the surprising half.
    near = [frag,
            (125.0, 180.0, 265.0, 210.0, "BELOW-LEFT"),
            (305.0, 180.0, 435.0, 210.0, "BELOW-RIGHT")]
    ok = layout_respects(280, frag, near)
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} layout gate: neighbouring lines that stop at "
          f"the column accept it")

    crossed = near + [(130.0, 210.0, 430.0, 240.0, "RUNS-THROUGH-1"),
                      (130.0, 245.0, 430.0, 275.0, "RUNS-THROUGH-2")]
    ok = not layout_respects(280, frag, crossed)
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} layout gate: two lines running through the "
          f"column reject it")

    one_crossing = near + [(130.0, 210.0, 430.0, 240.0, "RUNS-THROUGH-1")]
    ok = layout_respects(280, frag, one_crossing)
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} layout gate: ONE crossing line is tolerated "
          f"(_SPLIT_MAX_STRADDLERS={_server._SPLIT_MAX_STRADDLERS}) — on a page of fused "
          f"bubbles the other lines are cross-bubble fragments too")

    overhang = near + [(130.0, 210.0, 280.0 + 0.15 * 30, 240.0, "SLIGHT-OVERHANG")]
    ok = layout_respects(280, frag, overhang)
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} layout gate: a line overhanging the column by "
          f"less than {_server._SPLIT_STRADDLE_MARGIN_FACTOR}x its height doesn't count as "
          f"crossing (real left-bubble lines overrun by ~12px)")

    # ── 4. End to end, both gates ────────────────────────────────────────
    pieces = split_fragment(frag, 0.9, words, lm, near, {})
    texts = [p[0][4] for p in pieces]
    ok = texts == ["LEFTA LEFTB", "RIGHTA RIGHTB"]
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} both gates agreeing divides the fragment into "
          f"{texts}")

    pieces_blocked = split_fragment(frag, 0.9, words, lm, crossed, {})
    ok = len(pieces_blocked) == 1 and pieces_blocked[0][0] == frag
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} shape alone is NOT enough: the same pinched "
          f"component is left intact when the layout disagrees")

    if len(pieces) == 2:
        lb, rb = pieces[0][0], pieces[1][0]
        ok = lb[2] <= rb[0]
        all_pass &= ok
        print(f"{'PASS' if ok else 'FAIL <<<':8} the two halves get disjoint boxes "
              f"(x{lb[0]:.0f}-{lb[2]:.0f} | x{rb[0]:.0f}-{rb[2]:.0f}) and per-side "
              f"confidence")

    # ── 5. Degrade to no-op rather than raising ──────────────────────────
    checks = [
        ("no word boxes", split_fragment(frag, 0.9, None, lm, near, {})),
        ("one word only", split_fragment(frag, 0.9, _words([("X", 120, 190)]), lm, near, {})),
        ("no label map",  split_fragment(frag, 0.9, words, None, near, {})),
    ]
    for label, res in checks:
        ok = len(res) == 1 and res[0][0] == frag
        all_pass &= ok
        print(f"{'PASS' if ok else 'FAIL <<<':8} degrades safely: {label} returns the "
              f"fragment unchanged")

    bad = _server._normalise_word_group(("not-a-word-tuple",), 0)
    ok = bad is None
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} degrades safely: an unexpected word_results "
          f"shape yields None rather than raising (got {bad!r})")

    # ── 6. The real page ─────────────────────────────────────────────────
    page = _find_real_page()
    if page is None:
        print()
        print("SKIPPED (not a failure): es-la_shinobigoto_ch65_p05.png isn't next to this")
        print("script or in eval_samples/, so the only check here that proves anything")
        print("about real pixels did not run. Tests 1-5 above are synthetic geometry.")
    else:
        from PIL import Image
        pil  = Image.open(page).convert("RGB")
        w, h = pil.size
        gray = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2GRAY)
        real_lm = _server._find_bubble_components(gray, w, h)

        real_box = (1461.0, 356.0, 1974.0, 408.0, "...SERÁS LA CONTRA MÍ EN")
        real_words = _words([("...SERÁS", 1461, 1623), ("LA", 1632, 1683),
                             ("CONTRA", 1701, 1854), ("MÍ", 1872, 1923),
                             ("EN", 1924, 1974)], y1=356, y2=408)
        # The rest of the two balloons, as RapidOCR reports them. These are
        # the layout evidence: the left balloon's lines stop before the
        # waist, the right balloon's start after it.
        neighbours = [
            real_box,
            (1699.0, 277.0, 1969.0, 318.0, "CREES QUE SI"),
            (1751.0, 319.0, 1915.0, 362.0, "PIERDES"),
            (1517.0, 408.0, 1634.0, 451.0, "ÚNICA"),
            (1711.0, 406.0, 1959.0, 446.0, "UN COMBATE"),
            (1455.0, 445.0, 1689.0, 498.0, "CASTIGADA,"),
            (1756.0, 447.0, 1912.0, 490.0, "JUSTO..."),
            (1461.0, 533.0, 1688.0, 580.0, "TERMINARÁ."),
        ]

        pieces = split_fragment(real_box, 0.93, real_words, real_lm, neighbours, {})
        texts = [p[0][4] for p in pieces]
        ok = texts == ["...SERÁS LA", "CONTRA MÍ EN"]
        all_pass &= ok
        print(f"{'PASS' if ok else 'FAIL <<<':8} REAL PAGE: the 515px cross-bubble fragment "
              f"divides on the balloon waist")
        for t in texts:
            print(f"             {t!r}")

        # Companion: the whole point is that merging cannot do this. Feed the
        # UNSPLIT fragment through and confirm the wrong text survives into a
        # region — if it didn't, this fix would solve nothing new.
        regions, _ = _server._merge_bubble_regions(
            [real_box], w, h, bubble_label_map=real_lm, gray=gray)
        merged = [r["text"] for r in regions]
        ok = merged == ["...SERÁS LA CONTRA MÍ EN"]
        all_pass &= ok
        print(f"{'PASS' if ok else 'FAIL <<<':8} companion: left unsplit, merging cannot "
              f"repair it — the cross-bubble text survives into a region ({merged!r})")

    print()
    if all_pass:
        print("ALL PASS")
    else:
        print("SOME FAILED — see FAIL rows above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
