/**
 * Incremental translation build.
 *
 * For every locale in locales.json:
 *   1. Reads the freshly-generated .pot.
 *   2. Reads the existing committed .po (if any) for that locale.
 *   3. Finds msgids that are new (in .pot but missing/untranslated in .po).
 *   4. Asks WP.org translate.wordpress.org for community translations of those new msgids.
 *   5. Uses OpenRouter to AI-fill anything still untranslated after the WP.org merge.
 *   6. Writes the merged .po and compiles .mo / .l10n.php / .json via `ddev wp i18n ...`.
 *
 * Plural strings (msgid_plural set) are *not* AI-filled in v1 — they are lifted from WP.org if
 * available and otherwise left blank. Plural-form handling is a follow-up.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gettextParser = require('gettext-parser');

const { fetchWpOrgTranslations } = require('./fetch-wporg');
const {
  aiFill,
  formatDuration,
  getPluralForLocale,
  validatePlaceholders,
  loadContextForLocale,
  loadGlossaryForLocale,
  findContextMatchesForItem,
  findGlossaryMatchesForItem,
} = require('./ai-fill');
const { auditFile } = require('./check-placeholders');
const { LOCALES, LOCALE_NAMES } = require('./locales');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const LANGUAGES_DIR = path.join(PLUGIN_ROOT, 'languages');
const SLUG = 'translatepress-multilingual';

const TODAY = new Date().toISOString().slice(0, 10);

function loadPot() {
  const potPath = path.join(LANGUAGES_DIR, `${SLUG}.pot`);
  if (!fs.existsSync(potPath)) {
    throw new Error(`POT not found at ${potPath}. Run \`gulp pot\` first.`);
  }
  return gettextParser.po.parse(fs.readFileSync(potPath));
}

function loadExistingPo(locale) {
  const poPath = path.join(LANGUAGES_DIR, `${SLUG}-${locale}.po`);
  if (!fs.existsSync(poPath)) return null;
  return gettextParser.po.parse(fs.readFileSync(poPath));
}

function isTranslated(entry) {
  if (!entry || !entry.msgstr) return false;
  return entry.msgstr.some(s => s && s.length > 0);
}

// -- PO custom-flag scheme -------------------------------------------------
//
// Each AI-touched msgstr carries a `#,` flags line listing the glossary/context entries
// that influenced its translation, as content-addressed 8-hex hashes:
//
//   #, tp-ai, tp-ctx-a3f8b9c1, tp-ctx-d4e5f6a7, tp-glo-b1c2d3e4
//
// `tp-ai` marks the msgstr as AI-generated (informational; lets `grep` separate AI vs
// community translations). `tp-ctx-HASH` records a context entry that matched; `tp-glo-
// HASH` records a glossary entry that matched. On the next `translations:update` run we
// recompute the current matching set and compare to the stored hashes — if any matching
// entry's hash isn't in the stored set, this msgstr is stale and gets re-routed to AI.
//
// Flag-line format is exactly what GNU gettext defines for custom sticky flags (each
// `flag-name[=value]` separated by `, ` on a `#,` line). We use `-` instead of `=` in
// the token to keep the value visually attached to its prefix and to dodge any tooling
// that might parse the value half specially. Custom flags round-trip cleanly through
// msgmerge / gettext-parser. We must NOT use `#, fuzzy` for this — fuzzy is the
// human-translator-review marker; reusing it would (a) cause msgfmt to skip the entry
// by default and (b) conflict with editors like Poedit.

function parseTpFlags(flagStr) {
  if (!flagStr) return { isAi: false, ctxHashes: new Set(), gloHashes: new Set(), preserved: [] };
  const tokens = flagStr.split(',').map(s => s.trim()).filter(Boolean);
  const ctxHashes = new Set();
  const gloHashes = new Set();
  let isAi = false;
  const preserved = [];
  for (const t of tokens) {
    if (t === 'tp-ai') isAi = true;
    else if (t.startsWith('tp-ctx-')) ctxHashes.add(t.slice('tp-ctx-'.length));
    else if (t.startsWith('tp-glo-')) gloHashes.add(t.slice('tp-glo-'.length));
    else preserved.push(t); // fuzzy, c-format, no-c-format, etc. — leave intact
  }
  return { isAi, ctxHashes, gloHashes, preserved };
}

function formatTpFlags({ isAi, ctxHashes, gloHashes, preserved }) {
  const tp = [];
  if (isAi) tp.push('tp-ai');
  for (const h of [...ctxHashes].sort()) tp.push(`tp-ctx-${h}`);
  for (const h of [...gloHashes].sort()) tp.push(`tp-glo-${h}`);
  const all = [...(preserved || []), ...tp];
  return all.length > 0 ? all.join(', ') : undefined;
}

/**
 * Stamp a merged entry with the given context/glossary hashes + tp-ai marker.
 * Preserves any non-tp flags (fuzzy, c-format, …) already on the entry. Pass empty
 * hash arrays for community/kept entries that should retain their non-tp flags but
 * not gain any tp markers.
 */
