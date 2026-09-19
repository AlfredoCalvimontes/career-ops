#!/usr/bin/env node
/**
 * role-tier.mjs — rank roles by how much you want them (T1 / T2 / T3 bridge).
 *
 *   node role-tier.mjs classify "<job title>" [--score 4.1] [--pay 1500] [--json]
 *   node role-tier.mjs board [--json]        # your tracked applications, grouped by tier
 *   node role-tier.mjs shortlist [--json]    # ranked, not-yet-applied postings (data/seen-jobs.json), by tier
 *   node role-tier.mjs set-pay <url> <monthly-usd>   # record a posting's stated pay
 *
 * Tiers come from `config/profile.yml → role_tiers` (tier_1, tier_2, tier_3_bridge).
 * T2 scores are capped at 4.0 and T3 at 3.5. A T3 "bridge" role is only worth
 * taking when it pays MORE than `role_tiers.bridge_min_monthly_usd` (your current
 * monthly pay); at or below it, it fails. Pay is monthly USD. Read-only apart from
 * `set-pay`. Exit 0 ok, 1 nothing found, 2 bad usage.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { applyTierPolicy, classifyTier, compareByTier, parseMonthlyUsd, TIER_LABEL } from './lib/role-tiers.mjs';
import { keyFor, loadSeenJobs, setPay, withSeenJobs } from './lib/seen-jobs.mjs';
import { detectColumns, LEGACY_COLMAP, parseTrackerRow } from './tracker-parse.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';

/** Read role_tiers, the bridge threshold, the pay floor and the triage threshold from the profile. Never throws. */
export function loadRoleTierConfig(path = join(getCareerOpsRoot(), 'config', 'profile.yml')) {
  const empty = { tiers: {}, bridgeMinMonthlyUsd: null, floorMonthlyUsd: null, threshold: undefined };
  if (!existsSync(path)) return empty;
  let cfg;
  try { cfg = yaml.load(readFileSync(path, 'utf8')) ?? {}; } catch { return empty; }
  const rt = cfg.role_tiers ?? {};
  const bridge = Number(rt.bridge_min_monthly_usd);
  const threshold = Number(cfg.pipeline?.triage_threshold);
  return {
    tiers: { tier_1: rt.tier_1 ?? [], tier_2: rt.tier_2 ?? [], tier_3_bridge: rt.tier_3_bridge ?? [] },
    bridgeMinMonthlyUsd: rt.bridge_min_monthly_usd != null && Number.isFinite(bridge) ? bridge : null,
    floorMonthlyUsd: parseMonthlyUsd(cfg.compensation?.minimum),
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : undefined,
  };
}

/** Classify + apply the policy for one role. */
export function evaluateRole({ title, score, payMonthlyUsd }, config) {
  const t = classifyTier(title, config.tiers);
  const policy = score != null && Number.isFinite(Number(score))
    ? applyTierPolicy({ score: Number(score), tier: t.tier, payMonthlyUsd: payMonthlyUsd ?? null, bridgeMinMonthlyUsd: config.bridgeMinMonthlyUsd, floorMonthlyUsd: config.floorMonthlyUsd, threshold: config.threshold })
    : null;
  return { ...t, label: t.tier ? TIER_LABEL[t.tier] : '—', policy };
}

