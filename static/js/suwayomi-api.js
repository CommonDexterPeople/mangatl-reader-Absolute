// ═══════════════════════════════════════════════════════════════
// suwayomi-api.js
// Reads chapter/page data from a self-hosted Suwayomi-Server instance
// (github.com/Suwayomi/Suwayomi-Server) via its REST API. Suwayomi runs
// real Tachiyomi/Mihon Android extensions through an Android-compat layer,
// which is what actually matters here — it's the door to hundreds of
// community-maintained sources (raw scans, manhwa/manhua, non-English
// releases) beyond whatever MangaDex happens to have translated.
//
// Unlike MangaDex, there's no "paste a chapter URL" flow: Suwayomi
// identifies a chapter by (mangaId, chapterIndex), both discovered by
// browsing Suwayomi's own WebUI (http://127.0.0.1:4567 by default) — the
// mangaId is in that page's URL, and chapterIndex is the `index` field
// from GET /api/v1/manga/{mangaId}/chapters (1, 2, 3… — NOT the chapter's
// `id` field, which is a global cross-manga id, and NOT `chapterNumber`,
// which is a float that can skip or repeat for specials).
//
// chapterFromSuwayomi() returns the exact same {id, kind, title,
// sourceLang, pages: [{cdn, img}]} shape chapterFromFileList()/
// chapterFromCbz() do (local-source.js) — so it drops straight into
// whatever already consumes THAT shape (e.g. erase-tool.js's
// _loadEraseLocalChapter, or a pipeline.js entry point built the same way)
// without either needing to change for a third source. Nothing here has
// been wired into the UI yet — this is the adapter only, same as
// local-source.js's chapterFrom* functions existed before they got a
// "Local Folder / CBZ" button pointed at them.
//
// cdn/img both point at the same Suwayomi URL, routed through this
// server's existing /proxy — same reason MangaDex's fetchPageUrls()
// (mangadex-api.js) does that instead of using the CDN URL directly: an
// <img> drawn onto the erase tool's <canvas> taints that canvas unless
// it's same-origin, and Suwayomi (127.0.0.1:4567) is a different origin
// from this app even though it's on the same machine. `cdn` still carries
// the raw Suwayomi URL too, since /ocr, /vision-crop, and /export-page all
// fetch it themselves server-side (via imageRefBody()'s `{url: cdn}`
// branch, same as MangaDex) rather than needing the browser's copy.
//
// server.py's _validate_image_url() has a narrow, explicit carve-out for
// exactly this host:port (SUWAYOMI_HOST) — it does NOT accept arbitrary
// http:// or "localhost" URLs generally, only this one designated host. If
// your Suwayomi instance runs somewhere else, change SUWAYOMI_BASE below
// AND SUWAYOMI_HOST in server.py to match (or set the MTL_SUWAYOMI_HOST
// env var server-side instead of editing the constant).
// ═══════════════════════════════════════════════════════════════

const SUWAYOMI_BASE = 'http://127.0.0.1:4567'; // must match SUWAYOMI_HOST in server.py

/**
 * Fetches a single chapter's page list from Suwayomi and returns it in the
 * standard chapter-object shape.
 *
 *   mangaId      — Suwayomi's internal manga id (e.g. 229)
 *   chapterIndex — the chapter's `index` field, not `id` or `chapterNumber`
 *                  (see the file header above)
 *   sourceLang   — language code for OCR/translation. Suwayomi doesn't
 *                  report a chapter's language anywhere in its API, so
 *                  this has to come from whoever's calling this — same
 *                  requirement chapterFromFileList()/chapterFromCbz() have.
 */
async function chapterFromSuwayomi(mangaId, chapterIndex, sourceLang) {
  const detailUrl = `${SUWAYOMI_BASE}/api/v1/manga/${mangaId}/chapter/${chapterIndex}`;
  let meta;
  try {
    const r = await fetch(detailUrl);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    meta = await r.json();
  } catch (e) {
    throw new Error(
      `Couldn't reach Suwayomi at ${SUWAYOMI_BASE} (${e.message}). ` +
      `Is the server running, and is SUWAYOMI_BASE pointed at the right host:port?`
    );
  }

  // pageCount sits at -1 until Suwayomi's actually fetched this chapter's
  // real page list from its source extension at least once — same
  // "-1 until opened" you'll see for any never-opened chapter in
  // GET /api/v1/manga/{mangaId}/chapters. Opening it once in Suwayomi's
  // own reader (or any client) resolves this; there's no way to force that
  // fetch from here without duplicating Suwayomi's own source-extension
  // logic, which is well outside what this adapter should be doing.
  const pageCount = meta.pageCount;
  if (typeof pageCount !== 'number' || pageCount <= 0) {
    throw new Error(
      `Suwayomi hasn't fetched this chapter's pages yet (pageCount=${pageCount}). ` +
      `Open chapter ${chapterIndex} once in Suwayomi's own reader first, then try again.`
    );
  }

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const cdn = `${SUWAYOMI_BASE}/api/v1/manga/${mangaId}/chapter/${chapterIndex}/page/${i}`;
    pages.push({ cdn, img: `/proxy?url=${encodeURIComponent(cdn)}` });
  }

  return {
    id:         `suwayomi:${mangaId}:${chapterIndex}`,
    kind:       'suwayomi',
    title:      meta.name || `Chapter ${chapterIndex}`,
    sourceLang: sourceLang || 'ja',
    pages,
  };
}
