// ═══════════════════════════════════════════════════════════════
// llm-export-format.js
// The file that goes out to a chat AI, and the parser for what comes
// back. Pure functions only — no DOM, no imports, no storage.
// ═══════════════════════════════════════════════════════════════
//
// This is half of the external-LLM translation path (ROADMAP.md §6); the
// panel, the review modal and the apply step are in llm-export.js. The
// split exists so THIS half can run under plain Node — test_llm_export_
// format.mjs imports it directly. Nothing else in static/js/ can be
// imported that way (state-and-constants.js reads localStorage at module
// evaluation), so this file must never import another module: the test
// would drag that module's DOM touches in and stop running.
//
// THE CONTRACT. Every region leaves as one line, `P{page}B{n}: text`, under
// a prompt that tells the model to answer in the same shape. Positions
// never travel; the ID is the whole link between export and import. IDs
// are plain 1-based integers with no zero-padding — `P03` vs `P3` is a
// mismatch the parser would only have to normalise away again.
//
// PARSING IS GENEROUS ON PURPOSE. Chat models decorate: fences, bold IDs,
// "Page 3, Bubble 2:", a preamble, a closing note, a translation that
// wrapped onto a second line. The parser accepts all of that and reports
// what it did (flags on each entry, five reconciliation buckets), because
// the review step makes over-inclusion visible while a silently dropped
// line would not be. Import never creates, moves or deletes a region —
// llm-export.js only ever fills `tl` on an ID that already exists — so the
// worst a malformed reply can do is put a wrong string somewhere the
// person is about to be shown and asked to approve.

export const LLMX_FORMAT_V = 1;

/** Region types that carry a tag on the export line. The tag changes how a
 *  line should be translated; the parser ignores it on the way back. */
export const LLMX_TAGGED_TYPES = ['sfx', 'sign', 'narration', 'thought'];

export function llmxEntryId(page1, n1) { return `P${page1}B${n1}`; }

/** One region → one physical line: newlines become spaces, runs of
 *  whitespace collapse. Applied to both what is exported and what is
 *  compared against at import, so the "unchanged" test is not fooled by a
 *  correction-UI textarea's line breaks. */
export function llmxFlattenLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** `P3B2 [sfx]: text` — the tag only when it says something (speech is the
 *  default and untagged). */
export function llmxEntryLine(entry) {
  const tag = LLMX_TAGGED_TYPES.includes(entry.t) ? ` [${entry.t}]` : '';
  return `${entry.id}${tag}: ${llmxFlattenLine(entry.text)}`;
}

/** "Page 7" or "Pages 11–20" — never "Pages 7–7". */
export function llmxPageRangeLabel(from, to) {
  return from === to ? `Page ${from}` : `Pages ${from}–${to}`;
}

/** Page ranges for "N pages per file". batchSize 0 (or ≥ pageCount) means
 *  one file for the whole chapter. 1-based, inclusive. */
export function llmxBatches(pageCount, batchSize) {
  if (!batchSize || batchSize >= pageCount) return [{ from: 1, to: pageCount }];
  const out = [];
  for (let from = 1; from <= pageCount; from += batchSize) {
    out.push({ from, to: Math.min(pageCount, from + batchSize - 1) });
  }
  return out;
}

// ── The export file ───────────────────────────────────────────────────────
// Plain Markdown, not JSON: chat models mangle JSON far more than labelled
// lines, every chat UI accepts a .md upload, and the person can read it.
// One self-contained file — the prompt is the first thing the model sees,
// so it works on every AI with no URL games. The count is stated twice,
// header and footer: "reply with exactly N lines" is the single most
// effective instruction against a model that trails off at line 60, and
// it gives the parser a number to check.