function stampEntry(entry, { isAi, ctxHashes, gloHashes }) {
  const existingFlag = (entry.comments && entry.comments.flag) || '';
  const parsed = parseTpFlags(existingFlag);
  const next = formatTpFlags({
    isAi,
    ctxHashes,
    gloHashes,
    preserved: parsed.preserved,
  });
  if (next === undefined) {
    if (entry.comments && 'flag' in entry.comments) delete entry.comments.flag;
    return;
  }
  entry.comments = entry.comments || {};
  entry.comments.flag = next;
}

function buildBaseHeaders(locale, existingHeaders, wporgHeaders) {
  const headers = Object.assign({}, existingHeaders || {}, wporgHeaders || {});
  headers['Project-Id-Version'] = headers['Project-Id-Version'] || 'TranslatePress Multilingual';
  headers['Language'] = locale;
  headers['MIME-Version'] = '1.0';
  headers['Content-Type'] = 'text/plain; charset=UTF-8';
  headers['Content-Transfer-Encoding'] = '8bit';
  headers['X-Generator'] = `TranslatePress build (community + OpenRouter), ${TODAY}`;
  headers['Last-Translator'] = 'WordPress.org community contributors + TranslatePress AI';
  // Authoritative Plural-Forms per locale. Overrides whatever the WP.org pack may have shipped
  // (which is fine — gettext consumers respect the local header).
  const plural = getPluralForLocale(locale);
  headers['Plural-Forms'] = `nplurals=${plural.nplurals}; plural=${plural.expr};`;
  return headers;
}

/**
 * Build the merged translation set for one locale.
 * Mutates and returns a gettext-parser-shaped object suitable for `gettextParser.po.compile`.
 */
