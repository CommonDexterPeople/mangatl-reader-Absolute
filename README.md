# MangaTL-Reader

**Read manga in a language it hasn't been translated into — yet.**

MangaTL-Reader is a self-hosted tool that layers OCR + AI translation on top of MangaDex. Point it at a chapter that's already been fan-translated into Vietnamese, Korean, Indonesian, or any other language, and it re-translates that into whatever language you actually read — live, in your browser, with the original scanlation group credited on every page.

It also works completely offline against your own local folder or `.cbz`/`.zip` files — no MangaDex chapter required — and can pull chapters from a self-hosted [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) instance as a third source.

---

## Contents

- [What it actually does](#what-it-actually-does)
- [Features](#features)
- [Getting started](#getting-started)
- [Requirements](#requirements)
- [Project layout](#project-layout-for-contributors)
- [Known limitations](#known-limitations)
- [A note on scope](#a-note-on-scope)
- [License](#license)

---

## What it actually does

Give it either:

- a **MangaDex chapter URL** — any chapter that's already been translated into a non-English language, or
- a **folder of page images, or a `.cbz`/`.zip` archive** on your own computer

and it hands you back the same chapter, readable in your language, in your browser. No manually retyping dialogue, no waiting on a group that's dropped a series, no needing to learn the bridge language first.

---

## Features

### Translation pipeline
- Dual OCR engines, routed automatically:
  - **EasyOCR** (local, free) is the default and handles most languages well
  - **Gemini Vision** (needs a Gemini key) kicks in for scripts EasyOCR historically struggles with — CJK, Arabic, Thai, Cyrillic, Vietnamese, heavy-diacritic Latin — controlled by a `smart` / `all` / `off` setting: `smart` (default) spends Vision quota only on those hard-mode languages, `all` runs it on every page for max accuracy at roughly double the API calls, `off` disables Vision entirely even with a key on file
  - When Vision is used, EasyOCR still runs afterward purely to double-check bubble *positions* — a real detection model doesn't suffer the spatial drift an LLM's coordinate guess can, so its box gets adopted whenever the text matches, while Vision's own text stays authoritative (shown as `vision+easyocr` in the OCR engine badge)
  - Automatic fallback to EasyOCR if Vision errors, times out, hits a quota limit, or its response fails to parse — surfaced as a toast, never a silent quality drop
  - DeepSeek-only users always get plain EasyOCR — Vision OCR needs a Gemini key regardless of which provider is doing translation
- Translation via **Gemini** or **DeepSeek** — bring your own API key; both offer a free or near-free tier
- Spatial reading-order inference: understands left/right panel columns instead of flattening the whole page into one top-to-bottom blob
- Automatic OCR cleanup before translation — rejoins hyphen-split words, merges a bubble that got split into 2–3 OCR fragments, filters out single-character screentone noise
- Per-region **type classification** (speech / thought / sfx / narration / sign), so sound effects and caption boxes get handled differently from dialogue
- Chapter-level local cache — reopening a chapter you've already translated is instant and doesn't re-spend API calls

### Local Folder / CBZ mode
- Read straight from your own files — no MangaDex chapter needed, and it works fully offline apart from the OCR/translation calls themselves
- Feeds into the exact same OCR → translate → correct → export pipeline as a MangaDex chapter
- Natural filename sorting (`page2.jpg` before `page10.jpg`)
- Automatically skips junk entries (`__MACOSX/`, `.DS_Store`, `ComicInfo.xml`)
- **Known trade-off:** a local chapter's pages live only in that browser tab's memory — closing or reloading loses them, the same way closing a file picker would. Everything else (OCR, translation, corrections, export) works normally within the session.

### Suwayomi-Server mode
- Pull a chapter straight from your own self-hosted [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) instance, alongside MangaDex and local folder/CBZ as a third chapter source
- Same OCR → translate → correct → export pipeline as any other source — nothing about reading, correcting, or exporting a chapter behaves differently once it's loaded
- Chapters loaded this way are cached the same as MangaDex chapters (unlike local folder/CBZ, whose pages don't survive a reload — see above): a Suwayomi chapter's pages are real, re-fetchable URLs against your own server, so there's no downside to keeping the cache entry
- Also available as a source in the standalone Erase Tool, alongside MangaDex and local folder/CBZ (see below)

### Tuning bubble merging
- **⚖ MERGE** on any page opens a live preview of the **Bubble Merge Sensitivity** setting, drawn over that page: each box is one region the pipeline would translate as a unit, and dragging the slider re-groups them instantly
- The right value depends on how a particular series is lettered — how far apart its bubbles sit, how tightly its lines are set — so rather than guess and re-read a chapter to find out, you can see the answer on the page in front of you
- Costs nothing to use: re-grouping already-detected text is pure geometry (~20ms), so it re-runs neither OCR nor translation and spends no API quota

### Manual correction & QA
- **✏ Correct UI** — draw, split, merge, delete, and reorder bubble regions by hand when the automatic pass gets something wrong
- Two ways to draw a *new* region: a normal draw (re-OCRs the crop with EasyOCR) or a **✦ VISION draw** (sends the same crop to Gemini Vision instead) — for stylized/decorative fonts, vertical or mixed-script SFX, or anywhere the confidence badge was clearly wrong
- Per-region retranslation, so you can fix one bubble without re-running the whole page
- **✓ Check Flow** — a manually-triggered, whole-page continuity pass: one AI call re-reads every translated bubble on the page *together* (not one at a time) and flags translations that break the conversation — a pronoun that doesn't match who's speaking, a reply that doesn't follow from the line before it, tone that jars against its neighbors, terminology that's inconsistent with the rest of the page. Deliberately opt-in rather than automatic (it's a second full API call on top of the initial translation pass), and results show as a diff you approve line-by-line, never an auto-apply
- Corrections are saved locally and reapplied automatically the next time that chapter is opened

### Export
- **⬇ Export Typeset Chapter** — downloads the chapter as a zip of flattened PNGs: original text erased, your translation drawn in its place
- Reuses whatever OCR/translation already ran during reading — exporting doesn't trigger new AI calls
- Pages are processed **one at a time** with a live progress panel (⏳ pending / ✓ done / ✗ failed) — a long chapter never means one long blocking request, and you can keep reading while it runs
- Per-page **↻ retry** and **✏ fix** (jumps straight to the correction UI for that page)
- Download-as-you-go: the zip is available as soon as one page finishes, and can be re-downloaded after fixing more

### Typesetting quality
- OpenCV inpainting for textured or shaded bubbles; a cheap flat-fill for plain white/pale ones, auto-routed per region
- Automatic black/white text color choice based on each erased region's own brightness — no black-on-black on dark caption boxes
- Sound effects are left untouched by default — a plain text overlay usually looks worse than the original stylized SFX, so it's skipped the way a human typesetter would
- Font auto-fit-and-wrap to the original bubble's dimensions

### Standalone Erase Tool
- A separate screen for just cleaning a page — erase the original text, draw nothing back — for anyone who wants to do their own typesetting from scratch
- Works from a MangaDex chapter URL, your own local folder/CBZ, or a self-hosted Suwayomi-Server instance — the same three sources the main reader supports

### MangaDex integration
- Optional OAuth login, attaching your account to API requests (useful for rate limits and anything gated to logged-in users)
- Adjacent-chapter navigation (prev/next) without leaving the reader
- Every translated chapter credits the original scanlation group with a link back to their MangaDex profile

### Built with care for a tool that talks to the internet
- Image-fetching routes are restricted to an allowlist of MangaDex CDN hosts, not "any `https://` URL" — closes off a server-side request forgery (SSRF) path
- All externally-sourced text (e.g. scanlation group names from the API) is HTML-escaped before rendering
- Binds to `127.0.0.1` by default and prints a loud warning if you ever change that, since the server has no built-in authentication of its own

---

## Getting started

**Just want to read something?**
Grab the latest `MangaTL-Reader.py` from this repo's **Releases** page and double-click it (or run `python MangaTL-Reader.py`). It auto-installs its own dependencies on first run — this takes a few minutes since EasyOCR downloads a language model — and opens your browser automatically once it's ready.

**Want to edit, extend, or contribute?**
Clone the repo instead. The source is split into readable files, not one multi-thousand-line blob:

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
python server.py
```

Edit anything under `static/` and refresh your browser — no restart needed. Editing `server.py` does need one.

---

## Requirements

- Python 3.9+
- An internet connection (for MangaDex chapters, Vision OCR, and translation)
- A free **Gemini** API key ([aistudio.google.com](https://aistudio.google.com/app/apikey)) **or** a **DeepSeek** key (roughly $0.02–0.05 per chapter)

---

## Project layout (for contributors)

```
.
├── server.py           Flask backend — routes, OCR pipeline, translation providers
├── mtl/                Modules split out of server.py
│   ├── config.py          Constants shared by server.py and the modules below
│   ├── security.py        SSRF allowlist, image-body loading, exposure guard
│   ├── geometry.py        Panel borders, bubble components, fused-bubble waist veto
│   ├── merge.py           Grouping OCR fragments into one region per bubble
│   └── inpaint.py         Text erasure: LaMa, OpenCV inpainting, flat fill, smudge pass
├── static/
│   ├── index.html         Page markup only
│   ├── style.css          All styling
│   └── js/                ES modules, one per concern: chapter pipeline,
│                           correction UI, export, MangaDex auth, etc.
│                           main.js is the entry point; chapter-source.js
│                           defines the Chapter shape every source produces.
└── build.py             Reassembles everything into one distributable .py file
```

`mtl/` exists because `server.py` had grown to ~6,100 lines with the first route
around line 4,600. The modules there are ordinary imports, so the tests import and
call the real functions rather than scraping source text. `build.py` **inlines**
them into the single-file build rather than importing them — so a module in `mtl/`
may import from an earlier one in `config → security → geometry → merge → inpaint`
order, but never from `server.py` itself, and CI checks the built file has no `mtl`
imports left.

`merge.py` is the one module worth reading before you touch it. It was a single
739-line `_merge_bubble_regions()` whose margin math, union-find, vetoes, column
detection and line clustering were all closures — testable only by running the
whole pipeline and inferring from the region count which stage had broken. Each
stage is now a module-level function taking explicit arguments; its module
docstring lists them in the order they run. The algorithm did not change in the
split (verified by running the old and new implementations against identical
inputs, including real pages, and diffing the outputs).

One consequence worth knowing: the structural vetoes are reached through a
`VetoSet`, not called by name. Tests that need to disable exactly one veto — to
prove the symptom it prevents still reproduces without it — pass an override
instead of monkeypatching. Monkeypatching cannot work here, because `merge.py`
binds those functions into its own namespace at import, and it would still
*appear* to work in the single-file build, where `build.py` flattens every module
into one shared namespace.

`static/js/` is ES modules. Each file declares what it imports, so load order is
no longer something you maintain by hand — `index.html` loads exactly one entry
point (`main.js`) and a new module just needs importing wherever it's used.

`main.js` also holds the **global bridge**: `index.html` and a lot of
JS-generated markup call functions straight from inline `onclick="…"`
attributes, which resolve against the global scope at click time. Module scope
isn't global, so `main.js` re-publishes every module's exports onto `window` —
about 100 of the ~440 top-level names are reachable that way. It's a
compatibility shim, not the target state: convert inline handlers to
`addEventListener` or event delegation, then drop modules from that list as
nothing in the markup calls into them.

**Adding a chapter source** (a fourth alongside MangaDex, Suwayomi, and local
folder/CBZ) means writing one loader in `chapter-source.js` that returns a
`Chapter`, then registering it on each screen. It used to mean writing it twice —
once for the reader and once, near-identically, for the Erase Tool. The `Chapter`
shape is documented at the top of `chapter-source.js`; note `cacheable`, which is
what encodes "local pages don't survive a reload" as data rather than prose.

Three consequences worth knowing before editing `static/js/`:

- **You can't assign to another module's binding.** Imports are read-only. Shared
  mutable state goes through setters (`setCancelled()` in
  `state-and-constants.js`), and behaviour is added to another module's function
  by subscribing to a hook it exposes (`onAfterPageRender()` in `page-render.js`),
  never by reassigning it.
- **Prefer `export function` over `export const fn = …`.** Both work under ES
  modules, but the single-file build flattens everything into one classic script,
  where a top-level `const` is a lexical global (reachable from inline handlers,
  but not a `window` property) while a function declaration is both. Declarations
  keep `window.X` resolving identically in either build.
- **Top-level names must stay unique across all of `static/js/`.** Modules
  themselves don't require that, but `build.py` flattens them into one scope for
  the single-file build, where a collision is a redeclaration. The build fails
  loudly if two modules export the same name.

Run `python build.py` to produce `dist/MangaTL-Reader.py` — this is exactly what gets attached to a GitHub Release for the "just double-click it" crowd. Don't hand-edit the built file: fixes belong in `server.py`/`static/`, then re-run the build.

---

## Known limitations

- Local-folder/CBZ pages don't persist across a reload (see [above](#local-folder--cbz-mode)) — this is a deliberate trade-off, not a bug, since caching a chapter whose images can never re-render would be worse than no cache entry at all.
- Six test files cover the SSRF allowlist, the DeepSeek JSON-rescue heuristic, three bubble-segmentation cases, and the merge pipeline's individual stages; there's no broader suite beyond those yet. The three bubble-segmentation suites are synthetic geometry apart from two checks that run against a real page when `eval_samples/` is present, and the stage tests are synthetic by design — they pin each stage's contract, not the real-page tuning of the constants, which lives in `KNOWN_ISSUES_DRAFT.md`. Nothing covers the routes, the translation providers, or any of `static/js/`. All six run in CI on every push/PR (`.github/workflows/ci.yml`), alongside a syntax check of every JS and Python file and a `build.py` smoke test that confirms the single-file build still imports standalone.

---

## A note on scope

This is a **personal reading tool**, not a publishing pipeline. It doesn't scan, host, or store any manga itself — it only processes chapters you already have access to, either through MangaDex's own public API or your own local files, using an AI API key you provide. It credits both MangaDex and the original scanlation group on every chapter, and it doesn't run ads or charge for anything the API provides.

The chapter-export feature produces a finished, shareable file, which is a meaningfully different thing than reading a translated chapter in your own browser. What you do with an exported chapter afterward is your own call and your own responsibility — this project doesn't take a position on it either way.

---

## License

AGPL-3.0 — see [LICENSE](LICENSE). In short: use it, modify it, self-host it, no restrictions for personal use. If you distribute a modified version — including running it as a hosted web service others can use — you need to make that modified source available too.
