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
from urllib.parse import urlparse

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

def _validate_image_url(url: str):
    """Parse + validate an image URL. Returns the parsed urllib result on
    success; calls abort(400, ...) and does not return on failure."""
    from urllib.parse import urlparse
    parsed = urlparse(url)

    # Scoped Suwayomi carve-out — see SUWAYOMI_HOST above. Checked before the
    # https:// requirement below, since Suwayomi's default install is
    # deliberately plain http:// and only for this exact host:port.
    if url.startswith("http://") and (parsed.netloc or "").lower() == SUWAYOMI_HOST.lower():
        return parsed

    if not url.startswith("https://"):
        abort(400, "Only HTTPS image URLs are accepted.")
    if not _is_allowed_image_host(parsed.hostname or ""):
        abort(400, "URL host is not an allowed MangaDex CDN host.")
    return parsed

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
#   {"url": "https://uploads.mangadex.org/..."}  — existing MangaDex-CDN path,
#     unchanged: _validate_image_url + requests.get, exactly as before.
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
        img_r = requests.get(image_url, timeout=20, headers={"User-Agent": USER_AGENT})
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