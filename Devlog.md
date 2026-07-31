# MangaTL-Reader — project layout

This used to be one 5,484-line `.py` file. It's now split into files you can
actually navigate, edit, and get real syntax highlighting for. Nothing about
*how the app behaves* changed — only where the code lives.

```
.
├── server.py           Flask backend: routes, OCR pipeline, translation providers.
├── static/
│   ├── index.html        Page markup only.
│   ├── style.css          All CSS (was the <style> block).
│   └── js/                All JS (was the <script> block), split into modules:
│       ├── state-and-constants.js   globals + language-name table
│       ├── cache.js                 localStorage chapter cache + its UI
│       ├── utils.js                 runConcurrent, toast/status, esc(), nav
│       ├── mangadex-api.js          chapter/page fetch, adjacent-chapter lookup
│       ├── local-source.js          local-folder/CBZ input — the non-MangaDex
│       │                              counterpart to mangadex-api.js (see below)
│       ├── ocr-client.js            calls into backend /ocr
│       ├── mangadex-auth.js         OAuth2 login/refresh
│       ├── translate-client.js      model/lang selection, translateBatch()
│       ├── page-render.js           page skeleton/render/retry
│       ├── pipeline.js              the main fetch→OCR→translate→render loop
│       ├── reorder-ui.js            manual reading-order UI
│       ├── box-overlay.js           shared drag-to-draw/render box engine
│       │                              (used by both correction-ui.js and
│       │                              erase-tool.js — see its header)
│       ├── correction-ui.js         manual bubble-correction UI
│       ├── zip-writer.js            dependency-free client-side ZIP builder
│       └── export.js                "Export Typeset" — one page at a time, with retry/fix
└── build.py             Reassembles everything into one distributable .py file.
```

## Vision OCR coordinate bug: badges/boxes scattered on flagship models

**Symptom:** with `gemini-3.5-flash` or `gemini-3.1-pro-preview` selected (and
Vision OCR mode `smart`/`all`), numbered badges piled up in the page's
bottom-right corner and correction/erase boxes rendered as huge, near-full-page
rectangles — while the translated text itself still came through fine.

**Cause:** `_ocr_gemini_vision()` in `server.py` prompts Gemini for coords on
a custom 0–100 scale, but the flagship models' strong built-in
object-detection/grounding prior sometimes overrides that and returns coords
on Gemini's *native* 0–1000 scale instead (e.g. `cx: 752` for a bubble really
at 75.2%). The existing coordinate-format fixes only covered two Flash-Lite
failure modes (all-fractional 0–1, and a mixed 0–1/0–100 batch) — a
systematically-0–1000 batch matched neither, so it fell straight through to
the "keep badges on-screen" safety clamp, which pins anything over 99 down to
99. Since real text is rarely in the top-left 10% of a page, that meant
almost every badge got clamped into the same corner, and every box clamped
into a near-full-page rectangle. Translation was unaffected because it runs
on Gemini's extracted `text`, which is separate from the (mis-scaled)
coordinates.

**Fix:** a third detection case in that same normalization block — if a
majority of the coordinates in a batch are unambiguously > 100 (impossible on
a correctly-scaled 0–100 batch), divide the whole batch by 10 before the
safety clamp runs. `CACHE_V` bumped to 5 so any chapter cached while this bug
was live gets dropped and re-fetched with correct coordinates.

## Vision OCR resize: webtoon strips coming out illegible

**Symptom:** on a tall webtoon/manhwa page (especially an uncut single-strip
episode imported via local folder/CBZ), Vision OCR misses text or returns
garbage — worse than a normal manga page using the same settings.

**Cause:** `_ocr_gemini_vision()` resizes every page into a flat `(800,
1200)` box before sending it to Gemini. `Image.thumbnail()` picks one scale
factor that satisfies both dimensions — for a normal manga page (~1.5:1)
that's a no-op or close to it, but for a tall strip (e.g. 800x6000, ~7.5:1)
the factor gets dragged down to whatever the 1200px height cap demands,
crushing the width along with it even though the width alone was already
within its own 800 budget. A 800x6000 strip came out ~160px wide.

**Fix:** the height budget now grows with the page's own aspect ratio once
it's clearly not a normal page (aspect > 2), capped at 4800 so a
pathologically long uncut strip still gets bounded image-token cost. Normal
pages are untouched — byte-identical output to before. `CACHE_V` bumped to 6.

## Suwayomi-Server adapter (third source, beyond MangaDex)

**What:** `static/js/suwayomi-api.js` — `chapterFromSuwayomi(mangaId,
chapterIndex, sourceLang)` fetches a chapter's page list from a self-hosted
[Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) instance
(`http://127.0.0.1:4567` by default) and returns it in the same `{id, kind,
title, sourceLang, pages: [{cdn, img}]}` shape `chapterFromFileList`/
`chapterFromCbz` (local-source.js) already use.

