# bin/translations

Build pipeline that produces the bundled `.po` / `.mo` / `.l10n.php` / `.json` files in `languages/` for every locale in `locales.json`.

For each locale it: (1) pulls community translations from translate.wordpress.org, (2) **gates every community translation through the unified placeholder check** — translations that invent placeholders the source doesn't have *or* drop a positional placeholder are rejected and routed to AI instead, (3) AI-fills the gaps via OpenRouter, (4) **applies the same unified check to every AI translation** — failures trigger up to 3 retries before being dropped (msgstr left empty), (5) compiles artifacts with `ddev wp i18n make-*`, (6) **auto-runs the audit** to confirm no bad msgstr slipped through; the build exits non-zero if the audit finds anything. Per-string rule: community always wins **when it passes the placeholder gate**; AI fills gaps + rejected community entries.

At runtime, `class-translate-press.php` registers `load_textdomain_mofile` / `load_translation_file` / `load_script_translation_file` filters that force WordPress to load the bundled files instead of whatever WP.org's Language Pack installer drops into `wp-content/languages/plugins/`.

### Opting out of the runtime override

Users (or other plugins) can disable the override without touching code:

- **Admin UI**: TranslatePress → Settings → Advanced → Troubleshooting → **Disable bundled plugin translations**. When checked, WordPress's default textdomain load order applies (`wp-content/languages/plugins/` first, bundled files as fallback).
- **PHP filter**: `add_filter( 'trp_use_bundled_translations', '__return_false' );`. Programmatic equivalent of the toggle — useful in custom plugins or mu-plugins. The setting is implemented as a bridge that hooks this same filter (see `includes/advanced-settings/disable-bundled-translations.php`).

Both default to "use bundled" (the override is on). Either disable path simply skips registering the three filters; the standard `load_plugin_textdomain` call still runs so WP.org community packs (if present) are loaded normally.

## Prerequisites

- DDEV running (`ddev start`), because the compile step shells out to `ddev wp i18n ...`.
- `.env` at the plugin root with `OPENROUTER_API_KEY=...`. The key is read at build time only and never at runtime.

## Commands

The translation pipeline is **decoupled** from `pot` / `catalog`. Nothing in the gulp chain or release scripts (`version.sh` etc.) triggers OpenRouter — translations only run when you invoke a `translations:*` command explicitly.

