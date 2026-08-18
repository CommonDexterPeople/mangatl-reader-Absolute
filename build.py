#!/usr/bin/env python3
"""
build.py — reassemble the split MangaTL-Reader project into one .py file
==========================================================================

Why this exists
----------------
server.py + static/ is the version you actually EDIT: real files, real
syntax highlighting, a JS linter that understands JS. But sometimes you
want to hand ONE file to someone else — "download this, run it, done" —
without asking them to keep a folder structure intact.

This script produces that single-file version. It does NOT hand-edit
anything: it reads server.py and static/*, inlines the frontend into a
Python triple-quoted string (exactly like the original MangaTL-Reader_V3.py
was structured), then writes the result to dist/MangaTL-Reader.py.

You should never need to edit dist/MangaTL-Reader.py directly — if you find
a bug or want a feature, fix it in server.py / static/, then re-run this
script. Treat dist/ as a build artifact, not a source file.

USAGE
    python build.py
    python build.py --output dist/MyCustomName.py
"""

import argparse
import re
from pathlib import Path

HERE = Path(__file__).parent
STATIC = HERE / "static"

# Order matters: these are plain <script> tags sharing global scope (no ES
# modules), so later files can reference functions/state defined in earlier
# ones. This MUST match the <script src="..."> order in static/index.html —
# the build script cross-checks this automatically (see _js_order_from_html)
# so a stale hardcoded list here can't silently drift from the real page.


