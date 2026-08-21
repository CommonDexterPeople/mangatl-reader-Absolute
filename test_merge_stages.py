#!/usr/bin/env python3
"""
test_merge_stages.py — unit tests for the individual stages of the bubble
merge pipeline (mtl/merge.py).

WHY THIS FILE EXISTS
  The other merge tests (test_side_by_side_bubble_merge.py,
  test_fused_bubble_waist.py, test_bubble_outline_tracing.py,
  test_adjacent_container_gap.py) all drive the WHOLE pipeline and assert on
  the regions that come out the far end. That is the right shape for them —
  each pins a specific real-page bug end to end. But it means every one of
  them fails the same way, with a region count that is off by one, no matter
  which stage actually broke; and a stage with no end-to-end symptom on those
  particular pages is not covered at all.

  Until _merge_bubble_regions was decomposed, testing a stage on its own was
  not possible: margin computation, the union-find, the gap-profile veto,
  column detection and line clustering were closures inside one 739-line
  function, reachable only by calling the whole thing. This file covers each
  stage directly, so a failure names the stage.

WHAT IT DOES NOT DO
  These are synthetic inputs. They pin the CONTRACT of each stage (what it
  promises its caller), not the real-page tuning of the constants — that
  evidence lives in KNOWN_ISSUES_DRAFT.md and is guarded by the end-to-end
  tests above. A change that keeps every contract here and still breaks a
  real page is exactly what those tests are for; the two layers are
  complementary, not redundant.
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


_results = []


def check(ok: bool, label: str, detail: str = ""):
    _results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL <<<':8} {label}")
    if detail and not ok:
        print(f"             {detail}")


# ── Stage 1: compute_merge_margins ────────────────────────────────────────────

def test_margins():
    print("\n-- compute_merge_margins --")
    cmm = _server.compute_merge_margins

    # Each box reaches according to its OWN height, not a page-wide median.
    # This is the bug the per-box margin replaced: a page mixing small SFX
    # with a large bubble used to derive one small global margin from the
    # small-text median, too small to bridge the large bubble's own leading.
    boxes = [(0, 0, 100, 10, "small"), (0, 0, 100, 100, "big")]
    mv, mh = cmm(boxes, 1000, 1500, margin_scale=0.5)
    check(mv[1] > mv[0] * 5,
          "vertical margin scales with each box's OWN height",
          f"small={mv[0]} big={mv[1]}")

    # Horizontal reach is deliberately much tighter than vertical.
    check(all(h < v for h, v in zip(mh, mv)),
          "horizontal margin is tighter than vertical on every box",
          f"mv={mv} mh={mh}")
    ratio = _server.HORIZONTAL_GAP_FACTOR / _server.LINE_GAP_FACTOR
    expected_h = max(4, int(100 * 0.5 * _server.HORIZONTAL_GAP_FACTOR))
    check(mh[1] == expected_h,
          "horizontal margin equals height x scale x HORIZONTAL_GAP_FACTOR",
          f"got {mh[1]}, expected {expected_h} (ratio to vertical {ratio:.3f})")

    # Degenerate zero-height boxes still get the absolute floor, not 0px.
    mv0, mh0 = cmm([(0, 0, 10, 0, "noise")], 1000, 1500, margin_scale=0.5)
    check(mv0 == [4] and mh0 == [4],
          "zero-height box falls back to the 4px absolute floor",
          f"mv={mv0} mh={mh0}")

    # Webtoon strips (aspect > 2) get 60% reach so stacked panels don't bridge.
    tall_v, _ = cmm(boxes, 800, 4000, margin_scale=0.5)
    norm_v, _ = cmm(boxes, 800, 1200, margin_scale=0.5)
    check(tall_v[1] < norm_v[1],
          "webtoon aspect ratio shrinks vertical reach",
          f"webtoon={tall_v[1]} normal={norm_v[1]}")

    # margin_scale is the user-facing slider and must move reach monotonically.
    seq = [cmm(boxes, 1000, 1500, margin_scale=s)[0][1] for s in (0.2, 0.5, 1.0, 1.5)]
    check(seq == sorted(seq) and seq[0] < seq[-1],
          "margin_scale moves reach monotonically", f"{seq}")


# ── expand_box / boxes_overlap ────────────────────────────────────────────────

def test_expand_and_overlap():
    print("\n-- expand_box / boxes_overlap --")
    e = _server.expand_box((100, 100, 200, 140, "t"), margin_v=20, margin_h=5)
    check(e == (95, 80, 205, 160), "expand_box grows per-axis", f"{e}")

    ov = _server.boxes_overlap
    check(ov((0, 0, 10, 10), (10, 10, 20, 20)), "touching rects count as overlapping")
    check(not ov((0, 0, 10, 10), (11, 0, 20, 10)), "a 1px gap is not an overlap")
    check(ov((0, 0, 100, 100), (20, 20, 30, 30)), "containment counts as overlapping")


# ── _UnionFind ────────────────────────────────────────────────────────────────

def test_union_find():
    print("\n-- _UnionFind --")
    u = _server._UnionFind(6)
    check(len({u.find(i) for i in range(6)}) == 6, "starts fully disjoint")
    u.union(0, 1); u.union(1, 2); u.union(4, 5)
    roots = {u.find(i) for i in range(6)}
    check(len(roots) == 3, "transitive unions collapse to one root", f"roots={roots}")
    check(u.find(0) == u.find(2), "0 and 2 share a root via 1")
    check(u.find(0) != u.find(3), "3 stays on its own")
    u.union(0, 0)
    check(len({u.find(i) for i in range(6)}) == 3, "self-union is a no-op")


# ── Stage 2: vertical_gap_band ────────────────────────────────────────────────

def test_vertical_gap_band():
    print("\n-- vertical_gap_band --")
    band = _server.vertical_gap_band

    # The case the profile veto exists for: cleanly stacked, real gap.
    b = band((100, 100, 300, 140), (100, 160, 300, 200))
    check(b == (100, 140, 300, 160), "stacked pair yields the band between them", f"{b}")

    # THE REGRESSION THIS PROTECTS (see the docstring lifted into this
    # function): OCR line boxes commonly overlap slightly in y even for
    # genuinely separate, correctly-read lines. An earlier version always
    # picked SOME pair of edges as "the gap", producing a band spanning both
    # boxes' actual text ink — which then read as "continuous ink" and vetoed
    # a merge that should have gone through. Overlapping pairs must return
    # None so the profile check is skipped entirely.
    check(band((100, 1042, 300, 1079), (100, 1075, 300, 1111)) is None,
          "y-overlapping pair returns None (no coherent gap to profile)")

    # Side-by-side fragments have no inter-line gap to read.
    check(band((100, 100, 200, 140), (220, 100, 320, 140)) is None,
          "side-by-side pair returns None")

    # Order must not matter.
    lo, hi = (100, 100, 300, 140), (100, 160, 300, 200)
    check(band(lo, hi) == band(hi, lo), "band is symmetric in argument order")

    # Exactly touching boxes have a zero-height gap, which is not profilable.
    check(band((100, 100, 300, 140), (100, 140, 300, 180)) is None,
          "touching boxes (zero-height gap) return None")


# ── Stage 2: profile_confirms_gap ─────────────────────────────────────────────

def _page(fill=255):
    return np.full((400, 400), fill, dtype=np.uint8)


def _write_text(g, box, ink):
    """Paint a realistic text fragment: mostly bubble fill, with glyph strokes.

    Deliberately NOT a solid rectangle of ink. Polarity is inferred from a
    fragment's BULK brightness (see profile_confirms_gap docstring points 2
    and 3), so a solid-black "fragment" is indistinguishable from a dark-fill
    bubble and correctly flips the function to inverted polarity — which makes
    a solid-rectangle fixture test the opposite of what it looks like it tests.
    Real dark-on-light text leaves its box mostly light.
    """
    x1, y1, x2, y2 = box
    for x in range(x1 + 4, x2 - 4, 12):      # ~1/3 coverage, like real glyphs
        g[y1 + 6:y2 - 6, x:x + 4] = ink


def test_profile_confirms_gap():
    print("\n-- profile_confirms_gap --")
    pcg = _server.profile_confirms_gap
    frag_a, frag_b = (100, 100, 300, 140), (100, 180, 300, 220)

    # Clean white valley between two dark-text fragments -> merge is safe.
    g = _page(255)
    _write_text(g, frag_a, 0)
    _write_text(g, frag_b, 0)
    check(pcg(g, (100, 140, 300, 180), frag_a, frag_b) is True,
          "clean whitespace valley confirms the gap")

    # A full-width ink bridge across the gap must veto, even though clean
    # space flanks it on both sides (docstring point 4).
    g2 = g.copy()
    g2[158:162, 100:300] = 0
    check(pcg(g2, (100, 140, 300, 180), frag_a, frag_b) is False,
          "full-width ink bridge vetoes despite clear space on both sides")

    # Solid ink the whole way through -> no valley at all.
    g3 = g.copy()
    g3[140:180, 100:300] = 0
    check(pcg(g3, (100, 140, 300, 180), frag_a, frag_b) is False,
          "continuous ink across the band vetoes")

    # A narrow speck is not a bridge and must not veto.
    g4 = g.copy()
    g4[158:162, 150:156] = 0
    check(pcg(g4, (100, 140, 300, 180), frag_a, frag_b) is True,
          "a narrow speck in the gap does not veto")

    # Inverted polarity (light text on a dark bubble): polarity is sampled
    # from the FRAGMENTS, not the band — a densely-inked band would otherwise
    # be misread as an inverted background (docstring points 2 and 3).
    gi = _page(0)
    _write_text(gi, frag_a, 255)
    _write_text(gi, frag_b, 255)
    check(pcg(gi, (100, 140, 300, 180), frag_a, frag_b) is True,
          "inverted-polarity bubble reads its valley correctly")
    gi2 = gi.copy()
    gi2[158:162, 100:300] = 255
    check(pcg(gi2, (100, 140, 300, 180), frag_a, frag_b) is False,
          "inverted-polarity full-width bridge still vetoes")

    # Inconclusive cases must return None, never False — an inconclusive read
    # falls back to distance and must not block a merge on its own.
    check(pcg(None, (100, 140, 300, 180), frag_a, frag_b) is None,
          "no gray image -> None (inconclusive), not False")
    check(pcg(g, (100, 140, 102, 180), frag_a, frag_b) is None,
          "band narrower than 4px -> None")
    check(pcg(g, (100, 140, 300, 141), frag_a, frag_b) is None,
          "band shorter than 2px -> None")
    check(pcg(g, (100, 140, 300, 180), (0, 0, 0, 0), (0, 0, 0, 0)) is None,
          "no usable fragment-polarity sample -> None")


# ── Stage 2: the veto seam ────────────────────────────────────────────────────

def test_veto_seam():
    print("\n-- structural_veto / pair_is_vetoed / VetoSet --")
    a, b = (100, 100, 200, 140), (100, 160, 200, 200)

    check(not _server.structural_veto(a, b, [], []),
          "no borders, no label map -> nothing vetoes")

    # A horizontal panel border lying in the gap blocks the merge.
    check(_server.structural_veto(a, b, [150], []),
          "a panel border in the gap vetoes")

    # Each veto is independently overridable, and an override actually takes
    # effect at the real call site (the thing monkeypatching stopped doing
    # once merging moved into its own module).
    always = _server.VetoSet(waist_separates=lambda *x, **k: True)
    check(_server.structural_veto(a, b, [], [], vetoes=always),
          "an injected always-veto blocks a pair nothing else objects to")
    never = _server.VetoSet(crosses_border=lambda *x, **k: False)
    check(not _server.structural_veto(a, b, [150], [], vetoes=never),
          "an injected never-veto disables the border check")

    # The default set must be the real functions, so omitting `vetoes`
    # anywhere in the chain cannot silently disable a veto.
    d = _server.DEFAULT_VETOES
    check(d.crosses_border is _server._crosses_border
          and d.crosses_bubble_boundary is _server._crosses_bubble_boundary
          and d.waist_separates is _server._waist_separates_boxes,
          "DEFAULT_VETOES wires up the real geometry functions")

    # pair_is_vetoed must consult the pixels too, not only shape.
    g = _page(255)
    g[100:140, 100:200] = 0
    g[160:200, 100:200] = 0
    g[148:152, 100:200] = 0      # full-width bridge
    check(_server.pair_is_vetoed(a, b, [], [], gray=g),
          "pair_is_vetoed applies the gap-profile veto as well as shape")
    check(not _server.pair_is_vetoed(a, b, [], [], gray=None),
          "with no image, only the structural vetoes apply")


# ── Stage 3: grouping and confidence filtering ────────────────────────────────

def test_container_veto():
    """Text in a bubble vs text on artwork — the territory map and its veto."""
    print("\n-- _bubble_territory_map / _different_containers_separate_boxes --")
    import cv2
    from mtl.geometry import (_bubble_territory_map, _box_container,
                              _different_containers_separate_boxes,
                              _find_bubble_components)

    # A page with one white bubble on dark artwork. Dark LETTERS inside the
    # bubble are what make this a real test: they are holes in the bubble's
    # light region, and the whole point of the territory map is that a
    # fragment sitting on them still counts as inside the bubble.
    g = np.full((400, 400), 40, dtype=np.uint8)          # dark artwork
    cv2.ellipse(g, (260, 200), (110, 90), 0, 0, 360, 250, -1)   # bubble fill
    cv2.ellipse(g, (260, 200), (110, 90), 0, 0, 360, 30, 3)     # bubble outline
    for y in (170, 210):                                  # letters inside it
        cv2.rectangle(g, (200, y), (320, y + 22), 30, -1)
    # Caption on the artwork, drawn as outlined LETTER STROKES rather than a
    # solid white block. That distinction is the fixture's whole validity: a
    # solid block is itself a flat light region, so _find_bubble_components
    # gives it its own component and it stops being the "text with no
    # container" case this is meant to cover. Real free-floating manga
    # lettering is strokes on artwork, and forms no component — measured at
    # 0-2% territory coverage on eval_samples/caption_welds_to_bubble.jpg.
    for y in (170, 210):
        for x in range(20, 130, 14):
            cv2.rectangle(g, (x, y), (x + 5, y + 22), 245, -1)

    lbl  = _find_bubble_components(g, 400, 400)
    terr = _bubble_territory_map(lbl)
    check(terr is not None, "territory map is produced")

    in_bubble_a = (200, 170, 320, 192)
    in_bubble_b = (200, 210, 320, 232)
    on_art_a    = (20, 170, 130, 192)
    on_art_b    = (20, 210, 130, 232)

    lab_in,  cov_in  = _box_container(terr, in_bubble_a)
    lab_out, cov_out = _box_container(terr, on_art_a)
    # Filling the holes is the whole trick: a fragment sitting ON the letters
    # must still read as inside the bubble, not as a hole in it.
    check(lab_in > 0 and cov_in > 0.9,
          "a fragment on the bubble's own letters reads as fully inside it",
          f"label={lab_in} coverage={cov_in:.2f}")
    check(cov_out < 0.15,
          "a fragment on artwork reads as outside every bubble",
          f"label={lab_out} coverage={cov_out:.2f}")

    dc = _different_containers_separate_boxes
    check(dc(in_bubble_a, on_art_a, terr),
          "bubble text vs artwork text is refused")
    check(not dc(in_bubble_a, in_bubble_b, terr),
          "two fragments of the SAME bubble are not refused")
    check(not dc(on_art_a, on_art_b, terr),
          "two fragments of the same artwork caption are not refused")
    check(not dc(in_bubble_a, on_art_a, None),
          "no territory map (segmentation unavailable) never refuses")

    # THE DEAD BAND. A fragment straddling a bubble's edge is ambiguous, and
    # ambiguity must abstain — the single-cutoff version of this veto refused
    # such a pair against its own same-bubble neighbour, cutting a line in
    # half. Verified against the real geometry in test_bubble_outline_tracing.
    straddle = (60, 190, 260, 212)       # mostly on artwork, right end in the bubble
    _, cov_s = _box_container(terr, straddle)
    # Assert against the implementation's OWN band rather than a hand-picked
    # range: an earlier version of this check used a looser window, which let
    # a fixture that was actually 84% inside — i.e. confidently in the bubble,
    # not ambiguous at all — pass as if it were testing the dead band.
    from mtl.geometry import _CONTAINER_INSIDE, _CONTAINER_OUTSIDE
    check(_CONTAINER_OUTSIDE < cov_s < _CONTAINER_INSIDE,
          "the straddling fixture really is in the ambiguous band",
          f"coverage={cov_s:.2f}, band is {_CONTAINER_OUTSIDE}-{_CONTAINER_INSIDE}")
    check(not dc(straddle, in_bubble_a, terr),
          "a straddling fragment is NOT refused against bubble text (abstains)")
    check(not dc(straddle, on_art_a, terr),
          "a straddling fragment is NOT refused against artwork text (abstains)")


def test_grouping():
    print("\n-- group_fragment_boxes --")
    gfb = _server.group_fragment_boxes

    # Three lines of one bubble, one far-away fragment.
    boxes = [(100, 100, 300, 137, "L1"), (100, 145, 300, 182, "L2"),
             (100, 190, 300, 227, "L3"), (100, 900, 300, 937, "FAR")]
    groups = gfb(boxes, 1000, 1500, margin_scale=0.5)
    sizes = sorted(len(v) for v in groups.values())
    check(sizes == [1, 3], "three stacked lines group; a distant one does not",
          f"group sizes {sizes}")

    # Every index appears exactly once across all groups — nothing lost or
    # duplicated, which the region assembly downstream depends on.
    flat = sorted(i for v in groups.values() for i in v)
    check(flat == list(range(len(boxes))), "every box lands in exactly one group",
          f"{flat}")

    # A panel border between the lines splits them.
    split = gfb(boxes, 1000, 1500, margin_scale=0.5, h_borders=[141])
    check(sorted(len(v) for v in split.values()) == [1, 1, 2],
          "a panel border splits an otherwise-merging stack",
          f"{sorted(len(v) for v in split.values())}")

    check(gfb([], 1000, 1500) == {}, "no boxes -> no groups")


def test_confidence_filter():
    print("\n-- filter_groups_by_confidence --")
    fgc = _server.filter_groups_by_confidence
    groups = {0: [0, 1], 2: [2]}
    confs = [0.9, 0.35, 0.35]

    # Opt-in only: without both confidences and min_conf this is a no-op.
    check(fgc(dict(groups)) == groups, "no-op when the caller did not opt in")
    check(fgc(dict(groups), confidences=confs) == groups,
          "no-op when min_conf is missing")

    # The clustered rescue: 0.35 survives beside a confident neighbour, but
    # the identical isolated 0.35 fragment is dropped as noise.
    out = fgc(dict(groups), confidences=confs, min_conf=0.5, clustered_floor=0.3)
    check(out == {0: [0, 1]},
          "low-confidence fragment survives beside a confident neighbour, "
          "identical isolated one is dropped", f"{out}")

    # clustered_floor still guards against pure noise inside a real bubble.
    out2 = fgc(dict(groups), confidences=confs, min_conf=0.5, clustered_floor=0.4)
    check(out2 == {0: [0]}, "clustered_floor above the fragment drops it anyway",
          f"{out2}")

    # A group that loses every member disappears rather than becoming empty.
    out3 = fgc({0: [1, 2]}, confidences=confs, min_conf=0.5, clustered_floor=0.3)
    check(out3 == {}, "a group with no survivors is removed, not left empty",
          f"{out3}")


# ── Stage 4: reading order ────────────────────────────────────────────────────

def test_line_cluster():
    print("\n-- line_cluster --")
    lc = _server.line_cluster

    # THE REGRESSION THIS PROTECTS: two words on the same visual line can have
    # slightly different y1 (detection noise, or a short word's box simply not
    # spanning the same vertical range as a taller neighbour). A naive sort by
    # (y1, x1) puts "un" after "paseo tranquilo." because its y1 is a few px
    # lower. Clustering by vertical OVERLAP first is robust to that.
    boxes = [(200, 104, 400, 138, "paseo tranquilo."),
             (100, 100, 180, 140, "un")]
    order = lc(boxes, [0, 1])
    check([boxes[i][4] for i in order] == ["un", "paseo tranquilo."],
          "same-line words read left-to-right despite differing y1",
          f"{[boxes[i][4] for i in order]}")

    # Lines still order top-to-bottom.
    multi = [(100, 200, 300, 240, "second"), (100, 100, 300, 140, "first"),
             (320, 100, 400, 140, "line")]
    order2 = lc(multi, [0, 1, 2])
    check([multi[i][4] for i in order2] == ["first", "line", "second"],
          "lines order top-to-bottom, fragments left-to-right within a line",
          f"{[multi[i][4] for i in order2]}")

    check(lc(boxes, []) == [], "empty input -> empty order")
    check(lc(boxes, [1]) == [1], "single fragment passes through")


def test_column_split():
    print("\n-- detect_column_split --")
    dcs = _server.detect_column_split

    # Two genuine side-by-side columns must be detected so they are read one
    # column fully at a time, not interleaved line by line.
    two_col = []
    for r in range(4):
        y = 100 + r * 50
        two_col.append((100, y, 280, y + 40, f"L{r}"))
        two_col.append((400, y, 580, y + 40, f"R{r}"))
    got = dcs(two_col, list(range(len(two_col))))
    check(got is not None and len(got[0]) == 4 and len(got[1]) == 4,
          "two parallel columns are detected", f"{got}")

    # THE KEY CHECK this stage exists for: a SHORT but genuinely parallel
    # second column must still be detected. Requiring the shorter side to
    # span some fraction of total height would wrongly reject it.
    short_right = [b for b in two_col if not b[4].startswith("R")]
    short_right += [(400, 100, 580, 140, "R0"), (400, 150, 580, 190, "R1")]
    got2 = dcs(short_right, list(range(len(short_right))))
    check(got2 is not None and len(got2[1]) == 2,
          "a short but parallel second column is still detected", f"{got2}")

    # A trailing line at the BOTTOM of a paragraph sits below it with little
    # y-overlap, and must NOT be mistaken for a second column.
    trailing = [(100, 100 + r * 50, 280, 140 + r * 50, f"L{r}") for r in range(4)]
    trailing += [(400, 320, 580, 360, "T0"), (400, 370, 580, 410, "T1")]
    check(dcs(trailing, list(range(len(trailing)))) is None,
          "a trailing block below the paragraph is not a second column")

    # One column, and too-few-fragments cases, fall through.
    one_col = [(100, 100 + r * 50, 300, 140 + r * 50, f"L{r}") for r in range(5)]
    check(dcs(one_col, list(range(5))) is None, "a single column is not split")
    check(dcs(two_col, [0, 1]) is None, "fewer than 2x min_fragments -> None")


def test_order_fragments():
    print("\n-- order_fragments --")
    two_col = []
    for r in range(3):
        y = 100 + r * 50
        two_col.append((100, y, 280, y + 40, f"L{r}"))
        two_col.append((400, y, 580, y + 40, f"R{r}"))
    order = _server.order_fragments(two_col, list(range(len(two_col))))
    names = [two_col[i][4] for i in order]
    check(names == ["L0", "L1", "L2", "R0", "R1", "R2"],
          "columns read left fully, then right — not interleaved", f"{names}")


# ── Stage 5: assemble_region ──────────────────────────────────────────────────

def test_assemble_region():
    print("\n-- assemble_region --")
    ar = _server.assemble_region

    # Hyphen rejoin across a line break.
    boxes = [(100, 100, 200, 140, "SHUN-"), (100, 150, 200, 190, "PEI.")]
    r = ar(boxes, [0, 1], 1000, 1000)
    check(r["text"] == "SHUNPEI.", "trailing hyphen rejoins across lines", r["text"])

    # Non-hyphenated fragments join with a space.
    boxes2 = [(100, 100, 200, 140, "HELLO"), (100, 150, 200, 190, "THERE")]
    check(ar(boxes2, [0, 1], 1000, 1000)["text"] == "HELLO THERE",
          "plain fragments join with a single space")

    # Geometry is emitted as percentages of the page, from the union box.
    r2 = ar(boxes2, [0, 1], 1000, 1000)
    check(r2["box"] == [10.0, 10.0, 20.0, 19.0],
          "box is the union, as page percentages", f"{r2['box']}")
    check(r2["cx"] == 15.0 and r2["cy"] == 14.5,
          "centre is the union box's centre, as percentages",
          f"cx={r2['cx']} cy={r2['cy']}")

    # Region confidence is the MIN across fragments, not the average — a
    # merged region is only as trustworthy as its weakest fragment.
    r3 = ar(boxes2, [0, 1], 1000, 1000, confidences=[0.95, 0.40])
    check(r3["confidence"] == 0.4, "confidence is the min across fragments",
          f"{r3['confidence']}")
    check(ar(boxes2, [0, 1], 1000, 1000)["confidence"] is None,
          "confidence is None when the caller never opted in")


def main():
    test_margins()
    test_expand_and_overlap()
    test_union_find()
    test_vertical_gap_band()
    test_profile_confirms_gap()
    test_veto_seam()
    test_container_veto()
    test_grouping()
    test_confidence_filter()
    test_line_cluster()
    test_column_split()
    test_order_fragments()
    test_assemble_region()

    print()
    passed = sum(1 for r in _results if r)
    if all(_results):
        print(f"ALL PASS — {passed} stage-level checks.")
        return 0
    print(f"SOME FAILED — {passed}/{len(_results)} passed; see FAIL rows above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
