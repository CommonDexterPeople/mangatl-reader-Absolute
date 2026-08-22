#!/usr/bin/env python3
"""
test_model_registry.py — keeps the AI-model list consistent across the three
places that have to agree about it.

WHAT THIS ACTUALLY TESTS
  Adding a model to the picker is a THREE-file edit, and nothing about
  getting it wrong is loud:

    static/index.html            <option value="provider|model-id">
    static/js/translate-client.js  MODEL_INFO['provider|model-id']
    rates.json                   provider -> model-id  (cost tracking)

  Miss the MODEL_INFO entry and getModelInfo()'s
  `|| MODEL_INFO['gemini|gemini-3.5-flash']` fallback quietly hands back the
  WRONG model's label and API-key placeholder — the picker says one thing,
  the key hint says another, and nothing errors. Miss the rates.json entry
  and the cost tracker silently drops to its character-count estimate
  instead of a dollar figure.

  This is not hypothetical: rates.json listed gemini-3.6-flash (and said so
  in its own header — "not yet in the app's model picker") while the picker
  did not offer it at all.

HOW TO RUN
  python test_model_registry.py
  (pure text parsing — no server, no network, no deps beyond the stdlib.)

WHAT "PASS" MEANS
  Every model the picker offers is fully wired: it has a MODEL_INFO entry
  and a rates.json price. Models priced in rates.json but not offered in the
  picker are reported as INFO, not failures — pre-pricing a model you
  haven't shipped yet is deliberate (that is how 3.6-flash got there), and
  the cost tracker reads rates.json for models used by older cached
  chapters too.
"""

import io
import json
import re
import sys

HTML  = "static/index.html"
JS    = "static/js/translate-client.js"
RATES = "rates.json"

html  = io.open(HTML, encoding="utf-8").read()
js    = io.open(JS, encoding="utf-8").read()
rates = json.load(io.open(RATES, encoding="utf-8"))

# "provider|model-id" from every <option> in the model picker.
picker = re.findall(r'<option value="([a-z0-9-]+\|[A-Za-z0-9._-]+)"', html)
# Keys of the MODEL_INFO object literal.
info   = set(re.findall(r"^\s*'([a-z0-9-]+\|[A-Za-z0-9._-]+)':", js, re.M))

assert picker, f"no <option value=\"provider|model\"> found in {HTML} — did the markup change?"
assert info,   f"no MODEL_INFO keys found in {JS} — did the table change shape?"

def priced(provider: str, model: str) -> bool:
    """DeepL bills per character, not per token, so it has no per-model rate
    entry — a top-level 'deepl' key is the whole story for it."""
    if provider == "deepl":
        return "deepl" in rates
    return isinstance(rates.get(provider), dict) and model in rates[provider]

print(f"{'picker option':34} {'MODEL_INFO':11} {'rates.json':11} result")
all_pass = True
for key in picker:
    provider, model = key.split("|", 1)
    has_info  = key in info
    has_rate  = priced(provider, model)
    ok = has_info and has_rate
    all_pass &= ok
    print(f"{key:34} {str(has_info):11} {str(has_rate):11} {'PASS' if ok else 'FAIL <<<'}")

# Reverse direction: priced but not offered. Informational only — see docstring.
offered = {k.split("|", 1)[1] for k in picker}
extra = [(p, m) for p in ("gemini", "deepseek")
         if isinstance(rates.get(p), dict)
         for m in rates[p] if not m.startswith("_") and m not in offered]
if extra:
    print()
    print("INFO — priced in rates.json but not offered in the picker")
    print("       (fine on purpose; listed so the gap stays visible):")
    for p, m in extra:
        print(f"         {p}|{m}")

print()
if all_pass:
    print(f"ALL PASS — all {len(picker)} picker models have a MODEL_INFO entry and a price.")
else:
    print("SOME FAILED — a model the picker offers is not fully wired up.")
    print("  MODEL_INFO False  → getModelInfo() falls back to the DEFAULT model's")
    print("                      label + key placeholder, silently mislabelling it.")
    print("  rates.json False  → the cost tracker drops to a character-count")
    print("                      estimate instead of a real dollar figure.")
    sys.exit(1)
