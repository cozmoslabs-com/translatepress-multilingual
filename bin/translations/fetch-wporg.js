/**
 * Fetches community translations for translatepress-multilingual from translate.wordpress.org.
 *
 * Returns a Map<msgid, msgstr> of community-translated strings for the given locale.
 * Empty msgstr entries and fuzzy entries are dropped — we only care about actually-translated strings.
 *
 * If WP.org has no translation set for the locale, returns an empty Map.
 *
 * Plural strings: we key the Map by msgid (singular). The msgstr value is the joined plural form
 * if present, but in practice gettext-parser exposes plurals separately and the AI / merge step
 * handles them via the raw translation object — see build-incremental.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gettextParser = require('gettext-parser');

const SLUG = 'translatepress-multilingual';
const API_URL = `https://api.wordpress.org/translations/plugins/1.0/?slug=${SLUG}`;

// Plugin-local tmp dir (gitignored) so build artifacts are visible if cleanup ever fails.
const PLUGIN_TMP_DIR = path.resolve(__dirname, '..', '..', 'tmp');

async function fetchWpOrgTranslations(locale) {
  const apiResp = await fetch(API_URL);
  if (!apiResp.ok) {
    throw new Error(`WP.org translations API returned ${apiResp.status}`);
  }
  const data = await apiResp.json();
  const entry = (data.translations || []).find(t => t.language === locale);
  if (!entry || !entry.package) {
    return { entries: {}, headers: {} };
  }

  fs.mkdirSync(PLUGIN_TMP_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(PLUGIN_TMP_DIR, `wporg-${locale}-`));
  try {
    const zipPath = path.join(tmpDir, 'pack.zip');
    const zipResp = await fetch(entry.package);
    if (!zipResp.ok) {
      throw new Error(`Translation pack download for ${locale} returned ${zipResp.status}`);
    }
    const buf = Buffer.from(await zipResp.arrayBuffer());
    fs.writeFileSync(zipPath, buf);

    execFileSync('unzip', ['-o', '-q', zipPath, '-d', tmpDir]);

    const poPath = path.join(tmpDir, `${SLUG}-${locale}.po`);
    if (!fs.existsSync(poPath)) {
      const found = fs.readdirSync(tmpDir).find(f => f.endsWith('.po'));
      if (!found) return { entries: {}, headers: {} };
      return parsePoFile(path.join(tmpDir, found));
    }
    return parsePoFile(poPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parsePoFile(poPath) {
  const raw = fs.readFileSync(poPath);
  const parsed = gettextParser.po.parse(raw);

  const entries = {};
  for (const ctx of Object.keys(parsed.translations)) {
    for (const msgid of Object.keys(parsed.translations[ctx])) {
      if (msgid === '') continue;
      const t = parsed.translations[ctx][msgid];
      const isFuzzy = (t.comments && t.comments.flag && t.comments.flag.includes('fuzzy'));
      if (isFuzzy) continue;
      const hasTranslation = t.msgstr && t.msgstr.some(s => s && s.length > 0);
      if (!hasTranslation) continue;
      entries[ctx === '' ? msgid : `${ctx}${msgid}`] = {
        msgctxt: ctx === '' ? undefined : ctx,
        msgid,
        msgid_plural: t.msgid_plural,
        msgstr: t.msgstr.slice(),
      };
    }
  }
  return { entries, headers: parsed.headers || {} };
}

module.exports = { fetchWpOrgTranslations };