async function mergeLocale(locale, pot, existingPo, wporg, { fullRebuild = false, skipAi = false, update = false, stampOnly = false } = {}) {
  const merged = {
    charset: 'utf-8',
    headers: buildBaseHeaders(locale, existingPo && existingPo.headers, wporg.headers),
    translations: {},
  };

  // --update mode loads the current glossary + context maps for this locale (including
  // any per-locale overrides) so we can recompute, per msgid, the set of entry hashes
  // that SHOULD currently be applied. We then compare against the `tp-ctx-…` / `tp-glo-…`
  // flags stored in the existing PO — if an expected hash is missing, the msgstr is
  // stale and gets re-routed to AI. Without --update we don't touch existing translations
  // beyond gap-filling, even if ctx/glo entries have changed since last build.
  // --stamp-only is a migration mode: it loads the same maps and writes the same stamps
  // but never calls AI. Use it once after first deploying the hash-tracking scheme so
  // existing translations get their fingerprints recorded without burning tokens.
  const enableStamps = update || stampOnly;
  const glossary  = enableStamps ? loadGlossaryForLocale(locale) : null;
  const contextMap = enableStamps ? loadContextForLocale(locale) : null;

  const toAiFill = [];
  const idToKey = new Map();        // id passed to AI → { ctx, msgid, isPlural, expectedCtxHashes, expectedGloHashes }
  const skipStamps = new Map();     // "ctx\x04msgid" → { ctxHashes, gloHashes } — for community/kept entries we stamp at write time
  let rejectedCommunityCount = 0;
  let staleInvalidatedCount = 0;
  let stampedExistingCount = 0;
  let stampedCommunityCount = 0;

  for (const ctx of Object.keys(pot.translations)) {
    merged.translations[ctx] = merged.translations[ctx] || {};
    for (const msgid of Object.keys(pot.translations[ctx])) {
      const potEntry = pot.translations[ctx][msgid];
      if (msgid === '') {
        merged.translations[ctx][msgid] = { msgid: '', msgstr: [''] };
        continue;
      }

      const existingEntry = existingPo && existingPo.translations[ctx] && existingPo.translations[ctx][msgid];
      const wporgKey = ctx === '' ? msgid : `${ctx}${msgid}`;
      const wporgEntry = wporg.entries[wporgKey];
      const sourceEntry = { msgid, msgid_plural: potEntry.msgid_plural };
      const item = { source: msgid, msgid_plural: potEntry.msgid_plural };

      // expectedCtxHashes/expectedGloHashes: the set of glossary/context entry hashes
      // that currently match this msgid. Computed for both --update (used to detect
      // staleness) and --stamp-only (used to write the migration stamps).
      let isStale = false;
      let expectedCtxHashes = new Set();
      let expectedGloHashes = new Set();
      if (enableStamps) {
        for (const e of findContextMatchesForItem(item, contextMap))  expectedCtxHashes.add(e.hash);
        for (const e of findGlossaryMatchesForItem(item, glossary))   expectedGloHashes.add(e.hash);
      }
      if (update) {
        const storedFlag = (existingEntry && existingEntry.comments && existingEntry.comments.flag) || '';
        const stored = parseTpFlags(storedFlag);
        for (const h of expectedCtxHashes) if (!stored.ctxHashes.has(h)) { isStale = true; break; }
        if (!isStale) for (const h of expectedGloHashes) if (!stored.gloHashes.has(h)) { isStale = true; break; }
        if (isStale) staleInvalidatedCount++;
      }

      // When AI is unavailable (--no-ai, or AI aborted mid-run), staleness and full-rebuild
      // are NOT actionable — we can't re-translate to satisfy them. Falling through to the
      // AI-queue branch would pre-write an empty stub and leave it that way, destroying the
      // existing translation. So suppress those flags here: --no-ai means "fill gaps only,
      // don't invalidate anything we can't re-fill". The keep-community / keep-existing
      // branches below then run normally and preserve what's on disk.
      const effectiveStale = isStale && !skipAi;
      const effectiveFull  = fullRebuild && !skipAi;

      // --stamp-only: trust the existing translation as-is (it was generated against the
      // current ctx/glo state — you're asserting that by passing this flag), write the
      // current hashes onto the flag line, never call AI. Priority is existing > community
      // (the inverse of normal flow) because the whole point is to preserve what's on disk
      // — typically an AI translation from a recent build that the operator wants to keep.
      // Skips silently if neither an existing nor a community translation is available;
      // those gaps will be filled on the next regular `:update` or `:incremental` run.
      if (stampOnly) {
        if (existingEntry && isTranslated(existingEntry)) {
          const check = validatePlaceholders(sourceEntry, existingEntry.msgstr);
          if (check.ok) {
            merged.translations[ctx][msgid] = {
              msgctxt: ctx === '' ? undefined : ctx,
              msgid,
              msgid_plural: potEntry.msgid_plural,
              msgstr: existingEntry.msgstr,
              comments: existingEntry.comments ? { ...existingEntry.comments } : undefined,
            };
            const storedFlag = (existingEntry.comments && existingEntry.comments.flag) || '';
            const stored = parseTpFlags(storedFlag);
            skipStamps.set(`${ctx}\x04${msgid}`, { isAi: stored.isAi, ctxHashes: expectedCtxHashes, gloHashes: expectedGloHashes });
            stampedExistingCount++;
            continue;
          }
        }
        if (wporgEntry && isTranslated(wporgEntry)) {
          const check = validatePlaceholders(sourceEntry, wporgEntry.msgstr);
          if (check.ok) {
            merged.translations[ctx][msgid] = {
              msgctxt: ctx === '' ? undefined : ctx,
              msgid,
              msgid_plural: potEntry.msgid_plural,
              msgstr: wporgEntry.msgstr,
            };
            skipStamps.set(`${ctx}\x04${msgid}`, { isAi: false, ctxHashes: expectedCtxHashes, gloHashes: expectedGloHashes });
            stampedCommunityCount++;
            continue;
          }
        }
        // No existing, no community — leave an empty stub. Don't queue for AI.
        const stubMsgstr = potEntry.msgid_plural
          ? new Array(getPluralForLocale(locale).nplurals).fill('')
          : [''];
        merged.translations[ctx][msgid] = {
          msgctxt: ctx === '' ? undefined : ctx,
          msgid,
          msgid_plural: potEntry.msgid_plural,
          msgstr: stubMsgstr,
        };
        continue;
      }

      // Community always wins — UNLESS (a) its translation fails the unified safety+quality
      // placeholder check, or (b) --update detected stale ctx/glo hashes for this msgid. In
      // both cases we route through AI so the new placeholder fix / fresh hint guidance is
      // applied. Stamp on accept so the next --update run can compare against an honest baseline.
      if (!effectiveStale && wporgEntry && isTranslated(wporgEntry)) {
        const check = validatePlaceholders(sourceEntry, wporgEntry.msgstr);
        if (check.ok) {
          merged.translations[ctx][msgid] = {
            msgctxt: ctx === '' ? undefined : ctx,
            msgid,
            msgid_plural: potEntry.msgid_plural,
            msgstr: wporgEntry.msgstr,
            comments: existingEntry && existingEntry.comments ? { ...existingEntry.comments } : undefined,
          };
          if (update && !skipAi) {
            skipStamps.set(`${ctx}\x04${msgid}`, { isAi: false, ctxHashes: expectedCtxHashes, gloHashes: expectedGloHashes });
          }
          continue;
        }
        rejectedCommunityCount++;
      }

      // Already AI-translated in a previous build → keep it (unless --full re-AI's everything
      // or --update detected stale hashes). Preserve any prior tp-ai / tp-ctx-… / tp-glo-…
      // flags by copying the whole comments block; if --update kept it, we re-stamp below
      // with the current expected hash set so we don't accumulate stale tokens.
      if (!effectiveFull && !effectiveStale && existingEntry && isTranslated(existingEntry)) {
        const check = validatePlaceholders(sourceEntry, existingEntry.msgstr);
        if (check.ok) {
          merged.translations[ctx][msgid] = {
            msgctxt: ctx === '' ? undefined : ctx,
            msgid,
            msgid_plural: potEntry.msgid_plural,
            msgstr: existingEntry.msgstr,
            comments: existingEntry.comments ? { ...existingEntry.comments } : undefined,
          };
          if (update && !skipAi) {
            const storedFlag = (existingEntry.comments && existingEntry.comments.flag) || '';
            const stored = parseTpFlags(storedFlag);
            skipStamps.set(`${ctx}\x04${msgid}`, { isAi: stored.isAi, ctxHashes: expectedCtxHashes, gloHashes: expectedGloHashes });
          }
          continue;
        }
      }

      // New, untranslated, rejected-by-placeholder, or stale-against-ctx/glo → queue for AI.
      const id = `${toAiFill.length}`;
      idToKey.set(id, { ctx, msgid, isPlural: !!potEntry.msgid_plural, expectedCtxHashes, expectedGloHashes });
      const extracted = potEntry.comments && potEntry.comments.extracted;
      const aiItem = {
        id,
        source: msgid,
        msgctxt: ctx === '' ? undefined : ctx,
        comments: extracted || undefined,
      };
      if (potEntry.msgid_plural) {
        aiItem.msgid_plural = potEntry.msgid_plural;
      }
      toAiFill.push(aiItem);

      // Pre-create the stub entry. Plurals get nplurals empty forms so the .po file shape is
      // valid even if the AI fails validation for every retry.
      const stubMsgstr = potEntry.msgid_plural
        ? new Array(getPluralForLocale(locale).nplurals).fill('')
        : [''];
      merged.translations[ctx][msgid] = {
        msgctxt: ctx === '' ? undefined : ctx,
        msgid,
        msgid_plural: potEntry.msgid_plural,
        msgstr: stubMsgstr,
        // Carry forward any non-tp flags (fuzzy, c-format, …) — the stamp below preserves them.
        comments: existingEntry && existingEntry.comments ? { ...existingEntry.comments } : undefined,
      };
    }
  }

  const { covered, total } = communityStats(pot, wporg);
  const result = { merged, communityCount: covered, totalCount: total, aiAttempted: toAiFill.length, rejectedCommunity: rejectedCommunityCount, staleInvalidated: staleInvalidatedCount, stampedExisting: stampedExistingCount, stampedCommunity: stampedCommunityCount, aiStats: null };

  const rejFrag = rejectedCommunityCount > 0 ? ` (${rejectedCommunityCount} community translation(s) rejected for missing positionals — routed to AI)` : '';
  const staleFrag = staleInvalidatedCount > 0 ? ` [${staleInvalidatedCount} msgid(s) stale vs current glossary/context — routed to AI]` : '';

  if (stampOnly) {
    console.log(`  [${locale}] stamp-only: ${stampedExistingCount} existing + ${stampedCommunityCount} community translation(s) stamped with current hashes.`);
  } else if (toAiFill.length === 0) {
    console.log(`  [${locale}] no new strings; community covered ${covered}/${total} of source set.${rejFrag}${staleFrag}`);
  } else if (skipAi) {
    console.log(`  [${locale}] --no-ai: skipping ${toAiFill.length} gaps (community covered ${covered}/${total} of source set).${rejFrag}${staleFrag}`);
  } else {
    console.log(`  [${locale}] ${toAiFill.length} new strings to AI-fill (community covered ${covered}/${total} of the source set).${rejFrag}${staleFrag}`);
    const { translations: aiResults, stats } = await aiFill(locale, toAiFill);
    for (const [id, info] of idToKey.entries()) {
      const t = aiResults.get(id);
      const entry = merged.translations[info.ctx][info.msgid];
      if (typeof t === 'undefined') continue; // dropped after retries — leave stub empty
      if (info.isPlural) {
        entry.msgstr = Array.isArray(t) ? t : [String(t)];
      } else {
        entry.msgstr = [String(t)];
      }
      // Stamp AI-translated entries with current expected hashes (computed even outside
      // update mode so new translations from a plain `:incremental` run also carry the
      // fingerprint that lets future `:update` runs compare honestly).
      const stampCtx = update
        ? info.expectedCtxHashes
        : new Set(findContextMatchesForItem({ source: info.msgid, msgid_plural: entry.msgid_plural }, loadContextForLocale(locale)).map(e => e.hash));
      const stampGlo = update
        ? info.expectedGloHashes
        : new Set(findGlossaryMatchesForItem({ source: info.msgid, msgid_plural: entry.msgid_plural }, loadGlossaryForLocale(locale)).map(e => e.hash));
      stampEntry(entry, { isAi: true, ctxHashes: stampCtx, gloHashes: stampGlo });
    }
    result.aiStats = stats;
  }

  // Re-stamp community-kept and existing-kept entries with the current hash set so the next
  // --update run sees an honest baseline. Only runs in --update mode (otherwise we leave
  // entries untouched and let the next --update do the work).
  for (const [key, stamp] of skipStamps.entries()) {
    const sep = key.indexOf('\x04');
    const ctx = key.slice(0, sep);
    const msgid = key.slice(sep + 1);
    const entry = merged.translations[ctx] && merged.translations[ctx][msgid];
    if (!entry) continue;
    stampEntry(entry, stamp);
  }

  return result;
}

