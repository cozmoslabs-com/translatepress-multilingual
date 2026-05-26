/**
 * Placeholder integrity audit for committed .po files.
 *
 * Walks every languages/translatepress-multilingual-{locale}.po file (or just one with --locale=),
 * parses each translated entry, and compares printf placeholders between source and translation.
 *
 * Two classes of finding:
 *   - CRITICAL: translation contains a positional placeholder (%1$s, %2$d, …) the source does not.
 *     This *will* cause `sprintf` to fatal in PHP at runtime when the string is rendered, because
 *     PHP attempts to read an argument that isn't there. Must be fixed before ship.
 *   - MISSING: source contains a positional placeholder the translation drops. PHP won't fatal
 *     (sprintf just ignores extra args) but the user sees a sentence with no variable
 *     substituted — e.g. "update to version  or newer" with a gap where the version should be.
 *
 * Plurals: each <fN> form is checked independently. A form may use any subset of the union of
 *   placeholders in msgid + msgid_plural — the same rule the AI-fill validator enforces. The
 *   "MISSING" check for plurals reports a form that has *zero* of the placeholders that appear
 *   in either source form (likely a quality bug). CRITICAL still flags inventions.
 *
 * Exit code:
 *   0 = no CRITICAL findings (still may have MISSING — strict mode below promotes those).
 *   1 = at least one CRITICAL finding.
 *
 * Flags:
 *   --locale=xx_XX   only audit one locale
 *   --strict         exit 1 on MISSING findings too (default: exit 1 only on CRITICAL)
 *   --quiet          suppress per-entry detail; only print summary table
 */

const fs = require('fs');
const path = require('path');
const gettextParser = require('gettext-parser');
const { LOCALES, LOCALE_NAMES } = require('./locales');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const LANGUAGES_DIR = path.join(PLUGIN_ROOT, 'languages');
const SLUG = 'translatepress-multilingual';

