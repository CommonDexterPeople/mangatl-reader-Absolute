"""
Network-input hardening: the SSRF allowlist, image-body loading, and the
"you are about to expose this thing" startup guard.

Everything here exists because this server takes URLs and image payloads from
a request body and then fetches/decodes them. It binds to 127.0.0.1 by default
and has no authentication of its own, so these are the checks that keep a
localhost-only tool from becoming an open fetch primitive if that assumption
ever changes (someone sets HOST=0.0.0.0, or tunnels the port).

Tested by test_ssrf_guard.py, which imports _is_allowed_image_host from here
via server.py and runs it against adversarial hostnames.
"""

import base64
import os
import socket
import sys
from urllib.parse import urljoin, urlparse

import requests
from flask import abort

from mtl.config import USER_AGENT

# ── Allowlisted image-CDN hosts ───────────────────────────────────────────────
# /proxy, /ocr-crop and /vision-crop previously accepted ANY "https://" URL.
# That's fine while HOST stays 127.0.0.1 (only the local user can reach the
# server at all), but it's an open HTTPS fetch/SSRF primitive with no defense
# in depth if someone ever changes HOST to 0.0.0.0 or exposes the port via a
# tunnel. These three routes only ever need to fetch MangaDex CDN images, so
# restrict them to known CDN hostnames rather than trusting "starts with
# https://" alone.
_ALLOWED_IMAGE_HOSTS = {
    "uploads.mangadex.org",
}

# A self-hosted Suwayomi-Server (github.com/Suwayomi/Suwayomi-Server) serves
# page images over plain HTTP on localhost by default — outside both of the
# rules above (wrong scheme, and not a MangaDex host either). Rather than
# loosen the https:// requirement or the hostname allowlist generally — which
# would hand this SSRF guard's whole job away — carve out ONLY this one exact
# host:port. That keeps the guard's actual purpose intact: even if something
# malicious ever got a crafted URL into a request body (e.g. a malicious
# page's cross-origin fetch to this dev server), the most it could make this
# server fetch is whatever's listening on that single designated port, not
# arbitrary internal hosts/ports on the machine. Override via env var if your
# Suwayomi instance runs somewhere other than the default port.
SUWAYOMI_HOST = os.environ.get("MTL_SUWAYOMI_HOST", "127.0.0.1:4567")

def _is_allowed_image_host(hostname: str) -> bool:
    """True if hostname is an allowlisted MangaDex CDN host, or a MangaDex
    MD@Home node (these are dynamically assigned, e.g. <hash>.mangadex.network,
    so we match the parent domain rather than a fixed list of node names)."""
    if not hostname:
        return False
    hostname = hostname.lower()
    if hostname in _ALLOWED_IMAGE_HOSTS:
        return True
    return hostname.endswith(".mangadex.network") or hostname.endswith(".mangadex.org")

def _image_url_allowed(url: str):
    """The allowlist decision on its own: the parsed urllib result if `url`
    passes, None if it doesn't. Pure — no abort, no request context needed.

    Split out of _validate_image_url so the SAME rule can be applied to a
    redirect target (see _get_image_response), where there is no client to
    send a 400 to and the failure means something different. One predicate,
    two callers, no chance of the two drifting apart.
    """
    parsed = urlparse(url)

    # Scoped Suwayomi carve-out — see SUWAYOMI_HOST above. Checked before the
    # https:// requirement below, since Suwayomi's default install is
    # deliberately plain http:// and only for this exact host:port.
    if url.startswith("http://") and (parsed.netloc or "").lower() == SUWAYOMI_HOST.lower():
        return parsed

    if not url.startswith("https://"):
        return None
    if not _is_allowed_image_host(parsed.hostname or ""):
        return None
    return parsed

def _validate_image_url(url: str):
    """Parse + validate an image URL. Returns the parsed urllib result on
    success; calls abort(400, ...) and does not return on failure."""
    parsed = _image_url_allowed(url)
    if parsed is not None:
        return parsed
    # Re-derive which rule rejected it, so the message still names the actual
    # problem rather than a generic "not allowed".
    if not url.startswith("https://"):
        abort(400, "Only HTTPS image URLs are accepted.")
    abort(400, "URL host is not an allowed MangaDex CDN host.")

# ── Fetching an allowlisted image URL ─────────────────────────────────────────
# _validate_image_url checks the URL the CLIENT supplied. requests.get()
# follows redirects by default, and nothing re-checks where they lead — so an
# allowlisted host answering "302 Location: http://127.0.0.1:9200/" walked the
# fetch straight back out of the allowlist, and /proxy handed the response body
# to the caller. Reproduced against the real /proxy call path: the fetch
# reached an unrelated host and its body came back verbatim.
#
# That is not a hypothetical trust boundary. _is_allowed_image_host accepts any
# *.mangadex.network host because MD@Home node names are dynamic — and those
# nodes are run by volunteers, not by MangaDex. "An allowlisted host is
# honest about where it points" was never a safe assumption.
#
# Redirects are followed rather than refused outright: a CDN is entitled to
# redirect, and refusing would break a legitimate move between MD@Home nodes.
# What changes is that every hop goes back through the same allowlist, so a
# redirect can only ever move WITHIN the set of hosts already permitted.
_MAX_IMAGE_REDIRECTS = 4

