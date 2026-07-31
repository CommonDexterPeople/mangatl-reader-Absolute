#!/usr/bin/env python3
"""
test_deepseek_rescue.py — regression test for the DeepSeek thinking-mode
JSON rescue logic in _translate_deepseek() (Strategy A: find the JSON
object enclosing the "translations" key inside reasoning_content).

BACKGROUND
  See KNOWN_ISSUES_DRAFT.md, "DeepSeek rescue Strategy A: doesn't handle a
  nested object before the key". The original implementation used
  rc.rfind('{', 0, idx) to find the opening brace of the enclosing JSON
  object — which finds the NEAREST '{' before the key, not the one that
  actually encloses it. Any nested object sitting between the true start
  and the key (e.g. {"model":{"name":"x"},"translations":[...]}) broke
  this: the nearest '{' belongs to the nested object, so json.loads was
  handed a syntactically broken fragment and the rescue silently failed
  (returned "" — which downstream becomes an HTTP 422 telling the user to
  retry, even though the model's output was actually fine and rescuable).

  Fixed by walking backward from the key counting brace depth instead of
  a single rfind, so the brace found is the true enclosing one regardless
  of what's nested inside it.

WHAT THIS TESTS
  Extracts the actual patched brace-finding logic straight out of
  server.py (not a hand-copied duplicate) and runs it against 10 cases:
  the original failing case, the plain/common case (regression guard —
  this MUST keep working, it's the hot path), several nesting shapes,
  and three "must correctly return nothing" negative cases so the fix
  doesn't trade a false-negative bug for a false-positive one.

HOW TO RUN
  python test_deepseek_rescue.py
  (pure string/JSON logic — no network, no API keys, no dependencies
  beyond the standard library, runs in well under a second)
"""

import json
import re
import sys
import textwrap

with open("server.py", "r", encoding="utf-8") as f:
    SRC = f.read()

# Pull the live brace-finding block straight out of server.py so this test
# stays honest against future edits — if someone changes the logic and
# breaks it, this test breaks against the REAL code, not a stale copy.
_m = re.search(r"idx = rc\.rfind.*?_i -= 1\n", SRC, re.S)
if not _m:
    print("Could not locate the patched brace-finding block in server.py —")
    print("has _translate_deepseek() been renamed or restructured? Update")
    print("the regex in this script to match, or check the fix wasn't reverted.")
    sys.exit(1)

# The block is extracted mid-line from server.py, where it lives nested
# inside an `if`/`try` at some fixed base indentation (currently 16 spaces).
# textwrap.dedent can't help directly: the captured text's OWN first line
# (from the regex match start) has no leading whitespace while every line
# after it shares a common indent — dedent sees "some lines have zero
# indent" and refuses to strip anything. Fix: dedent only lines[1:] (which
# DO share a common prefix), then rejoin with the untouched first line.
# Verified below by compiling the result before use, so a future edit that
# changes server.py's indentation and breaks this is caught immediately
# with a clear error instead of a confusing downstream test failure.
_lines = _m.group(0).splitlines()
_body_dedented = textwrap.dedent("\n".join(_lines[1:])) if len(_lines) > 1 else ""
_BRACE_FINDER_SRC = _lines[0] + ("\n" + _body_dedented if _body_dedented else "")
try:
    compile(_BRACE_FINDER_SRC, "<extracted>", "exec")
except SyntaxError as e:
    print("Extracted block from server.py doesn't compile after de-indenting —")
    print("the extraction regex or this normalization needs updating.")
    print(f"SyntaxError: {e}")
    print("--- extracted text ---")
    print(_BRACE_FINDER_SRC)
    sys.exit(1)


def rescue_strategy_a(rc: str, rescue_key: str = "translations") -> str:
    """Re-runs the exact Strategy A logic extracted from server.py against
    a given reasoning_content string. Returns the rescued JSON substring,
    or "" if nothing was rescuable."""
    content = ""
    ns = {"rc": rc, "rescue_key": rescue_key, "content": content, "json": json}
    exec(_BRACE_FINDER_SRC, ns)
    brace = ns.get("brace", -1)
    if brace is not None and brace >= 0:
        try:
            m_obj = json.loads(rc[brace:])
            if isinstance(m_obj, dict) and rescue_key in m_obj:
                content = rc[brace:]
        except Exception:
            pass
    return content


# (label, reasoning_content input, should_succeed)
TESTS = [
    ("original failing case — nested object before key (the bug this fixes)",
     'blah blah thinking... {"model":{"name":"x"},"translations":["hi","bye"]}', True),

    ("plain case — no nesting (regression guard: the common/hot path)",
     'blah blah thinking... {"translations":["hi","bye"]}', True),

    ("doubly-nested object before key",
     'notes {"a":{"b":{"c":1}},"translations":["x"]}', True),

    ("nested object AFTER translations too (brace balance both sides)",
     '{"translations":["x"],"meta":{"k":"v"}}', True),

    ("key appears twice — must resolve to a genuinely parseable object",
     'draft {"translations":["old"]} final: {"translations":["new","real"]}', True),

    ("stray unbalanced brace earlier in the string",
     'random text with a stray } bracket then {"translations":["ok"]}', True),

    ("deep nesting: object-in-object-in-array-in-object",
     'x {"outer":{"mid":{"inner":[1,2,{"z":3}]}},"translations":["deep"]}', True),

    ("no translations key at all — must return empty, not crash",
     "blah blah no json here at all", False),

    ("translations key present but no valid JSON around it",
     "the translations of these words are tricky", False),

    ("empty string input", "", False),
]


def main():
    print(f"{'result':8} {'expected':8} label")
    all_pass = True
    for label, rc, should_succeed in TESTS:
        out = rescue_strategy_a(rc)
        ok = bool(out.strip()) == should_succeed
        if out.strip():
            try:
                parsed = json.loads(out)
                valid = isinstance(parsed, dict) and "translations" in parsed
            except Exception:
                valid = False
            ok = ok and valid
        all_pass &= ok
        print(f"{'PASS' if ok else 'FAIL <<<':8} {str(should_succeed):8} {label}")

    print()
    if all_pass:
        print("ALL PASS — rescue logic handles the documented bug and every")
        print("case tried here without regressing the common no-nesting path.")
    else:
        print("SOME FAILED — see FAIL rows above. Either the fix regressed,")
        print("or was reverted, or a new edge case was found.")
        sys.exit(1)


if __name__ == "__main__":
    main()
