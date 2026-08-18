#!/usr/bin/env python3
"""
test_ssrf_guard.py — checks the image-host allowlist against adversarial
hostnames, without needing EasyOCR/OpenCV/torch installed.

WHAT THIS ACTUALLY TESTS
  server.py's _is_allowed_image_host() (the SSRF guard for /proxy, /ocr,
  /ocr-crop, /vision-crop, /export-page). It imports the real function
  straight out of server.py rather than a copy, so this stays true even if
  the function changes later — no need to update this file when it does.

HOW TO RUN
  python test_ssrf_guard.py
  (needs server.py in the same folder and its module-scope deps installed —
  flask, requests, opencv-python-headless, numpy, pillow. Does NOT need
  easyocr/rapidocr/torch: those load lazily and are never touched here.
  Does NOT start the Flask server or touch the network — pure
  function-level check, runs in under a second.)

WHAT "PASS" MEANS
  Every row marked PASS means the function returned what a correct SSRF
  guard should for that input. Any FAIL means the allowlist has a real
  hole — a hostname that should be rejected is being accepted (or, less
  dangerously but still worth checking, a legit host is being rejected).
"""

import importlib.util
import sys

# Import the real function from the real module. server.py's dependency
# auto-installer is guarded behind `if __name__ == "__main__"`, so importing
# it here is a plain import with no pip side effect and no EasyOCR/torch load
# (those are lazy — see _get_reader()/_get_lama_engine()).
#
# This used to regex _ALLOWED_IMAGE_HOSTS and _is_allowed_image_host out of
# server.py's source text and exec() them, purely to dodge that installer.
# The cost was silent: reformatting the guard, or adding a blank line inside
# it, made the regex miss and the test assert against a stale/partial copy of
# code that no longer resembled what shipped. A real import can't drift.
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

_is_allowed_image_host = _server._is_allowed_image_host

# ── Adversarial test cases ────────────────────────────────────────────────
# (hostname, should_be_allowed, why this case matters)
TESTS = [
    ("uploads.mangadex.org",              True,  "legit CDN host"),
    ("abc123.mangadex.network",           True,  "legit MD@Home node (dynamic)"),
    ("evil.com",                          False, "unrelated host"),
    ("mangadex.org.evil.com",             False, "suffix trick — real domain is evil.com"),
    ("evilmangadex.org",                  False, "lookalike, not an actual subdomain"),
    ("uploads.mangadex.org.evil.com",     False, "legit-looking prefix, real domain is evil.com"),
    ("notmangadex.network",               False, "missing the dot — not a real subdomain"),
    ("169.254.169.254",                   False, "cloud metadata IP — must be rejected"),
    ("localhost",                         False, "must not be allowed via the CDN path"),
    ("127.0.0.1",                         False, "must not be allowed via the CDN path"),
    ("",                                  False, "empty hostname"),
]

print(f"{'hostname':38} {'expected':9} {'got':9} result")
all_pass = True
for host, expected, note in TESTS:
    got = _is_allowed_image_host(host)
    ok = got == expected
    all_pass &= ok
    print(f"{host:38} {str(expected):9} {str(got):9} {'PASS' if ok else 'FAIL <<<'}  ({note})")

print()
if all_pass:
    print("ALL PASS — allowlist rejects every adversarial hostname tried here.")
else:
    print("SOME FAILED — see FAIL rows above. That hostname is either being")
    print("wrongly accepted (a real hole) or wrongly rejected (a false positive).")
    sys.exit(1)