# Redirect statuses judged by CODE, deliberately, rather than by requests'
# own r.is_redirect. That property is `"location" in headers and status in
# REDIRECT_STATI` — so a 302 carrying NO Location reads as False and would be
# returned as if it were the image, handing the caller a redirect page's body
# instead. Caught by test_ssrf_guard.py's /no-location case, which is why it
# is in there.
_REDIRECT_STATI = frozenset({301, 302, 303, 307, 308})

def _get_image_response(url: str, timeout: int = 20):
    """requests.get() for an image URL, re-validating every redirect hop.

    `url` must already have passed _validate_image_url. Returns the final
    non-redirect Response; calls abort(502, ...) and does not return if a
    redirect leaves the allowlist, is malformed, or loops.
    """
    for _ in range(_MAX_IMAGE_REDIRECTS + 1):
        r = requests.get(url, timeout=timeout, headers={"User-Agent": USER_AGENT},
                         allow_redirects=False)
        if r.status_code not in _REDIRECT_STATI:
            return r

        location = r.headers.get("Location", "")
        r.close()
        if not location:
            abort(502, "Image host sent a redirect with no Location header.")
        # A Location may legally be relative; resolve it against the URL we
        # actually requested before judging the host, or a relative hop would
        # be measured as a hostname-less URL and rejected for the wrong reason.
        location = urljoin(url, location)
        if _image_url_allowed(location) is None:
            abort(502, "Image host redirected outside the allowed image hosts.")
        url = location

    abort(502, "Image host redirected too many times.")

# ── Serving fetched bytes back to the browser ─────────────────────────────────
# /proxy used to pass the upstream Content-Type through untouched, which hands
# the remote server control of how the browser interprets the body. A response
# declaring text/html is then RENDERED as HTML — on http://127.0.0.1:8080,
# which is the origin holding every API key this app stores in localStorage.
#
# The cross-origin guard in server.py does not close this: it deliberately
# allows a missing Origin (curl, scripts), and a top-level navigation to
# /proxy?url=… sends none. That permissiveness is correct for what that guard
# is for — the fix belongs on the response instead.
#
# Fail closed: anything not on this list is served as an opaque download rather
# than guessed at. /proxy only ever carries page images, so a legitimate
# response can't land outside it.
_ALLOWED_IMAGE_CONTENT_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
}

def _safe_image_content_type(raw: str) -> str:
    """Reduce an upstream Content-Type to one a browser can only treat as an
    image, or to application/octet-stream if it isn't one."""
    # Strip any ";charset=…" parameter before matching — "image/png; charset=x"
    # is the same type and must not fall through to the octet-stream branch.
    base = (raw or "").split(";", 1)[0].strip().lower()
    return base if base in _ALLOWED_IMAGE_CONTENT_TYPES else "application/octet-stream"

# ── Local-source images (local folder / CBZ) ──────────────────────────────────
# A local page never has an https:// CDN URL to fetch — the browser already
# has the bytes (read from a picked folder, or unzipped client-side from a
# .cbz). Rather than teach every image-consuming route two separate code
# paths, they all funnel through _load_image_bytes(), which accepts EITHER
# shape and returns raw bytes either way:
#
#   {"image_b64": "<base64>"}                 — local folder / CBZ page.
#     No requests.get, no _validate_image_url — there is no URL, so there is
#     nothing to SSRF. The size cap below is the only real risk (someone
#     shipping an oversized payload to a single-user local server), not host
#     validation.
#
#   {"url": "https://uploads.mangadex.org/..."}  — MangaDex-CDN path:
#     _validate_image_url on the URL the caller sent, then
#     _get_image_response, which re-applies the same allowlist to every
#     redirect hop rather than letting requests follow them unchecked.
_MAX_IMAGE_B64_BYTES = 25 * 1024 * 1024  # ~25MB decoded — generous for a single scanned page