function _llmxRules(mode, sourceName, targetName) {
  const idRules = [
    `Output ONE line per entry, in this exact form:  P3B2: ${mode === 'polish' ? 'polished' : 'translated'} text`,
    `Keep every ID exactly as written (P3B2, not "Page 3 Bubble 2"). Never renumber, merge, split, skip, or reorder entries.`,
    `Output ONLY the ${mode === 'polish' ? '' : 'translated '}lines. No introduction, no notes, no code fences, no commentary.`,
  ];
  if (mode === 'polish') {
    return [
      `Keep every line's meaning. Improve wording, flow and consistency so it reads as natural ${targetName} dialogue.`,
      ...idRules,
      `Entries tagged [sfx] are sound effects; [sign] is text on an object or wall; [narration] is a caption box, not speech; [thought] is internal monologue.`,
      `Keep each speaker's tone and register. Entries are in reading order; keep names and terms consistent across the chapter.`,
      `If a line is already good, return it unchanged.`,
    ];
  }
  return [
    `Translate from ${sourceName} to ${targetName}.`,
    ...idRules,
    `Entries tagged [sfx] are sound effects — write the equivalent ${targetName} onomatopoeia, or keep the original if none fits. [sign] is text on an object or wall. [narration] is a caption box, not speech. [thought] is internal monologue.`,
    `Keep each speaker's tone. Entries are in reading order; use earlier lines as context for later ones.`,
    `The text was read by OCR: rejoin a word split with a hyphen, ignore stray characters, and treat ALL-CAPS lettering as ordinary case.`,
  ];
}

/**
 * Build the complete .md file for one batch.
 *
 *   mode          'translate' (entries carry source text) | 'polish' (entries
 *                 carry the current translation)
 *   sourceName    language name to translate FROM, e.g. "Spanish (Latin American)"
 *   targetName    language name to translate TO, e.g. "English"
 *   seriesTitle   display title; chapterLabel e.g. "Ch. 12 · The Bridge" or ''
 *   pageCount     pages in the whole chapter
 *   pageFrom/To   this file's page range (1-based, inclusive); equal to
 *                 1..pageCount for a whole-chapter file
 *   entries       [{ id, t, text }] already restricted to this file's range,
 *                 in reading order
 *   glossaryBlock the string buildGlossaryPromptBlock() returns ('' when
 *                 the series has no glossary) — travels with the file so
 *                 the person's per-series terms apply
 */
export function llmxBuildExportFile({ mode = 'translate', sourceName, targetName, seriesTitle = '',
                                      chapterLabel = '', pageCount, pageFrom, pageTo,
                                      entries, glossaryBlock = '' }) {
  const isPolish = mode === 'polish';
  const title = isPolish ? 'Polish this manga translation' : 'Translate this manga chapter';
  const intro = isPolish
    ? `You are editing the ${targetName} translation of a manga chapter (translated from ${sourceName}). Rules:`
    : `You are translating dialogue from a manga chapter. Rules:`;
  const rules = _llmxRules(mode, sourceName, targetName).map((r, i) => `${i + 1}. ${r}`).join('\n');

  const whole = pageFrom === 1 && pageTo === pageCount;
  const range = whole
    ? `${pageCount} page${pageCount === 1 ? '' : 's'}`
    : `${llmxPageRangeLabel(pageFrom, pageTo).toLowerCase()} of ${pageCount}`;
  const name = [seriesTitle, chapterLabel].filter(Boolean).join(' ').trim() || 'untitled';
  const count = entries.length;
  const first = entries[0]?.id ?? '';
  const last  = entries[count - 1]?.id ?? '';

  const glossary = (glossaryBlock || '').trim();
  return [
    `# ${title}`,
    ``,
    intro,
    ``,
    rules,
    ...(glossary ? [``, glossary] : []),
    ``,
    `## Chapter: ${name} — ${range}, ${count} entr${count === 1 ? 'y' : 'ies'}`,
    ``,
    ...entries.map(llmxEntryLine),
    ``,
    `## Reply with exactly ${count} line${count === 1 ? '' : 's'}, ${first} through ${last}.`,
    ``,
  ].join('\n');
}

// ── The reply parser ──────────────────────────────────────────────────────
// Rules are ordered; earlier rules shape what later rules see.

