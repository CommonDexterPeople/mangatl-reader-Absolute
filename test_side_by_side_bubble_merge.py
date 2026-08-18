#!/usr/bin/env python3
"""
test_side_by_side_bubble_merge.py — regression test for the horizontal /
vertical merge-margin split in _merge_bubble_regions().

BACKGROUND
  See KNOWN_ISSUES_DRAFT.md, "Confirmed, blocking: _merge_bubble_regions
  over-merges adjacent bubbles on RapidOCR's fragment output" and the
  HORIZONTAL_GAP_FACTOR comment block in server.py.

  Before this fix, _merge_bubble_regions expanded every OCR fragment's box
  by the SAME margin in every direction (margin(i) = height(i) x
  margin_scale x LINE_GAP_FACTOR). LINE_GAP_FACTOR was calibrated against
  normal VERTICAL same-bubble line spacing (~1.5x box height) — reusing it
  for HORIZONTAL reach meant the merge step could also bridge the real
  physical gap between two separate, side-by-side bubbles (bubble padding +
  border ink + the other bubble's padding), fusing their text into one
  garbled region. RapidOCR's smaller, more numerous fragments made this
  likelier to trigger in practice, but the gap in the geometry isn't
  engine-specific.

  Fix: horizontal reach now uses its own, much tighter
  HORIZONTAL_GAP_FACTOR, on the reasoning that the only legitimate
  same-bubble reason to bridge a horizontal gap at all is staggered/zigzag
  lettering inside one narrow bubble — tight same-bubble spacing, not
  line-height — while vertical reach (LINE_GAP_FACTOR) is untouched.

  An earlier idea — reuse _profile_confirms_gap's ink-valley technique for
  horizontal gaps the way it already works for vertical ones — was
  considered and rejected: a clean whitespace gap looks pixel-identical
  whether it's a normal word-space inside one bubble or open panel
  background between two different bubbles, so ink density can't
  distinguish the two cases. Only gap SIZE relative to normal same-bubble
  spacing can, which is what this geometric fix controls instead.

WHAT THIS TESTS
  Imports _merge_bubble_regions directly from the live server.py (not a
  copy) and runs it against synthetic box layouts:
    1. Two side-by-side DIFFERENT-bubble fragments with a moderate real
       gap (20px) — narrower than the OLD shared margin would have
       bridged (~27px combined), wider than the NEW horizontal margin
       bridges (~8px combined). Must NOT merge under the fix; a companion
       check confirms the old shared-margin math WOULD have merged this
       exact layout, so this test is actually exercising the fix and not
       just testing something neither version would have merged anyway.
    2. Two SAME-bubble staggered-lettering fragments with a tight gap
       (5px) — inside the new horizontal margin's reach. Must still
       merge (regression guard: legitimate horizontal merges shouldn't
       be collateral damage).
    3. Two vertically-stacked same-bubble lines (normal line spacing) —
       untouched code path, must still merge (regression guard for the
       vertical direction, which this fix deliberately did not change).
    4. A panel-border pair (must NOT merge) and a tight normal pair
       (must merge) as a basic sanity check that the rest of the merge
       pipeline (border veto, general grouping) still runs end to end.

  This validates the LOGIC against constructed layouts, not real manga
  pages — it cannot confirm the actual Brazil_raw.jpg case is fixed, or
  that a real staggered-lettering page still merges, since those need
  real pixels and real OCR output. See KNOWN_ISSUES_DRAFT.md's own
  fix-verification bar: re-run this exact page (and a handful of others
  with tightly-packed panels) through both engines and confirm (a)
  RapidOCR no longer merges the two bubbles and (b) EasyOCR's existing
  behavior doesn't regress. That step still needs to happen against real
  pages before this is trusted, same as every other constant in this file.

HOW TO RUN
  python test_side_by_side_bubble_merge.py
  (pure box-geometry logic, gray=None throughout so no image/OpenCV work
  happens — fast, no real pixels needed)
"""

