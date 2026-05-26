/**
 * Full rebuild — thin wrapper over build-incremental.js with fullRebuild=true.
 *
 * Forces every msgid to be re-evaluated:
 *   - Community translations are re-pulled from WP.org and replace any stale AI strings.
 *   - Remaining gaps are re-sent to OpenRouter from scratch (existing AI translations are not kept).
 *
 * Intended to run periodically (e.g. before each plugin release) to refresh drift.
 */

const { buildIncremental } = require('./build-incremental');

const args = process.argv.slice(2);
const onlyLocaleArg = args.find(a => a.startsWith('--locale='));
const onlyLocale = onlyLocaleArg ? onlyLocaleArg.slice('--locale='.length) : undefined;

buildIncremental({ onlyLocale, fullRebuild: true }).catch(e => {
  console.error(e);
  process.exit(1);
});