def _load_image_bytes(body: dict) -> bytes:
    """Resolve the image bytes for an /ocr, /ocr-crop, /vision-crop or
    /export-page request body. Calls abort(...) and does not return on
    failure, same convention as _validate_image_url."""
    b64 = (body.get("image_b64") or "").strip()
    if b64:
        if b64.startswith("data:") and "," in b64:
            b64 = b64.split(",", 1)[1]
        # Base64 is ~4/3 the size of the decoded bytes — check the encoded
        # length first so an oversized payload is rejected without fully
        # decoding it.
        if len(b64) > _MAX_IMAGE_B64_BYTES * 4 // 3:
            abort(413, "Local image payload too large (max ~25MB per page).")
        try:
            image_bytes = base64.b64decode(b64, validate=False)
        except Exception:
            abort(400, "image_b64 could not be decoded — not valid base64.")
        if not image_bytes:
            # A string made entirely of characters outside the base64
            # alphabet silently strips down to "" instead of raising above —
            # catch that here with a clear message rather than letting it
            # fall through to a generic image-decode error two layers down.
            abort(400, "image_b64 decoded to zero bytes — not a valid image.")
        if len(image_bytes) > _MAX_IMAGE_B64_BYTES:
            abort(413, "Local image payload too large (max ~25MB per page).")
        return image_bytes

    image_url = (body.get("url") or "").strip()
    _validate_image_url(image_url)
    try:
        # Redirect hops are re-validated against the allowlist — see
        # _get_image_response. Validating only the URL the caller sent left
        # the allowlist escapable by any host willing to answer with a 302.
        img_r = _get_image_response(image_url)
        img_r.raise_for_status()
    except requests.RequestException as e:
        abort(502, f"Image download failed: {e}")
    return img_r.content

# ─── Entry ────────────────────────────────────────────────────────────────────
# FIX #14 — safety check: this app stores Gemini/DeepSeek/DeepL API keys and
#   MangaDex client_secret in the browser's localStorage in plaintext, and
#   every POST route in this file (/auth/login, /auth/refresh, /proxy,
#   /translate, /translate-deepl, /deepl-languages, /ocr, /ocr-crop,
#   /vision-crop, /export-page, /export-chapter) is unauthenticated.
#   That's an acceptable risk model for HOST=127.0.0.1 (only the local user
#   can reach it), but becomes a real credential/data exposure if HOST is
#   ever changed to 0.0.0.0 or a LAN/public address without adding auth in
#   front of it.
#
#   Note "only the local user can reach it" needs one qualifier: a web page
#   the local user merely has OPEN also counts as local. server.py's
#   _block_cross_origin() before_request hook is what closes that gap
#   (cross-origin POSTs and rebound Host headers); it is not authentication,
#   and everything above about exposing the port still applies.
#
# FIX #16 — a printed warning doesn't stop anything; it only helps someone
#   who reads server output BEFORE the server is already reachable, which
#   defeats the point for anyone who set HOST and walked away, or who's
#   running this unattended (a scheduled task, a Docker container, etc).
#   Change of behavior: exposing the server now REFUSES TO START unless the
#   person opts in explicitly via the MTL_ALLOW_EXPOSED=1 environment
#   variable — set once, on purpose, not something that happens as a side
#   effect of editing HOST. This does not add real authentication (still
#   none) — it just makes "I am knowingly accepting this risk" a deliberate
#   act instead of an easy-to-miss side effect.
_LOCALHOST_ADDRS = {"127.0.0.1", "localhost", "::1"}

def _check_exposure_or_exit(host: str) -> None:
    if host in _LOCALHOST_ADDRS:
        return

    allowed = os.environ.get("MTL_ALLOW_EXPOSED", "").strip() == "1"

    print()
    print("  ⚠️   HOST is not localhost (currently: " + host + ")")
    print("  ⚠️   This server has no authentication. Anyone who can reach it")
    print("  ⚠️   on your network can read stored API keys, log in as you on")
    print("  ⚠️   MangaDex (client_secret is sent to /auth/login unauthenticated),")
    print("  ⚠️   and use /auth/login, /auth/refresh, /proxy, /translate,")
    print("  ⚠️   /translate-deepl, /deepl-languages, /ocr, /ocr-crop,")
    print("  ⚠️   /vision-crop, /export-page, /export-chapter — every route in")
    print("  ⚠️   this app that takes a POST body, with no login of its own.")
    print("  ⚠️   Only do this on a trusted network, and ideally put it behind")
    print("  ⚠️   your own auth (reverse proxy, VPN, etc.) first.")

    if not allowed:
        print()
        print("  ✗   Refusing to start on a non-localhost address without an")
        print("  ✗   explicit opt-in. If you understand the risk above and want")
        print("  ✗   to proceed anyway, set MTL_ALLOW_EXPOSED=1 and run again:")
        print()
        print("        (macOS/Linux)  MTL_ALLOW_EXPOSED=1 python server.py")
        print("        (Windows PS)   $env:MTL_ALLOW_EXPOSED=1; python server.py")
        print()
        sys.exit(1)

    print("  ⚠️   MTL_ALLOW_EXPOSED=1 is set — starting anyway.")
    print()