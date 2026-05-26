/**
 * Calls OpenRouter to translate WordPress plugin UI strings the WP.org community hasn't covered.
 *
 * Adopts the Potomatic (https://github.com/GravityKit/potomatic) approach:
 *   - XML-shaped payload (more robust than JSON for strings with quotes / newlines / escapes).
 *   - Explicit `placeholders="%s,%d"` attribute on each source so the model can self-check.
 *   - Glossary support: terms in bin/translations/glossary.json (plus optional per-locale
 *     glossary-{locale}.json override) get injected as a few-shot worked example turn so the
 *     model echoes brand names verbatim instead of translating them.
 *
 * Safety: every returned translation is validated against its source's printf placeholders.
 * If the multiset of placeholders in the translation isn't a subset of the source's, the item
 * is re-sent to the model. We retry up to MAX_RETRIES times after the initial attempt; items
 * still failing after that are dropped from the result (the caller leaves msgstr empty so
 * gettext falls back to the English source — safer than a malformed sprintf format string).
 *
 * Plurals: items with msgid_plural are sent inside <singular>/<plural> tags. The model returns
 * one <f0>/<f1>/.../<fN> form per locale's nplurals (from plural-forms.json). Each form is
 * validated independently against the union of source placeholders (msgid + msgid_plural).
 *
 * Public API: `aiFill(locale, items)` where items = [{ id, source, msgid_plural?, msgctxt?, comments? }, ...].
 * Returns { translations: Map<id, string | string[]>, stats }. A string value means singular;
 * an array means plural forms in f0..fN order.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOCALE_NAMES } = require('./locales');

/**
 * Content hash for a single glossary/context entry. Used to detect "this entry has
 * changed since we last applied it" — see build-incremental.js's update flow. SHA1 of
 * `${key}=${value}` truncated to 8 hex chars: ~4 billion distinct entries before
 * realistic collision risk, which is overkill for our ~50-entry config and short
 * enough to embed in PO custom flags without bloating the file.
 *
 * Critically, the hash is content-addressed: editing a hint changes the hash, which is
 * what triggers re-translation of affected msgids. There is no version number to
 * maintain — just write/edit/delete entries and the pipeline figures out what to do.
 */
function hashEntry(key, value) {
  return crypto.createHash('sha1').update(`${key}=${value}`).digest('hex').slice(0, 8);
}

//const MODEL = 'anthropic/claude-sonnet-4';
const MODEL = 'moonshotai/kimi-k2.6';
const BATCH_SIZE = 20;
const MAX_RETRIES = 3; // attempts after the initial call before we give up on an item
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `You are a professional translator specializing in WordPress plugin user-interface localization. You translate strings from English to {{TARGET_LANGUAGE}} ({{TARGET_LANGUAGE_CODE}}) for use in admin screens, settings pages, tooltips and notices.

### Source-element attributes

Each <source> element may carry these attributes — read them before translating:

- **i="N"** — the index; your <t> response must use the same N.
- **placeholders="..."** — a comma list of every placeholder that must appear in your translation (e.g. \`%s,%1$s,[strong],[/strong]\`). Use it as a checklist.
- **ctx="..."** — the gettext msgctxt for the string. It disambiguates an ambiguous source: e.g. \`ctx="page 1 of 3"\` on the source "of" tells you it's a pagination separator (use a numeric separator like "／" or "/", not the preposition); \`ctx="Untranslated in this language"\` on "in" tells you it's a locative, not a verb. Always let ctx pick the correct meaning when the source word/phrase is ambiguous.
- **c="..."** — the \`#. translators:\` developer comment. It usually explains what each placeholder represents or the surrounding UI context. Use it to choose register and to confirm placeholder ordering — e.g. \`c="1: upgrade action text, 2: account URL"\` tells you %1$s is a verb phrase and %2$s is a URL, which guides how to reorder them naturally in the target sentence.
- **hint="..."** — TranslatePress-specific disambiguation for ambiguous keywords found in the source (e.g. "string" = piece of translatable text, not rope; "post" = WordPress article, not mail). Multiple hints separated by " | ". When present, follow the conceptual sense it specifies and render the term in the target language using that sense — even if a more literal cognate exists.

### Hard rules

1. **Preserve placeholders EXACTLY**: %s, %d, %1$s, %2$d. The translation must contain the same set and count of placeholders as the source — no more, no fewer. Use only the ASCII percent sign (%), never the fullwidth ％ (U+FF05). Each <source> element carries a placeholders="..." attribute listing what must appear; verify your output against it. Inventing placeholders that aren't in the source (e.g. emitting %2$s when source has only %1$s) causes a fatal error in WordPress.
2. **Preserve bracket placeholders**: [example], [product], {value}. Keep them as-is. Do NOT convert to %s.
3. **Preserve bracket tags**: [strong], [/strong], [link], [/link]. Keep them as-is. Do NOT convert to HTML.
4. **Preserve HTML tags verbatim**: <a href="...">, <strong>, <br/>. Translate only the visible text inside, never the tag names or attribute values.
5. **Preserve escape sequences**: \\n, \\t, \\". Do not "render" them.
6. **Preserve trailing/leading whitespace** from the source string verbatim.
7. **Glossary**: Earlier turns may include glossary worked examples — apply the SAME target rendering to those terms wherever they appear in the batch. Treat them as proper nouns and keep them untranslated unless the glossary specifies otherwise.
8. **Tone**: concise, neutral admin-UI register. Button labels stay button-like; sentence-case stays sentence-case; trailing colons stay trailing colons.
9. **Plural forms**: Singular items use <t i="N">translation</t>. Plural items (source has <singular> and <plural> tags) use <t i="N"><f0>...</f0><f1>...</f1>...</t> with exactly the number of forms the user message specifies for this locale. Each form's placeholders must be a subset of those in the source singular OR plural — never invent a new one.
10. **No commentary, no markdown fences, no JSON**: respond only with <t i="N">...</t> elements, one per input <source> element, in input order. The "i" must match the source's "i".`;

