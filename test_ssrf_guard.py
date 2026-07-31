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
  (needs server.py in the same folder; does NOT start the Flask server or
  touch the network — pure function-level check, runs in under a second)

WHAT "PASS" MEANS
  Every row marked PASS means the function returned what a correct SSRF
  guard should for that input. Any FAIL means the allowlist has a real
  hole — a hostname that should be rejected is being accepted (or, less
  dangerously but still worth checking, a legit host is being rejected).
"""

import importlib.util
import sys

# Import _is_allowed_image_host directly from server.py without running the
# rest of the file (which would trigger the dependency auto-installer and
# try to import EasyOCR/cv2/etc). We do this by loading just enough of the
# module namespace to get the one function + the constant it depends on.
spec = importlib.util.spec_from_file_location("server", "server.py")
# We can't fully exec server.py (heavy deps), so instead read the two pieces
# we need as source and exec them in an isolated namespace. This is more
# fragile than a real import but avoids needing EasyOCR/torch installed just
# to run a hostname-string test.
import re

with open("server.py", "r", encoding="utf-8") as f:
    src = f.read()

# Pull out _ALLOWED_IMAGE_HOSTS and _is_allowed_image_host by name.
ns = {}
m1 = re.search(r"^_ALLOWED_IMAGE_HOSTS = \{.*?\}\n", src, re.S | re.M)
m2 = re.search(r"^def _is_allowed_image_host.*?\n\n\n", src, re.S | re.M)
if not m1 or not m2:
    print("Could not locate the guard in server.py — has it been renamed/moved?")
    print("Open server.py and search for '_is_allowed_image_host' by hand instead.")
    sys.exit(1)

exec(m1.group(0), ns)
exec(m2.group(0), ns)
_is_allowed_image_host = ns["_is_allowed_image_host"]

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
