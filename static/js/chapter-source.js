// ═══════════════════════════════════════════════════════════════
// chapter-source.js
// One Chapter shape, one loader per source, one source-picker factory.
// ═══════════════════════════════════════════════════════════════
//
// There are three places a chapter can come from — MangaDex, a self-hosted
// Suwayomi server, and a local folder/.cbz — and two screens that consume
// them: the reader (pipeline.js) and the standalone Erase Tool
// (erase-tool.js). That is 3 x 2, and it was written out as six near-copies:
// erase-tool.js had its own toggleEraseLocalSource / handleEraseLocalFolderInput
// / loadEraseFromSuwayomi that differed from local-source.js's and
// pipeline.js's only in which DOM ids they touched and which function they
// handed the result to. Adding a fourth source meant writing it twice.
//
// This file is the seam. A source produces a Chapter; a screen consumes one.
// Neither knows about the other, so a new source is one loader here plus one
// registration per screen, and a new screen reuses all three loaders as-is.
//
// ── The Chapter shape ────────────────────────────────────────────────────────
//   id          string   Unique, prefixed by source ('local:…', 'suwayomi:…',
//                        or a bare MangaDex UUID).
//   kind        string   'mangadex' | 'suwayomi' | 'folder' | 'cbz'. Shown in
//                        the reader header and used for source-specific copy.
//   title       string   Display title.
//   sourceLang  string   Language to translate FROM.
//   pages       array    [{ cdn, img }] — cdn is what the server fetches for
//                        OCR/export, img is what the <img> tag displays. They
//                        differ for proxied and local-blob sources.
//   mangaId     ?string  Stable per-series key where one exists (MangaDex and
//                        Suwayomi); null for local folder/CBZ, which have no
//                        stable series identity. glossary.js keys off this.
//   cacheable   boolean  Whether this chapter survives a reload. False for
//                        local sources: their pages are object URLs backed by
//                        blobs in this tab's memory, so a cache entry would
//                        point at images that can never render again. This
//                        used to be prose in the README; it is a field now so
//                        the rule lives with the data it describes.

import { fetchChapterMeta, fetchPageUrls } from './mangadex-api.js';
import { chapterFromSuwayomi } from './suwayomi-api.js';
import { chapterFromCbz, chapterFromFileList } from './local-source.js';
import { toast } from './utils.js';

/**
 * Load a MangaDex chapter as a Chapter.
 *
 * Meta and page list are fetched together, but `onMeta` fires the moment meta
 * lands, before the page list resolves. That exists because the reader shows
 * the title and scanlation-group credit as soon as it can and only then says
 * "Loading page list…" — folding both fetches into one await would have held
 * the header blank until the slower of the two finished. The Erase Tool has no
 * header to fill and simply omits the callback.
 */
export async function chapterFromMangaDex(chapterId, quality = 'data', signal, { onMeta } = {}) {
  const metaPromise = fetchChapterMeta(chapterId, signal);
  // A meta failure is non-fatal: the Erase Tool stays fully usable for
  // manual-only boxes without it, and the reader still has the page list.
  // sourceLang then falls back to 'en', matching what callers already tolerate.
  const meta = await metaPromise.catch(() => null);
  if (meta && onMeta) onMeta(meta);

  const pages = await fetchPageUrls(chapterId, quality, signal);
  if (!pages.length) throw new Error('No pages found for this chapter.');

  return {
    id:         chapterId,
    kind:       'mangadex',
    title:      meta?.mangaTitle || chapterId,
    sourceLang: meta?.translatedLanguage || 'en',
    pages,
    mangaId:    meta?.mangaId || null,
    cacheable:  true,
    meta,       // MangaDex-only: chapter number, volume, groups — for the header.
  };
}

// ── Source-picker factories ──────────────────────────────────────────────────
// Both screens render the same controls with different id prefixes ('' for the
// reader, 'erase-' for the Erase Tool). These build the handler set once and
// let each screen supply the prefix and what to do with the resulting Chapter.
//
// `guard` is optional and returns false to abort: the reader uses it to refuse
// a load when no API key is set, since translating is the whole point there.
// The Erase Tool passes none — erasing needs no key.

/** Handlers for the "Local Folder / CBZ" source controls. */
export function makeLocalSourceUI({ idPrefix = '', onChapter, guard }) {
  const el = (suffix) => document.getElementById(`${idPrefix}${suffix}`);

  async function load(build, files, readingMsg, failMsg) {
    if (guard && !guard()) return;
    try {
      toast(readingMsg, 3000);
      onChapter(await build(files, el('local-source-lang')?.value || 'ja'));
    } catch (e) {
      toast(`${failMsg}: ${e.message}`);
    }
  }

  return {
    toggle:     () => el('local-source-wrap')?.classList.toggle('open'),
    pickFolder: () => el('local-folder-input')?.click(),
    pickCbz:    () => el('local-cbz-input')?.click(),

    async onFolderInput(event) {
      const files = event.target.files;
      event.target.value = '';   // allow picking the same folder again later
      if (!files || !files.length) return;
      await load(chapterFromFileList, files, 'Reading folder…', "Couldn't read that folder");
    },

    async onCbzInput(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      await load(chapterFromCbz, file, 'Reading archive…', "Couldn't read that archive");
    },
  };
}

/** Handlers for the "Suwayomi server" source controls. */
export function makeSuwayomiSourceUI({ idPrefix = '', onChapter, guard }) {
  const el = (suffix) => document.getElementById(`${idPrefix}${suffix}`);

  return {
    toggle: () => el('suwayomi-source-wrap')?.classList.toggle('open'),

    async load() {
      if (guard && !guard()) return;
      const mangaId      = el('suwayomi-manga-id')?.value.trim();
      const chapterIndex = el('suwayomi-chapter-index')?.value.trim();
      const sourceLang   = el('suwayomi-source-lang')?.value;

      if (!mangaId || !chapterIndex) {
        toast('Enter both a Manga ID and a Chapter Index.');
        return;
      }
      toast('Fetching from Suwayomi…', 3000);
      try {
        onChapter(await chapterFromSuwayomi(mangaId, chapterIndex, sourceLang));
      } catch (e) {
        toast(e.message);
      }
    },
  };
}