// -- glossary --------------------------------------------------------------

function loadGlossaryForLocale(locale) {
  const defaultPath = path.join(__dirname, 'glossary.json');
  const localePath = path.join(__dirname, `glossary-${locale}.json`);
  const merged = {};
  for (const p of [defaultPath, localePath]) {
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      if (typeof k === 'string' && typeof v === 'string' && k && v) {
        merged[k.toLowerCase()] = { source: k, target: v, hash: hashEntry(k, v) };
      }
    }
  }
  return merged;
}

/**
 * Batch-level glossary matcher used to build the few-shot prompt turn. Returns each
 * glossary entry whose key appears anywhere in the batch (msgid or msgid_plural).
 * Order-preserving so the prompt's worked-example list is deterministic.
 */
function findGlossaryMatches(items, glossary) {
  const matches = [];
  const seen = new Set();
  const haystack = items.map(i => `${i.source || ''}\n${i.msgid_plural || ''}`).join('\n').toLowerCase();
  for (const [normalizedKey, entry] of Object.entries(glossary)) {
    const escaped = normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(haystack) && !seen.has(normalizedKey)) {
      seen.add(normalizedKey);
      matches.push(entry);
    }
  }
  return matches;
}

/**
 * Per-item glossary matcher. Unlike findGlossaryMatches (batch-level, used to populate
 * the few-shot turn), this returns the glossary entries actually present in THIS msgid
 * — used by build-incremental.js's update flow to stamp the correct `tp-glo-HASH` flags
 * onto each individual msgstr.
 */
function findGlossaryMatchesForItem(item, glossary) {
  if (!glossary || Object.keys(glossary).length === 0) return [];
  const haystack = `${item.source || ''}\n${item.msgid_plural || ''}`.toLowerCase();
  const matches = [];
  for (const [normalizedKey, entry] of Object.entries(glossary)) {
    const escaped = normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(haystack)) matches.push(entry);
  }
  return matches;
}

// -- context (per-keyword conceptual hints) --------------------------------

/**
 * Load context hints for the locale. Same merging rule as glossary: default `context.json`
 * + optional per-locale `context-{locale}.json` override. Keys are case-insensitive,
 * word-boundary matched against each individual source (and msgid_plural). Each hint
 * becomes a `hint="..."` attribute on the matching <source> element so the model can
 * disambiguate the keyword's sense before translating. Locale-agnostic by design: hints
 * describe the CONCEPT (what the word means inside TranslatePress's UI), not the target
 * rendering — the model uses its own language knowledge to pick the right target word.
 *
 * Unlike glossary entries (target = string), context entries are { hint: string }, but for
 * source-file ergonomics we accept a plain `key → hint` JSON map.
 */
