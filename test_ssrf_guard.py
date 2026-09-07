#!/usr/bin/env python3
"""
test_ssrf_guard.py — checks the image-host allowlist against adversarial
hostnames, without needing EasyOCR/OpenCV/torch installed.

WHAT THIS ACTUALLY TESTS
  The SSRF guard for /proxy, /ocr, /ocr-crop, /vision-crop, /export-page,
  at BOTH layers it has to hold at:

    1. the hostname rule — _is_allowed_image_host(), against adversarial
       hostnames;
    2. the fetch — _get_image_response(), against a redirect, and
       _safe_image_content_type(), against a hostile Content-Type.

  Layer 2 exists because layer 1 passing is not sufficient and the gap was
  real: _validate_image_url() checked the URL the client sent, and then
  requests.get() followed redirects with nothing re-checking where they
  led. An allowlisted host answering "302 Location: http://127.0.0.1:…"
  walked the fetch straight back out of the allowlist. Every hostname
  assertion below passed throughout — which is exactly why the string-level
  cases alone were not enough to trust.

  Everything is imported from the real modules rather than copied, so this
  stays true if those functions change.

HOW TO RUN
  python test_ssrf_guard.py
  (needs server.py in the same folder and its module-scope deps installed —
  flask, requests, opencv-python-headless, numpy, pillow. Does NOT need
  easyocr/rapidocr/torch: those load lazily and are never touched here.
  Does NOT start the Flask server and reaches nothing beyond loopback: the
  redirect cases run against two throwaway HTTP servers on 127.0.0.1 that
  this file starts and stops itself. Runs in about a second.)

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

print("── 1. hostname allowlist ─────────────────────────────────────────────")
print(f"{'hostname':38} {'expected':9} {'got':9} result")
all_pass = True
for host, expected, note in TESTS:
    got = _is_allowed_image_host(host)
    ok = got == expected
    all_pass &= ok
    print(f"{host:38} {str(expected):9} {str(got):9} {'PASS' if ok else 'FAIL <<<'}  ({note})")


# ── 2. the fetch: redirects must not escape the allowlist ────────────────────
# Every hostname case above passed even when this was broken, which is the
# whole reason this section exists. These run against real HTTP on loopback
# rather than a stubbed transport: the bug was in what requests does by
# default, so a test that replaces requests would have tested nothing.
#
# The two servers are bound to SUWAYOMI_HOST — the one host:port the guard
# admits over plain http:// — because it is the only allowlisted host that can
# be stood up locally. That lets a redirect be checked in BOTH directions:
# one that stays on an allowed host must still be followed, one that leaves
# must be refused. Without the first case a fix that simply banned all
# redirects would pass, and would silently break a CDN that legitimately
# moves a page between MD@Home nodes.
import http.server
import socketserver
import threading

from werkzeug.exceptions import HTTPException

_get_image_response      = _server._get_image_response
_safe_image_content_type = _server._safe_image_content_type
SUWAYOMI_HOST            = _server.SUWAYOMI_HOST

SECRET = b"INTERNAL-SERVICE-RESPONSE-THAT-MUST-NOT-BE-PROXIED"
IMAGE  = b"\x89PNG\r\n\x1a\n-pretend-this-is-a-page-scan"

_allowed_host, _, _allowed_port = SUWAYOMI_HOST.partition(":")
_allowed_port = int(_allowed_port or 80)

print()
print("── 2. redirect handling at the fetch ─────────────────────────────────")

class _OffAllowlist(http.server.BaseHTTPRequestHandler):
    """Stands in for whatever an escaped redirect lands on."""
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(SECRET)))
        self.end_headers()
        self.wfile.write(SECRET)
    def log_message(self, *a): pass

class _AllowedHost(http.server.BaseHTTPRequestHandler):
    """Bound to SUWAYOMI_HOST, so the guard treats it as an allowed host.
    Each path exercises one redirect shape."""
    def _redirect(self, location=None):
        self.send_response(302)
        if location is not None:
            self.send_header("Location", location)
        self.end_headers()
    def do_GET(self):
        if self.path == "/escape":            # 302 off the allowlist
            self._redirect(f"http://127.0.0.1:{OFF_PORT}/internal")
        elif self.path == "/stay":            # 302 within the allowed host
            self._redirect("/page.png")       # relative, as CDNs often send
        elif self.path == "/no-location":     # 302 with no Location at all
            self._redirect(None)
        elif self.path == "/loop":            # 302 to itself, forever
            self._redirect("/loop")
        else:
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(IMAGE)))
            self.end_headers()
            self.wfile.write(IMAGE)
    def log_message(self, *a): pass

def _serve(handler, port=0):
    srv = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def _stop(srv):
    # shutdown() before server_close() — closing the socket out from under a
    # running serve_forever() loop makes it raise on a dead descriptor, which
    # prints a thread traceback that looks like a test failure and isn't.
    srv.shutdown()
    srv.server_close()

_off = _serve(_OffAllowlist)
OFF_PORT = _off.server_address[1]

try:
    _allowed = _serve(_AllowedHost, _allowed_port)
except OSError as e:
    # Something already owns that port — most likely a real Suwayomi-Server.
    # Skip rather than fail: this is the environment's doing, not the guard's.
    print(f"SKIP     redirect cases — could not bind {SUWAYOMI_HOST} ({e}).")
    print("         Stop whatever is on that port, or set MTL_SUWAYOMI_HOST,")
    print("         to run them. The hostname cases above still ran.")
    _allowed = None

def _fetch(path):
    """(body, error) — exactly one is None."""
    try:
        return _get_image_response(f"http://{SUWAYOMI_HOST}{path}").content, None
    except HTTPException as e:
        return None, f"{e.code} {e.description}"

if _allowed is not None:
    FETCH_TESTS = [
        # (path, must the fetch be refused?, what the case proves)
        ("/escape",      True,  "302 to a non-allowlisted host must NOT be followed"),
        ("/no-location", True,  "302 with no Location must not fall through"),
        ("/loop",        True,  "redirect loop must terminate, not hang"),
        ("/stay",        False, "302 within an allowed host must STILL be followed"),
        ("/page.png",    False, "no redirect at all — the ordinary path"),
    ]
    for path, must_refuse, note in FETCH_TESTS:
        body, err = _fetch(path)
        if must_refuse:
            ok = body is None
            got = f"refused ({err})" if ok else "FETCHED"
        else:
            ok = body == IMAGE
            got = "image returned" if ok else f"got {body!r} / {err}"
        # Independent of the pass/fail rule above: the internal server's body
        # must never appear, whatever else went wrong.
        leaked = body is not None and SECRET in body
        ok = ok and not leaked
        all_pass &= ok
        print(f"{'PASS' if ok else 'FAIL <<<':9}{path:14} {got:38} ({note})")
        if leaked:
            print("           ^^ the internal server's body was proxied back — "
                  "this is the original vulnerability, live.")
    _stop(_allowed)
_stop(_off)


# ── 3. the response: a hostile Content-Type must not reach the browser ───────
# /proxy serves on the same origin as the app, which is where the browser
# keeps every stored API key. Reflecting the upstream type let a remote host
# have its body rendered as HTML there. Anything not a real image type is
# served as an opaque download instead.
print()
print("── 3. Content-Type pinning on the way back out ───────────────────────")

CT_TESTS = [
    ("image/png",                "image/png",                "ordinary image passes through"),
    ("image/jpeg",               "image/jpeg",               "ordinary image passes through"),
    ("IMAGE/JPEG",               "image/jpeg",               "case is normalised, not rejected"),
    ("image/png; charset=utf-8", "image/png",                "a parameter must not sink a real type"),
    ("text/html",                "application/octet-stream", "HTML must never be served on this origin"),
    ("text/html; charset=utf-8", "application/octet-stream", "…nor with a charset attached"),
    ("image/svg+xml",            "application/octet-stream", "SVG scripts, so it is not an allowed image"),
    ("application/javascript",   "application/octet-stream", "script types are not images"),
    ("",                         "application/octet-stream", "missing type must fail closed"),
    (None,                       "application/octet-stream", "absent header must fail closed"),
]

print(f"{'upstream says':28} {'served as':28} result")
for raw, expected, note in CT_TESTS:
    got = _safe_image_content_type(raw)
    ok = got == expected
    all_pass &= ok
    shown = "(absent)" if raw is None else (repr(raw) if raw == "" else raw)
    print(f"{shown:28} {got:28} {'PASS' if ok else 'FAIL <<<'}  ({note})")

print()
if all_pass:
    print("ALL PASS — the allowlist holds at the hostname, survives a redirect,")
    print("and no non-image type can be served back on this app's own origin.")
else:
    print("SOME FAILED — see FAIL rows above. A hostname row means the allowlist")
    print("has a hole; a redirect row means the fetch can leave it; a")
    print("Content-Type row means a remote host can choose how the browser")
    print("interprets a response served on this app's origin.")
    sys.exit(1)