const scoreOf = (cell) => {
  const m = String(cell ?? '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return m ? Number(m[1]) : null;
};

function trackerRows() {
  const path = resolveTrackerPath(getCareerOpsRoot());
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  const colmap = detectColumns(lines) || LEGACY_COLMAP;
  return lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
}

function printGrouped(rows, fmt) {
  for (const tier of [1, 2, 3, null]) {
    const group = rows.filter((r) => (r.tier ?? null) === tier);
    if (!group.length) continue;
    console.log(`\n${tier ? `${TIER_LABEL[tier]} — ${{ 1: 'career target', 2: 'adjacent (less preferred)', 3: 'bridge (only if it pays more than now)' }[tier]}` : 'Unclassified (add the title to role_tiers)'}`);
    for (const r of group) console.log(`  ${fmt(r)}`);
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const json = hasFlag(rest, '--json');
  const config = loadRoleTierConfig();
  if (!Object.values(config.tiers).some((l) => l.length)) {
    console.error('role-tier: no role_tiers in config/profile.yml (see config/profile.example.yml)');
    if (cmd) return 2;
  }

  if (cmd === 'classify') {
    const title = rest.find((a) => !a.startsWith('--') && a !== flagValue(rest, '--score') && a !== flagValue(rest, '--pay'));
    if (!title) { console.error('usage: node role-tier.mjs classify "<job title>" [--score N] [--pay USD]'); return 2; }
    const pay = flagValue(rest, '--pay');
    const res = evaluateRole({ title, score: flagValue(rest, '--score'), payMonthlyUsd: pay != null ? Number(pay) : null }, config);
    if (json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`${res.label}${res.matched ? `  (matches "${res.matched}"${res.ambiguous ? ', ambiguous: took the worse tier' : ''})` : '  (no tier matches this title)'}`);
      if (res.policy) {
        console.log(`effective score ${res.policy.effectiveScore.toFixed(1)}  verdict ${res.policy.verdict}`);
        res.policy.notes.forEach((n) => console.log(`  - ${n}`));
      }
    }
    return 0;
  }

  if (cmd === 'board') {
    const rows = trackerRows();
    if (!rows) { console.error('role-tier: no tracker yet (data/applications.md)'); return 1; }
    const out = rows.map((r) => {
      const score = scoreOf(r.score);
      const e = evaluateRole({ title: r.role, score }, config);
      return { num: r.num, company: r.company, role: r.role, status: r.status, score, tier: e.tier, label: e.label };
    }).sort((a, b) => compareByTier(a, b) || a.num - b.num);
    if (json) console.log(JSON.stringify(out, null, 2));
    else if (!out.length) console.log('No tracked applications yet.');
    else printGrouped(out, (r) => `#${String(r.num).padStart(3)}  ${(r.score != null ? r.score.toFixed(1) : ' — ').padStart(4)}  ${r.status.padEnd(10)} ${r.company} | ${r.role}`);
    return out.length ? 0 : 1;
  }

  if (cmd === 'shortlist') {
    const seenPath = process.env.CAREER_OPS_SEEN_JOBS || join(getCareerOpsRoot(), 'data', 'seen-jobs.json');
    const { state } = loadSeenJobs(seenPath);
    const rows = Object.entries(state.jobs).filter(([, j]) => !j.expired && j.rank).map(([key, j]) => {
      const e = evaluateRole({ title: j.title, score: j.rank.score, payMonthlyUsd: j.payMonthlyUsd }, config);
      return { key, company: j.company, title: j.title, url: j.url, score: e.policy?.effectiveScore ?? j.rank.score, rawScore: j.rank.score, payMonthlyUsd: j.payMonthlyUsd ?? null, tier: e.tier, label: e.label, verdict: e.policy?.verdict ?? '—', notes: e.policy?.notes ?? [] };
    }).sort((a, b) => compareByTier(a, b) || a.key.localeCompare(b.key));
    if (json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('No ranked, live postings in data/seen-jobs.json. Run rank-pipeline first.');
    else printGrouped(rows, (r) => `${r.score.toFixed(1)}${r.rawScore !== r.score ? `(raw ${r.rawScore.toFixed(1)})` : ''}  ${r.verdict.padEnd(8)} ${r.company || '?'} | ${r.title || '?'}${r.payMonthlyUsd != null ? `  ${r.payMonthlyUsd} USD/mo` : ''}\n        ${r.url}`);
    return rows.length ? 0 : 1;
  }

  if (cmd === 'set-pay') {
    const [url, usd] = rest.filter((a) => !a.startsWith('--'));
    const n = Number(usd);
    if (!keyFor(url) || !Number.isFinite(n) || n < 0) { console.error('usage: node role-tier.mjs set-pay <url> <monthly-usd>'); return 2; }
    const seenPath = process.env.CAREER_OPS_SEEN_JOBS || join(getCareerOpsRoot(), 'data', 'seen-jobs.json');
    return withSeenJobs(seenPath, (state) => {
      const k = keyFor(url);
      if (!state.jobs[k]) { console.error('role-tier: that posting is not recorded (run rank-pipeline or seen-jobs record-* first)'); return 1; }
      setPay(state, k, n);
      console.log(`recorded ${Math.round(n)} USD/month for ${k}`);
      return 0;
    });
  }

  console.error('usage: node role-tier.mjs <classify|board|shortlist|set-pay> [...]');
  return 2;
}

if (isMainModule(import.meta.url)) {
  Promise.resolve(main(process.argv.slice(2))).then((c) => process.exit(c), (err) => { console.error(`role-tier: ${err?.message || err}`); process.exit(1); });
}
