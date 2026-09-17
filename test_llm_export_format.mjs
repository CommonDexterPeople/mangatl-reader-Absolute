#!/usr/bin/env node
// test_llm_export_format.mjs — the LLM-export file format and reply parser.
//
// Run:  node test_llm_export_format.mjs
//
// The first JavaScript test in this repo, and the reason llm-export-format.js
// is a separate, import-free module: everything else under static/js/ reads
// localStorage or the DOM at import time and cannot load under Node at all.
// The parser is exactly the kind of code that regresses silently — eight
// ordered rules whose interactions (fences vs. continuation, bold markers vs.
// *SFX*, duplicates vs. last-wins) are easy to break while fixing one of them
// — so it gets pinned here rather than re-verified by hand each time.
//
// Same conventions as the Python suites: plain script, prints each case,
// exits non-zero on the first failure, no framework.

import {
  llmxBatches,
  llmxBuildExportFile,
  llmxEntryId,
  llmxEntryLine,
  llmxExpectedForReply,
  llmxFlattenLine,
  llmxParseReply,
  llmxReconcile,
} from './static/js/llm-export-format.js';

let passed = 0;
function check(name, cond, detail = '') {
  if (!cond) {
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ✓ ${name}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = rows => Object.fromEntries(rows.map(r => [r.id, r]));

// ─── The export file ─────────────────────────────────────────────────────────
console.log('\nExport file');

const entries = [
  { id: 'P1B1', page: 1, n: 1, t: 'speech',    text: '¿Qué es esto?' },
  { id: 'P1B2', page: 1, n: 2, t: 'sfx',       text: '¡PUM!' },
  { id: 'P1B3', page: 1, n: 3, t: 'speech',    text: 'Gracias' },
  { id: 'P2B1', page: 2, n: 1, t: 'speech',    text: '¡Espera!' },
  { id: 'P2B2', page: 2, n: 2, t: 'sign',      text: 'Estación\nCentral' },
  { id: 'P2B3', page: 2, n: 3, t: 'narration', text: 'Al día  siguiente…' },
  { id: 'P3B1', page: 3, n: 1, t: 'thought',   text: '¿Por qué?' },
];

check('entry id is plain integers, no padding', llmxEntryId(3, 12) === 'P3B12');
check('flatten collapses newlines and runs of spaces', llmxFlattenLine('a\n  b\t c') === 'a b c');
check('speech line has no tag', llmxEntryLine(entries[0]) === 'P1B1: ¿Qué es esto?');
check('sfx / sign / narration / thought lines are tagged',
  llmxEntryLine(entries[1]) === 'P1B2 [sfx]: ¡PUM!' &&
  llmxEntryLine(entries[4]) === 'P2B2 [sign]: Estación Central' &&
  llmxEntryLine(entries[5]) === 'P2B3 [narration]: Al día siguiente…' &&
  llmxEntryLine(entries[6]) === 'P3B1 [thought]: ¿Por qué?');

const whole = llmxBuildExportFile({
  mode: 'translate', sourceName: 'Spanish (Latin American)', targetName: 'English',
  seriesTitle: 'Some Series', chapterLabel: 'Ch. 12', pageCount: 3, pageFrom: 1, pageTo: 3,
  entries, glossaryBlock: '\n\nGLOSSARY — use these exact translations whenever the source term appears:\nYodaka → Nighthawk',
});
check('file opens with the prompt, not the data', whole.startsWith('# Translate this manga chapter\n'));
check('prompt names both languages', whole.includes('Translate from Spanish (Latin American) to English.'));
check('sfx rule names the target language', whole.includes('the equivalent English onomatopoeia'));
check('glossary travels with the file', whole.includes('Yodaka → Nighthawk'));
check('header states the count and the whole-chapter range', whole.includes('## Chapter: Some Series Ch. 12 — 3 pages, 7 entries'));
check('footer repeats the count with first and last ID', whole.includes('## Reply with exactly 7 lines, P1B1 through P3B1.'));
check('every entry line is present, in order', (() => {
  const idx = entries.map(e => whole.indexOf(llmxEntryLine(e)));
  return idx.every(i => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]);
})());

const batch = llmxBuildExportFile({
  mode: 'translate', sourceName: 'Spanish', targetName: 'English', seriesTitle: 'S', pageCount: 40,
  pageFrom: 11, pageTo: 20, entries: entries.slice(0, 2), glossaryBlock: '',
});
check('batch header states the page range', batch.includes('— pages 11–20 of 40, 2 entries'));
check('a single-page file says "page 7 of 40", not "pages 7–7"', llmxBuildExportFile({
  mode: 'translate', sourceName: 'Spanish', targetName: 'English', pageCount: 40, pageFrom: 7, pageTo: 7,
  entries: entries.slice(0, 1),
}).includes('— page 7 of 40, 1 entry'));
check('no glossary block when the series has none', !batch.includes('GLOSSARY'));

const polish = llmxBuildExportFile({
  mode: 'polish', sourceName: 'Spanish', targetName: 'English', pageCount: 1, pageFrom: 1, pageTo: 1,
  entries: [{ id: 'P1B1', t: 'speech', text: 'What is this?' }],
});
check('polish mode has its own title and rules',
  polish.startsWith('# Polish this manga translation') && polish.includes('If a line is already good, return it unchanged.'));
check('single entry: singular wording', polish.includes('1 entry') && polish.includes('exactly 1 line,'));

check('batches: whole chapter when size is 0 or ≥ pageCount',
  eq(llmxBatches(24, 0), [{ from: 1, to: 24 }]) && eq(llmxBatches(24, 30), [{ from: 1, to: 24 }]));
check('batches: 24 pages by 10 → 1–10, 11–20, 21–24',
  eq(llmxBatches(24, 10), [{ from: 1, to: 10 }, { from: 11, to: 20 }, { from: 21, to: 24 }]));

// ─── ROADMAP §6's worked example: "what a messy return looks like" ───────────
console.log('\nThe worked example from ROADMAP.md');

const messy = `Sure! Here's the translation:

\`\`\`
P1B1: What is this?
P1B2: *BANG*
Page 1, Bubble 3: Thank you
P2B1: Wait!
P2B1: Hold on!
P2B2 [sign]: Central Station
This is a sign on the station building in the background.
P24B4: See you tomorrow
\`\`\`

Note: I kept the place names as they were.
`;

// A 24-page export whose entries include the ones above.
const bigExport = [
  { id: 'P1B1',  page: 1,  n: 1, text: '¿Qué es esto?' },
  { id: 'P1B2',  page: 1,  n: 2, text: '¡PUM!' },
  { id: 'P1B3',  page: 1,  n: 3, text: 'Gracias' },
  { id: 'P1B4',  page: 1,  n: 4, text: 'Vamos' },
  { id: 'P2B1',  page: 2,  n: 1, text: '¡Espera!' },
  { id: 'P2B2',  page: 2,  n: 2, text: 'Estación Central' },
  { id: 'P3B1',  page: 3,  n: 1, text: 'Hola' },
  { id: 'P24B3', page: 24, n: 3, text: 'Adiós' },
  { id: 'P24B4', page: 24, n: 4, text: 'Hasta mañana' },
];

const parsed = llmxParseReply(messy);
check('fences and both commentary lines are ignored', parsed.entries.every(e => /^P\d+B\d+$/.test(e.id)));
check('6 entries survive after de-duplication; 7 ID lines were read (P2B1 twice)',
  parsed.entries.length === 6 && parsed.matchedLines === 7,
  `got ${parsed.entries.length} entries / ${parsed.matchedLines} lines`);

const rec = llmxReconcile(parsed, bigExport, { pageCount: 24 });
const rows = byId(rec.rows);
check('6 matched — the six rows the ROADMAP example says get approved', rec.rows.length === 6, `matched ${rec.rows.map(r => r.id).join(',')}`);
check('spelled-out "Page 1, Bubble 3" normalised to P1B3', rows.P1B3?.text === 'Thank you');
check('P2B1 takes the LAST value and is flagged duplicate',
  rows.P2B1?.text === 'Hold on!' && rows.P2B1.flags.includes('duplicate') && eq(rec.duplicates, ['P2B1']));
check('P2B2 absorbs the continuation line and is flagged wrapped',
  rows.P2B2?.text === 'Central Station This is a sign on the station building in the background.' &&
  rows.P2B2.flags.includes('wrapped'));
check('the closing note is NOT glued onto P24B4', rows.P24B4?.text === 'See you tomorrow' && !rows.P24B4.flags.includes('wrapped'));
check('*BANG* keeps its asterisks', rows.P1B2?.text === '*BANG*');
check('missing lists exactly the un-returned IDs', eq(rec.missing, ['P1B4', 'P3B1', 'P24B3']));
check('no unknown IDs', rec.unknown.length === 0);
check('sanity flag: not partial (3 of 9 missing is under half)', !rec.warnings.some(w => w.startsWith('Looks partial')));

// The same reply against an export where most of the chapter is absent.
const rec2 = llmxReconcile(parsed, [...bigExport,
  ...Array.from({ length: 20 }, (_, i) => ({ id: `P10B${i + 1}`, page: 10, n: i + 1, text: `x${i}` }))],
  { pageCount: 24 });
check('sanity flag fires when more than half is missing', rec2.warnings.some(w => w.startsWith('Looks partial')));

// ─── ID-line variants ────────────────────────────────────────────────────────
console.log('\nID-line variants');

function one(line) {
  const p = llmxParseReply(line);
  return p.entries.length === 1 ? p.entries[0] : null;
}
const variants = [
  ['plain',                 'P3B2: text here',            'P3B2', 'text here'],
  ['lowercase',             'p3b2: text',                 'P3B2', 'text'],
  ['bold id',               '**P3B2:** text',             'P3B2', 'text'],
  ['bold id, colon inside', '**P3B2**: text',             'P3B2', 'text'],
  ['underscore bold',       '__P3B2__: text',             'P3B2', 'text'],
  ['backtick id',           '`P3B2`: text',               'P3B2', 'text'],
  ['bullet',                '- P3B2: text',               'P3B2', 'text'],
  ['star bullet',           '* P3B2: text',               'P3B2', 'text'],
  ['list number',           '12. P3B2: text',             'P3B2', 'text'],
  ['list number paren',     '3) P3B2: text',              'P3B2', 'text'],
  ['dash separator',        'P3B2 - text',                'P3B2', 'text'],
  ['en dash separator',     'P3B2 – text',                'P3B2', 'text'],
  ['fullwidth colon',       'P3B2： text',                'P3B2', 'text'],
  ['spaced id',             'P 3 B 2: text',              'P3B2', 'text'],
  ['hyphenated id',         'P3-B2: text',                'P3B2', 'text'],
  ['dotted id',             'P3.B2: text',                'P3B2', 'text'],
  ['tag kept on return',    'P3B2 [sfx]: *Crash*',        'P3B2', '*Crash*'],
  ['bold id + tag',         '**P3B2 [sign]:** Exit',      'P3B2', 'Exit'],
  ['bold whole text',       'P3B2: **What is this?**',    'P3B2', 'What is this?'],
  ['sfx after bold id',     '**P1B2:** *BANG*',           'P1B2', '*BANG*'],
  ['spelled out',           'Page 3, Bubble 2: text',     'P3B2', 'text'],
  ['spelled out, dash',     'Page 3 - Bubble 2 - text',   'P3B2', 'text'],
  ['spelled out, bold',     '**Page 3 Bubble 2:** text',  'P3B2', 'text'],
  ['big numbers',           'P124B37: text',              'P124B37', 'text'],
  ['leading whitespace',    '   P3B2: text',              'P3B2', 'text'],
];
for (const [name, line, id, text] of variants) {
  const e = one(line);
  check(`variant: ${name}`, e && e.id === id && e.text === text,
    `${JSON.stringify(line)} → ${e ? `${e.id} / ${JSON.stringify(e.text)}` : 'no match'}`);
}

const nonMatches = [
  'Here is P3 of the translation:',
  'PB2: text',
  'P3B: text',
  'Page 3: text',
  'PS: I kept the names.',
  'Problem B2 is solved: yes',
];
for (const line of nonMatches) {
  check(`non-match: ${JSON.stringify(line)}`, llmxParseReply(line).entries.length === 0);
}

// ─── Continuation edges ──────────────────────────────────────────────────────
console.log('\nContinuation');

const cont1 = llmxParseReply('P1B1: first\nsecond line\nthird line\n\nNot part of it');
check('multiple wrapped lines all join, blank line ends the run',
  cont1.entries[0].text === 'first second line third line' && cont1.entries[0].wrapped);

const cont2 = llmxParseReply('P1B1: done\n## Reply with exactly 3 lines\nstray');
check('a heading ends a continuation run and is not itself appended',
  cont2.entries[0].text === 'done' && !cont2.entries[0].wrapped);

const cont3 = llmxParseReply('```\nP1B1: done\n```\nNote: thanks');
check('a closing fence ends a continuation run even without a blank line',
  cont3.entries[0].text === 'done' && !cont3.entries[0].wrapped);

const cont4 = llmxParseReply('P1B1:\nWhat is this?');
check('translation on the line AFTER the ID is picked up as a wrapped continuation',
  cont4.entries[0].text === 'What is this?' && cont4.entries[0].wrapped);

const cont5 = llmxParseReply('Sure, here you go:\nP1B1: hi\nP1B2: there');
check('a preamble before the first ID is ignored, not attached to anything',
  cont5.entries.length === 2 && cont5.entries[0].text === 'hi' && !cont5.entries[0].wrapped);

check('CRLF input parses the same as LF',
  eq(llmxParseReply('P1B1: a\r\nP1B2: b\r\n').entries.map(e => e.text), ['a', 'b']));

// ─── Reconciliation buckets ──────────────────────────────────────────────────
console.log('\nReconciliation');

const small = [
  { id: 'P1B1', page: 1, n: 1, text: 'Hola' },
  { id: 'P1B2', page: 1, n: 2, text: '¡PUM!' },
  { id: 'P2B1', page: 2, n: 1, text: 'Adiós' },
];

const r1 = llmxReconcile(llmxParseReply('P1B1: Hi\nP1B2: ¡PUM!\nP2B1:\nP9B9: ghost'), small, { pageCount: 2 });
check('unchanged: identical text is applied but flagged',
  byId(r1.rows).P1B2?.flags.includes('unchanged') && eq(r1.unchanged, ['P1B2']));
check('empty text after the colon counts as missing',
  eq(r1.missing, ['P2B1']) && eq(r1.empty, ['P2B1']) && !byId(r1.rows).P2B1);
check('unknown ID is listed and never becomes a row', eq(r1.unknown, ['P9B9']) && !byId(r1.rows).P9B9);
check('page beyond the chapter triggers the wrong-chapter warning',
  r1.warnings.some(w => w.includes('page 9') && w.includes('2 pages')));
check('lineCount reports lines read before de-duplication', r1.lineCount === 4 && r1.expectedCount === 3);

const r2 = llmxReconcile(llmxParseReply('P7B1: a\nP7B2: b\nP7B3: c\nP1B1: Hi'), small, { pageCount: 8 });
check('unknown > matched triggers the wrong-file warning', r2.warnings.some(w => w.includes('not in this export')));

const r3 = llmxReconcile(llmxParseReply('P1B1: Hi\nP1B2: *Boom*\nP2B1: Bye'), small, { pageCount: 2 });
check('a complete, clean reply: all matched, nothing missing, no warnings',
  r3.rows.length === 3 && r3.missing.length === 0 && r3.unknown.length === 0 && r3.warnings.length === 0);

// ─── Batch selection ─────────────────────────────────────────────────────────
console.log('\nBatch selection');

const manifest = [];
for (let p = 1; p <= 24; p++) for (let n = 1; n <= 2; n++) manifest.push({ id: llmxEntryId(p, n), page: p, n, text: 'x' });

const replyBatch1 = llmxParseReply(manifest.filter(e => e.page <= 10).map(e => `${e.id}: y`).join('\n'));
const exp1 = llmxExpectedForReply(manifest, replyBatch1.entries, 10, 24);
check('a reply to file 1 of 3 is measured against pages 1–10 only',
  exp1.length === 20 && exp1.every(e => e.page <= 10));
check('…so a complete batch reply shows nothing missing',
  llmxReconcile(replyBatch1, exp1, { pageCount: 24 }).missing.length === 0);

const replyBatch3Partial = llmxParseReply('P21B1: a\nP22B1: b');
const exp3 = llmxExpectedForReply(manifest, replyBatch3Partial.entries, 10, 24);
check('the last, short batch (21–24) is its own set',
  exp3.length === 8 && exp3.every(e => e.page >= 21));
check('a partial reply to that batch lists the rest of the batch as missing',
  eq(llmxReconcile(replyBatch3Partial, exp3, { pageCount: 24 }).missing, ['P21B2', 'P22B2', 'P23B1', 'P23B2', 'P24B1', 'P24B2']));

const replyTwo = llmxParseReply('P1B1: a\nP15B1: b');
check('a concatenated reply touching two files is measured against both',
  llmxExpectedForReply(manifest, replyTwo.entries, 10, 24).length === 40);

check('whole-chapter export (batchSize 0) always uses the full set',
  llmxExpectedForReply(manifest, replyBatch3Partial.entries, 0, 24).length === 48);

const replyAlien = llmxParseReply('P99B1: a');
check('a reply touching no known page is measured against everything (so the unknown warning still fires)',
  llmxExpectedForReply(manifest, replyAlien.entries, 10, 24).length === 48);

// ─── Round trip ──────────────────────────────────────────────────────────────
console.log('\nRound trip');

const rtEntries = entries.map(e => ({ ...e }));
const rtFile = llmxBuildExportFile({
  mode: 'translate', sourceName: 'Spanish', targetName: 'English', pageCount: 3, pageFrom: 1, pageTo: 3,
  entries: rtEntries,
});
// Simulate a model that answers each line of the file it was given.
const answered = rtFile.split('\n')
  .map(l => llmxParseReply(l).entries[0])
  .filter(Boolean)
  .map(e => `${e.id}: [${e.text}]`)
  .join('\n');
const rt = llmxReconcile(llmxParseReply(answered), rtEntries, { pageCount: 3 });
check('every exported line parses back out of the file itself', rt.expectedCount === 7 && rt.lineCount === 7);
check('a line-for-line answer matches everything with no flags and no warnings',
  rt.rows.length === 7 && rt.rows.every(r => r.flags.length === 0) && rt.warnings.length === 0 && rt.missing.length === 0);

console.log(`\nALL PASS — ${passed} checks.`);
