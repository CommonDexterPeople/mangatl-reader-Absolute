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
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
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
- Three OCR engines — two local and free, one API-based — routed automatically:
  - **EasyOCR** (local, free) — the default when installed. The more reliable of the two local engines on most languages, and clearly better on Vietnamese stacked tone marks. Heavier: it pulls in torch, and downloads a language model (~100–400 MB) the first time you use it.
  - **RapidOCR** (local, free) — consistently 4–7× faster and far lighter on memory, and it bundles its own model (~30 MB) rather than downloading one, so it works offline immediately. Its model is one shared character set rather than being bound to the chapter's declared language, which makes it structurally better on a page whose actual language differs from what the chapter says. Weaker on stacked diacritics — it drops or swaps Vietnamese tone marks.
  - **Gemini Vision** (needs a Gemini key) kicks in for scripts the local engines historically struggle with — CJK, Arabic, Thai, Cyrillic, Vietnamese, heavy-diacritic Latin — controlled by a `smart` / `all` / `off` setting: `smart` (default) spends Vision quota only on those hard-mode languages, `all` runs it on every page for max accuracy at roughly double the API calls, `off` disables Vision entirely even with a key on file
- Which local engine runs is **your choice, per chapter**, in the Local OCR Engine setting. Neither wins outright — they have genuinely different per-language strengths — so the app suggests one per chapter based on the source language and lets you accept it, keep your pick, or make it the default for that language. Shown once per chapter, not once per page.
  - When Vision is used, your chosen local engine still runs afterward purely to double-check bubble *positions* — a real detection model doesn't suffer the spatial drift an LLM's coordinate guess can, so its box gets adopted whenever the text matches, while Vision's own text stays authoritative (shown as `vision+easyocr` or `vision+rapidocr` in the OCR engine badge)
  - Automatic fallback to your chosen local engine if Vision errors, times out, hits a quota limit, or its response fails to parse — surfaced as a toast, never a silent quality drop
  - DeepSeek-only users always get plain local OCR — Vision OCR needs a Gemini key regardless of which provider is doing translation
  - **The packaged Windows build ships RapidOCR only.** Bundling EasyOCR would mean shipping torch and still downloading a model on first use — see [packaging/README.md](packaging/README.md). Running from source gives you both.
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
- Two ways to draw a *new* region: a normal draw (re-OCRs the crop with whichever local engine is active) or a **✦ VISION draw** (sends the same crop to Gemini Vision instead) — for stylized/decorative fonts, vertical or mixed-script SFX, or anywhere the confidence badge was clearly wrong
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
- Binds to `127.0.0.1` by default, and *refuses to start* on any other address unless you set `MTL_ALLOW_EXPOSED=1` — the server has no authentication of its own, so exposing it has to be a deliberate act rather than an easy-to-miss side effect
- Rejects cross-origin requests and unexpected `Host` headers, so a random website you happen to have open can't drive the pipeline behind your back (CSRF), and a hostile domain can't re-resolve itself to `127.0.0.1` to read the responses (DNS rebinding)
  - If you run it behind a reverse proxy, name the hostname(s) the proxy forwards so they aren't rejected: `MTL_ALLOWED_HOSTS=manga.example.com python server.py`

---

## Getting started

**Just want to read something?**

> **No release is published yet** — the Releases page is empty, so for now both
> builds below are made from a clone. `python build.py` produces the single-file
> `dist/MangaTL-Reader.py`; [packaging/README.md](packaging/README.md) covers the
> Windows installer. Once a release is cut, they'll be downloads rather than
> build steps and the rest of this section applies as written.

Two builds, whose first-run cost is very different:

| | Windows installer | `MangaTL-Reader.py` (any OS) |
|---|---|---|
| Install | Next-next-finish, Start Menu shortcut | Double-click the file, or `python MangaTL-Reader.py` |
| First run | **Ready immediately** | **A few minutes** — installs its own dependencies |
| First page you OCR | Ready immediately | **~100–400 MB** — EasyOCR fetches its language model |
| OCR engines | RapidOCR + Gemini Vision | EasyOCR + RapidOCR + Gemini Vision |

The single-file build installs EasyOCR, which pulls in PyTorch — that is the
bulk of those few minutes, not the language model, which is fetched separately
and later. The installer carries RapidOCR's models inside it and needs neither
step, at the cost of not having EasyOCR at all
(see [packaging/README.md](packaging/README.md) for why that trade is worth it).

Both costs are one-time either way; later runs start in seconds.

**Want to edit, extend, or contribute?**
Clone the repo and see **[CONTRIBUTING.md](CONTRIBUTING.md)**:

```bash
git clone https://github.com/CommonDexterPeople/mangatl-reader-Absolute.git
cd mangatl-reader-Absolute
python server.py
```

Running from source has the same first-run cost as the single-file build: it
installs what's missing on startup (PyTorch being most of it), and EasyOCR
fetches its language model the first time you actually OCR a page — not at
startup. The browser opens on its own when the server is ready.

**Then you need an API key.** Translation is the one part that isn't local:

