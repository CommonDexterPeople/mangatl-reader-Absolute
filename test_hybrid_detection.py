#!/usr/bin/env python3
"""
test_hybrid_detection.py — covers _run_hybrid_detection and its spatial
fragment matcher.

WHAT THIS PROTECTS
  The hybrid path takes RapidOCR's BOXES (and therefore the region grouping)
  and EasyOCR's TEXT, for languages where that measurably beats either engine
  alone. Measured on eval_samples/Vietname pages/Vietnam page.png against
  hand-read ground truth:

      RapidOCR only   mean similarity 0.789   diacritic density  8.0%
      EasyOCR only                    0.759                     15.7%
      hybrid                          0.835                     14.2%
      (ground truth)                  1.000                     23.2%

  RapidOCR drops roughly two thirds of Vietnamese tone marks; EasyOCR keeps
  more of them but groups worse. The full numbers, and the same gain
  reproduced on two more pages, are in KNOWN_ISSUES_DRAFT.md.

  The scope guards matter as much as the mechanism: a language outside
  _HYBRID_LANGS must NOT pay for a second inference pass, and Korean must
  route to EasyOCR alone because RapidOCR has no Korean coverage at all.

HOW TO RUN
  python test_hybrid_detection.py
  Synthetic geometry for the matcher plus dispatch checks — no page images
  and no OCR run needed, so this stays fast. The real-page evidence lives in
  KNOWN_ISSUES_DRAFT.md; re-measure there when changing _HYBRID_LANGS.
"""
import importlib.util
import sys

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


def main():
    ok = True
    match = _server._match_fragments_spatially

    # ── 1. Overlapping boxes pair; disjoint ones don't ────────────────────
    a = [(10, 10, 110, 50, "A0"), (10, 60, 110, 100, "A1"), (500, 500, 600, 540, "A2")]
    b = [(12, 12, 112, 52, "B0"), (14, 62, 108, 98, "B1")]
    m = match(a, b)
    good = (set(m) == {0, 1}) and m[0][0] == 0 and m[1][0] == 1
    ok &= good
    print(f"{'PASS' if good else 'FAIL <<<':8} overlapping fragments pair 1:1 by position, "
          f"the far-away one stays unmatched (got {sorted(m)})")

    # ── 2. Greedy 1:1 — one box can't claim two partners ──────────────────
    a2 = [(0, 0, 100, 40, "A")]
    b2 = [(2, 2, 98, 38, "B_close"), (5, 5, 95, 35, "B_also")]
    m2 = match(a2, b2)
    one_to_one = len(m2) == 1 and len(set(j for j, _ in m2.values())) == 1
    ok &= one_to_one
    print(f"{'PASS' if one_to_one else 'FAIL <<<':8} matching is 1:1 — a fragment claims at "
          f"most one partner even when several overlap it")

    # ── 3. Text is NOT used, so corruption can't break the pairing ────────
    # This is the reason the matcher is spatial: the whole point is that one
    # engine's text is wrong, so matching on text would assume the answer.
    a3 = [(10, 10, 110, 50, "LAN DUY NHAT TOI TUNG CHONG DI B ME")]
    b3 = [(11, 11, 109, 49, "LẦN DUY NHẤT TÔI TỪNG CHỐNG ĐỐI BỐ MẸ")]
    m3 = match(a3, b3)
    text_blind = (0 in m3)
    ok &= text_blind
    print(f"{'PASS' if text_blind else 'FAIL <<<':8} pairing ignores text entirely — "
          f"diacritic-stripped and correct readings of the same line still match")

    # ── 4. Below-threshold overlap is rejected ────────────────────────────
    a4 = [(0, 0, 100, 40, "A")]
    b4 = [(90, 30, 190, 70, "B")]        # slivered corner overlap only
    rejected = len(match(a4, b4)) == 0
    ok &= rejected
    print(f"{'PASS' if rejected else 'FAIL <<<':8} a sliver of overlap is not a match "
          f"(min IoU {_server._HYBRID_MIN_IOU})")

    # ── 5. Scope: only the measured languages take the two-pass path ──────
    langs_ok = _server._HYBRID_LANGS == {"vi"}
    ok &= langs_ok
    print(f"{'PASS' if langs_ok else 'FAIL <<<':8} _HYBRID_LANGS is exactly {{'vi'}} — the only "
          f"language measured (got {_server._HYBRID_LANGS}); adding one needs real before/after "
          f"numbers, see KNOWN_ISSUES_DRAFT.md")

    # ── 6. Dispatch: hybrid is selectable and falls through correctly ─────
    import inspect
    route_src = inspect.getsource(_server.ocr_page)
    wired = '"hybrid"' in route_src and "_run_hybrid_detection" in route_src
    ok &= wired
    print(f"{'PASS' if wired else 'FAIL <<<':8} /ocr accepts local_engine='hybrid' and "
          f"dispatches to _run_hybrid_detection")

    hy_src = inspect.getsource(_server._run_hybrid_detection)
    guards = ('lang == "ko"' in hy_src and "_run_easyocr_detection" in hy_src
              and "_HYBRID_LANGS" in hy_src and "_run_rapidocr_detection" in hy_src)
    ok &= guards
    print(f"{'PASS' if guards else 'FAIL <<<':8} scope guards present: Korean routes to EasyOCR "
          f"alone (RapidOCR has no Korean coverage), other languages fall through to a single "
          f"engine rather than paying for two passes")

    print()
    print("ALL PASS" if ok else "SOME FAILED — see FAIL rows above.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
