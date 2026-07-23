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

**Not yet wired up:** the standalone 🧹 Erase Tool screen still only loads
pages by MangaDex URL — it wasn't touched, since it's a separate
loading path from the main reader pipeline. Giving it a local-folder/CBZ
input too would reuse the same `local-source.js` building blocks
(`chapterFromFileList`/`chapterFromCbz`/`imageRefBody`), just wired into
`erase-tool.js`'s own page-loading instead of `pipeline.js`'s.

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