import importlib.util
import sys

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

merge = _server._merge_bubble_regions


def region_count(boxes, **kwargs):
    regions, _ = merge(boxes, img_w=900, img_h=600, **kwargs)
    return len(regions), [r["text"] for r in regions]


def main():
    all_pass = True

    # ── 1. Side-by-side DIFFERENT bubbles, moderate real gap ──────────────
    # "SABE O" (bubble 1, line 2) / "EU OUVI" (bubble 2, line 1) — modeled
    # on the y-ranges from the confirmed Brazil_raw.jpg bug in
    # KNOWN_ISSUES_DRAFT.md. Real gap = 20px.
    box_a = (60, 109, 150, 127, "SABE O")     # height 18
    box_b = (170, 114, 260, 131, "EU OUVI")   # height 17, gap = 170-150 = 20

    n, texts = region_count([box_a, box_b])
    ok_new = n == 2
    all_pass &= ok_new
    print(f"{'PASS' if ok_new else 'FAIL <<<':8} fix: 20px different-bubble gap stays split "
          f"(got {n} region(s): {texts})")

    # Companion check: confirm the OLD shared-margin math (LINE_GAP_FACTOR
    # applied in both directions, pre-fix behaviour) really would have
    # merged this exact layout — otherwise this test isn't exercising the
    # fix at all, just confirming a large gap that was never in danger.
    old_margin = lambda h: max(4, int(h * 0.5 * 1.6))  # margin_scale=0.5 default
    old_reach = old_margin(18) + old_margin(17)
    real_gap = box_b[0] - box_a[2]
    ok_would_have_merged = old_reach > real_gap
    all_pass &= ok_would_have_merged
    print(f"{'PASS' if ok_would_have_merged else 'FAIL <<<':8} companion: old shared margin "
          f"({old_reach}px combined reach) exceeds the {real_gap}px gap — confirms "
          f"this layout is a real pre-fix false-merge case, not a vacuous test")

    # ── 2. Side-by-side SAME bubble (staggered lettering), tight gap ──────
    box_c = (400, 109, 460, 127, "COL1")   # height 18
    box_d = (465, 114, 520, 131, "COL2")   # height 17, gap = 465-460 = 5

    n, texts = region_count([box_c, box_d])
    ok = n == 1
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} regression: tight 5px staggered-lettering gap "
          f"still merges (got {n} region(s): {texts})")

    # ── 3. Vertically-stacked SAME bubble, normal line spacing ────────────
    box_e = (60, 200, 250, 220, "LINE ONE")   # height 20
    box_f = (60, 230, 250, 250, "LINE TWO")   # height 20, gap = 230-220 = 10

    n, texts = region_count([box_e, box_f])
    ok = n == 1
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} regression: normal 10px vertical line gap "
          f"still merges (got {n} region(s): {texts}) — vertical path is untouched "
          f"by this fix, so this should behave exactly as before")

    # ── 4. Basic pipeline sanity: panel border still vetoes a merge ───────
    box_g = (60, 300, 200, 320, "TOP PANEL")
    box_h = (60, 340, 200, 360, "BOTTOM PANEL")   # gap = 20, well within vertical reach
    n, texts = region_count([box_g, box_h], h_borders=[330], v_borders=[])
    ok = n == 2
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} sanity: panel border between two boxes still "
          f"vetoes the merge (got {n} region(s): {texts})")

    print()
    if all_pass:
        print("ALL PASS — the horizontal/vertical margin split blocks the constructed")
        print("false-merge case, without breaking legitimate horizontal or vertical")
        print("same-bubble merges, or the panel-border veto.")
        print()
        print("REMAINING STEP (not covered by this script): re-run the real")
        print("Brazil_raw.jpg page and a real staggered-lettering page through both")
        print("engines, per KNOWN_ISSUES_DRAFT.md's fix-verification bar.")
    else:
        print("SOME FAILED — see FAIL rows above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
