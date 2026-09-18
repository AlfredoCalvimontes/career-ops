#!/usr/bin/env node
/**
 * check-gates.mjs — run the pre-scoring eligibility + language gates on a JD.
 *
 *   node check-gates.mjs jds/acme.md
 *   node check-gates.mjs - < jd.txt          # read JD from stdin
 *   node check-gates.mjs jds/acme.md --json
 *
 * Reads `config/profile.yml` (location.authorized_in, location.regions,
 * language.spoken). A missing profile or JD file is reported, never thrown.
 * Exit 0 = PASS/FLAG, 1 = FAIL (do not score or draft), 2 = bad invocation.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { checkEligibility, checkLanguage, combineGates, profileFromConfig, FAIL } from './lib/gates.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

export function loadGateProfile(path = join(getCareerOpsRoot(), 'config/profile.yml')) {
  if (!existsSync(path)) return profileFromConfig({});
  try {
    return profileFromConfig(yaml.load(readFileSync(path, 'utf8')) ?? {});
  } catch {
    return profileFromConfig({});
  }
}

export function runGates(jd, gateProfile) {
  const eligibility = checkEligibility(jd, gateProfile.profile);
  const language = checkLanguage(jd, gateProfile.spoken);
  return { eligibility, language, combined: combineGates(eligibility, language) };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--') || a === '-');
  if (!target) {
    console.error('usage: node check-gates.mjs <jd-file|-> [--json]');
    process.exit(2);
  }
  let jd;
  try {
    jd = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
  } catch (err) {
    console.error(`cannot read JD: ${err.message}`);
    process.exit(2);
  }
  const res = runGates(jd, loadGateProfile());
  if (json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const { eligibility: e, language: l, combined } = res;
    console.log(`Eligibility: ${e.verdict} (${e.kind})${e.verified ? '' : ' — unverified'}${e.tags.length ? ` [${e.tags.join(', ')}]` : ''}`);
    if (e.quote) console.log(`  "${e.quote}"`);
    console.log(`  ${e.reason}`);
    console.log(`Language:    ${l.verdict}`);
    if (l.quote) console.log(`  "${l.quote}"`);
    console.log(`  ${l.reason}`);
    console.log(`\nDecision: ${combined.verdict}${combined.blocks ? ' — do not score or draft' : ''}`);
  }
  process.exit(res.combined.verdict === FAIL ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
