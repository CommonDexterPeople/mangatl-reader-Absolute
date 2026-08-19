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
  server.py's _rescue_json_from_reasoning() — the real function, imported,
  not a hand-copied duplicate — against 10 cases: the original failing
  case, the plain/common case (regression guard — this MUST keep working,
  it's the hot path), several nesting shapes, and three "must correctly
  return nothing" negative cases so the fix doesn't trade a false-negative
  bug for a false-positive one.

HOW TO RUN
  python test_deepseek_rescue.py
  (pure string/JSON logic — no network, no API keys. Needs server.py's
  module-scope deps installed to import it: flask, requests,
  opencv-python-headless, numpy, pillow. Runs in well under a second.)
"""

import importlib.util
import json
import sys

# Import the real function from the real module. This file used to regex the
# brace-finding logic out of server.py's source text, de-indent it, and exec()
# it in a synthetic namespace — because the logic was inline inside
# _translate_deepseek(), and reaching it any other way meant making a network
# call. It has since been lifted into a module-level _rescue_json_from_reasoning(),
# and server.py's pip-install bootstrap is guarded behind __main__, so a plain
# import works and the test can no longer drift from the shipped code.
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

rescue_strategy_a = _server._rescue_json_from_reasoning


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
