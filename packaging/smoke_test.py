#!/usr/bin/env python3
"""
smoke_test.py — launch the packaged build and prove it actually works.

WHY THIS EXISTS
  Two real defects shipped in the packaged Windows build that no existing
  test could have caught, because every one of them tests the SOURCE tree:

    - It recommended EasyOCR for Vietnamese — an engine absent from that
      build, for a picker option that isn't there.
    - /ocr-crop called _get_reader() unconditionally, so the Correct UI's
      "draw a new region" returned 500 "No module named 'easyocr'" — the
      first thing a user hits when fixing a bubble by hand.

  Both are invisible from a source install, where easyocr IS importable.
  The only way to catch this class of bug is to run the artifact you would
  actually hand someone. That is all this file does.

WHAT IT CHECKS
  1. The bundle contains no torch/easyocr/scipy/skimage — the exclusions are
     the whole reason the build is 247MB rather than ~900MB, and a stray
     transitive import silently undoes them.
  2. The exe starts and serves /health.
  3. POST /ocr does real OCR: reports ocr_engine=rapidocr, and separates two
     bubbles it should separate rather than welding them into one region.
  4. POST /ocr-crop works — the #13 regression, pinned.
  5. The cross-origin guard is live in the frozen build: a foreign Origin is
     rejected with 403, not processed.

HOW TO RUN
  python packaging/smoke_test.py packaging/out/MangaTL-Reader/MangaTL-Reader.exe

  Exits 0 if every check passes, 1 otherwise, and always tries to stop the
  server it started.
"""

import base64
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

for _s in (sys.stdout, sys.stderr):
    if _s is not None and hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

PORT = int(os.environ.get("SMOKE_PORT") or 8791)
BASE = f"http://127.0.0.1:{PORT}"
FORBIDDEN = ("torch", "easyocr", "scipy", "skimage")

_results = []

def check(name, ok, detail=""):
    _results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL <<<'}  {name}" + (f"  — {detail}" if detail else ""))
    return ok

def post(path, payload, origin=BASE, timeout=240):
    """POST JSON. Returns (status, body-text). Never raises on an HTTP error
    status — a 403/500 is a result to assert on here, not an exception."""
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **({"Origin": origin} if origin else {})},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")

def test_page_b64():
    """Two clearly separated speech bubbles. The gap between them is the
    point: check 3 asserts they come back as TWO regions, which is what the
    merge pipeline gets wrong when its geometry is broken."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (800, 1000), "white")
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("arialbd.ttf", 34)
    except Exception:
        f = ImageFont.load_default()
    d.ellipse([80, 80, 560, 330], fill="white", outline="black", width=5)
    d.text((150, 150), "HELLO WORLD", fill="black", font=f)
    d.text((150, 200), "THIS IS A TEST", fill="black", font=f)
    d.ellipse([250, 500, 720, 760], fill="white", outline="black", width=5)
    d.text((320, 580), "SECOND BUBBLE", fill="black", font=f)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()

def main():
    if len(sys.argv) < 2:
        print("usage: smoke_test.py <path-to-exe>")
        return 1
    exe = os.path.abspath(sys.argv[1])
    if not os.path.isfile(exe):
        print(f"  FAIL <<<  no exe at {exe}")
        return 1

    bundle = os.path.dirname(exe)
    print(f"\nSmoke-testing {exe}\n")

    # 1. Exclusions held.
    internal = os.path.join(bundle, "_internal")
    present = []
    if os.path.isdir(internal):
        entries = {e.lower() for e in os.listdir(internal)}
        present = [m for m in FORBIDDEN if m in entries]
    check("bundle excludes torch/easyocr/scipy/skimage",
          not present, f"found: {', '.join(present)}" if present else "")

    # RapidOCR does NOT fail loudly when its models are missing from the
    # bundle -- it silently falls back to downloading them from modelscope.cn
    # at first use. Observed directly: remove them and /ocr returns
    # "Failed to download https://www.modelscope.cn/...".
    #
    # That matters twice over. It is the difference between the build working
    # offline and not, which is the entire reason this build ships RapidOCR
    # instead of EasyOCR. And on a CI runner with working network the download
    # would SUCCEED, so every check below would pass on a bundle that is
    # broken for the offline user. Assert the files are really present rather
    # than inferring it from OCR working.
    models_dir = os.path.join(internal, "rapidocr", "models")
    onnx = ([f for f in os.listdir(models_dir) if f.endswith(".onnx")]
            if os.path.isdir(models_dir) else [])
    check("RapidOCR ONNX models are bundled (not downloaded at runtime)",
          len(onnx) >= 3, f"found {len(onnx)}: {sorted(onnx)}")

    env = dict(os.environ, PORT=str(PORT), PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen([exe], cwd=bundle, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        # 2. Starts and serves. A frozen build unpacks and imports cv2 +
        #    onnxruntime before it can bind, so allow a generous cold start.
        up = False
        for _ in range(90):
            if proc.poll() is not None:
                break
            try:
                with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
                    if r.status == 200:
                        up = True
                        break
            except Exception:
                time.sleep(1)
        if not check("exe starts and serves /health", up,
                     "" if up else "never became reachable"):
            out = proc.stdout.read().decode("utf-8", "replace") if proc.stdout else ""
            print("\n--- server output ---\n" + out[:2000])
            return 1

        b64 = test_page_b64()

        # 3. Real OCR through the real pipeline.
        st, body = post("/ocr", {"image_b64": b64, "lang": "en",
                                 "vision_mode": "off", "local_engine": "rapidocr"})
        data = json.loads(body) if st == 200 else {}
        regions = data.get("regions", [])
        check("POST /ocr returns 200", st == 200, f"status={st}")
        check("OCR ran on rapidocr", data.get("ocr_engine") == "rapidocr",
              f"got {data.get('ocr_engine')!r}")
        check("two bubbles stay two regions", len(regions) == 2,
              f"got {len(regions)}: {[r.get('text','')[:24] for r in regions]}")

        # 4. The /ocr-crop regression from #13.
        st, body = post("/ocr-crop", {"image_b64": b64, "box": [80, 80, 560, 330],
                                      "lang": "en"})
        text = (json.loads(body).get("text", "") if st == 200 else "")
        check("POST /ocr-crop returns 200 (was 500 pre-#13)", st == 200, f"status={st}")
        check("/ocr-crop returns text", bool(text.strip()), f"text={text!r}")

        # 5. Security guard survives freezing.
        st, _ = post("/ocr", {"image_b64": b64, "lang": "en"},
                     origin="https://evil.example.com", timeout=30)
        check("cross-origin POST rejected with 403", st == 403, f"status={st}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()

    failed = [n for n, ok, _ in _results if not ok]
    print()
    if failed:
        print(f"SMOKE TEST FAILED — {len(failed)} of {len(_results)} checks failed:")
        for n in failed:
            print(f"  - {n}")
        return 1
    print(f"ALL PASS — {len(_results)} checks against the real packaged build.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
