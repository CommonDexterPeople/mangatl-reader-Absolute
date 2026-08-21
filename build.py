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

# Frontend load order is no longer a global-scope constraint: static/js/ is ES
# modules, so each file declares its own dependencies in its own imports.
# main.js is the entry point and the single place listing the modules —
# _flatten_js_modules() reads that list, so nothing here can drift from the
# real page.


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# Order matters and must match server.py's own import block: inlining is just
# concatenation, so a module may only reference names defined by a module
# EARLIER in this list. mtl/__init__.py is deliberately excluded — it's a
# docstring-only package marker with nothing to inline.
_MTL_INLINE_ORDER = ["config.py", "security.py", "geometry.py", "merge.py",
                     "inpaint.py"]

_MTL_BEGIN = "# ─── BEGIN local modules (build.py inlines these) ─"
_MTL_END = "# ─── END local modules ─"


# static/js/ is ES modules now, loaded through a single entry (main.js). The
# single-file build has no module loader and no server to resolve './x.js'
# specifiers against, so the frontend is FLATTENED into one classic <script>:
# imports and export keywords are stripped and the modules are concatenated.
#
# That works because every top-level name across static/js/ is unique (the
# build asserts it below) and, in a classic script, top-level declarations are
# already global — which is exactly what main.js's Object.assign(window, …)
# bridge exists to reproduce under modules. So the bridge is dropped here: it
# would reference module namespace objects that no longer exist after
# flattening, and it is redundant when everything is global anyway.

_ENTRY_JS = "main.js"
_IMPORT_RE = re.compile(r"^import\b[^;]*;[ \t]*\n?", re.M)
_EXPORT_RE = re.compile(r"^export[ \t]+", re.M)
_BRIDGE_RE = re.compile(r"^Object\.assign\(\s*\n\s*window,.*?^\);[ \t]*\n?", re.M | re.S)


def _entry_module_order(entry_src: str) -> list[str]:
    """Module filenames in the order main.js imports them.

    main.js is the single source of truth for load order now, the same way
    index.html's <script> tags used to be — so reordering imports there is all
    it takes to reorder the bundle, with nothing to keep in sync here.
    """
    order = re.findall(r"^import \* as \w+ from '\./([^']+\.js)';", entry_src, re.M)
    if not order:
        raise SystemExit(
            f"No `import * as … from './x.js'` lines found in static/js/{_ENTRY_JS}. "
            "build.py reads those to determine bundle order — if the entry "
            "module's import style changed, update _entry_module_order()."
        )
    return order


def _flatten_js_modules(js_dir: Path) -> tuple[str, list[str]]:
    """Concatenate the ES modules into one classic-script bundle."""
    entry_src = _read(js_dir / _ENTRY_JS)
    order = _entry_module_order(entry_src)

    missing = [m for m in order if not (js_dir / m).exists()]
    if missing:
        raise SystemExit(f"{_ENTRY_JS} imports modules that don't exist: {missing}")

    seen: dict[str, str] = {}
    chunks = []
    for name in order:
        src = _read(js_dir / name)
        # Guard the assumption that makes flattening safe at all.
        for decl in re.findall(
            r"^export[ \t]+(?:async[ \t]+)?(?:function|const|let|var|class)[ \t]+([A-Za-z_$][\w$]*)",
            src, re.M,
        ):
            if decl in seen and seen[decl] != name:
                raise SystemExit(
                    f"Top-level name '{decl}' is declared in both {seen[decl]} and "
                    f"{name}. Under ES modules that's legal, but the single-file "
                    "build flattens everything into one scope where it is a "
                    "redeclaration. Rename one of them."
                )
            seen[decl] = name
        body = _EXPORT_RE.sub("", _IMPORT_RE.sub("", src)).strip("\n")
        chunks.append(f"// ═══ {name} ═══\n{body}")

    entry_body = _BRIDGE_RE.sub("", _IMPORT_RE.sub("", entry_src)).strip("\n")
    entry_body = _EXPORT_RE.sub("", entry_body)
    chunks.append(f"// ═══ {_ENTRY_JS} (bridge dropped — flat scope is already global) ═══\n{entry_body}")

    return "\n\n\n".join(chunks), order + [_ENTRY_JS]