function communityStats(pot, wporg) {
  let total = 0;
  let covered = 0;
  for (const ctx of Object.keys(pot.translations)) {
    for (const msgid of Object.keys(pot.translations[ctx])) {
      if (msgid === '') continue;
      total++;
      const key = ctx === '' ? msgid : `${ctx}${msgid}`;
      if (wporg.entries[key]) covered++;
    }
  }
  return { covered, total };
}

function writePo(locale, merged) {
  const poPath = path.join(LANGUAGES_DIR, `${SLUG}-${locale}.po`);
  const out = gettextParser.po.compile(merged);
  fs.writeFileSync(poPath, out);
  return poPath;
}

function findDdevRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.ddev'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find a .ddev/ folder above ${startDir}. Is DDEV initialized?`);
}

function compileArtifacts() {
  const ddevRoot = findDdevRoot(PLUGIN_ROOT);
  // `ddev wp ...` runs inside the container at /var/www/html, which maps to ddevRoot on host.
  // Pass a path relative to ddevRoot so it resolves identically inside the container.
  const relLanguages = path.relative(ddevRoot, LANGUAGES_DIR);
  console.log(`Compiling .mo / .l10n.php / .json via ddev wp i18n in ${relLanguages}`);
  execFileSync('ddev', ['wp', 'i18n', 'make-mo',   relLanguages], { cwd: ddevRoot, stdio: 'inherit' });
  execFileSync('ddev', ['wp', 'i18n', 'make-php',  relLanguages], { cwd: ddevRoot, stdio: 'inherit' });
  execFileSync('ddev', ['wp', 'i18n', 'make-json', relLanguages, '--no-purge'], { cwd: ddevRoot, stdio: 'inherit' });
}