def _js_order_from_html(html: str) -> list[str]:
    """Extract the ordered list of static/js/*.js filenames referenced by
    <script src="/static/js/NAME.js"> tags in index.html, in document order.
    This is the source of truth for load order — not a hardcoded list here —
    so editing index.html's script order and re-running build.py just works."""
    return re.findall(r'<script src="/static/js/([^"]+\.js)"></script>', html)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def build(output_path: Path) -> None:
    server_src = _read(HERE / "server.py")
    index_html = _read(STATIC / "index.html")
    style_css = _read(STATIC / "style.css")
    rates_json_path = HERE / "rates.json"
    rates_json = _read(rates_json_path) if rates_json_path.exists() else None

    js_files = _js_order_from_html(index_html)
    if not js_files:
        raise SystemExit(
            "No <script src=\"/static/js/...\"> tags found in static/index.html — "
            "can't determine JS load order. Did index.html's script tags change format?"
        )
    missing = [f for f in js_files if not (STATIC / "js" / f).exists()]
    if missing:
        raise SystemExit(f"index.html references JS files that don't exist: {missing}")

    js_bundle = "\n\n".join(_read(STATIC / "js" / f).rstrip("\n") for f in js_files)

    # Inline the stylesheet: replace the <link rel="stylesheet" href="/static/style.css">
    # tag with an actual <style> block.
    style_tag = f"<style>\n{style_css.rstrip(chr(10))}\n</style>"
    html = index_html.replace(
        '<link rel="stylesheet" href="/static/style.css">', style_tag
    )
    if style_tag not in html:
        raise SystemExit(
            "Couldn't find the style.css <link> tag in index.html to inline — "
            "did the tag's exact text change?"
        )

    # Inline every <script src="/static/js/...."></script> tag. Replace the
    # FIRST one with the full bundle, then delete the rest (they're now part
    # of the bundle) — preserves position in the document while consolidating
    # every module into one <script> block, same shape as the original file.
    first_replaced = False
    for f in js_files:
        tag = f'<script src="/static/js/{f}"></script>'
        if not first_replaced:
            html = html.replace(tag, f"<script>\n{js_bundle}\n</script>", 1)
            first_replaced = True
        else:
            html = html.replace(tag, "", 1)

    # Inline rates.json the same way _HTML gets inlined below: replace the
    # empty _RATES_DEFAULT = {} placeholder in server.py with the real,
    # parsed contents of rates.json, so the single-file dist build has a
    # working cost-tracker rate table even with no rates.json sitting next
    # to it (get_rates() in server.py still prefers an on-disk rates.json
    # if the person running the dist build adds one — this is only the
    # fallback for when they don't).
    if rates_json is not None:
        try:
            import json as _json
            parsed_rates = _json.loads(rates_json)
        except ValueError as e:
            raise SystemExit(f"rates.json exists but isn't valid JSON: {e}")
        rates_literal = "_RATES_DEFAULT = " + repr(parsed_rates) + "\n"
        if "_RATES_DEFAULT = {}\n" not in server_src:
            raise SystemExit(
                "Couldn't find the _RATES_DEFAULT = {} placeholder in server.py — "
                "did get_rates()'s fallback mechanism change?"
            )
        server_src = server_src.replace("_RATES_DEFAULT = {}\n", rates_literal, 1)
    else:
        print("  WARNING: rates.json not found — dist build's cost tracker will have "
              "no default rates until one is added next to the dist file.")

    # server.py currently serves the frontend from disk via send_from_directory.
    # For the single-file build we need the ORIGINAL in-memory-string behavior:
    # a module-level _HTML constant plus a Response(...)-based index() route.
    # We splice that in right after the PORT line (same position the original
    # MangaTL-Reader_V3.py had it), and rewrite index()/Flask-app-init to match.
    html_literal = '_HTML = r"""\n' + html.rstrip("\n") + '\n"""\n'

    if "HOST         = \"127.0.0.1\"\nPORT         = 8080\n" not in server_src:
        raise SystemExit("Couldn't find the HOST/PORT anchor in server.py — did it change?")

    server_src = server_src.replace(
        'HOST         = "127.0.0.1"\nPORT         = 8080\n',
        'HOST         = "127.0.0.1"\nPORT         = 8080\n'
        '# ─── Embedded frontend (generated by build.py — do not edit here) ───────────\n'
        + html_literal,
        1,
    )

    # Single-file build doesn't need a static folder or send_from_directory.
    server_src = server_src.replace(
        'app = Flask(__name__, static_folder="static", static_url_path="/static")',
        "app = Flask(__name__)",
        1,
    )
    server_src = server_src.replace(
        "from flask import Flask, Response, abort, jsonify, request, send_from_directory",
        "from flask import Flask, Response, abort, jsonify, request",
        1,
    )
    server_src = server_src.replace(
        '@app.route("/")\n'
        "def index():\n"
        "    # The frontend now lives on disk under static/ instead of an in-memory\n"
        "    # Python string — send_from_directory reads it fresh each request, so\n"
        "    # editing static/index.html (or its CSS/JS) takes effect on a normal\n"
        "    # browser refresh, no server restart needed.\n"
        '    return send_from_directory(app.static_folder, "index.html")\n',
        '@app.route("/")\n'
        "def index():\n"
        '    return Response(_HTML, content_type="text/html; charset=utf-8")\n',
        1,
    )

    # Docstring: swap the "server-only" framing back to "single-file" framing
    # so the generated file's own header isn't misleading about its shape.
    server_src = server_src.replace(
        "MangaTL-Reader  —  Manga translation tool (server)\n"
        "===================================================\n",
        "MangaTL-Reader  —  Single-file manga translation tool\n"
        "======================================================\n"
        "(Generated by build.py — edit server.py / static/ instead of this file.)\n",
        1,
    )
    server_src = server_src.replace(
        "This is the Flask backend. The frontend lives in static/ (index.html,\n"
        "style.css, js/*.js) and is served from disk — nothing frontend-related is\n"
        "embedded in this file. See build.py if you want to reassemble everything\n"
        "into a single distributable .py file (e.g. for sharing with someone who\n"
        "just wants to download one file and run it).\n\n"
        "USAGE\n"
        "  python server.py                — starts the server and opens the browser\n"
        "  (Windows) double-click run.py   — same, if Python is installed\n",
        "USAGE\n"
        "  python MangaTL-Reader.py         — starts the server and opens the browser\n"
        "  (Windows) double-click the file — same, if Python is installed\n",
        1,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(server_src, encoding="utf-8")

    lines = server_src.count("\n")
    print(f"Built {output_path}  ({lines} lines)")
    print(f"  inlined {len(js_files)} JS module(s): {', '.join(js_files)}")
    print(f"  inlined style.css ({style_css.count(chr(10))} lines)")
    if rates_json is not None:
        print(f"  inlined rates.json as _RATES_DEFAULT ({rates_json.count(chr(10))} lines)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=HERE / "dist" / "MangaTL-Reader.py",
        help="Where to write the single-file build (default: dist/MangaTL-Reader.py)",
    )
    args = parser.parse_args()
    build(args.output)


if __name__ == "__main__":
    main()
