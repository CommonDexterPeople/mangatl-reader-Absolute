# MangaTL-Reader

**Read manga in a language it hasn't been translated into — yet.**

MangaTL-Reader is a self-hosted tool that layers OCR + AI translation on top of MangaDex. Point it at a chapter that's already been fan-translated into Vietnamese, Korean, Indonesian, or any other language, and it re-translates that into whatever language you actually read — live, in your browser, with the original scanlation group credited on every page.

It also works completely offline against your own local folder or `.cbz`/`.zip` files — no MangaDex chapter required.

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
- OCR via **EasyOCR** (local, free) or **Gemini Vision** (higher quality, needs an API key), with automatic fallback from Vision → EasyOCR on quota or network errors — you'll see a toast if this happens, not a silent quality drop
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

### Manual correction & QA
- **✏ Correct UI** — draw, split, merge, delete, and reorder bubble regions by hand when the automatic pass gets something wrong
- Per-region retranslation, so you can fix one bubble without re-running the whole page
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
- Currently MangaDex-chapter only (see [Known limitations](#known-limitations))

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
├── static/
│   ├── index.html         Page markup only
│   ├── style.css          All styling
│   └── js/                One module per concern: chapter pipeline, correction UI,
│                           export, local-source handling, MangaDex auth, etc.
└── build.py             Reassembles everything into one distributable .py file
```

Load order matters in `static/js/` — these are plain `<script>` tags sharing one global scope, not ES modules, so a new module's `<script>` tag needs to go into `index.html` after whatever it depends on.

Run `python build.py` to produce `dist/MangaTL-Reader.py` — this is exactly what gets attached to a GitHub Release for the "just double-click it" crowd. Don't hand-edit the built file: fixes belong in `server.py`/`static/`, then re-run the build.

---

## Known limitations

- Local-folder/CBZ pages don't persist across a reload (see [above](#local-folder--cbz-mode)) — this is a deliberate trade-off, not a bug, since caching a chapter whose images can never re-render would be worse than no cache entry at all.
- The standalone Erase Tool doesn't yet accept local-folder/CBZ input — MangaDex chapters only, for now.
- No automated test suite yet.

---

## A note on scope

This is a **personal reading tool**, not a publishing pipeline. It doesn't scan, host, or store any manga itself — it only processes chapters you already have access to, either through MangaDex's own public API or your own local files, using an AI API key you provide. It credits both MangaDex and the original scanlation group on every chapter, and it doesn't run ads or charge for anything the API provides.

The chapter-export feature produces a finished, shareable file, which is a meaningfully different thing than reading a translated chapter in your own browser. What you do with an exported chapter afterward is your own call and your own responsibility — this project doesn't take a position on it either way.

---

## License

MIT — see [LICENSE](LICENSE).