- **Gemini** — free tier, no card: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Also unlocks Vision OCR, which is what handles Japanese, Korean, Chinese, Thai, Cyrillic and Vietnamese well.
- **DeepSeek** — roughly $0.02–0.05 per chapter: [platform.deepseek.com](https://platform.deepseek.com)
- **DeepL** — translation only, no speech/thought/SFX typing

Paste it into the key field on the main screen. It is stored in your browser's
`localStorage` and sent to your own local server, never anywhere else — see
[SECURITY.md](SECURITY.md).

---

## Requirements

- Python 3.11+ — this is what CI runs, and what the current dependency set
  actually resolves against (`numpy` and `onnxruntime` both require 3.11+;
  `requests`, `pillow` and `torch` require 3.10+). Python 3.9 has been
  end-of-life since October 2025 and 3.10 reaches it in October 2026.
- An internet connection (for MangaDex chapters, Vision OCR, and translation)
- A free **Gemini** API key ([aistudio.google.com](https://aistudio.google.com/app/apikey)) **or** a **DeepSeek** key (roughly $0.02–0.05 per chapter)

---

## Configuration

Everything is optional; the defaults are what you want for reading on your own
machine.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to serve on. The app tells you to set this if 8080 is taken. |
| `MTL_SUWAYOMI_HOST` | `127.0.0.1:4567` | Where your Suwayomi-Server lives, if not the default port. |
| `MTL_MODEL_DIR` | next to the app | Where downloaded model checkpoints are cached. Set it if the install directory isn't writable (a machine-wide install under Program Files, a read-only mount). |
| `MTL_ALLOW_EXPOSED` | unset | Required to start on a non-localhost address. The server has no authentication, so exposing it has to be deliberate — read [SECURITY.md](SECURITY.md) first. |
| `MTL_ALLOWED_HOSTS` | unset | Comma-separated hostnames to accept in the `Host` header. Needed only behind a reverse proxy, which forwards its own hostname. |

```bash
PORT=8081 python server.py                    # macOS/Linux
$env:PORT=8081; python server.py              # Windows PowerShell
```

---

## Troubleshooting

**"Port 8080 is already in use."** Something else has it. Set `PORT` as above —
no need to edit any file.

**Windows warns about an unknown publisher.** The packaged build isn't
code-signed (a certificate is an annual cost this project doesn't carry), so
SmartScreen and some antivirus flag it. "More info" → "Run anyway", or run from
source instead if you'd rather not.

**First run seems frozen.** It's downloading the EasyOCR model — a few hundred
MB with no progress bar. Give it a few minutes. It only happens once.

**Translation fails but OCR works.** Almost always the API key: wrong provider
selected for the key you pasted, or a free-tier quota that has run out. The
error toast names which provider rejected it.

**Everything is slow, or OCR quality is poor.** Try the other local engine
(EasyOCR vs RapidOCR) in the settings — they have genuinely different
per-language strengths, and the app suggests one per chapter. With a Gemini key,
Vision OCR handles the hard scripts far better than either.

**Bubbles are merged together or split apart.** Use **⚖ MERGE** on the page to
tune the sensitivity live — it costs no API calls. **✏ Correct** fixes
individual regions by hand.

---

## Project layout

Moved to **[CONTRIBUTING.md](CONTRIBUTING.md)** — the module map, why `mtl/`
exists, how `build.py` flattens everything into the single-file build, and the
three things about `static/js/` that will bite you before you notice them.

---

## Known limitations

- Local-folder/CBZ pages don't persist across a reload (see [above](#local-folder--cbz-mode)) — this is a deliberate trade-off, not a bug, since caching a chapter whose images can never re-render would be worse than no cache entry at all.
- Eight test files cover the SSRF allowlist, the DeepSeek JSON-rescue heuristic, four bubble-segmentation cases, the merge pipeline's individual stages, and the model registry's consistency across the picker, `MODEL_INFO` and `rates.json`; there's no broader suite beyond those yet. The four bubble-segmentation suites are synthetic geometry apart from two checks that run against a real page when `eval_samples/` is present, and the stage tests are synthetic by design — they pin each stage's contract, not the real-page tuning of the constants, which lives in `KNOWN_LIMITATION_DRAFT.md`. Nothing covers the routes, the translation providers, or any of `static/js/`. All eight run in CI on every push/PR (`.github/workflows/ci.yml`), alongside a syntax check of every JS and Python file and a `build.py` smoke test that confirms the single-file build still imports standalone.

---

## A note on scope

This is a **personal reading tool**, not a publishing pipeline. It doesn't scan, host, or store any manga itself — it only processes chapters you already have access to, either through MangaDex's own public API or your own local files, using an AI API key you provide. It credits both MangaDex and the original scanlation group on every chapter, and it doesn't run ads or charge for anything the API provides.

The chapter-export feature produces a finished, shareable file, which is a meaningfully different thing than reading a translated chapter in your own browser. What you do with an exported chapter afterward is your own call and your own responsibility — this project doesn't take a position on it either way.

---

## License

AGPL-3.0 — see [LICENSE](LICENSE). In short: use it, modify it, self-host it, no restrictions for personal use. If you distribute a modified version — including running it as a hosted web service others can use — you need to make that modified source available too.