async function buildIncremental({ onlyLocale, fullRebuild = false, skipAi = false, update = false, stampOnly = false } = {}) {
  const locales = onlyLocale ? [onlyLocale] : LOCALES;
  const pot = loadPot();
  const runStart = Date.now();
  const rows = [];
  let aiAborted = null; // sticky abort reason — once set, remaining locales skip AI

  for (let i = 0; i < locales.length; i++) {
    const locale = locales[i];
    if (!LOCALE_NAMES[locale]) {
      console.warn(`  [${locale}] not in locale-name map; skipping.`);
      continue;
    }
    const localeStart = Date.now();
    const effectiveSkipAi = skipAi || !!aiAborted;
    const header = `[${i + 1}/${locales.length}] -- ${locale} (${LOCALE_NAMES[locale]})`
      + (fullRebuild ? ' [FULL REBUILD]' : '')
      + (stampOnly ? ' [STAMP-ONLY]' : (update ? ' [UPDATE]' : ''))
      + (effectiveSkipAi && !stampOnly ? (aiAborted ? ' [AI ABORTED — community-only]' : ' [NO AI]') : '');
    console.log(header);

    const existingPo = loadExistingPo(locale);
    let wporg;
    try {
      wporg = await fetchWpOrgTranslations(locale);
    } catch (e) {
      console.warn(`  [${locale}] WP.org fetch failed: ${e.message}. Continuing with empty community set.`);
      wporg = { entries: {}, headers: {} };
    }

    const { merged, communityCount, totalCount, aiAttempted, aiStats } =
      await mergeLocale(locale, pot, existingPo, wporg, { fullRebuild, skipAi: effectiveSkipAi, update, stampOnly });

    if (aiStats && aiStats.aborted && !aiAborted) {
      aiAborted = aiStats.abortReason || 'unknown';
    }

    const poPath = writePo(locale, merged);
    const localeMs = Date.now() - localeStart;

    const aiBatches  = aiStats ? aiStats.batches          : 0;
    const aiTokens   = aiStats ? aiStats.totalTokens      : 0;
    const aiCost     = aiStats && aiStats.costKnown ? aiStats.costUsd : null;
    const costFrag   = aiCost !== null ? `, $${aiCost.toFixed(4)}` : '';
    const aiFrag     = aiStats ? `, AI ${aiBatches} call(s)/${aiTokens} tok${costFrag}` : '';
    console.log(`  [${locale}] wrote ${path.relative(PLUGIN_ROOT, poPath)} — ${formatDuration(localeMs)} (community ${communityCount}/${totalCount}${aiFrag})`);

    rows.push({
      locale,
      community: communityCount,
      total: totalCount,
      aiAttempted,
      aiBatches,
      aiTokens,
      aiCost,
      elapsedMs: localeMs,
    });
  }

  compileArtifacts();

  if (rows.length > 1) {
    printSummary(rows, Date.now() - runStart);
  }

  // Auto-audit. Runs the standalone audit logic on every .po we just wrote — final safety
  // net for anything the runtime checks may have missed. Cheap (~1s for all 43 locales);
  // would surface any bad msgstr that survived the merge or AI validation.
  runFinalAudit(locales);

  if (aiAborted) {
    console.warn('');
    console.warn(`⚠ AI translation aborted: ${aiAborted}`);
    console.warn('  .po files were written with whatever was already translated (community + previously-saved AI).');
    console.warn('  Untranslated msgids were left with empty msgstr; gettext will fall back to the English source.');
    console.warn('  Fix the underlying issue (quota, API key, network) and re-run to fill the gaps.');
    process.exitCode = 2;
  }
}

