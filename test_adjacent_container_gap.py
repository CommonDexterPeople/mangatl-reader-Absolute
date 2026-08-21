#!/usr/bin/env python3
"""
test_adjacent_container_gap.py — regression test for HORIZONTAL_GAP_FACTOR.

WHAT THIS PROTECTS
  Two ADJACENT TEXT CONTAINERS separated only by a clean whitespace gutter
  must not be merged into one region. Before HORIZONTAL_GAP_FACTOR was
  lowered from 0.5 to 0.3, three real pages produced a single region with
  both containers' lines interleaved, e.g.:

    'Y ENCIMA, EN EL CAPÍTULO T¿Y EN ESE MOMENTO 2, CUANDO AKAYA, QUE DEJÓ
     AKAYA TAMPOCO SE ESTÁ EL TENIS DE MESA EN LA COLUMPIANDO, SOLO ESTÁ …'

  which is two side-by-side caption boxes read as one. Hit on BOTH engines.

WHY THE OTHER VETOES CANNOT COVER THIS
  Measured on the real page: the gutter is pure 255 white, so there is no
  ink for _crosses_bubble_boundary or _bubble_outline_mask to find, and both
  boxes land in ONE flat-light component. The containers are RECTANGLES, so
  the silhouette has no constriction — the per-column extent across the
  gutter runs 348→355→363→372→379px, waist ratio 0.948 against a 0.85
  threshold, so _waist_separates_boxes correctly reports "no waist".
  Shape and ink are both structurally absent; gap SIZE is all that is left.

HOW TO RUN
  python test_adjacent_container_gap.py
  Synthetic geometry only — no page images needed, runs in under a second.
  The real-page evidence lives in KNOWN_ISSUES_DRAFT.md; this test pins the
  mechanism so the constant cannot drift back up unnoticed.
"""
import importlib.util
import sys

import numpy as np

_spec = importlib.util.spec_from_file_location("mangatl_server", "server.py")
_server = importlib.util.module_from_spec(_spec)
sys.modules["mangatl_server"] = _server
try:
    _spec.loader.exec_module(_server)
except ImportError as e:
    print(f"Could not import server.py: {e}")
    print("Install its module-scope deps first:")
    print("  pip install flask requests opencv-python-headless numpy pillow")
    sys.exit(1)


def _two_caption_boxes():
    """Two rectangular caption boxes side by side, sharing one flat-light
    component, separated by a clean white gutter — no ink, no constriction.

    Geometry mirrors the real page's proportions: ~37px line height, ~14px
    gutter between the nearest fragments' edges.
    """
    h, w = 420, 700
    label_map = np.zeros((h, w), np.int32)
    # ONE continuous component spanning both containers AND the gutter between
    # them. That is what the real page looks like: the gutter is pure white,
    # and white is flat+light, so _find_bubble_components includes it in the
    # mask rather than treating it as a boundary. This is precisely why the
    # silhouette has no constriction to measure — the mask never narrows.
    label_map[60:400, 40:660] = 1
    # 37px line height and a 14px gutter between the nearest fragment edges,
    # both taken from the real page. Those two numbers are what make this a
    # real test: margin_h = height x margin_scale x HORIZONTAL_GAP_FACTOR, so
    # the pair's combined horizontal reach is 37 x 0.5 x F x 2 = 37F. At the
    # old F=0.5 that is 18.5px, which bridges a 14px gutter and merges the two
    # containers; at F=0.3 it is 11.1px, which does not. Widen the gutter and
    # this test silently stops testing anything.
    left, right = [], []
    y = 80
    while y + 37 < 390:
        left.append((60, y, 316, y + 37, f"L{len(left)}"))
        right.append((330, y, 640, y + 37, f"R{len(right)}"))   # 330-316 = 14px gutter
        y += 45
    return label_map, left, right


def main():
    all_pass = True
    label_map, left, right = _two_caption_boxes()
    boxes = left + right
    h, w = label_map.shape

    # Companion check: this must exercise the GAP path, not another veto.
    la = _server._dominant_component_for_box(label_map, left[0][:4])
    lb = _server._dominant_component_for_box(label_map, right[0][:4])
    same = (la == lb and la != 0)
    all_pass &= same
    print(f"{'PASS' if same else 'FAIL <<<':8} companion: both containers are ONE component "
          f"(labels {la}/{lb}) — so _crosses_bubble_boundary cannot be what separates them")

    waist = _server._waist_separates_boxes(left[0][:4], right[0][:4], label_map, {})
    all_pass &= (not waist)
    print(f"{'PASS' if not waist else 'FAIL <<<':8} companion: rectangles have no constriction, "
          f"so the waist veto correctly does NOT fire (got {waist}) — gap size is the only signal left")

    regions, _ = _server._merge_bubble_regions(
        boxes, w, h, [], [], 0.5, bubble_label_map=label_map, gray=None)
    texts = [r["text"] for r in regions]
    mixed = [t for t in texts if "L0" in t and "R0" in t]
    ok = (len(regions) >= 2 and not mixed)
    all_pass &= ok
    print(f"{'PASS' if ok else 'FAIL <<<':8} fix: the two containers stay separate "
          f"({len(regions)} regions, no region mixes L* and R*)")
    if mixed:
        print(f"             interleaved region: {mixed[0][:100]}")

    # Guard the constant itself: at the old 0.5 this same layout merges.
    # Read straight off the module. This used to regex it out of server.py's
    # source text, because it was a local variable inside _merge_bubble_regions
    # and there was nothing to import. Now that merging lives in mtl/merge.py
    # it is a real module-level constant, so the test reads the value the code
    # actually uses rather than a value that merely appears in a source file.
    val = getattr(_server, "HORIZONTAL_GAP_FACTOR", None)
    within = val is not None and val <= 0.35
    all_pass &= within
    print(f"{'PASS' if within else 'FAIL <<<':8} constant: HORIZONTAL_GAP_FACTOR is {val} "
          f"(must stay <= 0.35 — RapidOCR needs <=0.35 and EasyOCR <=0.30 to fix the real pages)")

    print()
    if all_pass:
        print("ALL PASS — adjacent containers across a clean gutter stay separate.")
    else:
        print("SOME FAILED — see FAIL rows above.")
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
