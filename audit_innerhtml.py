#!/usr/bin/env python3
"""
audit_innerhtml.py — finds every `.innerHTML = ...` assignment in static/js
that interpolates a variable, and tells you whether that variable is passed
through esc() at that exact spot.

WHAT THIS DOES NOT DO
  It cannot tell you whether a variable actually holds attacker-controlled
  data (that requires knowing where the value came from — an API response,
  a filename, vs. a hardcoded UI string). It only tells you WHERE
  interpolation happens without esc(), so a human can make that call fast
  instead of grepping 18 files by hand.

HOW TO READ THE OUTPUT
  Each hit shows the file, line, the ${...} expression, and whether esc()
  wraps it. "NOT ESCAPED" isn't automatically a bug — plenty of these are
  static strings, counts, or values that never leave your own machine
  (e.g. a local filename, a hardcoded label). Go through each NOT ESCAPED
  line and ask: "could this value ever contain markup from outside my own
  code?" If yes — an API field, a filename from a MangaDex response, OCR'd
  text — that's a real gap. If no, it's noise.

HOW TO RUN
  python audit_innerhtml.py
"""

import re
import sys
from pathlib import Path

JS_DIR = Path("static/js")

# Matches   something.innerHTML = `...`   or   something.innerHTML = "..." / '...'
# across multi-line template literals (DOTALL), non-greedy up to the next
# unescaped backtick/quote-at-statement-end. This is a heuristic, not a JS
# parser — good enough to flag candidates for human review, not a formal
# guarantee.
ASSIGN_RE = re.compile(
    r"(\w[\w.]*)\.innerHTML\s*=\s*(`(?:[^`\\]|\\.)*`|\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')",
    re.DOTALL,
)
INTERP_RE = re.compile(r"\$\{([^}]*)\}")


def line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def main():
    if not JS_DIR.is_dir():
        print(f"Can't find {JS_DIR} — run this from the project root.")
        sys.exit(1)

    total_hits = 0
    flagged = 0

    for path in sorted(JS_DIR.glob("*.js")):
        src = path.read_text(encoding="utf-8")
        for m in ASSIGN_RE.finditer(src):
            target, literal = m.group(1), m.group(2)
            interps = INTERP_RE.findall(literal)
            if not interps:
                continue  # no interpolation at all — nothing to check here
            ln = line_of(src, m.start())
            for expr in interps:
                total_hits += 1
                expr_stripped = expr.strip()
                is_escaped = bool(re.search(r"\besc\s*\(", expr_stripped))
                # A few expressions are obviously safe regardless of esc():
                # pure numbers/counts, or another ${...} that's itself just
                # a nested literal. Still printed, just marked differently,
                # since "obviously safe" is exactly the kind of judgment
                # call that's worth a human glance rather than auto-hiding.
                looks_numeric = bool(re.fullmatch(r"[\w.]+(\.length)?", expr_stripped)) and \
                    not re.search(r"(text|title|name|label|msg|message|err)", expr_stripped, re.I)

                tag = "ESCAPED    " if is_escaped else (
                    "LIKELY OK  " if looks_numeric else "NOT ESCAPED"
                )
                if not is_escaped and not looks_numeric:
                    flagged += 1
                print(f"{tag}  {path.name}:{ln:<5} {target}.innerHTML  ${{ {expr_stripped} }}")

    print()
    print(f"{total_hits} interpolated innerHTML expression(s) found, "
          f"{flagged} worth a manual look (not ESCAPED, not obviously numeric).")
    print("Review each 'NOT ESCAPED' line above: does that variable ever carry")
    print("text from outside your own code (API response, filename, OCR text)?")


if __name__ == "__main__":
    main()