function runFinalAudit(locales) {
  console.log('');
  console.log('Auditing committed .po files for placeholder integrity...');
  let totalCritical = 0;
  let totalMissing = 0;
  const offenders = [];
  for (const locale of locales) {
    const poPath = path.join(LANGUAGES_DIR, `${SLUG}-${locale}.po`);
    if (!fs.existsSync(poPath)) continue;
    const report = auditFile(poPath);
    const critical = report.findings.filter(f => f.critical.length > 0).length;
    const missing  = report.findings.filter(f => f.missing.length > 0 && f.critical.length === 0).length;
    totalCritical += critical;
    totalMissing  += missing;
    if (critical > 0 || missing > 0) {
      offenders.push({ locale, critical, missing });
    }
  }
  if (totalCritical === 0 && totalMissing === 0) {
    console.log(`✓ Audit clean: ${locales.length} locale(s), 0 critical, 0 missing.`);
    return;
  }
  console.warn(`✗ Audit found issues across ${offenders.length} locale(s):`);
  for (const o of offenders) {
    console.warn(`  - ${o.locale}: ${o.critical} critical, ${o.missing} missing`);
  }
  console.warn('  Run `npm run translations:check-placeholders` for full per-entry detail.');
  if (totalCritical > 0) {
    process.exitCode = process.exitCode || 3;
  } else if (process.exitCode === undefined) {
    // Missing-only is a warning by default; --strict tightens to exit 3 at the audit script level.
  }
}

