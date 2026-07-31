// ═══════════════════════════════════════════════════════════════
// mangadex-api.js
// Unauthenticated MangaDex read calls: chapter metadata, page image URLs,
// and the adjacent-chapter (prev/next) feed lookup + its cache.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// MANGADEX API  (routed via local proxy)
// ══════════════════════════════════════════════
function parseChapterId(url) {
  const m = url.match(/chapter\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

async function fetchChapterMeta(id, signal) {
  const authHeaders = await getMdHeaders();
  const r = await fetch(`/mangadex/chapter/${id}?includes[]=manga&includes[]=scanlation_group`, { signal, headers: authHeaders });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.errors?.[0]?.detail || `MangaDex error ${r.status}`);
  }
  const { data } = await r.json();
  const attrs    = data.attributes;
  const mangaRel = data.relationships.find(x => x.type === 'manga');
  const titles   = mangaRel?.attributes?.title ?? {};

  // Collect all scanlation groups (a chapter can have more than one)
  const groups = data.relationships
    .filter(x => x.type === 'scanlation_group' && x.attributes?.name)
    .map(x => ({ name: x.attributes.name, id: x.id }));

  return {
    mangaTitle:         titles.en ?? Object.values(titles)[0] ?? 'Unknown Manga',
    mangaId:            mangaRel?.id ?? null,
    chapter:            attrs.chapter ?? '?',
    chapterTitle:       attrs.title   ?? '',
    volume:             attrs.volume  ?? null,
    translatedLanguage: attrs.translatedLanguage ?? 'en',
    groups,
  };
}

// FIX #12: returns {cdn, img} pairs instead of plain strings.
//   cdn  — raw CDN HTTPS URL, used by /ocr (must be HTTPS for the proxy to accept)
//   img  — routed through /proxy so all image traffic goes through the local server
async function fetchPageUrls(id, quality, signal) {
  const authHeaders = await getMdHeaders();
  const r = await fetch(`/mangadex/at-home/server/${id}`, { signal, headers: authHeaders });
  if (!r.ok) throw new Error(`Failed to get page server: ${r.status}`);
  const { baseUrl, chapter } = await r.json();
  let files, tier;
  if (quality === 'data-saver' && chapter.dataSaver?.length) {
    files = chapter.dataSaver; tier = 'data-saver';
  } else {
    files = chapter.data; tier = 'data';
  }
  return files.map(f => {
    const cdn = `${baseUrl}/${tier}/${chapter.hash}/${f}`;
    return { cdn, img: `/proxy?url=${encodeURIComponent(cdn)}` };
  });
}

// FIX #5: paginate with offset instead of assuming 500 covers everything.
//   Handles manga with 500+ chapters per language without silently missing
//   the adjacent-chapter lookup.
//
// FIX #13: cache the full feed per (mangaId, lang) instead of re-paginating
//   the entire chapter list on every single prev/next hop. For long-running
//   series (500+ chapters) that was O(total chapters) network + JSON work
//   just to answer an O(1) "what's next" question, every single navigation.
//   A short in-session TTL keeps it from ever going too stale if a new
//   chapter is uploaded mid-session.
const _FEED_CACHE_TTL = 5 * 60 * 1000;  // 5 minutes — long enough to cover a reading session
const _feedCache = new Map();  // key: `${mangaId}_${lang}` -> { chapters, timestamp }

async function _getMangaFeed(mangaId, lang, signal) {
  const cacheKey = `${mangaId}_${lang}`;
  const cached   = _feedCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < _FEED_CACHE_TTL) {
    return cached.chapters;
  }

  const LIMIT = 500;
  const base  = `/mangadex/manga/${mangaId}/feed`
    + `?translatedLanguage[]=${lang}&order[chapter]=asc&limit=${LIMIT}`
    + `&contentRating[]=safe&contentRating[]=suggestive`
    + `&contentRating[]=erotica&contentRating[]=pornographic`;
  const authHeaders = await getMdHeaders();

  let all = [], offset = 0, total = Infinity;
  while (offset < total) {
    const r = await fetch(`${base}&offset=${offset}`, { signal, headers: authHeaders });
    if (!r.ok) throw new Error(`Feed fetch failed: ${r.status}`);
    const body = await r.json();
    total  = body.total ?? 0;
    if (!body.data?.length) break;
    all    = all.concat(body.data);
    offset += body.data.length;
  }
  _feedCache.set(cacheKey, { chapters: all, timestamp: Date.now() });
  return all;
}

async function fetchAdjacentChapters(mangaId, currentId, lang, signal) {
  try {
    const all = await _getMangaFeed(mangaId, lang, signal);
    const idx = all.findIndex(ch => ch.id === currentId);
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: idx > 0            ? all[idx - 1].id : null,
      next: idx < all.length-1 ? all[idx + 1].id : null,
    };
  } catch { return { prev: null, next: null }; }
}