def _strip_mtl_imports(src: str, fname: str) -> str:
    """Drop a module's own `from mtl.… import …` lines.

    Once every module is concatenated into one flat file, a sibling's names
    are already in scope, so these imports are not just redundant — they'd
    fail, since there is no `mtl` package next to the single-file build.

    Handles the PARENTHESIZED multi-line form as well as the one-liner. An
    earlier version filtered line-by-line on startswith("from mtl."), which
    silently kept the continuation lines and the closing paren of

        from mtl.geometry import (
            _crosses_border,
        )

    leaving a bare tuple and a stray `)` — a SyntaxError in the dist build
    that nothing upstream would explain. Anything unparseable raises here
    instead, so a future import style that this doesn't understand fails
    loudly at build time rather than in a downloaded file's traceback.
    """
    out, lines, i = [], src.split(chr(10)), 0
    while i < len(lines):
        line = lines[i]
        if line.startswith(("from mtl.", "import mtl")):
            if "(" in line and ")" not in line:
                depth = line.count("(") - line.count(")")
                while depth > 0:
                    i += 1
                    if i >= len(lines):
                        raise SystemExit(
                            f"build.py: unterminated `from mtl.…` import in "
                            f"mtl/{fname} — cannot strip it safely."
                        )
                    depth += lines[i].count("(") - lines[i].count(")")
            i += 1
            continue
        out.append(line)
        i += 1
    return chr(10).join(out)


def _inline_local_modules(server_src: str, mtl_dir: Path):
    """Replace server.py's `from mtl.… import …` block with the actual source
    of those modules, so the single-file build has no package to import.

    The block is delimited by BEGIN/END sentinel comments in server.py rather
    than matched by regex against the import statements themselves, so adding
    or reordering an import inside that block can't silently desync this.

    Each module's own `from mtl.… import …` lines are stripped — once inlined
    those names all share one flat namespace. Their stdlib/third-party imports
    are kept as-is: re-importing an already-loaded module is a cheap dict
    lookup, and pruning them would mean working out which are still needed.
    """
    start = server_src.find(_MTL_BEGIN)
    if start == -1:
        raise SystemExit(
            "Couldn't find the BEGIN sentinel for the mtl import block in "
            "server.py. If the local-module imports moved or the sentinel "
            "comment changed, update _MTL_BEGIN in build.py to match."
        )
    end = server_src.find(_MTL_END, start)
    if end == -1:
        raise SystemExit("Found the BEGIN sentinel in server.py but not the END one.")
    end = server_src.index(chr(10), end) + 1

    chunks, inlined = [], []
    for fname in _MTL_INLINE_ORDER:
        path = mtl_dir / fname
        if not path.exists():
            raise SystemExit(
                f"build.py expects mtl/{fname} but it doesn't exist. Update "
                "_MTL_INLINE_ORDER if a module was renamed or removed."
            )
        body = _strip_mtl_imports(_read(path), fname)
        chunks.append(
            f"# ═══ inlined from mtl/{fname} (generated by build.py) ═══"
            + chr(10) + body.strip(chr(10))
        )
        inlined.append(fname)

    replacement = (
        "# ─── Local modules, inlined by build.py ─────────────────────────────────────"
        + chr(10)
        + "# In the split source these live in mtl/*.py and server.py imports them."
        + chr(10)
        + "# Edit them there, not here — this file is a build artifact."
        + chr(10) * 2
        + (chr(10) * 3).join(chunks)
        + chr(10)
    )
    return server_src[:start] + replacement + server_src[end:], inlined


def build(output_path: Path) -> None:
    server_src = _read(HERE / "server.py")
    server_src, mtl_inlined = _inline_local_modules(server_src, HERE / "mtl")
    index_html = _read(STATIC / "index.html")
    style_css = _read(STATIC / "style.css")
    rates_json_path = HERE / "rates.json"
    rates_json = _read(rates_json_path) if rates_json_path.exists() else None

    js_bundle, js_files = _flatten_js_modules(STATIC / "js")

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

    # Swap the module entry tag for the flattened bundle. It becomes a CLASSIC
    # <script>, not type="module": the bundle has had its import/export syntax
    # stripped, and a classic script is what makes every top-level declaration
    # global again, so the inline onclick= handlers in the markup still resolve.
    entry_tag = '<script type="module" src="/static/js/main.js"></script>'
    if entry_tag not in html:
        raise SystemExit(
            "Couldn't find the module entry tag in index.html. build.py "
            "replaces that tag with the flattened bundle; if the entry script "
            "tag changed, update entry_tag in build.py to match. Expected: "
            + entry_tag
        )
    html = html.replace(entry_tag, "<script>\n" + js_bundle + "\n</script>", 1)

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

    if 'HOST         = "127.0.0.1"\n' not in server_src:
        raise SystemExit("Couldn't find the HOST/PORT anchor in server.py — did it change?")

    server_src = server_src.replace(
        'HOST         = "127.0.0.1"\n',
        'HOST         = "127.0.0.1"\n'
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
    print(f"  inlined {len(mtl_inlined)} local module(s): {', '.join(mtl_inlined)}")
    print(f"  flattened {len(js_files)} JS module(s) into one classic <script>")
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