function printSummary(rows, totalMs) {
  const cols = [
    { key: 'locale',    label: 'locale',   align: 'left'  },
    { key: 'coverage',  label: 'coverage', align: 'right' },
    { key: 'ai',        label: 'AI',       align: 'right' },
    { key: 'tokens',    label: 'tokens',   align: 'right' },
    { key: 'cost',      label: 'cost USD', align: 'right' },
    { key: 'elapsed',   label: 'elapsed',  align: 'right' },
  ];
  const fmtRows = rows.map(r => ({
    locale:   r.locale,
    coverage: `${r.community}/${r.total}`,
    ai:       r.aiAttempted ? `${r.aiBatches}×` : '-',
    tokens:   r.aiTokens ? r.aiTokens.toLocaleString() : '-',
    cost:     r.aiCost !== null ? `$${r.aiCost.toFixed(4)}` : '-',
    elapsed:  formatDuration(r.elapsedMs),
  }));
  const totals = rows.reduce((acc, r) => ({
    aiBatches: acc.aiBatches + (r.aiBatches || 0),
    aiTokens:  acc.aiTokens  + (r.aiTokens || 0),
    aiCost:    acc.aiCost    + (r.aiCost || 0),
    aiCostKnown: acc.aiCostKnown || r.aiCost !== null,
  }), { aiBatches: 0, aiTokens: 0, aiCost: 0, aiCostKnown: false });
  fmtRows.push({
    locale:   'TOTAL',
    coverage: '',
    ai:       totals.aiBatches ? `${totals.aiBatches}×` : '-',
    tokens:   totals.aiTokens ? totals.aiTokens.toLocaleString() : '-',
    cost:     totals.aiCostKnown ? `$${totals.aiCost.toFixed(4)}` : '-',
    elapsed:  formatDuration(totalMs),
  });

  const widths = cols.map(c => Math.max(c.label.length, ...fmtRows.map(r => String(r[c.key]).length)));
  const pad = (val, w, align) => {
    val = String(val);
    return align === 'right' ? val.padStart(w) : val.padEnd(w);
  };
  const sep = '  ';
  const line = (vals) => cols.map((c, i) => pad(vals[c.key], widths[i], c.align)).join(sep);

  console.log('');
  console.log('Summary');
  console.log('─'.repeat(widths.reduce((a, b) => a + b, 0) + sep.length * (cols.length - 1)));
  console.log(line(Object.fromEntries(cols.map(c => [c.key, c.label]))));
  for (const r of fmtRows.slice(0, -1)) console.log(line(r));
  console.log('─'.repeat(widths.reduce((a, b) => a + b, 0) + sep.length * (cols.length - 1)));
  console.log(line(fmtRows[fmtRows.length - 1]));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const onlyLocaleArg = args.find(a => a.startsWith('--locale='));
  const onlyLocale = onlyLocaleArg ? onlyLocaleArg.slice('--locale='.length) : undefined;
  const fullRebuild = args.includes('--full');
  const skipAi = args.includes('--no-ai');
  const update = args.includes('--update');
  const stampOnly = args.includes('--stamp-only');
  buildIncremental({ onlyLocale, fullRebuild, skipAi, update, stampOnly }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { buildIncremental, mergeLocale, parseTpFlags, formatTpFlags, stampEntry };
