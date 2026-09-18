#!/usr/bin/env node
/**
 * check-robots.mjs — may a blocked fetch of <url> be retried with browser headers?
 *
 *   node check-robots.mjs <url> [--json]
 *
 * Exit 0 = the retry may proceed, 1 = do not retry (go find the employer's own
 * posting instead), 2 = bad invocation. CAREER_OPS_IGNORE_ROBOTS=1 overrides.
 */

import { robotsGate } from './lib/robots-gate.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('usage: node check-robots.mjs <url> [--json]');
    process.exit(2);
  }
  const res = await robotsGate(url);
  if (json) console.log(JSON.stringify(res, null, 2));
  else console.log(`${res.allowed ? 'ALLOWED' : 'BLOCKED'}: ${res.reason}`);
  process.exit(res.allowed ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`check-robots: unexpected error — ${err?.message || err}`);
    process.exit(2);
  });
}
