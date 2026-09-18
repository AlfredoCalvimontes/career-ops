#!/usr/bin/env node
/**
 * verify-host.mjs — classify a posting URL's host as official ATS, known job
 * board / configured portal, or unverified.
 *
 *   node verify-host.mjs <url> [--json]
 *
 * Reads `portals.yml` (tracked_companies[].careers_url) so a company's own
 * careers host counts as a configured portal. A missing or unparsable
 * portals.yml is ignored. Exit 0 = verified (ats/portal), 1 = unverified,
 * 2 = bad invocation.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { verifyHost, portalHostsFromConfig, UNVERIFIED } from './lib/host-verify.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

export function loadPortalHosts(path = join(getCareerOpsRoot(), 'portals.yml')) {
  if (!existsSync(path)) return [];
  try {
    return portalHostsFromConfig(yaml.load(readFileSync(path, 'utf8')) ?? {});
  } catch {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('usage: node verify-host.mjs <url> [--json]');
    process.exit(2);
  }
  const res = verifyHost(url, { portalHosts: loadPortalHosts() });
  if (json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(res.label);
    for (const w of res.warnings) console.log(`  ! ${w}`);
  }
  process.exit(res.class === UNVERIFIED ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