| Command | What it does | Touches translations? | Makes AI calls? |
|---|---|---|---|
| `npm run pot` | Regenerates `languages/translatepress-multilingual.pot` by scanning the plugin's PHP source. **Nothing else** — no catalog regen, no translation build, no API calls. Run this after adding/renaming `__()` / `_n()` calls. | no | no |
| `npm run catalog` | Regenerates `catalog.php` from the existing `.pot`, for translate.wordpress.org's scanner. Does **not** touch `.po` files or hit OpenRouter. | no | no |
| `npm run translations:incremental` | For every locale, fetches WP.org community translations, then AI-fills only msgids that are **missing or untranslated** in the locale's existing `.po`. Compiles `.mo` / `.l10n.php` / `.json`. Existing AI translations are kept as-is. | yes (incremental — only new msgids) | yes (only for new/untranslated msgids) |
| `npm run translations:full-rebuild` | Same per-locale flow, but **discards all existing AI translations** and re-AI-fills every gap from scratch. Also re-pulls WP.org so community drift overwrites prior AI on a per-string basis. Expensive. | yes (every msgid for every locale) | yes (every gap for every locale — expensive) |
| `npm run translations:update` | **Apply pending glossary/context changes.** For every msgid, computes the set of glossary/context entries currently matching it (by 8-hex content hash) and compares to the `tp-ctx-…` / `tp-glo-…` flags already stamped on its msgstr. If any matching entry's hash isn't in the stored set, the msgstr is stale and gets re-routed to AI with the new hint guidance. Untouched if all matching hashes are already stored. This is the command to run after editing `context.json` or `glossary.json`. | yes (only stale msgids — incremental after first run) | yes (only stale msgids — bounded) |
| `npm run translations:check-placeholders` | Audits every committed `.po` for placeholder integrity. Reports **CRITICAL** findings (translation invents a placeholder source doesn't — would fatal `sprintf` at runtime) and **MISSING** findings (positional from source dropped — visible display bug). Exit code `1` on CRITICAL; add `--strict` to also fail on MISSING. Safe to run repeatedly; reads only, no writes. | no | no |

### Typical workflows

- **Added a new `__()` / `_n()` call in PHP** → `npm run pot` (refresh source string list) → `npm run catalog` (catalog.php for WP.org scanner) → manually `npm run translations:incremental` when you want the new msgids translated → `npm run translations:check-placeholders` to verify nothing regressed.
- **Editing the prompt or model in `ai-fill.js`** → `npm run translations:full-rebuild` so the existing translations get redone with the new settings → `npm run translations:check-placeholders`.
- **Adding/editing a `context.json` or `glossary.json` entry** → `npm run translations:update` to apply only the pending changes. The build compares each msgid's matching entry hashes against what's stamped in its msgstr's `tp-ctx-…` / `tp-glo-…` flags and only re-translates the stale ones. Add `--locale=ro_RO` to verify on one locale first. Then `npm run translations:check-placeholders`.
- **A translation came out wrong in language X for word W** → open `bin/translations/context.json`, add or refine an entry `"W": "<conceptual hint, locale-agnostic>"` (see the `_comment` field for format). Edit in place if `W` is already there — the hash changes and `:update` will re-translate matching msgids. Then `npm run translations:update -- --locale=X` to verify on that one locale, inspect the diff, and `npm run translations:update` to apply to all. If only locale X needs steering, put the entry in `bin/translations/context-X.json` instead.
- **I want to add a context entry but don't know which words are problematic** → `grep -E "^msgstr" languages/translatepress-multilingual-<locale>.po | sort | less` and scan for awkward renderings. For a specific suspect word, `grep -B1 "msgid.*\bWORD\b" languages/translatepress-multilingual-<locale>.po` shows how the locale currently renders each occurrence.
- **Pre-release QA** → `npm run translations:check-placeholders` (also `--strict` to catch quality-grade misses). Wire it into CI / pre-push if you want a hard gate.
- **None of the four build commands are wired into `version.sh` or any other release script** — translation builds are explicit, manual, and intentional. Only `translations:check-placeholders` is cheap enough to run on every commit if you want.

### Single-locale runs (useful for iterating)

```bash
node bin/translations/build-incremental.js --locale=ja            # one locale, incremental
node bin/translations/build-incremental.js --locale=ja --no-ai    # community merge only, no OpenRouter calls
node bin/translations/build-incremental.js --locale=ja --full     # full rebuild for this locale only
```

### Tests

```bash
npm run test:translations          # 54 tests, ~2s, mocks OpenRouter so $0 cost
TRP_SKIP_NETWORK=1 npm run test:translations   # skip the WP.org network tests
```

The suite (`bin/translations/test/integration.test.js`, Node's built-in test runner — no extra deps) covers:

- Locale registry shape (43 entries, all have names, none English).
- Glossary loading + word-boundary matching, including the longer-compound preference.
- Placeholder extraction (`%s` / `%d` / `%1$s` / `%%`) and validation (rejects extra, invented positional, fullwidth `％`).
- Plural-form validation against `max(msgid, msgid_plural)` count rule.
- Response parsing for both singular and plural shapes, including XML entity unescaping.
- `plural-forms.json` integrity (every locale has 1–6 `nplurals`).
- Real WP.org fetch for de_DE (verifies > 100 community entries) and ja (verifies empty).
- aiFill with mocked OpenRouter: glossary preservation, plural array return, bad-translation retry-3x-then-drop, retry-then-succeed, 402 graceful abort, network-error graceful abort.
- `hasAllSourcePositionals` quality gate: no-positionals vacuous-true, `%1$s` preserved, `%1$s` dropped (the literal ru_RU case), multi-positional handling, plural union-coverage, plural all-forms-drop rejection, non-positional `%s` not gated.

Set `TRP_SKIP_NETWORK=1` in environments without internet access to skip the two WP.org tests; everything else is hermetic.

## Files

| File | Purpose |
|---|---|
| `locales.json` | Frozen list of 43 locales we ship translations for. Snapshot of `api.wordpress.org/stats/locale/1.0/` taken 2026-05-20. Do not edit casually — it's the source of truth. |
| `locales.js` | Loads `locales.json`, exposes `LOCALES` (codes) and `LOCALE_NAMES` (code → human name). |
| `glossary.json` | Default "do not translate" terms applied to every locale (brand names, tech acronyms). Matches are word-boundary, case-insensitive, then injected as few-shot worked examples in the AI prompt. |
| `glossary-{locale}.json` | Optional per-locale override merged on top of the default. Useful if e.g. a Cyrillic-script locale wants transliterated brand names. |
| `context.json` | Per-keyword **conceptual** hints (locale-agnostic). When a source msgid contains a context keyword (word-boundary, case-insensitive), the matched hint(s) get attached to that string's `<source>` element as a `hint="..."` attribute. Unlike glossary (forces a fixed target rendering), context disambiguates the SENSE of an ambiguous word — e.g. `string` = piece of translatable text, not rope; `post` = WordPress article, not mail. The model picks the right target word per language using its own knowledge. **Format:** flat JSON, `"keyword": "conceptual hint string"`. Keys are matched case-insensitively at `\b…\b` word boundaries, so `"post"` matches "Post", "post.", "/post/edit", but NOT "postal" or "postscript". Editing a hint in place changes its content hash and queues all matching msgids for re-translation on the next `npm run translations:update`. |
| `context-{locale}.json` | Optional per-locale override merged on top of the default context. Useful if a specific locale needs tighter steering for an ambiguous keyword. |
| `plural-forms.json` | Per-locale `nplurals` + Plural-Forms expression + human-readable rule. The expression goes into the .po header; the rule is injected into the AI prompt so the model knows how many forms to produce and what each one encodes (e.g. Russian 3 forms: singular / paucal / plural). |
| `fetch-wporg.js` | Downloads translate.wordpress.org's translation pack for a locale, extracts the `.po`, returns `{ msgid → msgstr }`. |
| `ai-fill.js` | Builds the XML-shaped OpenRouter prompt (with glossary few-shot turn) and parses the response. Validates every translation against the source's printf placeholders and retries failures up to 3 times. Uses `provider: { sort: 'throughput' }` for routing and `usage: { include: true }` for cost reporting. 90-second per-request timeout. |
| `build-incremental.js` | Orchestrator. Reads the `.pot`, loads each locale's existing `.po`, merges WP.org community on top (always wins, **subject to the placeholder-integrity gate**), queues remaining gaps for AI, writes `.po`, then compiles `.mo` / `.l10n.php` / `.json` via `ddev wp i18n`. Tracks per-locale stats and prints a summary table at the end of multi-locale runs. Logs `(N community translation(s) rejected for missing positionals — routed to AI)` when the gate triggers. |
| `build-full.js` | Thin wrapper that calls `build-incremental.js` with `fullRebuild: true` — re-pulls WP.org for every msgid and re-AI-fills every gap (no carry-over). |
| `check-placeholders.js` | Audit script. Walks every committed `.po`, parses each entry, compares printf placeholders between msgid (+ msgid_plural) and msgstr (each form for plurals). Reports CRITICAL findings (translation invents a placeholder — sprintf-fatal) and MISSING findings (positional dropped from translation — visible bug). Used by `npm run translations:check-placeholders`. |

## How the prompt works

1. Glossary is loaded for the locale (default + per-locale merge).
2. For each batch (20 msgids), terms from the glossary that appear in any source string are matched via `\bterm\b`.
3. Matched terms are injected as a few-shot turn: `user` message with the source terms, `assistant` message with their target forms. This trains the model on-the-fly to preserve them.
4. If any item in the batch is a plural (has `msgid_plural`), a "Plural-form rule for {locale}: …" preamble is prepended to the user message so the model knows how many forms to emit.
5. The real batch follows. Each `<source>` element carries a `placeholders="%s,%1$s"` attribute so the model can self-verify, plus `ctx="..."` (msgctxt), `c="..."` (developer comments from `#.`), and `hint="..."` (matched `context.json` entries) when present. Plural items use `<source><singular>…</singular><plural>…</plural></source>` shape.
6. The model responds with `<t i="N">translation</t>` for singular items and `<t i="N"><f0>…</f0><f1>…</f1>…</t>` for plurals. The parser maps each `i` back to the original msgid.

## Incremental glossary/context updates (hash-based)

The `translations:update` command applies pending `glossary.json` / `context.json` changes incrementally — only msgids actually affected by edits get re-translated. The scheme is content-addressed, not version-numbered, so editing a hint in place is the same operation as adding a new entry.

### How it works

1. At read time, every loaded glossary/context entry is fingerprinted: `sha1(${key}=${value})` truncated to 8 hex chars. This is the entry's identity.
2. After AI translates an msgstr, the build writes a `#,` flag line on that PO entry listing the hashes of the glossary/context entries that matched the source:

    ```po
    #, tp-ai, tp-ctx-a3f8b9c1, tp-ctx-d4e5f6a7, tp-glo-b1c2d3e4
    msgid "Edit the post slug here"
    msgstr "Editează aici slug-ul articolului"
    ```

   - `tp-ai` — msgstr is AI-generated (informational; `grep tp-ai` separates AI vs community translations).
   - `tp-ctx-HASH` — a context entry that matched this msgid at translate time.
   - `tp-glo-HASH` — a glossary entry that matched.

3. On the next `translations:update` run, the build recomputes the matching hash set per msgid against the *current* `glossary.json` / `context.json` and compares to what's stamped. **If any current matching hash is missing from the stamp**, the msgstr is stale and re-routed to AI. If the stamp is a superset of current matches, the msgstr is kept and re-stamped (so removed entries naturally prune from the flag line).

### Reading the flag line

Open any committed `.po` and you'll see lines like:

    #, tp-ai, tp-ctx-a3f8b9c1, tp-glo-b1c2d3e4

Tokens are comma-separated, written in this fixed order: `tp-ai` first (if AI-generated), then `tp-ctx-…` (sorted by hash), then `tp-glo-…` (sorted by hash). The `tp-` prefix is our namespace; anything else on the line (`fuzzy`, `c-format`, …) is preserved verbatim and round-trips through `msgmerge`. Each hash is `sha1("${key}=${value}")` truncated to 8 hex chars — short enough not to bloat the file, long enough that our ~50-entry config will never collide. The hash is content-addressed, not versioned: edit a hint in place and the hash changes, which is what triggers re-translation. To find which entry produced a given hash:

```bash
node -e 'const c=require("crypto"); console.log(c.createHash("sha1").update("KEY=VALUE").digest("hex").slice(0,8))'
```

with the suspect entry's key + value.

### What triggers re-translation

| Action | Re-translates |
|---|---|
| Add new context entry `"category": "..."` | msgids containing "category" that don't already have that hash |
| Edit a hint or glossary target | msgids matching the changed entry (hash differs) |
| Remove an entry | nothing (stale tokens are pruned the next time those msgids go through `--update`) |
| Add per-locale `context-ro_RO.json` override | only that locale's matching msgids (the locale's expected hash differs from the default's) |
| Add new msgid via `npm run pot` | the new msgid only (gap-fill behavior, same as `:incremental`) |
| Run `:full-rebuild` | every msgid for every locale; new stamps are written from scratch against the current glossary/context |
| Add `--no-ai` to any mode | nothing — `--no-ai` suppresses staleness and `--full` because we can't re-translate to satisfy them. Existing translations are preserved (gap-fill is also skipped for untranslated msgids). |
| AI dropped an msgid after 3 retries (msgstr left empty, no `tp-ai` stamp) | retried on next `:incremental` or `:update` |

### PO format compatibility

Custom `#,` flags are explicitly blessed by GNU gettext's [Sticky flags](https://www.gnu.org/software/gettext/manual/html_node/Sticky-flags.html). They round-trip cleanly through `msgmerge`, `msgcat`, and `gettext-parser`. We deliberately don't use `#, fuzzy` (collides with translator-review workflow + `msgfmt` skips fuzzy entries by default) or `#.` extracted comments (regenerated from POT every merge, so anything tool-specific gets stripped).

### Migration story

Translations committed before this scheme have no flag stamps. Two ways to handle this:

- **Free migration via `--stamp-only`** (recommended when your `.po` files were just regenerated and you trust they match current `glossary.json` / `context.json`): write the current hashes onto every existing translation without re-translating anything. No AI calls, no token cost.

    ```bash
    npm run translations:update -- --stamp-only           # all locales
    npm run translations:update -- --stamp-only --locale=ro_RO   # one locale
    ```

    After this, the next `npm run translations:update` is a true no-op until you edit a glossary/context entry.

- **Paid re-translation via plain `--update`**: if you're NOT sure existing translations were generated against the current ctx/glo state, run `translations:update` without `--stamp-only`. The build will see `stored_hashes = ∅` for every entry and re-translate everything matching any current entry — one-time cost equivalent to a targeted rebuild, with the upside of producing fresh hint-guided output.

Pick `--stamp-only` when you've just run a rebuild and the on-disk translations are demonstrably aligned with the live config. Otherwise pick plain `--update`.

> **Note for new contributors:** The migration was performed once in commit `b904c979` — every committed `.po` already carries its current hash stamps. You should never need `--stamp-only` unless you're seeding a freshly initialized locale's `.po` from scratch.

> **`--stamp-only` is a declaration of trust, not a verification.** It writes the current hashes onto the existing translations as-is; it does not check that the translation actually respects the current hint. Use it only when you know the on-disk state is aligned with the live config (e.g. immediately after a build, or right after restoring from a known-good commit).

## Placeholder safety

There is **one validator** — `validatePlaceholders(source, target)` in `bin/translations/ai-fill.js` — and it is applied to **every translation, from any source, on every translations command**: AI output, community translations on intake, and pre-existing entries from prior builds. After the build, the standalone audit re-applies the same logic to the written `.po` files as a redundant safety net.

The validator combines two rules:

### Safety: subset multiset (clean source) / count parity (ambiguous source)

The validator picks one of two modes based on whether the source itself contains any `%` that isn't an unambiguous WP printf spec (i.e., not one of `%s`, `%d`, `%i`, `%f`, `%%`, or positional variants).

**Clean source — strict mode**: each translation form's printf-placeholder multiset must be ≤ the source's max-per-placeholder multiset (max taken over `msgid` + `msgid_plural`). Catches:

- **Invented positionals** (`%2$s` in translation when source has only `%1$s`) — would fatal `sprintf` at runtime.
- **Extra unnumbered** (`%s %s` in translation when source has one `%s`) — `sprintf` would consume an arg it wasn't given.
- **Bare `%` followed by a non-specifier** (`% r`, `% z`, etc.) — PHP 8 throws `ValueError` ("Unknown format specifier"). Catches translators who forgot to escape `%` as `%%`.
- **Unsupported PHP specifiers** in translation that the source doesn't have (`%x`, `%o`, `%e`, `%g`, etc., not just `%s`/`%d`). The full PHP printf grammar including width/precision/flags (`%05d`, `%.2f`, `%-10s`) is matched and normalised.
- **Fullwidth `％`** (U+FF05) anywhere — looks like a placeholder but `sprintf` doesn't recognise it.

**Ambiguous source — relaxed mode**: when the source contains a `%` pattern that PHP would parse via space-flag conversions (`% s`, `% d`) or that's a literal `%` in prose (`95% similarity`), the validator only requires that the translation not have *more* `%` characters than the source max. The reasoning: PHP would already fatal on the English source if it were ever `sprintf`'d, so a faithful translation isn't introducing new risk. In TranslatePress's codebase such strings are JS-substituted (`tooltip_text_default` via `.replace()` in `percentage-bar-logic.js`) or plain-echo'd (`wp_kses(__())`), never sprintf'd, so no fatal occurs at runtime.

### Quality: positional union coverage

Every positional placeholder (`%N$x`) that appears in `msgid` or `msgid_plural` must appear in **at least one** translation form. Catches dropped positionals — at runtime the sentence would render with a missing link/variable. Example we caught on `ru_RU`:

> source: `"Choose which engine you want to use in order to %1$s automatically translate your website."`
> community msgstr (rejected): `"Выберите, какой движок вы хотите использовать для автоматического перевода сайта."`

Plurals use a **union check** (placeholders must appear in *some* form, not every form), so legitimate Slavic-style omissions where the singular doesn't use a placeholder another form has are not false-positives.

Unnumbered `%s` / `%d` are **not** required to be present in translations — sometimes dropping them is intentional, and the safety rule already prevents the dangerous direction (inventing extras).

### Where the validator runs

| Source of translation | Validator applied? | What happens on failure |
|---|---|---|
| **AI output** (every model response) | yes — `validateTranslation` wraps the unified validator | item is re-sent to the model with a hint up to 3 times; items still failing after the cap are dropped and msgstr stays empty so gettext falls back to English |
| **WP.org community translation** (every msgid we accept from the pack) | yes — `validatePlaceholders` in `build-incremental.js`'s merge step | community entry is rejected; msgid is queued for AI fill instead. Per-locale log: `(N community translation(s) rejected for missing positionals — routed to AI)` |
| **Pre-existing entry** (kept from prior build's `.po`) | yes — same call as community | entry is rejected; if `--full` was passed it always re-fills, otherwise it falls through to AI |
| **Final `.po` after compile** | yes — auto-audit at end of every `translations:*` build | non-zero exit code if anything slipped through. Banner names offending locales; full detail via `npm run translations:check-placeholders` |

### Standalone audit (`npm run translations:check-placeholders`)

Same rules, run on already-written `.po` files independent of any build. Useful as a CI pre-merge gate or a manual sanity check. Reports `CRITICAL` findings (safety failures — sprintf-fatal risk) and `MISSING` findings (quality failures — display bugs). Exits `1` on CRITICAL by default; `--strict` also exits `1` on MISSING. No network, no AI calls — runs in about a second across all 43 locales.

## Notes

- **Plurals**: fully supported. Each locale's `nplurals` comes from `plural-forms.json`. The header's `Plural-Forms` is written from the same source — overriding whatever the WP.org pack may have shipped.
- **Locales without WP.org packs** (e.g. `ja` at time of writing) get 100 % AI coverage — there's no community baseline to merge.
- The committed `.po` is the auditable source of truth. The `.mo` / `.l10n.php` / `.json` are derivable from it — they're committed too so the plugin zip ships ready-to-use.
- Build cost is incremental: only msgids missing from a locale's existing `.po` trigger AI calls. A full rebuild trips OpenRouter for every gap.
- Per-batch progress line reports elapsed time, tokens, USD cost, retry rounds, and dropped items. Multi-locale runs end with a summary table totalling those across locales.
