## Known, not yet hit: two narrow edge cases found in review (not fixed)

Both are the same *class* of bug as the ones already fixed and documented
above — a heuristic that's correct for the case it was built against, wrong
on a narrower shape it wasn't tested on. Neither has been observed in real
use; both were found by deliberately constructing the input rather than by
seeing it fail. Leaving them here rather than fixing blind, since "fix a bug
you haven't reproduced against real output" is exactly the trap the bubble-
boundary docstring above warns about.

### DeepSeek rescue Strategy A: doesn't handle a nested object before the key

**Where:** `_translate_deepseek()`, server.py:2995-3008 (Strategy A, the
`rfind`/`json.loads` path).

**Claimed:** the comment at line 2996-2997 says this "correctly handles
nested objects like `{"model":{"name":"x"},"translations":[...]}` that the
regex below would choke on."

**Actually happens:** it doesn't. `rc.rfind('{', 0, idx)` finds the
*nearest* unmatched `{` before the `"translations"` key — which, when a
nested object like `"model":{"name":"x"}` sits between the true start and
the key, is that inner object's opening brace, not the outer one's. So
`rc[brace:]` starts mid-object (`{"name":"x"},"translations":[...]}`) and
`json.loads` raises `Extra data` rather than parsing. Strategy B's regex
fallback doesn't catch it either — its `[^{}]*?` guard between the opening
brace and the key breaks on any nested `{}` in between, same root cause.

Verified directly (not from source): rescue on
`'blah blah thinking... {"model":{"name":"x"},"translations":["hi","bye"]}'`
returns `""` from both strategies. Everything without a nested object
before the key — the common case, and everything currently in the test
suite of adversarial inputs tried — rescues correctly.

**Likely real-world trigger:** a thinking model that writes some other
JSON-shaped fragment (draft notes, a nested field) *before* settling on
`translations` in the same reasoning blob, rather than emitting
`{"translations": [...]}` as the first and only object. Not confirmed to
have happened; DeepSeek's thinking output style would need to actually do
this for it to matter.

**Possible fix, not yet tried against real output:** walk backward from
`idx` counting brace depth (increment on `}`, decrement on `{`, stop at the
`{` that brings depth to -1) instead of a single `rfind`, so the brace found
is the true enclosing one regardless of what's nested inside it. Needs
testing against a real captured thinking-mode response with this shape
before shipping, not just the synthetic string above — same standard the
bubble-boundary fix held itself to.

### Vision-OCR coordinate normalization: majority-vote misfires on sparse batches

**Where:** `_ocr_gemini_vision()`, the Case A/B/C normalization block
(around server.py:1630-1660), specifically the `over100_frac >= 0.5` check
for Case C (native 0-1000 scale).

**Claimed:** a majority of a batch's coordinate values being unambiguously
`>100` means the whole batch is on Gemini's native 0-1000 grounding scale,
so dividing everything by 10 is safe.

**Actually happens:** "majority" is measured as a fraction of *individual
values* (`cx`/`cy` pairs flattened), not a per-page confidence signal, so it
degenerates badly on a page with very few detected regions. Verified
directly: a single-region batch with one genuinely out-of-bounds coordinate
(e.g. `cx=105` from ordinary model noise, `cy=40` perfectly normal) hits
`over100_frac = 0.5` and the whole point gets divided by 10 — turning a
mostly-correct coordinate into a definitely-wrong one (`10.5, 4.0`). The
same happens with a 2-region batch where only 2 of 4 values are OOB. A
larger batch is naturally protected (one stray value can't reach 50%), so
this only bites on pages where Vision detected very few regions in the
first place.

**Not disclosed anywhere in the existing coordinate-normalization comment**
(server.py:1579-1622), which documents Cases A/B/C thoroughly but doesn't
flag that C's own detection rule has a small-n blind spot.

**Likely real-world trigger:** a mostly-empty or text-sparse page (title
page, a page with one big SFX and nothing else) combined with an ordinary
single hallucinated coordinate from the model — not a scale-format issue at
all, just normal noise landing on an unlucky page.

**Possible fix, not yet tried against real output:** require a minimum
region count (e.g. only trust the Case C majority-vote when `len(out) >= 4`
or similar) before applying it, falling back to the existing per-item
straggler logic (Case B) or leaving sparse batches unnormalized otherwise.
Needs checking against a handful of real sparse-page Vision responses to
pick a sane threshold rather than guessing one.

---

Both fixes above are sketched, not implemented — deliberately, since
neither bug has a confirmed real trigger yet, and this file's whole point
(per the bubble-boundary precedent) is that a heuristic fix aimed at a
constructed case rather than an observed one is as likely to cause a new
regression as to help. If either of these actually shows up — a page that
comes back with `finish_reason` errors it shouldn't, or a sparse page with
one badge scattered oddly — that's the point to come back here, confirm
the mechanism against the real response, and only then patch it.