**Wired up:** a "Suwayomi (self-hosted)" collapsible section on the home
screen (Manga ID, Chapter Index, Source Language, Load Chapter), feeding
`startPipelineWithSuwayomiSource()` in `pipeline.js` — the counterpart to
`startPipelineWithLocalSource()`, with one real difference: `cacheable: true`
here. A local chapter's page Blobs live only in memory for the tab, so
caching its translations without the images would leave a dead "✓ cached"
entry — but a Suwayomi chapter's pages are real, re-fetchable `http://` URLs
against a server expected to still be running next time, exactly like a
MangaDex chapter's CDN URLs are, so there's no reason to lose that benefit.
Not wired into the Erase Tool's own local-source section yet — that'd be the
same `_loadEraseLocalChapter()` pattern the local-folder/CBZ path already
uses there, just fed a Suwayomi chapter object instead.

Suwayomi identifies a chapter by `(mangaId, chapterIndex)`, both found by
browsing Suwayomi's own WebUI — there's no "paste a URL" flow the way
MangaDex has one. `chapterIndex` is the chapter's `index` field from
`GET /api/v1/manga/{mangaId}/chapters` (1, 2, 3…) — not its `id` (a global
cross-manga id) or `chapterNumber` (a float that can skip/repeat for
specials). A chapter's `pageCount` sits at `-1` until Suwayomi's actually
fetched its real page list from the source extension at least once — open it
in Suwayomi's own reader first if `chapterFromSuwayomi` complains about that.

**The one server-side change this needed:** `server.py`'s `_validate_image_url()`
previously hard-required `https://` and a MangaDex-CDN hostname — both fail
outright for Suwayomi's plain-`http://`-on-localhost default. Rather than
loosen either check generally, there's now a `SUWAYOMI_HOST` constant
(env-overridable via `MTL_SUWAYOMI_HOST`) carving out that **one exact
host:port**, checked before the `https://` requirement. This keeps the
guard's actual job intact: even a maliciously-crafted URL smuggled into a
request body can only reach that one designated port, not arbitrary
internal/local hosts. If your Suwayomi instance runs somewhere other than
`127.0.0.1:4567`, update `SUWAYOMI_HOST` here **and** `SUWAYOMI_BASE` in
`suwayomi-api.js` to match — both sides compare the literal host:port
string, so e.g. `localhost:4567` and `127.0.0.1:4567` are NOT
interchangeable; use the same one on both sides.

## Local Folder / CBZ input

The home screen has a collapsible **"Local Folder / CBZ"** section (below
the MangaDex chapter URL field) that reads pages straight from your
computer — no MangaDex chapter needed, and it works fully offline apart
from the OCR/translation AI calls themselves:

- **📁 Open Folder** — picks a folder of page images
  (`<input webkitdirectory>`), natural-sorted by filename
  (`page2.jpg` before `page10.jpg`).
- **📦 Open CBZ / ZIP** — reads a `.cbz`/`.zip` archive client-side and
  extracts its images in the same natural-sorted order. Junk entries
  (`__MACOSX/`, `.DS_Store`, `ComicInfo.xml`) are skipped automatically.

Pick a **Source Language** first (there's no chapter metadata to read it
from, unlike a MangaDex chapter), then either button drops straight into
the same reader/OCR/translate pipeline a MangaDex chapter uses.

**Architecture.** `local-source.js` is a second "source adapter" alongside
`mangadex-api.js` — it produces the exact same `{cdn, img}` page shape
`fetchPageUrls()` does (`cdn` is a `local-blob:<id>` reference instead of
an `https://` CDN url), so `pipeline.js` / `page-render.js` / `export.js` /
`correction-ui.js` don't need to know or care which kind of chapter they're
looking at. The one seam is `imageRefBody(cdnRef)`, which every OCR/crop/
export fetch call resolves its request body through — it sends `{url:...}`
for a real CDN url, or base64-encodes the local Blob into `{image_b64:...}`
otherwise. On the backend, `_load_image_bytes()` in `server.py` is the
mirror image: it accepts either shape and returns raw bytes either way, with
`image_b64` skipping `_validate_image_url`/`requests.get` entirely (there's
no URL to fetch, and therefore nothing to SSRF — the browser already has
the bytes). The CBZ reader itself is a from-scratch STORE+DEFLATE ZIP
parser (using `DecompressionStream`, no library), in the same
zero-external-dependency spirit as `zip-writer.js`.

**Known limitation: no persistence across a reload.** A local page's image
lives only in this tab's memory (a `Blob` + its `URL.createObjectURL()`),
never written to disk or IndexedDB — closing or reloading the tab loses
it, the same way closing a file-picker dialog would. Local chapters
deliberately don't get written to the localStorage chapter cache for this
reason (a "✓ cached" entry that can never re-render its images would be
worse than no cache entry at all — see the `cacheable` flag on
`_runChapterPipeline`/`startPipelineWithLocalSource` in `pipeline.js`).
Everything else — OCR, translation, ✏ CORRECT, and ⬇ Export Typeset — works
normally within the same session; it just doesn't survive a reload, same as
the images themselves don't. Giving local chapters real persistence would
mean storing the page bytes in IndexedDB instead of memory — a reasonable
next step if this turns out to matter in practice, not implemented here.