function loadContextForLocale(locale) {
  const defaultPath = path.join(__dirname, 'context.json');
  const localePath = path.join(__dirname, `context-${locale}.json`);
  const merged = {};
  for (const p of [defaultPath, localePath]) {
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      if (typeof k === 'string' && typeof v === 'string' && k && v) {
        merged[k.toLowerCase()] = { source: k, hint: v, hash: hashEntry(k, v) };
      }
    }
  }
  return merged;
}

/**
 * Per-item context matcher. Returns the full context entries (with key, hint, hash)
 * whose key appears in this msgid. Used by the update flow to stamp `tp-ctx-HASH`
 * flags and by the prompt builder (via findContextHintsForItem) for the `hint=`
 * attribute.
 */
function findContextMatchesForItem(item, contextMap) {
  if (!contextMap || Object.keys(contextMap).length === 0) return [];
  const haystack = `${item.source || ''}\n${item.msgid_plural || ''}`.toLowerCase();
  const matches = [];
  for (const [normalizedKey, entry] of Object.entries(contextMap)) {
    const escaped = normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(haystack)) matches.push(entry);
  }
  return matches;
}

/**
 * Returns the array of unique context hint strings that apply to a single item.
 * Dedupes by hint TEXT (not by entry key) because singular/plural keys may legitimately
 * share the same hint and the prompt's `hint=` attribute shouldn't repeat it.
 */
function findContextHintsForItem(item, contextMap) {
  const seen = new Set();
  const hints = [];
  for (const m of findContextMatchesForItem(item, contextMap)) {
    if (!seen.has(m.hint)) {
      seen.add(m.hint);
      hints.push(m.hint);
    }
  }
  return hints;
}

// -- plural forms ----------------------------------------------------------

let _pluralFormsCache = null;
function loadPluralForms() {
  if (_pluralFormsCache) return _pluralFormsCache;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'plural-forms.json'), 'utf8'));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  _pluralFormsCache = out;
  return out;
}

function getPluralForLocale(locale) {
  const all = loadPluralForms();
  return all[locale] || { nplurals: 2, expr: '(n != 1)', rule: 'f0=singular(1), f1=plural(0,2+).' };
}

// -- placeholders ----------------------------------------------------------

