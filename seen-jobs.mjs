#!/usr/bin/env node
/**
 * seen-jobs.mjs — persistent per-posting state: rank, gate verdicts, skill gaps, expiry.
 *
 *   node seen-jobs.mjs list [--min-rank N] [--gate PASS|FLAG|FAIL] [--tier 1|2|3] [--sort tier]
 *                           [--active|--expired] [--json]
 *   node seen-jobs.mjs show <url>
 *   node seen-jobs.mjs record-gates <url> --jd <file|-> [--company C] [--title T]
 *   node seen-jobs.mjs record-gaps  <url> --jd <file|-> [--company C] [--title T]
 *   node seen-jobs.mjs expire <url> [--reason text]
 *   node seen-jobs.mjs gaps [--min-rank N]          # skill gaps across ranked, live postings
 *   node seen-jobs.mjs prune --days N
 *
 * State lives in data/seen-jobs.json (user layer, gitignored), keyed by the
 * canonical posting URL. rank-pipeline.mjs writes ranks here and reuses them, so
 * an unchanged job is never re-scored. Nothing here deletes a pipeline row or
 * changes a tracker status. Exit 0 ok, 1 nothing found / failed, 2 bad usage.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  gapSummary, getRank, keyFor, listJobs, loadSeenJobs, prune, setExpired, setGaps, setGates, touch, withSeenJobs,
} from './lib/seen-jobs.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';

export const SEEN_PATH = join(getCareerOpsRoot(), 'data', 'seen-jobs.json');

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJd(target) {
  if (!target) throw new Error('--jd <file|-> is required');
  return target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
}

function fmt(j) {
  const rank = j.rank ? `${j.rank.score.toFixed(1)}/5` : '  —  ';
  const tier = j.tier ? `T${j.tier.tier}` : '  ';
  const g = j.gates ? `${j.gates.eligibility.verdict}/${j.gates.language.verdict}` : '—';
  const flags = [j.expired ? 'expired' : '', j.gaps?.length ? `${j.gaps.length} gap(s)` : '', ...(j.gates?.eligibility.tags ?? [])].filter(Boolean).join(', ');
  return `${tier} ${rank}  gates ${g.padEnd(9)} ${j.company || '?'} | ${j.title || '?'}${flags ? `  [${flags}]` : ''}\n        ${j.url}`;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const json = hasFlag(rest, '--json');
  const path = process.env.CAREER_OPS_SEEN_JOBS || SEEN_PATH;
  const urlArg = rest.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== flagValue(rest, '--jd') && a !== flagValue(rest, '--company') && a !== flagValue(rest, '--title') && a !== flagValue(rest, '--reason') && a !== flagValue(rest, '--gate') && a !== flagValue(rest, '--tier') && a !== flagValue(rest, '--sort') && a !== flagValue(rest, '--min-rank'));

  const note = (recovered) => { if (recovered) console.error(`seen-jobs: state file ${recovered}; starting from an empty state`); };

  if (cmd === 'list' || cmd === 'gaps' || cmd === 'show') {
    const { state, recovered } = loadSeenJobs(path);
    note(recovered);
    if (cmd === 'list') {
      const minRank = flagValue(rest, '--min-rank');
      const jobs = listJobs(state, {
        minRank: minRank != null ? Number(minRank) : undefined,
        gate: flagValue(rest, '--gate') ?? undefined,
        tier: flagValue(rest, '--tier') != null ? Number(flagValue(rest, '--tier')) : undefined,
        sort: flagValue(rest, '--sort') ?? undefined,
        expired: hasFlag(rest, '--expired') ? true : hasFlag(rest, '--active') ? false : undefined,
      });
      if (json) console.log(JSON.stringify(jobs, null, 2));
      else if (!jobs.length) console.log('No matching postings in data/seen-jobs.json.');
      else jobs.forEach((j) => console.log(fmt(j)));
      return 0;
    }
    if (cmd === 'gaps') {
      const minRank = flagValue(rest, '--min-rank');
      const sum = gapSummary(state, { minRank: minRank != null ? Number(minRank) : 0 });
      if (json) console.log(JSON.stringify(sum, null, 2));
      else if (!sum.gaps.length) console.log('No recorded skill gaps.');
      else {
        console.log(`Skill gaps across ${sum.jobs} live posting(s):`);
        sum.gaps.forEach((g) => console.log(`  ${String(g.count).padStart(3)}  ${g.skill}`));
      }
      return 0;
    }
    const key = keyFor(urlArg);
    const job = key && state.jobs[key];
    if (!job) { console.error('seen-jobs: no such posting recorded'); return 1; }
    console.log(json ? JSON.stringify({ key, ...job }, null, 2) : fmt({ key, ...job }));
    return 0;
  }

  if (cmd === 'record-gates' || cmd === 'record-gaps' || cmd === 'expire') {
    if (!keyFor(urlArg)) { console.error('seen-jobs: a valid http(s) posting URL is required'); return 2; }
    let jd = '';
    if (cmd !== 'expire') {
      try { jd = readJd(flagValue(rest, '--jd')); } catch (err) { console.error(`seen-jobs: ${err.message}`); return 2; }
    }
    ensureDir(path);
    const meta = { url: urlArg, company: flagValue(rest, '--company') ?? '', title: flagValue(rest, '--title') ?? '' };
    const out = await withSeenJobs(path, async (state, ctx) => {
      note(ctx.recovered);
      const key = touch(state, meta);
      if (cmd === 'expire') { setExpired(state, key, flagValue(rest, '--reason') ?? ''); return { key, ok: true }; }
      if (cmd === 'record-gates') {
        const { runGates, loadGateProfile } = await import('./check-gates.mjs');
        const res = runGates(jd, loadGateProfile());
        setGates(state, key, { eligibility: res.eligibility, language: res.language });
        return { key, decision: res.combined.verdict, eligibility: res.eligibility.verdict, language: res.language.verdict };
      }
      const { extractJdSkills, classifySkillGaps } = await import('./jd-skill-gap.mjs');
      const cvPath = join(getCareerOpsRoot(), 'cv.md');
      const cv = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
      const cls = classifySkillGaps(extractJdSkills(jd), cv);
      setGaps(state, key, cls.gap);
      return { key, gaps: cls.gap };
    });
    console.log(json ? JSON.stringify(out, null, 2) : `recorded ${cmd.replace('record-', '')} for ${out.key}${out.gaps ? `: ${out.gaps.length} gap(s)` : ''}${out.decision ? `: ${out.decision}` : ''}`);
    return 0;
  }

  if (cmd === 'prune') {
    const days = Number(flagValue(rest, '--days'));
    if (!Number.isFinite(days) || days <= 0) { console.error('usage: node seen-jobs.mjs prune --days N'); return 2; }
    ensureDir(path);
    const removed = await withSeenJobs(path, (state) => prune(state, days));
    console.log(`pruned ${removed.length} posting(s) last seen more than ${days} day(s) ago`);
    return 0;
  }

  console.error('usage: node seen-jobs.mjs <list|show|record-gates|record-gaps|expire|gaps|prune> [...]');
  return 2;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (err) => { console.error(`seen-jobs: ${err?.message || err}`); process.exit(1); });
}

export { getRank };
