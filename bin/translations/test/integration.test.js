/**
 * Integration tests for the translation build pipeline.
 *
 * Uses Node's built-in test runner — no extra deps.
 * Run with:    node --test bin/translations/test/integration.test.js
 * Or:          npm run test:translations
 *
 * Most tests mock `global.fetch` so OpenRouter is never actually called (no cost, fully
 * deterministic). The "fetch-wporg" group hits real WP.org but no AI — set
 * TRP_SKIP_NETWORK=1 to skip them in offline environments.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aiFill,
  hashEntry,
  loadGlossaryForLocale,
  findGlossaryMatches,
  findGlossaryMatchesForItem,
  loadContextForLocale,
  findContextHintsForItem,
  findContextMatchesForItem,
  extractPrintfPlaceholders,
  validatePrintfSubset,
  validateTranslation,
  validatePlaceholders,
  buildUserMessage,
  parseResponse,
  getPluralForLocale,
  hasAllSourcePositionals,
} = require('../ai-fill');
const { mergeLocale, parseTpFlags, formatTpFlags, stampEntry } = require('../build-incremental');
const { fetchWpOrgTranslations } = require('../fetch-wporg');
const { LOCALES, LOCALE_NAMES } = require('../locales');
const gettextParser = require('gettext-parser');

// -- locale registry -------------------------------------------------------

test('locales: 43 entries, no English variants', () => {
  assert.equal(LOCALES.length, 43);
  for (const l of LOCALES) assert.ok(!l.startsWith('en'), `${l} should not start with en`);
});

test('locales: every code has a human name', () => {
  for (const l of LOCALES) {
    assert.equal(typeof LOCALE_NAMES[l], 'string', `${l} missing name`);
    assert.ok(LOCALE_NAMES[l].length > 0);
  }
});

// -- glossary --------------------------------------------------------------

test('glossary: default loads with at least 40 entries', () => {
  const g = loadGlossaryForLocale('ja');
  assert.ok(Object.keys(g).length >= 40, `got ${Object.keys(g).length}`);
});

test('glossary: matches whole word case-insensitive', () => {
  const g = loadGlossaryForLocale('ja');
  const matches = findGlossaryMatches([
    { source: 'Welcome to TranslatePress' },
    { source: 'Save wordpress settings' }, // lowercase
  ], g);
  const sources = matches.map(m => m.source);
  assert.ok(sources.includes('TranslatePress'));
  assert.ok(sources.includes('WordPress'));
});

test('glossary: prefers longer compound matches alongside shorter', () => {
  const g = loadGlossaryForLocale('ja');
  const matches = findGlossaryMatches([{ source: 'Activate TranslatePress AI today' }], g);
  const sources = matches.map(m => m.source);
  // Both compound + bare brand are valid matches; both are sent as worked examples.
  assert.ok(sources.includes('TranslatePress AI'));
  assert.ok(sources.includes('TranslatePress'));
});

test('glossary: does not match substrings inside other words', () => {
  const g = loadGlossaryForLocale('ja');
  // "subURLed" should NOT match the URL entry.
  const matches = findGlossaryMatches([{ source: 'something unsubURLed here' }], g);
  assert.equal(matches.find(m => m.source === 'URL'), undefined);
});

// -- context (per-keyword conceptual hints) --------------------------------

test('context: default loads with the expected core keywords', () => {
  const c = loadContextForLocale('ro_RO');
  for (const key of ['string', 'strings', 'regular', 'slug', 'post']) {
    assert.ok(c[key], `expected context entry for "${key}"`);
    assert.equal(typeof c[key].hint, 'string');
    assert.ok(c[key].hint.length > 0);
  }
});

test('context: matches whole word case-insensitive on a single item', () => {
  const c = loadContextForLocale('ro_RO');
  const hints = findContextHintsForItem({ source: 'Translate Strings on the site' }, c);
  // "Strings" (capitalised) should match the lowercase "strings" key.
  assert.ok(hints.length >= 1);
  assert.ok(hints.some(h => /translatable text/i.test(h)));
});

test('context: does not match substrings inside other words', () => {
  const c = loadContextForLocale('ro_RO');
  // "Postman", "regulator" should NOT trigger "post" / "regular".
  const hints = findContextHintsForItem({ source: 'Postman regulator slugged-out' }, c);
  assert.equal(hints.length, 0);
});

test('context: dedupes by hint text so singular+plural keywords sharing prose collapse', () => {
  const c = loadContextForLocale('ro_RO');
  // Source contains BOTH "string" and "strings". Both keys map to distinct hint strings, but
  // singular ≠ plural here so we expect at least one of each. Mainly we want NO duplicates.
  const hints = findContextHintsForItem({ source: 'this string and those strings' }, c);
  const unique = new Set(hints);
  assert.equal(hints.length, unique.size);
});

test('context: matches against msgid_plural too', () => {
  const c = loadContextForLocale('ro_RO');
  // Singular has no keyword; plural does.
  const hints = findContextHintsForItem({ source: '%d item', msgid_plural: '%d posts' }, c);
  assert.ok(hints.length >= 1);
});

test('context: empty/missing map yields no hints', () => {
  assert.deepEqual(findContextHintsForItem({ source: 'string' }, null), []);
  assert.deepEqual(findContextHintsForItem({ source: 'string' }, {}), []);
});

test('context: findContextMatchesForItem returns hash-bearing entries', () => {
  const c = loadContextForLocale('ro_RO');
  const matches = findContextMatchesForItem({ source: 'Edit the post' }, c);
  assert.ok(matches.length >= 1);
  for (const m of matches) {
    assert.equal(typeof m.hash, 'string');
    assert.equal(m.hash.length, 8, 'hashes are 8 hex chars');
    assert.match(m.hash, /^[0-9a-f]+$/);
  }
});

test('context: hint attribute appears in built user message when keyword matches', () => {
  const c = loadContextForLocale('ro_RO');
  const xml = buildUserMessage([{ source: 'Translate Strings here' }], 1, c);
  assert.match(xml, /hint="/);
  // Quote-safe escaping — no unescaped double quotes inside the attribute value.
  const hintValueMatch = xml.match(/hint="([^"]*)"/);
  assert.ok(hintValueMatch, 'hint attribute should be parseable as a quoted string');
});

test('context: hint attribute absent when no keyword matches', () => {
  const c = loadContextForLocale('ro_RO');
  const xml = buildUserMessage([{ source: 'Save your changes.' }], 1, c);
  assert.doesNotMatch(xml, /hint="/);
});

test('context: aiFill end-to-end injects hint into request payload', async () => {
  let captured = null;
  await withMockFetch(async (url, opts) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    captured = JSON.parse(opts.body);
    return okResponse('<t i="1">Tradu textele aici</t>');
  }, async () => {
    const { translations } = await aiFill('ro_RO', [{ id: 'x', source: 'Translate Strings here' }]);
    assert.equal(translations.get('x'), 'Tradu textele aici');
  });
  assert.ok(captured, 'expected fetch to be called');
  const userMsg = captured.messages.find(m => m.role === 'user');
  assert.ok(userMsg, 'expected a user message');
  assert.match(userMsg.content, /hint="/);
});

// -- hash-based applied-state tracking -------------------------------------

test('hashEntry: deterministic and content-addressed', () => {
  const h1 = hashEntry('post', 'a piece of published content');
  const h2 = hashEntry('post', 'a piece of published content');
  const h3 = hashEntry('post', 'a piece of published content.');  // trailing period
  const h4 = hashEntry('Post', 'a piece of published content');   // different case key
  assert.equal(h1, h2, 'same input → same hash');
  assert.notEqual(h1, h3, 'edited value → different hash');
  assert.notEqual(h1, h4, 'different case key → different hash');
  assert.equal(h1.length, 8);
  assert.match(h1, /^[0-9a-f]+$/);
});

test('hashEntry: loaded glossary entries carry .hash', () => {
  const g = loadGlossaryForLocale('ja');
  for (const entry of Object.values(g)) {
    assert.equal(typeof entry.hash, 'string');
    assert.equal(entry.hash.length, 8);
    assert.equal(entry.hash, hashEntry(entry.source, entry.target),
      `${entry.source} hash should match recomputed`);
  }
});

test('hashEntry: loaded context entries carry .hash', () => {
  const c = loadContextForLocale('ro_RO');
  for (const entry of Object.values(c)) {
    assert.equal(typeof entry.hash, 'string');
    assert.equal(entry.hash.length, 8);
    assert.equal(entry.hash, hashEntry(entry.source, entry.hint),
      `${entry.source} hash should match recomputed`);
  }
});

test('findGlossaryMatchesForItem: only this item, not whole batch', () => {
  const g = loadGlossaryForLocale('ja');
  const matches = findGlossaryMatchesForItem({ source: 'Welcome to TranslatePress' }, g);
  const sources = matches.map(m => m.source);
  assert.ok(sources.includes('TranslatePress'));
  assert.ok(!sources.includes('WooCommerce'), 'should not pick up unrelated terms');
  for (const m of matches) assert.equal(typeof m.hash, 'string');
});

// -- PO custom-flag parsing/formatting -------------------------------------

test('parseTpFlags: empty input → empty state', () => {
  const p = parseTpFlags('');
  assert.equal(p.isAi, false);
  assert.equal(p.ctxHashes.size, 0);
  assert.equal(p.gloHashes.size, 0);
  assert.deepEqual(p.preserved, []);
});

test('parseTpFlags: extracts tp-ai, tp-ctx-*, tp-glo-*, preserves the rest', () => {
  const p = parseTpFlags('fuzzy, tp-ai, tp-ctx-a3f8b9c1, tp-ctx-d4e5f6a7, tp-glo-b1c2d3e4, c-format');
  assert.equal(p.isAi, true);
  assert.deepEqual([...p.ctxHashes].sort(), ['a3f8b9c1', 'd4e5f6a7']);
  assert.deepEqual([...p.gloHashes], ['b1c2d3e4']);
  assert.deepEqual(p.preserved.sort(), ['c-format', 'fuzzy']);
});

test('formatTpFlags: deterministic, sorted, preserves non-tp first', () => {
  const out = formatTpFlags({
    isAi: true,
    ctxHashes: new Set(['d4e5f6a7', 'a3f8b9c1']),
    gloHashes: new Set(['b1c2d3e4']),
    preserved: ['fuzzy'],
  });
  assert.equal(out, 'fuzzy, tp-ai, tp-ctx-a3f8b9c1, tp-ctx-d4e5f6a7, tp-glo-b1c2d3e4');
});

test('formatTpFlags: empty everything → undefined (no flag line written)', () => {
  assert.equal(formatTpFlags({ isAi: false, ctxHashes: new Set(), gloHashes: new Set(), preserved: [] }), undefined);
});

test('parseTpFlags ↔ formatTpFlags: round-trip stable', () => {
  const input = 'fuzzy, tp-ai, tp-ctx-a3f8b9c1, tp-glo-b1c2d3e4';
  const out = formatTpFlags(parseTpFlags(input));
  // Sorted output may reorder hashes but content is identical.
  const re = parseTpFlags(out);
  assert.equal(re.isAi, true);
  assert.deepEqual([...re.ctxHashes], ['a3f8b9c1']);
  assert.deepEqual([...re.gloHashes], ['b1c2d3e4']);
  assert.deepEqual(re.preserved, ['fuzzy']);
});

// -- gettext-parser round-trip (the real correctness risk) -----------------

test('gettext-parser: custom #, flags survive parse → compile round-trip', () => {
  const src = [
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '',
    '#, tp-ai, tp-ctx-a3f8b9c1, tp-glo-b1c2d3e4',
    'msgid "Translate strings here"',
    'msgstr "Tradu textele aici"',
    '',
  ].join('\n');
  const parsed = gettextParser.po.parse(src);
  const entry = parsed.translations[''] && parsed.translations['']['Translate strings here'];
  assert.ok(entry, 'expected msgid to parse');
  assert.ok(entry.comments && typeof entry.comments.flag === 'string',
    'gettext-parser should expose flag string');
  assert.match(entry.comments.flag, /tp-ai/);
  assert.match(entry.comments.flag, /tp-ctx-a3f8b9c1/);
  assert.match(entry.comments.flag, /tp-glo-b1c2d3e4/);

  const compiled = gettextParser.po.compile(parsed).toString('utf-8');
  assert.match(compiled, /tp-ai/);
  assert.match(compiled, /tp-ctx-a3f8b9c1/);
  assert.match(compiled, /tp-glo-b1c2d3e4/);

  // Re-parse to ensure no information loss after a round-trip.
  const reparsed = gettextParser.po.parse(compiled);
  const reentry = reparsed.translations[''] && reparsed.translations['']['Translate strings here'];
  const reFlags = parseTpFlags(reentry.comments.flag);
  assert.equal(reFlags.isAi, true);
  assert.deepEqual([...reFlags.ctxHashes], ['a3f8b9c1']);
  assert.deepEqual([...reFlags.gloHashes], ['b1c2d3e4']);
});

// -- stampEntry behavior ---------------------------------------------------

test('stampEntry: writes tp flags while preserving non-tp flags', () => {
  const entry = { msgstr: ['x'], comments: { flag: 'fuzzy, c-format' } };
  stampEntry(entry, { isAi: true, ctxHashes: new Set(['aaaaaaaa']), gloHashes: new Set(['bbbbbbbb']) });
  assert.equal(entry.comments.flag, 'fuzzy, c-format, tp-ai, tp-ctx-aaaaaaaa, tp-glo-bbbbbbbb');
});

test('stampEntry: re-stamping prunes obsolete tp tokens', () => {
  // Entry had ctx-OLD and ctx-MID stamps from a prior run; on re-stamp with only ctx-NEW,
  // the old tokens are gone — natural pruning when a config entry is removed/renamed.
  const entry = { msgstr: ['x'], comments: { flag: 'tp-ai, tp-ctx-oldoldol, tp-ctx-midmidmi' } };
  stampEntry(entry, { isAi: true, ctxHashes: new Set(['newnewne']), gloHashes: new Set() });
  assert.equal(entry.comments.flag, 'tp-ai, tp-ctx-newnewne');
});

test('stampEntry: empty stamps + no preserved → removes flag line entirely', () => {
  const entry = { msgstr: ['x'], comments: { flag: 'tp-ai, tp-ctx-aaaaaaaa' } };
  stampEntry(entry, { isAi: false, ctxHashes: new Set(), gloHashes: new Set() });
  assert.ok(!entry.comments.flag, 'flag should be removed when nothing to write');
});

// -- --stamp-only migration mode -------------------------------------------

// Minimal pot/po shape that mergeLocale accepts. Keeps tests hermetic — no fs, no AI.
function makePot(msgids) {
  const t = { '': { '': { msgid: '', msgstr: [''] } } };
  for (const m of msgids) t[''][m] = { msgid: m, msgstr: [''] };
  return { headers: {}, translations: t };
}
function makePo(entries) {
  const t = { '': { '': { msgid: '', msgstr: [''] } } };
  for (const [msgid, msgstr, flag] of entries) {
    t[''][msgid] = { msgid, msgstr: [msgstr], comments: flag ? { flag } : undefined };
  }
  return { headers: {}, translations: t };
}
const noWporg = { entries: {}, headers: {} };

test('mergeLocale --stamp-only: stamps existing translation without queueing AI', async () => {
  const pot = makePot(['Translate strings here']);
  const existingPo = makePo([['Translate strings here', 'Traduce textele aici', null]]);
  const { merged, aiAttempted } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { stampOnly: true });
  assert.equal(aiAttempted, 0, 'stamp-only must not queue any AI calls');
  const entry = merged.translations['']['Translate strings here'];
  assert.deepEqual(entry.msgstr, ['Traduce textele aici'], 'msgstr preserved');
  assert.ok(entry.comments && entry.comments.flag, 'flag line should be written');
  const parsed = parseTpFlags(entry.comments.flag);
  assert.ok(parsed.ctxHashes.size > 0, 'context entries matching "strings" should be stamped');
});

test('mergeLocale --stamp-only: msgid with NO matching ctx/glo gets empty stamp (no flag line)', async () => {
  const pot = makePot(['Save your changes']);
  const existingPo = makePo([['Save your changes', 'Salvează modificările', null]]);
  const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { stampOnly: true });
  const entry = merged.translations['']['Save your changes'];
  assert.deepEqual(entry.msgstr, ['Salvează modificările']);
  assert.ok(!entry.comments || !entry.comments.flag, 'no matching ctx/glo entries → no flag line');
});

test('mergeLocale --stamp-only: existing wins over community (preserves on-disk translation)', async () => {
  const pot = makePot(['Edit the post']);
  const existingPo = makePo([['Edit the post', 'Editează articolul', null]]); // AI-translated yesterday
  const wporg = { entries: { 'Edit the post': { msgid: 'Edit the post', msgstr: ['Editează postarea'] } }, headers: {} };
  const { merged } = await mergeLocale('ro_RO', pot, existingPo, wporg, { stampOnly: true });
  const entry = merged.translations['']['Edit the post'];
  assert.deepEqual(entry.msgstr, ['Editează articolul'], 'existing should win over community in stamp-only mode');
});

test('mergeLocale --stamp-only: preserves existing tp-ai flag if present', async () => {
  const pot = makePot(['Translate strings here']);
  const existingPo = makePo([['Translate strings here', 'Traduce textele aici', 'tp-ai']]);
  const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { stampOnly: true });
  const parsed = parseTpFlags(merged.translations['']['Translate strings here'].comments.flag);
  assert.equal(parsed.isAi, true, 'tp-ai should carry over from existing flags');
});

test('mergeLocale --stamp-only: no tp-ai marker when existing flags don\'t have it', async () => {
  // Community translation case: no tp-ai stamp on input → stamp-only stamps ctx but not tp-ai.
  const pot = makePot(['Translate strings here']);
  const existingPo = makePo([['Translate strings here', 'Traduce textele aici', null]]);
  const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { stampOnly: true });
  const parsed = parseTpFlags(merged.translations['']['Translate strings here'].comments.flag);
  assert.equal(parsed.isAi, false, 'no tp-ai stamp when source had no AI marker');
  assert.ok(parsed.ctxHashes.size > 0, 'ctx hashes still stamped');
});

test('mergeLocale --update: stamps ctx hashes after AI fill', async () => {
  // Untranslated msgid → AI fills → entry gets tp-ai + tp-ctx-* flags.
  const pot = makePot(['Translate strings here']);
  const existingPo = null;
  await withMockFetch(async () => okResponse('<t i="1">Traduce textele aici</t>'),
    async () => {
      const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { update: true });
      const entry = merged.translations['']['Translate strings here'];
      assert.deepEqual(entry.msgstr, ['Traduce textele aici']);
      assert.ok(entry.comments && entry.comments.flag);
      const parsed = parseTpFlags(entry.comments.flag);
      assert.equal(parsed.isAi, true);
      assert.ok(parsed.ctxHashes.size > 0, 'ctx entries matching "strings" should be stamped');
    });
});

test('mergeLocale --update: stale entry (missing hash) routes to AI', async () => {
  // Existing translation has NO tp-ctx stamp for "strings" entry → considered stale → re-routed.
  const pot = makePot(['Translate strings here']);
  const existingPo = makePo([['Translate strings here', 'old translation', null]]);
  let fetchCalls = 0;
  await withMockFetch(async () => { fetchCalls++; return okResponse('<t i="1">fresh translation</t>'); },
    async () => {
      const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { update: true });
      assert.equal(fetchCalls, 1, 'stale entry should trigger AI call');
      assert.deepEqual(merged.translations['']['Translate strings here'].msgstr, ['fresh translation']);
    });
});

test('mergeLocale --update: entry with current stamps is NOT re-translated', async () => {
  // Pre-stamp the existing entry with the hashes that context.json currently produces for
  // "strings" → stored ⊇ expected → not stale → kept, no AI call.
  const context = loadContextForLocale('ro_RO');
  const matches = findContextMatchesForItem({ source: 'Translate strings here' }, context);
  const stampedFlag = 'tp-ai, ' + matches.map(m => `tp-ctx-${m.hash}`).sort().join(', ');
  const pot = makePot(['Translate strings here']);
  const existingPo = makePo([['Translate strings here', 'kept translation', stampedFlag]]);
  let fetchCalls = 0;
  await withMockFetch(async () => { fetchCalls++; return okResponse('<t i="1">should not be used</t>'); },
    async () => {
      const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { update: true });
      assert.equal(fetchCalls, 0, 'up-to-date entry should NOT trigger AI call');
      assert.deepEqual(merged.translations['']['Translate strings here'].msgstr, ['kept translation']);
    });
});

test('mergeLocale --update --no-ai: stale entry is PRESERVED, not destroyed', async () => {
  // Regression test for a data-loss bug: in --update mode, stale entries get queued for AI,
  // which pre-writes an empty stub. With --no-ai the stub is never filled, so the existing
  // translation gets silently nuked. Fix: --no-ai suppresses staleness, falling through to
  // the keep-existing branch instead.
  const pot = makePot(['Translate strings here']);
  const existingPo = makePo([['Translate strings here', 'stale but worth keeping', null]]);
  let fetchCalls = 0;
  await withMockFetch(async () => { fetchCalls++; return okResponse('<t i="1">unused</t>'); },
    async () => {
      const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { update: true, skipAi: true });
      assert.equal(fetchCalls, 0, '--no-ai must not call AI');
      assert.deepEqual(
        merged.translations['']['Translate strings here'].msgstr,
        ['stale but worth keeping'],
        'existing translation must survive --update --no-ai even when stale',
      );
    });
});

test('mergeLocale --full --no-ai: all existing translations PRESERVED, not destroyed', async () => {
  // Regression test for a paired data-loss bug: --full normally re-AI's everything by routing
  // every msgid past the keep-existing branch. With --no-ai added, every msgid ends up as an
  // empty stub. Fix: --no-ai suppresses --full for the same reason it suppresses staleness.
  const pot = makePot(['Save your changes', 'Cancel']);
  const existingPo = makePo([
    ['Save your changes', 'Salvează modificările', null],
    ['Cancel', 'Anulează', null],
  ]);
  let fetchCalls = 0;
  await withMockFetch(async () => { fetchCalls++; return okResponse('<t i="1">unused</t>'); },
    async () => {
      const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { fullRebuild: true, skipAi: true });
      assert.equal(fetchCalls, 0, '--no-ai must not call AI even under --full');
      assert.deepEqual(merged.translations['']['Save your changes'].msgstr, ['Salvează modificările']);
      assert.deepEqual(merged.translations['']['Cancel'].msgstr, ['Anulează']);
    });
});

test('mergeLocale --update --no-ai: still gap-fills missing translations (just no AI for them)', async () => {
  // The compensating direction: --no-ai shouldn't destroy existing translations, but it also
  // shouldn't AI-fill missing ones. Net effect: missing msgids stay missing (gap-fill skipped),
  // existing-but-stale msgids stay intact.
  const pot = makePot(['Translate strings here', 'Brand new untranslated string']);
  const existingPo = makePo([['Translate strings here', 'existing', null]]);
  let fetchCalls = 0;
  await withMockFetch(async () => { fetchCalls++; return okResponse('<t i="1">unused</t>'); },
    async () => {
      const { merged } = await mergeLocale('ro_RO', pot, existingPo, noWporg, { update: true, skipAi: true });
      assert.equal(fetchCalls, 0);
      assert.deepEqual(merged.translations['']['Translate strings here'].msgstr, ['existing']);
      assert.deepEqual(merged.translations['']['Brand new untranslated string'].msgstr, [''],
        'truly-untranslated msgids stay empty under --no-ai (gap-fill skipped)');
    });
});

// -- placeholder extraction + validation -----------------------------------

test('placeholders: extracts %s, %d, positional', () => {
  assert.deepEqual(extractPrintfPlaceholders('Hello %s'), ['%s']);
  assert.deepEqual(extractPrintfPlaceholders('%1$s and %2$d'), ['%1$s', '%2$d']);
  assert.deepEqual(extractPrintfPlaceholders('No placeholders'), []);
  assert.deepEqual(extractPrintfPlaceholders('%% literal'), ['%%']);
});

test('validatePrintfSubset: same set passes', () => {
  assert.equal(validatePrintfSubset(['%s', '%d'], 'X %s Y %d Z'), true);
});

test('validatePrintfSubset: fewer is OK', () => {
  // Translator dropping a placeholder is safe (sprintf ignores extra args).
  assert.equal(validatePrintfSubset(['%s', '%d'], 'X Y Z'), true);
});

test('validatePrintfSubset: rejects extra (sprintf would fatal)', () => {
  assert.equal(validatePrintfSubset(['%s'], '%s %s'), false);
});

test('validatePrintfSubset: rejects invented positional', () => {
  assert.equal(validatePrintfSubset(['%1$s'], '%1$s %2$s'), false);
});

test('validatePrintfSubset: rejects fullwidth percent', () => {
  assert.equal(validatePrintfSubset(['%s'], '％s'), false);
});

// -- plural validation -----------------------------------------------------

test('plural validation: 1 form with 1 %d is OK', () => {
  const item = { source: '%d file', msgid_plural: '%d files' };
  assert.equal(validateTranslation(item, ['%d ファイル']).ok, true);
});

test('plural validation: 2 forms each with 1 %d is OK', () => {
  const item = { source: '%d file', msgid_plural: '%d files' };
  assert.equal(validateTranslation(item, ['%d Datei', '%d Dateien']).ok, true);
});

test('plural validation: form with too many %d rejected', () => {
  const item = { source: '%d file', msgid_plural: '%d files' };
  assert.equal(validateTranslation(item, ['%d %d Dateien']).ok, false);
});

test('plural validation: invented positional rejected', () => {
  const item = { source: '%d file', msgid_plural: '%d files' };
  assert.equal(validateTranslation(item, ['%1$s Datei']).ok, false);
});

// -- unified placeholder validator (safety + quality) ---------------------

test('validatePlaceholders: clean singular passes', () => {
  const r = validatePlaceholders({ msgid: 'Hello %1$s' }, ['Hola %1$s']);
  assert.equal(r.ok, true);
});

test('validatePlaceholders: invented positional rejected (safety kind)', () => {
  const r = validatePlaceholders({ msgid: 'Hello %1$s' }, ['Hola %1$s %2$s']);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'safety');
});

test('validatePlaceholders: dropped positional rejected (quality kind)', () => {
  const r = validatePlaceholders(
    { msgid: 'Update to %1$s now' },
    ['Mettre à jour maintenant'],
  );
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'quality');
  assert.match(r.reason, /%1\$s/);
});

test('validatePlaceholders: fullwidth percent rejected', () => {
  const r = validatePlaceholders({ msgid: 'Hello %s' }, ['Hola ％s']);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'safety');
});

test('validatePlaceholders: bare % introduced when source is clean → rejected', () => {
  // Source `"Hello %s"` is clean (one valid spec, no bare %). Translation introduces a bare
  // `% r` sequence (r is not a valid PHP conversion char) which PHP 8 throws ValueError on.
  const r = validatePlaceholders({ msgid: 'Hello %s' }, ['Hello %s %r world']);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'safety');
  assert.match(r.reason, /bare %/);
});

test('validatePlaceholders: properly escaped %% in translation passes', () => {
  const r = validatePlaceholders({ msgid: '50%% off' }, ['50%% rabatt']);
  assert.equal(r.ok, true);
});

test('validatePlaceholders: source-relative mode accepts mirrored bare % pattern', () => {
  // TranslatePress real case: source uses %s% as a JS-substituted placeholder pattern
  // (.replace() in percentage-bar-logic.js). The translation mirroring the pattern doesn't
  // introduce any new fatal risk — both source and translation are equally "unsafe-looking"
  // but neither is actually sprintf'd at runtime.
  const r = validatePlaceholders(
    { msgid: 'Text on this page is %s% translated into all languages.' },
    ['Texto en esta página es %s% traducido a todos los idiomas.'],
  );
  assert.equal(r.ok, true);
});

test('validatePlaceholders: source-relative mode REJECTS adding more % chars', () => {
  // Even in relaxed mode, translation can't introduce additional % chars beyond source max.
  const r = validatePlaceholders(
    { msgid: '%s% complete' },     // 2 % chars
    ['%s%% complete %s%'],          // 4 % chars — extra risk
  );
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'safety');
});

test('extractPrintfPlaceholders: %x / %o / %e / %g now recognised', () => {
  assert.deepEqual(extractPrintfPlaceholders('Hex %x, oct %o, sci %e, gen %g'),
    ['%x', '%o', '%e', '%g']);
});

test('extractPrintfPlaceholders: width/precision/flags normalize to bare identity', () => {
  // %5d, %.2f, %-10s, %+d, %05d should all reduce to %d, %f, %s, %d, %d for multiset compare.
  assert.deepEqual(extractPrintfPlaceholders('a %5d b %.2f c %-10s d %+d'),
    ['%d', '%f', '%s', '%d']);
});

test('extractPrintfPlaceholders: positional with width preserved', () => {
  assert.deepEqual(extractPrintfPlaceholders('%1$.2f and %2$05d'), ['%1$f', '%2$d']);
});

test('validatePlaceholders: %x added in translation when source has none → rejected', () => {
  // Closes the regex-coverage gap the subagent flagged: source has no %x, translation does
  // → sprintf with 1 arg, format wants 2 → fatal.
  const r = validatePlaceholders({ msgid: 'Hello %s' }, ['Bonjour %s %x']);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'safety');
});

test('validatePlaceholders: plural union-cover passes', () => {
  const r = validatePlaceholders(
    { msgid: '%1$s deleted 1 file', msgid_plural: '%1$s deleted %2$d files' },
    ['%1$s удалил 1 файл', '%1$s удалил %2$d файла'],
  );
  assert.equal(r.ok, true);
});

test('validatePlaceholders: plural with all forms dropping a positional rejected', () => {
  const r = validatePlaceholders(
    { msgid: '%1$s deleted 1 file', msgid_plural: '%1$s deleted %2$d files' },
    ['удалил 1 файл', 'удалил %2$d файла'],
  );
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'quality');
});

test('validatePlaceholders: plural form with too many %d (safety)', () => {
  const r = validatePlaceholders(
    { msgid: '%d file', msgid_plural: '%d files' },
    ['%d %d Dateien'],
  );
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'safety');
});

// -- AI-side quality enforcement (new: drops trigger retry) ----------------

test('aiFill: AI dropping a positional triggers retry-then-drop', async () => {
  // Mocks an AI that consistently drops %1$s from the response.
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    calls++;
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: '<t i="1">Translation without placeholder</t>' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 },
      }),
    };
  };
  try {
    const { translations, stats } = await aiFill('ja', [{ id: 'x', source: 'Hello %1$s' }]);
    assert.equal(translations.has('x'), false, 'should drop a translation missing required positional');
    assert.equal(stats.dropped, 1);
    assert.equal(stats.retryRounds, 3);
    assert.equal(calls, 4);
  } finally {
    global.fetch = origFetch;
  }
});

test('aiFill: AI dropping positional then recovering on retry → kept', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    calls++;
    const content = calls === 1
      ? '<t i="1">Bonjour</t>'             // drops %1$s — quality fail
      : '<t i="1">Bonjour %1$s</t>';        // recovered
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 },
      }),
    };
  };
  try {
    const { translations, stats } = await aiFill('fr_FR', [{ id: 'x', source: 'Hello %1$s' }]);
    assert.equal(translations.get('x'), 'Bonjour %1$s');
    assert.equal(stats.retryRounds, 1);
    assert.equal(stats.dropped, 0);
  } finally {
    global.fetch = origFetch;
  }
});

// -- community-translation quality gate ------------------------------------

test('hasAllSourcePositionals: no positionals → vacuously true', () => {
  assert.equal(hasAllSourcePositionals({ msgid: 'Hello world' }, ['Hola mundo']), true);
});

test('hasAllSourcePositionals: %1$s preserved → true', () => {
  assert.equal(hasAllSourcePositionals({ msgid: 'Update to %1$s now' }, ['Mettre à jour vers %1$s maintenant']), true);
});

test('hasAllSourcePositionals: %1$s dropped → false (the ru_RU case)', () => {
  assert.equal(
    hasAllSourcePositionals(
      { msgid: 'Choose which engine you want to use in order to %1$s automatically translate your website.' },
      ['Выберите движок для автоматического перевода сайта.'],
    ),
    false,
  );
});

test('hasAllSourcePositionals: %1$s and %2$s both preserved → true', () => {
  assert.equal(
    hasAllSourcePositionals(
      { msgid: 'Please %1$s at %2$s' },
      ['Por favor %1$s en %2$s'],
    ),
    true,
  );
});

test('hasAllSourcePositionals: %2$s dropped → false', () => {
  assert.equal(
    hasAllSourcePositionals(
      { msgid: 'Please %1$s at %2$s' },
      ['Por favor %1$s aquí'],
    ),
    false,
  );
});

test('hasAllSourcePositionals: plural where union of forms covers all source positionals → true', () => {
  // Loose union check: f0 has %1$s, f1 has %2$d → between them they cover both source positionals.
  assert.equal(
    hasAllSourcePositionals(
      { msgid: '%1$s deleted 1 file', msgid_plural: '%1$s deleted %2$d files' },
      ['%1$s удалил 1 файл', '%1$s удалил %2$d файла'],
    ),
    true,
  );
});

test('hasAllSourcePositionals: plural where ALL forms drop a source positional → false', () => {
  assert.equal(
    hasAllSourcePositionals(
      { msgid: '%1$s deleted 1 file', msgid_plural: '%1$s deleted %2$d files' },
      ['удалил 1 файл', 'удалил %2$d файла'],
    ),
    false,
  );
});

test('hasAllSourcePositionals: non-positional %s not gated (translator may legitimately drop)', () => {
  // Non-positional %s is unsafe to ADD (caught by validatePrintfSubset elsewhere) but DROPPING
  // an unnumbered %s is sometimes intentional. hasAllSourcePositionals only gates POSITIONAL.
  assert.equal(hasAllSourcePositionals({ msgid: 'Hello %s' }, ['Bonjour']), true);
});

// -- response parsing ------------------------------------------------------

test('parseResponse: singular returns string', () => {
  const m = parseResponse('<t i="1">Hello</t>');
  assert.equal(m.get('1'), 'Hello');
});

test('parseResponse: plural returns array', () => {
  const m = parseResponse('<t i="2"><f0>one</f0><f1>many</f1></t>');
  assert.deepEqual(m.get('2'), ['one', 'many']);
});

test('parseResponse: XML entities are unescaped', () => {
  const m = parseResponse('<t i="1">a &amp; b &lt;c&gt;</t>');
  assert.equal(m.get('1'), 'a & b <c>');
});

// -- plural-forms registry -------------------------------------------------

test('plural-forms: Japanese 1, German 2, Russian 3, Arabic 6, Slovenian 4', () => {
  assert.equal(getPluralForLocale('ja').nplurals, 1);
  assert.equal(getPluralForLocale('de_DE').nplurals, 2);
  assert.equal(getPluralForLocale('ru_RU').nplurals, 3);
  assert.equal(getPluralForLocale('ar').nplurals, 6);
  assert.equal(getPluralForLocale('sl_SI').nplurals, 4);
});

test('plural-forms: every locale in registry has an entry', () => {
  for (const l of LOCALES) {
    const p = getPluralForLocale(l);
    assert.ok(p.nplurals >= 1 && p.nplurals <= 6, `${l} has weird nplurals ${p.nplurals}`);
    assert.equal(typeof p.expr, 'string');
  }
});

// -- WP.org real network ---------------------------------------------------

const skipNetwork = process.env.TRP_SKIP_NETWORK === '1';

test('fetch-wporg: de_DE has community pack', { skip: skipNetwork }, async () => {
  const r = await fetchWpOrgTranslations('de_DE');
  assert.ok(Object.keys(r.entries).length > 100, `got ${Object.keys(r.entries).length}`);
});

test('fetch-wporg: ja has no pack — empty result', { skip: skipNetwork }, async () => {
  const r = await fetchWpOrgTranslations('ja');
  assert.equal(Object.keys(r.entries).length, 0);
});

// -- aiFill end-to-end with mocked OpenRouter ------------------------------

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = orig; });
}

function okResponse(content) {
  return {
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 },
    }),
  };
}

test('aiFill: singular with glossary preserved', async () => {
  await withMockFetch(async (url, opts) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url ' + url);
    // 1 glossary match ("TranslatePress") → batchStart=2 → item gets i=2.
    return okResponse('<t i="1">TranslatePress</t>\n<t i="2">こんにちは TranslatePress</t>');
  }, async () => {
    const { translations, stats } = await aiFill('ja', [{ id: 'x', source: 'Hello TranslatePress' }]);
    assert.equal(translations.get('x'), 'こんにちは TranslatePress');
    assert.equal(stats.dropped, 0);
    assert.equal(stats.retryRounds, 0);
    assert.equal(stats.aborted, false);
  });
});

test('aiFill: plural returns string[]', async () => {
  await withMockFetch(async (url) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    return okResponse('<t i="1"><f0>%d Datei</f0><f1>%d Dateien</f1></t>');
  }, async () => {
    const { translations } = await aiFill('de_DE', [
      { id: 'p', source: '%d file', msgid_plural: '%d files' },
    ]);
    assert.deepEqual(translations.get('p'), ['%d Datei', '%d Dateien']);
  });
});

test('aiFill: placeholder mismatch → 3 retries → drop', async () => {
  let calls = 0;
  await withMockFetch(async (url) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    calls++;
    // Always return a bad translation that invents %2$s.
    return okResponse('<t i="1">Bad %1$s %2$s translation</t>');
  }, async () => {
    const { translations, stats } = await aiFill('ja', [
      { id: 'x', source: 'Hello %1$s' },
    ]);
    assert.equal(translations.has('x'), false, 'bad translation should be dropped');
    assert.equal(stats.dropped, 1);
    assert.equal(calls, 4, 'should call initial + 3 retries');
    assert.equal(stats.retryRounds, 3);
  });
});

test('aiFill: bad first attempt, good second attempt → kept after retry', async () => {
  let calls = 0;
  await withMockFetch(async (url) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    calls++;
    const content = calls === 1
      ? '<t i="1">Bad %2$s</t>'      // invents %2$s — fails validation
      : '<t i="1">こんにちは %1$s</t>'; // OK
    return okResponse(content);
  }, async () => {
    const { translations, stats } = await aiFill('ja', [{ id: 'x', source: 'Hello %1$s' }]);
    assert.equal(translations.get('x'), 'こんにちは %1$s');
    assert.equal(stats.retryRounds, 1);
    assert.equal(stats.dropped, 0);
  });
});

test('aiFill: 402 quota → graceful abort, no translations, stats.aborted set', async () => {
  await withMockFetch(async (url) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    return { ok: false, status: 402, text: async () => '{"error":{"message":"Quota exhausted"}}' };
  }, async () => {
    const { translations, stats } = await aiFill('ja', [
      { id: 'x', source: 'foo' },
      { id: 'y', source: 'bar' },
    ]);
    assert.equal(stats.aborted, true);
    assert.ok(stats.abortReason.includes('402'));
    assert.equal(translations.size, 0);
  });
});

test('aiFill: network error → graceful abort', async () => {
  await withMockFetch(async (url) => {
    if (!url.startsWith('https://openrouter.ai/')) throw new Error('unexpected url');
    throw new TypeError('fetch failed: ECONNREFUSED');
  }, async () => {
    const { stats } = await aiFill('ja', [{ id: 'x', source: 'foo' }]);
    assert.equal(stats.aborted, true);
    assert.ok(stats.abortReason.includes('ECONNREFUSED'));
  });
});