// Rule 1 — fences. A line that is only ``` or ```lang (or ~~~) is never an
// entry, and it also ENDS a continuation run: the closing fence sits
// between the last entry and whatever note the model adds after it, and
// without a blank line in between that note would otherwise be glued onto
// the last translation.
const LLMX_FENCE_RE   = /^\s*(?:```|~~~)[\w+-]*\s*$/;
// Markdown headings and horizontal rules behave the same way — a model that
// echoes "## Reply with exactly…" back must not have it appended to P24B4.
const LLMX_BREAK_RE   = /^\s*(?:#{1,6}\s|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/;

// Rule 2 — the ID line, matched generously but requiring both numbers:
//   ^\s*(?:[-*•]\s+|\d+[.)]\s+)?      optional bullet or list number
//   (?:\*\*|__|`)?\s*                 optional bold/code opener
//   P\s*(\d+)\s*[-._]?\s*B\s*(\d+)    P3B2, P3-B2, P 3 B 2, P3.B2
//   \s*(?:\*\*|__|`)?                 bold/code closer after the ID
//   (?:\s*\[[^\]]*\])?                optional [sfx] tag, ignored
//   \s*(?:\*\*|__|`)?                 bold closer after the tag
//   \s*[:：\-–—]\s*                   colon, fullwidth colon, or dash
//   (?:(?:\*\*|__)(?=\s|$)\s*)?      bold closer after the colon: "**P1B2:** text"
//   (.*)$                             the translation
// Case-insensitive so `p3b2:` still counts. The bold closer after the colon
// is only ** or __ — never a single *, which would eat the opening asterisk
// of an SFX rendered as *BANG* — and only when followed by whitespace, so a
// fully bolded translation ("P3B2: **text**") keeps its opener for
// _llmxCleanText to strip as a pair.
const LLMX_ID_LINE_RE =
  /^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*|__|`)?\s*P\s*(\d+)\s*[-._]?\s*B\s*(\d+)\s*(?:\*\*|__|`)?(?:\s*\[[^\]]*\])?\s*(?:\*\*|__|`)?\s*[:：\-–—]\s*(?:(?:\*\*|__)(?=\s|$)\s*)?(.*)$/i;

// Also the spelled-out form — "Page 3, Bubble 2:" — because that is the
// commonest way a model "helpfully" rewrites the ID. Normalises to (3, 2).
const LLMX_SPELLED_LINE_RE =
  /^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*Page\s*(\d+)\s*[,;.\-–—]?\s*(?:Bubble|Balloon|Entry|Line)\s*(\d+)\s*(?:\*\*|__)?(?:\s*\[[^\]]*\])?\s*(?:\*\*|__)?\s*[:：\-–—]\s*(?:(?:\*\*|__)(?=\s|$)\s*)?(.*)$/i;

function _llmxCleanText(raw) {
  let t = llmxFlattenLine(raw);
  // A fully bold-wrapped translation ("**text**") is decoration, not text.
  // Only the double form: single asterisks are how SFX are written.
  const m = /^\*\*(.+)\*\*$/.exec(t);
  if (m) t = m[1].trim();
  return t;
}

function _llmxMatchIdLine(line) {
  const m = LLMX_ID_LINE_RE.exec(line) || LLMX_SPELLED_LINE_RE.exec(line);
  if (!m) return null;
  return { page: parseInt(m[1], 10), n: parseInt(m[2], 10), text: _llmxCleanText(m[3]) };
}

/**
 * Parse a pasted reply.
 *
 * Returns { entries, matchedLines, dupIds } where entries is the de-duplicated
 * list in reply order — [{ id, page, n, text, wrapped, dup }] — matchedLines
 * counts every ID line seen before de-duplication (the number to compare
 * against the count the export stated), and dupIds lists IDs that appeared
 * more than once.
 *
 * Rule 3 — a line that matches nothing is ignored: "Here's your translation:",
 * "Let me know if you'd like changes", blank lines.
 * Rule 4 — a non-matching, non-blank line DIRECTLY after a matched line is
 * probably a translation that wrapped: appended, and the entry is flagged
 * `wrapped`. A blank line, fence, heading or rule ends the run, so a
 * closing paragraph of commentary does not glue itself to the last bubble.
 * Duplicates — the LAST occurrence wins (models correct themselves
 * mid-output) and the survivor is flagged `dup`.
 */
export function llmxParseReply(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const seen = [];             // every matched entry, in order
  let current = null;          // the entry a continuation line would extend

  for (const line of lines) {
    if (!line.trim() || LLMX_FENCE_RE.test(line) || LLMX_BREAK_RE.test(line)) {
      current = null;          // Rules 1 & 4: these end a continuation run
      continue;
    }
    const hit = _llmxMatchIdLine(line);
    if (hit) {
      current = { id: llmxEntryId(hit.page, hit.n), page: hit.page, n: hit.n,
                  text: hit.text, wrapped: false, dup: false };
      seen.push(current);
      continue;
    }
    if (current) {             // Rule 4: continuation
      const extra = llmxFlattenLine(line);
      current.text = current.text ? `${current.text} ${extra}` : extra;
      current.wrapped = true;
    }
    // else Rule 3: preamble / commentary — ignored
  }

  // Last occurrence wins.
  const byId = new Map();
  const dupIds = [];
  for (const e of seen) {
    if (byId.has(e.id)) {
      if (!dupIds.includes(e.id)) dupIds.push(e.id);
      e.dup = true;
    }
    byId.set(e.id, e);
  }
  // Keep reply order of the surviving occurrence.
  const entries = seen.filter(e => byId.get(e.id) === e);
  return { entries, matchedLines: seen.length, dupIds };
}

/**
 * Which of the export's entries a reply should be measured against.
 *
 * A chapter exported as several files (batchSize pages each) comes back as
 * several replies, each covering one page range. "Missing" has to mean
 * "missing from THIS file's set", or a perfectly complete reply to file 1
 * of 4 would look 75% missing. The batches a reply touches are inferred
 * from the page numbers in it; a reply touching none (all IDs unknown)
 * is measured against everything, so the unknown-ID warning still fires.
 * Concatenated replies to several files simply touch several batches.
 */
export function llmxExpectedForReply(manifestEntries, parsedEntries, batchSize, pageCount) {
  if (!batchSize || batchSize >= pageCount) return manifestEntries;
  const batchOf = page => Math.floor((page - 1) / batchSize);
  const touched = new Set();
  for (const e of parsedEntries) {
    if (e.page >= 1 && e.page <= pageCount) touched.add(batchOf(e.page));
  }
  if (!touched.size) return manifestEntries;
  return manifestEntries.filter(e => touched.has(batchOf(e.page)));
}

/**
 * Rule 5 — reconcile a parsed reply against the export's ID set. Every
 * outcome is reported, none is fatal:
 *
 *   matched    in export and in reply           → rows, pending approval
 *   missing    in export, not in reply           → listed; regions untouched
 *   unknown    in reply, not in export           → discarded, listed
 *   duplicate  same ID twice                     → last kept, row flagged
 *   unchanged  reply text identical to exported  → row flagged (usually an
 *                                                  SFX kept as-is)
 *
 * Empty text after the colon counts as missing. Rule 6 — whole-import
 * sanity flags are warnings that never block.
 *
 * `expected` is [{ id, page, n, text, … }] (extra fields pass through on
 * row.expected, which is how llm-export.js finds the region again).
 */
export function llmxReconcile(parsed, expected, { pageCount = 0 } = {}) {
  const expById = new Map(expected.map(e => [e.id, e]));
  const rows = [], unknown = [], empty = [];
  const returned = new Set();
  let maxPage = 0;

  for (const e of parsed.entries) {
    maxPage = Math.max(maxPage, e.page);
    const exp = expById.get(e.id);
    if (!exp) { unknown.push(e.id); continue; }
    if (!e.text) { empty.push(e.id); continue; }
    returned.add(e.id);
    const flags = [];
    if (e.dup) flags.push('duplicate');
    if (e.wrapped) flags.push('wrapped');
    if (e.text === llmxFlattenLine(exp.text)) flags.push('unchanged');
    rows.push({ id: e.id, page: e.page, n: e.n, text: e.text, expected: exp, flags });
  }
  const missing = expected.filter(e => !returned.has(e.id)).map(e => e.id);
  const unchanged = rows.filter(r => r.flags.includes('unchanged')).map(r => r.id);

  const warnings = [];
  if (expected.length && missing.length * 2 > expected.length) {
    warnings.push(`Looks partial — ${missing.length} of ${expected.length} entries did not come back. ` +
                  `A free tier may have cut the reply off. Import what is here, then export the rest again.`);
  }
  if (unknown.length && unknown.length > rows.length) {
    warnings.push(`${unknown.length} ID${unknown.length === 1 ? '' : 's'} in the reply ` +
                  `${unknown.length === 1 ? 'is' : 'are'} not in this export — wrong file, or a reply for a different chapter?`);
  }
  if (pageCount && maxPage > pageCount) {
    warnings.push(`The reply mentions page ${maxPage}, but this chapter has ${pageCount} pages — wrong chapter?`);
  }

  return { rows, missing, unknown, empty, duplicates: parsed.dupIds.slice(), unchanged,
           warnings, lineCount: parsed.matchedLines, expectedCount: expected.length };
}
