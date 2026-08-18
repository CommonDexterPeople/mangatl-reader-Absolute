"""
eval_ocr_engines.py — compare EasyOCR vs RapidOCR against a folder of real
manga/webtoon pages, using the app's actual preprocessing + tuned params +
real per-language min_conf filter (not library defaults — see Devlog,
"same math" comparisons gave a meaningfully different picture than
stock-defaults comparisons did).

This is the eval script called for in ROADMAP.md item 3: the per-language
engine recommendation in _LOCAL_ENGINE_RECOMMENDATION is currently based on
one manually-tested page per language. This script is how that gets
replaced with a real sample — run it, read the report, update the dict.

WHY FRAGMENT-LEVEL, NOT REGION-LEVEL:
This reports on raw_boxes_out (individual OCR fragments, pre-merge), not
on the final merged `regions` a page would actually render with. That's
deliberate: KNOWN_ISSUES_DRAFT.md documents a confirmed bug where
_merge_bubble_regions over-merges adjacent bubbles specifically on
RapidOCR's fragment output. Scoring at the region level right now would
conflate "did the engine read the text correctly" with "did an already-
known, already-tracked merge bug corrupt the grouping" — two different
questions. Once that bug is fixed, add a region-level pass alongside this
one; don't fold it into this report before then.

USAGE:
    python3 eval_ocr_engines.py [folder]        # default: ./eval_samples
    python3 eval_ocr_engines.py [folder] --json report.json

FILENAME CONVENTION:
    <lang>_<anything>.{jpg,png,...}   e.g. es_redopin_1.jpg, ko_webtoon_1.jpg
    The two-letter prefix before the first underscore is used as the `lang`
    argument to both detection functions and as the min_conf lookup key.
    Files that don't match this pattern are skipped with a warning, not
    silently dropped — an eval script that quietly excludes files you meant
    to include is worse than one that fails loudly.

WHAT THIS DOES NOT DO:
    No automated accuracy scoring — there's no machine-readable ground
    truth transcription bundled with these images, only the images
    themselves. This prints both engines' output side by side for human
    review, same as every comparison in this project so far. If ground
    truth transcriptions get added later (e.g. a <filename>.txt sidecar
    per image), extend this script to diff against them instead of
    eyeballing — don't hand-wave automated scoring without real ground
    truth backing it.
"""
import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server


LANG_PREFIX_RE = re.compile(r"^([a-z]{2})_")


def _infer_lang(filename: str):
    m = LANG_PREFIX_RE.match(filename)
    return m.group(1) if m else None


def _run_one(engine_name, detect_fn, image_bytes, lang):
    t0 = time.time()
    try:
        regions, raw_boxes_out, _, _ = detect_fn(image_bytes, lang, 0.5)
    except Exception as e:
        return {"engine": engine_name, "error": str(e), "seconds": round(time.time() - t0, 2)}
    return {
        "engine": engine_name,
        "seconds": round(time.time() - t0, 2),
        "region_count": len(regions),      # secondary signal only — see module docstring
        "fragment_count": len(raw_boxes_out),
        "fragments": [
            {"text": b["text"]} for b in raw_boxes_out
        ],
    }


def evaluate_folder(folder: str):
    results = []
    files = sorted(os.listdir(folder))
    if not files:
        print(f"  (no files in {folder})")
        return results

    for fname in files:
        path = os.path.join(folder, fname)
        if not os.path.isfile(path):
            continue
        lang = _infer_lang(fname)
        if lang is None:
            print(f"  SKIP {fname} — filename doesn't match <lang>_… convention, "
                  f"can't infer language. Rename or pass lang explicitly.")
            continue

        with open(path, "rb") as f:
            image_bytes = f.read()

        print(f"\n=== {fname}  (lang={lang}) ===")
        easy = _run_one("easyocr", server._run_easyocr_detection, image_bytes, lang)
        rapid = _run_one("rapidocr", server._run_rapidocr_detection, image_bytes, lang)

        for r in (easy, rapid):
            if "error" in r:
                print(f"  {r['engine']:8s} ERROR: {r['error']}  ({r['seconds']}s)")
            else:
                print(f"  {r['engine']:8s} {r['seconds']:5.1f}s  "
                      f"{r['fragment_count']:3d} fragments  {r['region_count']:3d} regions")

        results.append({"file": fname, "lang": lang, "easyocr": easy, "rapidocr": rapid})

    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", nargs="?", default="eval_samples")
    ap.add_argument("--json", default=None, help="also write full results to this path")
    args = ap.parse_args()

    if not os.path.isdir(args.folder):
        print(f"No such folder: {args.folder}")
        sys.exit(1)

    results = evaluate_folder(args.folder)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\nFull fragment text written to {args.json} (read at fragment level, "
              f"not just the seconds/counts printed above — that's where the actual "
              f"OCR text is, for the human accuracy review this script doesn't do itself).")


if __name__ == "__main__":
    main()