// Full PHP printf-spec regex: optional positional (%N$), optional flags (+ - space 0 ' #),
// optional width (digits), optional precision (.digits), then a conversion char from the
// complete PHP set (b c d e E f F g G i o s u x X) or `%` for the escaped literal.
// Examples it matches: %s, %d, %1$s, %.2f, %05d, %-10s, %+d, %2$x, %%.
// Reference: https://www.php.net/manual/en/function.sprintf.php
const PRINTF_RE = /%(?:\d+\$)?[+\- 0'#]*\d*(?:\.\d+)?[bcdeEfFgGiosuxX%]/g;

// Broader regex used only for the *display* `placeholders="..."` attribute (helps the model).
// Includes bracket [tag] and curly {value} placeholders — those don't fatal but the model still
// needs the hint to preserve them.
const DISPLAY_PLACEHOLDER_RE = /%(?:\d+\$)?[+\- 0'#]*\d*(?:\.\d+)?[bcdeEfFgGiosuxX%]|\[[A-Za-z0-9_\/-]+\]|\{[A-Za-z0-9_-]+\}/g;

/**
 * Normalize a printf spec to its placeholder *identity* for multiset comparison.
 * Strips width/precision/flags so `%5d` and `%d` compare equal, and `%.2f` and `%f` compare
 * equal. Preserves the positional prefix (`%1$s` stays `%1$s`) since that affects arg
 * referencing, and preserves the conversion char since it affects arg type.
 */
function normalizePlaceholder(ph) {
  const m = String(ph).match(/^%(\d+\$)?[+\- 0'#]*\d*(?:\.\d+)?([bcdeEfFgGiosuxX%])$/);
  if (!m) return ph;
  return '%' + (m[1] || '') + m[2];
}

function extractPrintfPlaceholders(text) {
  const matches = String(text || '').match(PRINTF_RE) || [];
  return matches.map(normalizePlaceholder);
}

/**
 * Detect a translation that contains a bare `%` not part of any valid printf spec.
 * Example: source `"50%% off"` (escaped literal), translation `"50% off"` (forgot to escape).
 * PHP 8 throws ValueError on `sprintf("50% off")` because `% ` isn't a valid spec.
 */
function hasUnpairedPercent(text) {
  const stripped = String(text || '').replace(PRINTF_RE, '');
  return stripped.includes('%');
}

/**
 * Stricter regex that only matches *unambiguous* WP printf specs — `%s`, `%d`, `%i`, `%f`,
 * `%%`, and their positional variants `%N$s` / `%N$d` / etc. No flag chars (space, +, -, 0),
 * no width/precision. This is what we use to decide whether the source is "definitely
 * clean" — strings with patterns like `% s` (space-flag) or `95%` (literal %) flunk this
 * regex's strip and trigger source-relative mode.
 */
const STRICT_PRINTF_RE = /%(?:\d+\$)?[sdif%]/g;

function sourceHasAmbiguousPercent(text) {
  return String(text || '').replace(STRICT_PRINTF_RE, '').includes('%');
}

/** Count raw `%` characters in `text`. Used for the source-relative safety check. */
function countPercents(text) {
  return (String(text || '').match(/%/g) || []).length;
}

function extractDisplayPlaceholders(text) {
  const found = text.match(DISPLAY_PLACEHOLDER_RE);
  if (!found || found.length === 0) return null;
  return Array.from(new Set(found)).join(',');
}

// Legacy alias kept for the smoke-test exports.
function extractPlaceholders(text) {
  return extractDisplayPlaceholders(text);
}

function multiset(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

/**
 * Is the printf-placeholder multiset of `target` a subset of `source`'s multiset?
 * (Same placeholder may appear ≤ as many times in target; nothing new allowed.)
 * Also rejects fullwidth `％` and bare `%` not part of any valid spec.
 */
function validatePrintfSubset(sourcePlaceholders, target) {
  const src = multiset(sourcePlaceholders);
  const tgt = multiset(extractPrintfPlaceholders(target));
  for (const [k, n] of tgt) {
    if ((src.get(k) || 0) < n) return false;
  }
  if (target.includes('％')) return false;
  if (hasUnpairedPercent(target)) return false;
  return true;
}

function isPositional(ph) {
  return /^%\d+\$/.test(ph);
}

/**
 * Quality gate for community / pre-existing translations being merged into the .po:
 * does the translation (across all of its forms) include every positional placeholder that
 * appears anywhere in the source (msgid + msgid_plural)?
 *
 * Used by build-incremental.js's merge step to reject community translations like ru_RU's
 * "Choose which engine you want to use in order to %1$s automatically translate your website."
 * where the translator dropped %1$s — at runtime this would show the sentence with a missing
 * link/variable. Returns true if safe to merge as-is; false if it should be queued for AI.
 *
 * The rule deliberately checks the UNION of forms (not per-form), so plurals where one form
 * legitimately omits a placeholder another form has (e.g. Slavic singular vs paucal vs plural)
 * are not rejected for that reason alone.
 *
 * @param entry  - { msgid, msgid_plural? }
 * @param msgstr - string[] of translation forms (length 1 for singulars)
 */
function hasAllSourcePositionals(entry, msgstr) {
  const sourcePositionals = new Set([
    ...extractPrintfPlaceholders(entry.msgid).filter(isPositional),
    ...(entry.msgid_plural ? extractPrintfPlaceholders(entry.msgid_plural).filter(isPositional) : []),
  ]);
  if (sourcePositionals.size === 0) return true;

  const translatedPositionals = new Set();
  for (const form of (msgstr || [])) {
    if (!form) continue;
    for (const p of extractPrintfPlaceholders(form).filter(isPositional)) {
      translatedPositionals.add(p);
    }
  }
  for (const p of sourcePositionals) {
    if (!translatedPositionals.has(p)) return false;
  }
  return true;
}

/**
 * Unified placeholder validator covering both safety and quality.
 *
 * Safety (prevents sprintf-fatal at runtime in PHP):
 *   - Each translation form's printf-placeholder multiset must be a subset of the source's
 *     max-per-placeholder multiset (where source max is over msgid + msgid_plural). No
 *     translation form may contain a placeholder the source doesn't, or contain it more times.
 *   - Fullwidth `％` (U+FF05) is rejected anywhere — looks like a placeholder but sprintf
 *     doesn't recognise it.
 *
 * Quality (prevents visible "variable missing from sentence" bugs):
 *   - Every positional placeholder appearing in msgid or msgid_plural must appear in at least
 *     one translation form. (Union check across forms — Slavic-style omissions where the
 *     singular legitimately doesn't use a placeholder another form has are still allowed.)
 *
 * @param source - { msgid, msgid_plural? }
 * @param target - string[] of translation forms (length 1 for singulars)
 * @returns { ok: boolean, reason?: string, kind?: 'safety'|'quality' }
 */
function validatePlaceholders(source, target) {
  if (!Array.isArray(target)) {
    return { ok: false, reason: 'expected translation forms array', kind: 'safety' };
  }
  const idPh = extractPrintfPlaceholders(source.msgid);
  const plPh = source.msgid_plural ? extractPrintfPlaceholders(source.msgid_plural) : [];

  // If the SOURCE itself contains any `%` that isn't an unambiguous WP printf spec
  // (`%s`, `%d`, `%i`, `%f`, `%%`, or positional variants), we switch to source-relative
  // mode. Examples: TranslatePress's `%s%` JS-substitution pattern, literal `95%` in prose,
  // anything with space-flag conversions like `% d`. PHP would fatal on these if ever
  // sprintf'd — but since the codebase uses these strings via JS .replace() or plain echo
  // (never sprintf), neither English nor a faithful translation actually fatals at runtime.
  // In relaxed mode we only require the translation not introduce *additional* `%` chars
  // beyond what the source has — that's the only way it could make things worse.
  const sourceAmbiguous = sourceHasAmbiguousPercent(source.msgid) ||
                          (source.msgid_plural && sourceHasAmbiguousPercent(source.msgid_plural));
  if (sourceAmbiguous) {
    const sourceMaxPct = Math.max(
      countPercents(source.msgid),
      source.msgid_plural ? countPercents(source.msgid_plural) : 0,
    );
    for (let i = 0; i < target.length; i++) {
      const form = target[i] || '';
      if (!form) continue;
      if (form.includes('％')) {
        return { ok: false, reason: `form ${i} contains fullwidth percent`, kind: 'safety' };
      }
      if (countPercents(form) > sourceMaxPct) {
        return {
          ok: false,
          reason: `form ${i} has ${countPercents(form)} % chars (source max ${sourceMaxPct}) — would introduce new fatal risk`,
          kind: 'safety',
        };
      }
    }
    return { ok: true };
  }

  // Source max per placeholder = max(msgid count, msgid_plural count).
  const sMs = multiset(idPh);
  const pMs = multiset(plPh);
  const maxMs = new Map();
  for (const [k, n] of sMs) maxMs.set(k, Math.max(n, pMs.get(k) || 0));
  for (const [k, n] of pMs) if (!maxMs.has(k)) maxMs.set(k, n);

  // Safety: per-form subset rule + bare-% detection + fullwidth %.
  for (let i = 0; i < target.length; i++) {
    const form = target[i] || '';
    if (form.includes('％')) {
      return { ok: false, reason: `form ${i} contains fullwidth percent`, kind: 'safety' };
    }
    if (hasUnpairedPercent(form)) {
      return { ok: false, reason: `form ${i} has a bare % not part of a valid printf spec`, kind: 'safety' };
    }
    const tMs = multiset(extractPrintfPlaceholders(form));
    for (const [k, n] of tMs) {
      if ((maxMs.get(k) || 0) < n) {
        return { ok: false, reason: `form ${i} has too many ${k} (source max ${maxMs.get(k) || 0})`, kind: 'safety' };
      }
    }
  }

  // Quality: source positionals must each appear in some translation form.
  const sourcePositionals = new Set([...idPh, ...plPh].filter(isPositional));
  if (sourcePositionals.size > 0) {
    const targetPositionalUnion = new Set();
    for (const form of target) {
      if (!form) continue;
      for (const p of extractPrintfPlaceholders(form).filter(isPositional)) {
        targetPositionalUnion.add(p);
      }
    }
    for (const p of sourcePositionals) {
      if (!targetPositionalUnion.has(p)) {
        return { ok: false, reason: `positional ${p} missing from translation`, kind: 'quality' };
      }
    }
  }
  return { ok: true };
}

/**
 * Validate an AI translation result against an item. Thin wrapper around validatePlaceholders
 * that handles the singular-string vs plural-array shape difference and produces a uniform
 * { ok, reason } shape for the retry loop.
 */
function validateTranslation(item, translation) {
  const target = item.msgid_plural
    ? translation
    : (typeof translation === 'string' ? [translation] : null);
  if (!Array.isArray(target)) {
    return { ok: false, reason: item.msgid_plural ? 'expected plural forms array' : 'missing translation' };
  }
  return validatePlaceholders({ msgid: item.source, msgid_plural: item.msgid_plural }, target);
}

// -- XML escape ------------------------------------------------------------

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Attribute-value variant: also escapes the double quote so a hint/comment containing
// `"` doesn't terminate the attribute early. xmlUnescape handles &quot; symmetrically
// just in case it ever round-trips through the model.
function xmlEscapeAttr(s) {
  return xmlEscape(s).replace(/"/g, '&quot;');
}

function xmlUnescape(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// -- prompt assembly -------------------------------------------------------

function buildSourceXml(item, idx, contextMap) {
  const ph = extractDisplayPlaceholders(item.source) || extractDisplayPlaceholders(item.msgid_plural || '');
  const attrs = [`i="${idx}"`];
  attrs.push(ph ? `placeholders="${xmlEscapeAttr(ph)}"` : 'placeholders="none"');
  if (item.msgctxt) attrs.push(`ctx="${xmlEscapeAttr(item.msgctxt)}"`);
  if (item.comments) attrs.push(`c="${xmlEscapeAttr(item.comments)}"`);
  const hints = findContextHintsForItem(item, contextMap);
  if (hints.length > 0) attrs.push(`hint="${xmlEscapeAttr(hints.join(' | '))}"`);
  if (item.msgid_plural) {
    return `<source ${attrs.join(' ')}>\n  <singular>${xmlEscape(item.source)}</singular>\n  <plural>${xmlEscape(item.msgid_plural)}</plural>\n</source>`;
  }
  return `<source ${attrs.join(' ')}>${xmlEscape(item.source)}</source>`;
}

function buildUserMessage(items, startIndex = 1, contextMap) {
  return items.map((it, i) => buildSourceXml(it, startIndex + i, contextMap)).join('\n');
}

function buildGlossaryUserMessage(matches) {
  return matches.map((m, i) => {
    const ph = extractDisplayPlaceholders(m.source);
    const phAttr = ph ? `placeholders="${xmlEscapeAttr(ph)}"` : 'placeholders="none"';
    return `<source i="${i + 1}" ${phAttr}>${xmlEscape(m.source)}</source>`;
  }).join('\n');
}

function buildGlossaryAssistantMessage(matches) {
  return matches.map((m, i) => `<t i="${i + 1}">${xmlEscape(m.target)}</t>`).join('\n');
}

/**
 * Parse the model's response into Map<i, string | string[]>.
 * Singular: returns string. Plural: returns array of forms in f0..fN order.
 */
function parseResponse(text) {
  const out = new Map();
  const re = /<t\s+i="(\d+)"\s*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const i = m[1];
    const body = m[2];
    const formRe = /<f(\d+)\s*>([\s\S]*?)<\/f\1>/g;
    const forms = [];
    let fm;
    while ((fm = formRe.exec(body)) !== null) {
      const fIdx = parseInt(fm[1], 10);
      forms[fIdx] = xmlUnescape(fm[2]);
    }
    if (forms.length > 0) {
      // Plural response. Fill any holes with empty string so the array index is preserved.
      for (let k = 0; k < forms.length; k++) if (typeof forms[k] !== 'string') forms[k] = '';
      out.set(i, forms);
    } else {
      out.set(i, xmlUnescape(body));
    }
  }
  return out;
}

// -- env -------------------------------------------------------------------

function loadEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing .env at ${envPath}. Add OPENROUTER_API_KEY=...`);
  }
  const text = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[m[1]] = val;
  }
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing from .env');
  }
  return env;
}

// -- request ---------------------------------------------------------------

async function translateBatch(apiKey, locale, batch, glossaryMatches, contextMap, { retryHint = null } = {}) {
  const languageName = LOCALE_NAMES[locale] || locale;
  const pluralInfo = getPluralForLocale(locale);
  const system = SYSTEM_PROMPT
    .replace(/\{\{TARGET_LANGUAGE\}\}/g, languageName)
    .replace(/\{\{TARGET_LANGUAGE_CODE\}\}/g, locale);

  const messages = [{ role: 'system', content: system }];

  // Few-shot glossary turn (if any matches).
  if (glossaryMatches.length > 0) {
    messages.push({
      role: 'user',
      content: `Translate to ${languageName}. Keep these glossary terms exactly as instructed:\n\n${buildGlossaryUserMessage(glossaryMatches)}`,
    });
    messages.push({
      role: 'assistant',
      content: buildGlossaryAssistantMessage(glossaryMatches),
    });
  }

  // Build batch with plural rule preamble if any plural items present.
  const batchStart = glossaryMatches.length + 1;
  const hasPlurals = batch.some(it => !!it.msgid_plural);
  let preamble = `Translate to ${languageName}:`;
  if (hasPlurals) {
    preamble += `\n\nPlural-form rule for ${languageName} (${locale}): nplurals=${pluralInfo.nplurals}. ${pluralInfo.rule}`;
    preamble += `\nFor entries with <singular>/<plural> tags, respond with exactly ${pluralInfo.nplurals} form(s): <t i="N"><f0>...</f0>${pluralInfo.nplurals > 1 ? '<f1>...</f1>' : ''}${pluralInfo.nplurals > 2 ? '...' : ''}</t>.`;
  }
  if (retryHint) {
    preamble += `\n\n⚠ Previous attempt failed placeholder validation (${retryHint}). Re-translate the items below; copy each placeholder verbatim from source and add no new ones.`;
  }

  messages.push({
    role: 'user',
    content: `${preamble}\n\n${buildUserMessage(batch, batchStart, contextMap)}\n\nRespond with one <t i="N">...</t> per source, matching the "i" values above.`,
  });

  const body = {
    model: MODEL,
    messages,
    temperature: 0.2,
    // Route to the highest-throughput provider currently serving this model.
    // See https://openrouter.ai/docs/provider-routing
    provider: { sort: 'throughput' },
    // Ask OpenRouter to include token counts AND USD cost in the response.
    // See https://openrouter.ai/docs/use-cases/usage-accounting
    usage: { include: true },
  };

  // Fail fast if a provider hangs instead of waiting indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://translatepress.com',
        'X-Title': 'TranslatePress Build',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json = await resp.json();
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('OpenRouter returned no message content');

  const parsed = parseResponse(content);

  // Map XML indices back to input ids. Inputs start at batchStart.
  const result = new Map();
  batch.forEach((item, i) => {
    const xmlIndex = String(batchStart + i);
    const translation = parsed.get(xmlIndex);
    if (typeof translation !== 'undefined') {
      result.set(item.id, translation);
    }
  });

  const usage = json.usage || {};
  return {
    translations: result,
    usage: {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      costUsd: typeof usage.cost === 'number' ? usage.cost : null,
    },
  };
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

/**
 * Translate one batch with placeholder validation and bounded retries.
 *
 * Returns { results, dropped, usageSum, retryRounds, aborted, abortReason }.
 *
 * If a network/HTTP error from OpenRouter occurs, the function returns with `aborted` set to
 * the error message; whatever translations were validated in earlier attempts of this batch
 * are preserved in `results`. The caller is responsible for stopping further AI calls.
 */
async function translateBatchWithRetries(apiKey, locale, batch, glossaryMatches, contextMap) {
  const results = new Map();
  let pending = batch.slice();
  let retryRounds = 0;
  let lastFailures = [];
  const usageSum = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, costKnown: false };
  let aborted = false;
  let abortReason = null;

  for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
    const hint = attempt === 0
      ? null
      : `${lastFailures.length} item(s) had invalid placeholders: ${lastFailures.slice(0, 3).map(f => f.reason).join('; ')}`;

    let translations, usage;
    try {
      ({ translations, usage } = await translateBatch(apiKey, locale, pending, glossaryMatches, contextMap, { retryHint: hint }));
    } catch (e) {
      aborted = true;
      abortReason = e.message;
      break;
    }

    usageSum.promptTokens     += usage.promptTokens;
    usageSum.completionTokens += usage.completionTokens;
    usageSum.totalTokens      += usage.totalTokens;
    if (typeof usage.costUsd === 'number') {
      usageSum.costUsd += usage.costUsd;
      usageSum.costKnown = true;
    }

    const stillPending = [];
    lastFailures = [];
    for (const item of pending) {
      const t = translations.get(item.id);
      if (typeof t === 'undefined') {
        stillPending.push(item);
        lastFailures.push({ id: item.id, reason: 'no <t> response' });
        continue;
      }
      const validation = validateTranslation(item, t);
      if (validation.ok) {
        results.set(item.id, t);
      } else {
        stillPending.push(item);
        lastFailures.push({ id: item.id, reason: validation.reason });
      }
    }
    pending = stillPending;
    if (attempt > 0) retryRounds++;
    if (pending.length === 0) break;
  }

  return { results, dropped: pending.length, usageSum, retryRounds, aborted, abortReason };
}

/**
 * @param locale - WP locale code (e.g. "ja", "pt_BR")
 * @param items  - [{ id, source, msgid_plural?, msgctxt?, comments? }, ...]
 * @returns { translations: Map<id, string | string[]>, stats }
 */
async function aiFill(locale, items) {
  const stats = {
    batches: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    costUsd: 0, costKnown: false, elapsedMs: 0,
    retryRounds: 0, dropped: 0,
    aborted: false, abortReason: null,
  };
  if (items.length === 0) return { translations: new Map(), stats };

  const env = loadEnv();
  const glossary = loadGlossaryForLocale(locale);
  const contextMap = loadContextForLocale(locale);
  const result = new Map();
  const localeStart = Date.now();

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const glossaryMatches = findGlossaryMatches(batch, glossary);
    const contextHitCount = batch.reduce(
      (n, it) => n + (findContextHintsForItem(it, contextMap).length > 0 ? 1 : 0),
      0,
    );
    const batchNum = i / BATCH_SIZE + 1;
    const total = Math.ceil(items.length / BATCH_SIZE);
    process.stdout.write(`  [${locale}] AI batch ${batchNum}/${total} (${batch.length} strings, ${glossaryMatches.length} glossary hits, ${contextHitCount} context hits)...`);

    const batchStart = Date.now();
    const { results, dropped, usageSum, retryRounds, aborted, abortReason } =
      await translateBatchWithRetries(env.OPENROUTER_API_KEY, locale, batch, glossaryMatches, contextMap);
    const batchMs = Date.now() - batchStart;

    for (const [id, t] of results.entries()) result.set(id, t);

    stats.batches++;
    stats.promptTokens     += usageSum.promptTokens;
    stats.completionTokens += usageSum.completionTokens;
    stats.totalTokens      += usageSum.totalTokens;
    if (usageSum.costKnown) {
      stats.costUsd += usageSum.costUsd;
      stats.costKnown = true;
    }
    stats.retryRounds += retryRounds;
    stats.dropped     += dropped;

    const costFrag = stats.costKnown ? ` $${usageSum.costUsd.toFixed(4)}` : '';
    const retryFrag = retryRounds > 0 ? `, ${retryRounds} retry round${retryRounds === 1 ? '' : 's'}` : '';
    const dropFrag  = dropped > 0 ? `, ${dropped} dropped` : '';

    if (aborted) {
      stats.aborted = true;
      stats.abortReason = abortReason;
      // Items that hadn't been sent yet for this batch count as un-translated; the items in
      // SUBSEQUENT batches haven't been sent either — count them too so the caller knows the
      // damage.
      const untouchedThisBatch = batch.length - results.size;
      const remainingBatches = items.slice(i + BATCH_SIZE).length;
      stats.dropped += remainingBatches; // items in batches we never started
      process.stdout.write(` ABORTED after ${formatDuration(batchMs)} (${usageSum.totalTokens} tok${costFrag}${retryFrag}, ${untouchedThisBatch + remainingBatches} item(s) left untranslated): ${abortReason}\n`);
      break;
    }

    process.stdout.write(` done in ${formatDuration(batchMs)} (${usageSum.totalTokens} tok${costFrag}${retryFrag}${dropFrag})\n`);
  }

  stats.elapsedMs = Date.now() - localeStart;
  return { translations: result, stats };
}

module.exports = {
  aiFill,
  formatDuration,
  getPluralForLocale,
  hasAllSourcePositionals,
  validatePlaceholders,
  hashEntry,
  loadContextForLocale,
  loadGlossaryForLocale,
  findGlossaryMatches,
  findGlossaryMatchesForItem,
  findContextMatchesForItem,
  findContextHintsForItem,
  // exported for tests / smoke verification
  extractPlaceholders,
  extractPrintfPlaceholders,
  validateTranslation,
  validatePrintfSubset,
  buildUserMessage,
  parseResponse,
};