**Now wired up:** the standalone 🧹 Erase Tool screen also has its own
"Local Folder / CBZ" section (below the MangaDex chapter URL field), built
from the same `local-source.js` building blocks the main reader uses
(`chapterFromFileList`/`chapterFromCbz`/`imageRefBody`) — see
`_loadEraseLocalChapter()` in `erase-tool.js`, the counterpart to
`loadEraseChapter()`'s MangaDex path. Both paths converge on the same
`_erasePageList`/`_loadEraseCurrentPage()` state, so page navigation,
✦ seed from OCR, ✦ VISION draw, and 🧹 Erase all work identically regardless
of source — the only two call sites that ever needed to change were the
`/vision-crop` and `/export-page` request bodies, which now go through
`imageRefBody()` instead of hardcoding `{url: ...}`. The backend needed no
changes at all: `/export-page` and `/vision-crop` already accepted
`image_b64` via `_load_image_bytes()`.

## Erase Tool: batch save + zip download

The 🧹 Erase Tool no longer forces a download after every single page. Once
🧹 Erase finishes a page (and after any 🖌 brush touch-ups you make on it),
hit **💾 Save to batch** — this stores that page's finished image in memory
(keyed by page number; re-saving the same page just replaces its old copy)
without downloading anything yet. A panel above the page appears once at
least one page is saved, showing how many are queued, with:

- **⬇ Download ZIP (N)** — zips every saved page (client-side, via the same
  dependency-free `zip-writer.js` "⬇ Export Typeset" uses) and downloads it
  immediately.
- **✕ remove** per page, and **✕ clear batch** for all of them.
- **⬇ Download this page only** is still there too, next to 💾 Save to
  batch, for a quick one-off page without touching the batch at all.

The batch is scoped to whatever's currently loaded — pasting a new chapter
URL or opening a different local folder/CBZ starts a fresh, empty batch
rather than mixing pages from two different sources into one zip. See
`_eraseBatch` and the functions around it (`eraseSaveToBatch`,
`eraseDownloadBatchZip`, etc.) in `erase-tool.js`.

## Export Typeset Chapter

The reader has an "⬇ Export Typeset" button (top of the reading screen) that
downloads the currently-open chapter as a zip of flattened PNGs — original
text erased (via OpenCV inpainting), translated text drawn in its place.
It reuses whatever OCR/translation the reader already did — no extra AI
calls happen on export. If you've corrected any pages in the ✏ CORRECT UI,
the corrected version is used for those pages automatically.

**Pages are processed one at a time**, not as one big batch — a progress
panel appears below the header showing every page's status (⏳ pending,
✓ done, ✗ failed) as it goes, so a long chapter never means one long
blocking request. You can keep scrolling/reading while it runs.

If a page fails or comes out wrong:
- **↻ retry** re-runs just that page (picks up any correction-UI edit you've
  since made, in case you fixed the translation and want to re-export it)
- **✏ fix** scrolls to that page and opens the correction UI directly

**⬇ Download zip (N ready)** is available as soon as at least one page has
finished — you don't have to wait for the whole chapter, and you can
re-download after retrying more pages to get an updated zip.

Backend: `/export-page` (single page, called once per page by the frontend
loop) in `server.py`, built on a small typesetting module (`typeset_page()`)
that does the inpaint-erase + font-fit-and-wrap text draw. Image bytes come
from either a MangaDex CDN url (goes through the `_validate_image_url`
allowlist) or a local-folder/CBZ page's `image_b64` — see `_load_image_bytes()`
and the Local Folder / CBZ section above.
`/export-chapter` (whole-chapter, all pages in one request) still exists
server-side for anyone scripting against the API directly, but the UI no
longer uses it — zipping now happens client-side (`static/js/zip-writer.js`,
a small dependency-free ZIP writer) so partial progress can be downloaded
without a server round-trip.

## Day to day: edit here

Run the app normally:

```
python server.py
```

Edit `static/index.html`, `static/style.css`, or any file under `static/js/` —
Flask serves them straight from disk, so a browser refresh picks up changes
with no server restart needed (unlike editing Python route code, which still
needs a restart).

**Load order matters.** The files under `static/js/` share one global scope
(plain `<script>` tags, not ES modules — same as the original), so a module
can only use functions/variables defined in a module that loaded *before* it
in `index.html`. If you add a new module, add its `<script src="...">` tag in
`index.html` at the point in the list where its dependencies are already
satisfied.

## Sharing one file: build it

If you want to hand someone a single `.py` file — no folder, no "keep these
files together" — run:

```
python build.py
```

This reads `server.py` + everything under `static/` and writes
`dist/MangaTL-Reader.py`: one file, frontend inlined, byte-for-byte the same
behavior as this project (verified — the rebuilt JS is logic-identical to the
split source with comments stripped).

**Don't hand-edit `dist/MangaTL-Reader.py`.** Treat it as a build artifact.
If you find a bug in it, the fix belongs in `server.py` / `static/`, and then
you re-run `build.py`. Otherwise your fix will quietly vanish the next time
you rebuild.

```
python build.py --output dist/MyCustomName.py   # optional: custom output path
```