// Matches the full PHP printf spec set with width/precision/flags. The captured strings get
// normalized to a canonical "%[N$]X" identity so `%5d` and `%d` compare equal.
const PRINTF_RE = /%(?:\d+\$)?[+\- 0'#]*\d*(?:\.\d+)?[bcdeEfFgGiosuxX%]/g;

function normalizePlaceholder(ph) {
  const m = String(ph).match(/^%(\d+\$)?[+\- 0'#]*\d*(?:\.\d+)?([bcdeEfFgGiosuxX%])$/);
  if (!m) return ph;
  return '%' + (m[1] || '') + m[2];
}

function extractPlaceholders(text) {
  if (typeof text !== 'string') return [];
  return (text.match(PRINTF_RE) || []).map(normalizePlaceholder);
}

function hasUnpairedPercent(text) {
  if (typeof text !== 'string') return false;
  return text.replace(PRINTF_RE, '').includes('%');
}

function countPercents(text) {
  return (String(text || '').match(/%/g) || []).length;
}

// Only matches unambiguous WP printf specs (no space-flag etc) — see ai-fill.js.
const STRICT_PRINTF_RE = /%(?:\d+\$)?[sdif%]/g;

function sourceHasAmbiguousPercent(text) {
  return String(text || '').replace(STRICT_PRINTF_RE, '').includes('%');
}

function multiset(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function multisetDiff(haveMs, wantMs) {
  // Returns placeholders present in `wantMs` more times than in `haveMs` — i.e. how many extras
  // `wantMs` has over `haveMs`.
  const extras = new Map();
  for (const [k, n] of wantMs) {
    const diff = n - (haveMs.get(k) || 0);
    if (diff > 0) extras.set(k, diff);
  }
  return extras;
}

function isPositional(ph) {
  return /^%\d+\$/.test(ph);
}

function isTranslated(msgstr) {
  return Array.isArray(msgstr) && msgstr.some(s => s && s.length > 0);
}

function joinPlaceholderCounts(map) {
  if (map.size === 0) return '(none)';
  return Array.from(map.entries()).map(([k, n]) => n === 1 ? k : `${k}×${n}`).join(', ');
}

function shorten(s, n = 60) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Check one msgid/msgstr (or msgid_plural / forms[]) pair.
 * Returns { critical: [{form, extras}], missing: [{form, missing}] }.
 */
function checkEntry(entry) {
  const result = { critical: [], missing: [] };
  const idPh = extractPlaceholders(entry.msgid);
  const idPosSet = new Set(idPh.filter(isPositional));

  // If source itself contains any `%` that isn't an unambiguous WP printf spec, evaluate
  // translations in source-relative mode (see ai-fill.js for full rationale). A translation
  // is only "critical" if it has MORE % chars than the source's max — anything else would
  // be matching a source-side weirdness, not introducing new fatal risk.
  const sourceAmbiguous = sourceHasAmbiguousPercent(entry.msgid) ||
                          (entry.msgid_plural && sourceHasAmbiguousPercent(entry.msgid_plural));
  if (sourceAmbiguous) {
    const sourceMaxPct = Math.max(
      countPercents(entry.msgid),
      entry.msgid_plural ? countPercents(entry.msgid_plural) : 0,
    );
    entry.msgstr.forEach((form, i) => {
      if (!form) return;
      const tag = entry.msgid_plural ? `f${i}` : 'singular';
      if (form.includes('％')) {
        result.critical.push({ form: tag, extras: new Map([['fullwidth ％', 1]]), formText: form });
      }
      if (countPercents(form) > sourceMaxPct) {
        result.critical.push({ form: tag, extras: new Map([[`% chars (${countPercents(form)} > source max ${sourceMaxPct})`, 1]]), formText: form });
      }
    });
    return result;
  }

  if (entry.msgid_plural) {
    // Plural: each form independently. Allowed set = msgid ∪ msgid_plural.
    const plPh = extractPlaceholders(entry.msgid_plural);
    const plPosSet = new Set(plPh.filter(isPositional));
    const allowedMs = new Map();
    for (const [k, n] of multiset(idPh)) allowedMs.set(k, Math.max(n, multiset(plPh).get(k) || 0));
    for (const [k, n] of multiset(plPh)) if (!allowedMs.has(k)) allowedMs.set(k, n);
    const unionPosSet = new Set([...idPosSet, ...plPosSet]);

    entry.msgstr.forEach((form, i) => {
      if (!form) return;
      const tMs = multiset(extractPlaceholders(form));
      const tPos = new Set(extractPlaceholders(form).filter(isPositional));

      if (hasUnpairedPercent(form)) {
        result.critical.push({ form: `f${i}`, extras: new Map([['bare %', 1]]), formText: form });
      }
      if (form.includes('％')) {
        result.critical.push({ form: `f${i}`, extras: new Map([['fullwidth ％', 1]]), formText: form });
      }
      const extras = multisetDiff(allowedMs, tMs);
      if (extras.size > 0) {
        result.critical.push({ form: `f${i}`, extras, formText: form });
      }
      const missingPos = [...unionPosSet].filter(p => !tPos.has(p));
      if (missingPos.length > 0) {
        result.missing.push({ form: `f${i}`, missing: missingPos, formText: form });
      }
    });
  } else {
    const t = entry.msgstr[0];
    if (!t) return result;
    const sourceMs = multiset(idPh);
    const tMs = multiset(extractPlaceholders(t));

    if (hasUnpairedPercent(t)) {
      result.critical.push({ form: 'singular', extras: new Map([['bare %', 1]]), formText: t });
    }
    if (t.includes('％')) {
      result.critical.push({ form: 'singular', extras: new Map([['fullwidth ％', 1]]), formText: t });
    }
    const extras = multisetDiff(sourceMs, tMs);
    if (extras.size > 0) {
      result.critical.push({ form: 'singular', extras, formText: t });
    }
    const tPos = new Set(extractPlaceholders(t).filter(isPositional));
    const missingPos = [...idPosSet].filter(p => !tPos.has(p));
    if (missingPos.length > 0) {
      result.missing.push({ form: 'singular', missing: missingPos, formText: t });
    }
  }
  return result;
}

function auditFile(poPath) {
  const raw = fs.readFileSync(poPath);
  const parsed = gettextParser.po.parse(raw);
  const report = {
    file: poPath,
    total: 0,
    translated: 0,
    findings: [], // [{msgid, msgstr-or-forms, critical: [...], missing: [...]}]
  };

  for (const ctx of Object.keys(parsed.translations)) {
    for (const msgid of Object.keys(parsed.translations[ctx])) {
      if (msgid === '') continue;
      const entry = parsed.translations[ctx][msgid];
      report.total++;
      if (!isTranslated(entry.msgstr)) continue;
      report.translated++;
      const check = checkEntry(entry);
      if (check.critical.length > 0 || check.missing.length > 0) {
        report.findings.push({
          msgctxt: ctx === '' ? undefined : ctx,
          msgid: entry.msgid,
          msgid_plural: entry.msgid_plural,
          msgstr: entry.msgstr,
          critical: check.critical,
          missing: check.missing,
        });
      }
    }
  }
  return report;
}

function printReport(report, { quiet = false } = {}) {
  const criticalEntries = report.findings.filter(f => f.critical.length > 0);
  const missingEntries  = report.findings.filter(f => f.missing.length > 0 && f.critical.length === 0);

  const tag = criticalEntries.length > 0 ? '✗ CRITICAL'
            : missingEntries.length  > 0 ? '⚠ MISSING'
            : '✓ clean';
  const rel = path.relative(PLUGIN_ROOT, report.file);
  console.log(`${tag}  ${rel}  (${report.translated}/${report.total} translated, ${criticalEntries.length} critical, ${missingEntries.length} missing)`);

  if (quiet) return;

  for (const f of criticalEntries) {
    for (const c of f.critical) {
      console.log(`    CRITICAL  ${c.form}  extras=${joinPlaceholderCounts(c.extras)}`);
      console.log(`      msgid:  "${shorten(f.msgid)}"`);
      console.log(`      msgstr: "${shorten(c.formText)}"`);
    }
  }
  for (const f of missingEntries) {
    for (const m of f.missing) {
      console.log(`    MISSING   ${m.form}  positionals_not_in_translation=${m.missing.join(', ')}`);
      console.log(`      msgid:  "${shorten(f.msgid)}"`);
      console.log(`      msgstr: "${shorten(m.formText)}"`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const onlyLocaleArg = args.find(a => a.startsWith('--locale='));
  const onlyLocale = onlyLocaleArg ? onlyLocaleArg.slice('--locale='.length) : null;
  const strict = args.includes('--strict');
  const quiet = args.includes('--quiet');

  const locales = onlyLocale ? [onlyLocale] : LOCALES;
  const reports = [];

  for (const locale of locales) {
    const poPath = path.join(LANGUAGES_DIR, `${SLUG}-${locale}.po`);
    if (!fs.existsSync(poPath)) continue;
    reports.push(auditFile(poPath));
  }

  if (reports.length === 0) {
    console.error(onlyLocale ? `No .po file for ${onlyLocale}.` : 'No .po files found in languages/.');
    process.exit(1);
  }

  for (const r of reports) printReport(r, { quiet });

  // Summary
  const totalCritical = reports.reduce((a, r) => a + r.findings.filter(f => f.critical.length > 0).length, 0);
  const totalMissing  = reports.reduce((a, r) => a + r.findings.filter(f => f.missing.length > 0 && f.critical.length === 0).length, 0);
  const cleanFiles    = reports.filter(r => r.findings.every(f => f.critical.length === 0 && f.missing.length === 0)).length;

  console.log('');
  console.log(`Audited ${reports.length} file(s): ${cleanFiles} clean, ${totalCritical} critical finding(s), ${totalMissing} missing-positional finding(s).`);

  if (totalCritical > 0) {
    console.error('');
    console.error('✗ CRITICAL findings present — these would fatal sprintf at runtime. Fix before ship.');
    process.exit(1);
  }
  if (strict && totalMissing > 0) {
    console.error('');
    console.error('⚠ --strict: MISSING findings present.');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { auditFile, checkEntry, extractPlaceholders };
