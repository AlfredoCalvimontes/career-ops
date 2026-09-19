// tests/role-tiers.test.mjs — role tiers (lib/role-tiers.mjs, role-tier.mjs, tier in seen-jobs/rank-pipeline)
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { tokens, expandEntry, classifyTier, parseMonthlyUsd, applyTierPolicy, compareByTier } from '../lib/role-tiers.mjs';
import { emptyState, touch, setRank, setTier, setPay, listJobs, sanitizeState, keyFor, loadSeenJobs } from '../lib/seen-jobs.mjs';
import { loadRoleTierConfig, evaluateRole } from '../role-tier.mjs';

console.log('\nrole tiers — classification, policy, ordering, CLI');

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name);
  else fail(`${name} — expected ${e}, got ${a}`);
}

const TIERS = {
  tier_1: ['Senior Full Stack Engineer', 'Senior Backend Engineer (Python / Node.js)', 'AI-Assisted / LLM Application Engineer'],
  tier_2: ['Software / Solutions Architect', 'Technical Support / Customer Engineer', 'Implementation / Integration Engineer', 'QA / Test Automation Engineer', 'Technical Writer / Developer Advocate'],
  tier_3_bridge: ['Medical / English Interpreter', 'Translator', 'Customer Support / Client Support', 'Appointment Setter', 'Virtual Assistant'],
};

// ── tokens / entry expansion ──────────────────────────────────────────────
eq('seniority and punctuation are dropped', tokens('Sr. Backend Engineer (Python)'), ['backend', 'engineer']);
eq('full stack spellings agree', [tokens('Full-Stack'), tokens('full stack'), tokens('Fullstack')], [['fullstack'], ['fullstack'], ['fullstack']]);
eq('back-end spellings agree', tokens('Back-End Developer'), ['backend', 'engineer']);
eq('developer means engineer', tokens('Python Developer'), ['python', 'engineer']);
eq('plurals fold', tokens('Solutions Architects'), ['solution', 'architect']);
eq('"ss" words are not de-pluralized', tokens('Business Analyst'), ['business', 'analyst']);
eq('empty is empty', tokens(undefined), []);
eq('a lone leading word borrows the head noun', expandEntry('Medical / English Interpreter'), [['medical', 'interpreter'], ['english', 'interpreter']]);
eq('two full alternatives are kept', expandEntry('Technical Writer / Developer Advocate'), [['technical', 'writer'], ['engineer', 'advocate']]);
eq('parentheticals are ignored', expandEntry('Senior Backend Engineer (Python / Node.js)'), [['backend', 'engineer']]);
eq('a single-word entry stays a single word', expandEntry('Translator'), [['translator']]);
eq('"or" splits alternatives', expandEntry('Translator or Interpreter'), [['translator'], ['interpreter']]);

// ── classification ────────────────────────────────────────────────────────
const tierOf = (t) => classifyTier(t, TIERS).tier;
eq('T1 exact', tierOf('Senior Full Stack Engineer'), 1);
eq('T1 through spelling and developer/engineer', tierOf('Full-Stack Developer'), 1);
eq('T1 without seniority', tierOf('Backend Engineer'), 1);
eq('T1 with a location suffix', tierOf('Sr. Back-End Developer - Remote (LATAM)'), 1);
eq('T1 alternative', tierOf('LLM Application Engineer'), 1);
eq('T2 architect', tierOf('Solutions Architect'), 2);
eq('T2 support engineer', tierOf('Technical Support Engineer'), 2);
eq('T2 QA', tierOf('QA Engineer'), 2);
eq('T3 medical interpreter', tierOf('Medical Interpreter'), 3);
eq('T3 second alternative', tierOf('English Interpreter'), 3);
eq('T3 translator', tierOf('Spanish Translator'), 3);
eq('T3 customer support', tierOf('Customer Support Specialist'), 3);
eq('T3 appointment setter', tierOf('Appointment Setter (Remote)'), 3);
eq('a plain interpreter title is not a match without a qualifier', tierOf('Interpreter'), null);
eq('an unrelated title is unclassified', tierOf('Pastry Chef'), null);
eq('a generic title the lists do not name is unclassified', tierOf('Software Engineer'), null);
eq('an empty title is unclassified', tierOf(''), null);
eq('the matched entry is reported', classifyTier('Medical Interpreter', TIERS).matched, 'Medical / English Interpreter');
eq('more specific beats less specific across tiers', classifyTier('Technical Support Engineer', TIERS).tier, 2);
eq('a tie between tiers takes the worse tier and says so', classifyTier('Support Engineer', { tier_2: ['Support Engineer'], tier_3_bridge: ['Support Engineer'] }), { tier: 3, matched: 'Support Engineer', ambiguous: true });
eq('missing tier lists do not throw', classifyTier('Anything', {}).tier, null);
eq('undefined tiers do not throw', classifyTier('Anything').tier, null);

// ── money ─────────────────────────────────────────────────────────────────
eq('parse USD with commas and prose', parseMonthlyUsd('USD 1,000/month (about 6,000 Bs)'), 1000);
eq('parse $ amount', parseMonthlyUsd('$1500'), 1500);
eq('parse a number', parseMonthlyUsd(900), 900);
eq('no amount', parseMonthlyUsd('negotiable'), null);
eq('null', parseMonthlyUsd(null), null);

// ── policy ────────────────────────────────────────────────────────────────
const pol = (o) => applyTierPolicy({ threshold: 3.5, ...o });
eq('T1 is not capped', pol({ score: 4.6, tier: 1 }).effectiveScore, 4.6);
eq('T1 above the threshold passes', pol({ score: 4.6, tier: 1 }).verdict, 'PASS');
eq('T2 is capped at 4.0', pol({ score: 4.8, tier: 2 }).effectiveScore, 4);
eq('T2 keeps a passing verdict', pol({ score: 4.8, tier: 2 }).verdict, 'PASS');
eq('T3 is capped at 3.5', pol({ score: 4.9, tier: 3, payMonthlyUsd: 2000, bridgeMinMonthlyUsd: 1200 }).effectiveScore, 3.5);
eq('T3 that beats current pay can PASS', pol({ score: 4.9, tier: 3, payMonthlyUsd: 2000, bridgeMinMonthlyUsd: 1200 }).verdict, 'PASS');
eq('T3 at the same pay fails', pol({ score: 4.9, tier: 3, payMonthlyUsd: 1200, bridgeMinMonthlyUsd: 1200 }).verdict, 'FAIL');
eq('T3 below current pay fails', pol({ score: 4.9, tier: 3, payMonthlyUsd: 900, bridgeMinMonthlyUsd: 1200 }).verdict, 'FAIL');
eq('T3 with unstated pay is at best MARGINAL', pol({ score: 4.9, tier: 3, bridgeMinMonthlyUsd: 1200 }).verdict, 'MARGINAL');
eq('T3 with no threshold set is at best MARGINAL', pol({ score: 4.9, tier: 3, payMonthlyUsd: 5000 }).verdict, 'MARGINAL');
eq('the pay floor fails any tier', pol({ score: 4.9, tier: 1, payMonthlyUsd: 800, floorMonthlyUsd: 1000 }).verdict, 'FAIL');
eq('pay at the floor is fine', pol({ score: 4.9, tier: 1, payMonthlyUsd: 1000, floorMonthlyUsd: 1000 }).verdict, 'PASS');
eq('unknown pay never trips the floor', pol({ score: 4.9, tier: 1, floorMonthlyUsd: 1000 }).verdict, 'PASS');
eq('an unclassified role is not capped', pol({ score: 4.7, tier: null }).effectiveScore, 4.7);
eq('MARGINAL band', pol({ score: 3.2, tier: 1 }).verdict, 'MARGINAL');
eq('FAIL band', pol({ score: 2.4, tier: 1 }).verdict, 'FAIL');
eq('a custom threshold is honoured', pol({ score: 3.6, tier: 1, threshold: 4 }).verdict, 'MARGINAL');
eq('a non-numeric score fails safely', pol({ score: 'abc', tier: 1 }).verdict, 'FAIL');
eq('scores are clamped to 5', pol({ score: 9, tier: 1 }).effectiveScore, 5);
eq('notes explain a cap', pol({ score: 4.8, tier: 2 }).notes.some((n) => /capped at 4\.0/.test(n)), true);
eq('notes explain the bridge decision', pol({ score: 4, tier: 3, payMonthlyUsd: 900, bridgeMinMonthlyUsd: 1200 }).notes.some((n) => /no reason to switch/.test(n)), true);

// ── ordering ──────────────────────────────────────────────────────────────
const rows = [
  { id: 'c', tier: 3, score: 3.5, payMonthlyUsd: 1500 },
  { id: 'a', tier: 1, score: 3.6 },
  { id: 'd', tier: 3, score: 3.5, payMonthlyUsd: 2500 },
  { id: 'b', tier: 2, score: 4.0 },
  { id: 'x', tier: null, score: 5 },
  { id: 'a2', tier: 1, score: 4.4 },
];
eq('T1, T2, T3 (by pay), unclassified last', rows.sort(compareByTier).map((r) => r.id), ['a2', 'a', 'b', 'd', 'c', 'x']);
eq('a T3 role never outranks a T1 role, whatever its score', compareByTier({ tier: 3, score: 5 }, { tier: 1, score: 1 }) > 0, true);
eq('T3 with unknown pay sorts after known pay', compareByTier({ tier: 3, score: 4 }, { tier: 3, score: 3, payMonthlyUsd: 900 }) > 0, true);

// ── seen-jobs integration ─────────────────────────────────────────────────
const s = emptyState();
const k1 = touch(s, { url: 'https://a.test/1', company: 'A', title: 'Backend Engineer' });
const k2 = touch(s, { url: 'https://b.test/2', company: 'B', title: 'Medical Interpreter' });
const k3 = touch(s, { url: 'https://c.test/3', company: 'C', title: 'Solutions Architect' });
setRank(s, k1, { score: 3.6, reason: 'r' }); setRank(s, k2, { score: 4.9, reason: 'r' }); setRank(s, k3, { score: 4.2, reason: 'r' });
setTier(s, k1, 1, 'Senior Backend Engineer'); setTier(s, k2, 3, 'Medical / English Interpreter'); setTier(s, k3, 2, 'Software / Solutions Architect');
setPay(s, k2, 1800);
eq('setTier stores the match', s.jobs[k1].tier, { tier: 1, matched: 'Senior Backend Engineer' });
eq('an invalid tier is refused', setTier(s, k1, 7), false);
eq('a tier can be cleared', (setTier(s, k3, null), s.jobs[k3].tier), undefined);
setTier(s, k3, 2, 'Software / Solutions Architect');
eq('setPay rounds and stores', s.jobs[k2].payMonthlyUsd, 1800);
eq('negative pay is refused', setPay(s, k2, -5), false);
eq('list sorts by tier when asked', listJobs(s, { sort: 'tier' }).map((j) => j.company), ['A', 'C', 'B']);
eq('list sorts by raw rank by default', listJobs(s).map((j) => j.company), ['B', 'C', 'A']);
eq('list filters by tier', listJobs(s, { tier: 3 }).map((j) => j.company), ['B']);
const round = sanitizeState(JSON.parse(JSON.stringify(s)));
eq('tier and pay survive a save/load sanitize', [round.jobs[k2].tier.tier, round.jobs[k2].payMonthlyUsd], [3, 1800]);
eq('sanitize drops an invalid tier', sanitizeState({ jobs: { 'https://x.test/1': { url: 'https://x.test/1', tier: { tier: 9 } } } }).jobs['https://x.test/1'].tier, undefined);
eq('sanitize drops NaN pay', sanitizeState({ jobs: { 'https://x.test/1': { url: 'https://x.test/1', payMonthlyUsd: 'lots' } } }).jobs['https://x.test/1'].payMonthlyUsd, undefined);

// ── config + CLI in a temp root ───────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'career-ops-tiers-'));
try {
  const root = join(dir, 'root');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const profile = join(root, 'config', 'profile.yml');
  const yml = (bridge) => `compensation:\n  minimum: "USD 1,000/month (about 6,000 Bs)"\npipeline:\n  triage_threshold: 3.5\nrole_tiers:\n  tier_1:\n    - "Senior Backend Engineer"\n  tier_2:\n    - "Solutions Architect"\n  tier_3_bridge:\n    - "Medical / English Interpreter"\n    - "Customer Support"\n  bridge_min_monthly_usd: ${bridge}\n`;
  writeFileSync(profile, yml(1200));
  const cfg = loadRoleTierConfig(profile);
  eq('config: tiers are read', cfg.tiers.tier_3_bridge.length, 2);
  eq('config: the bridge threshold is read', cfg.bridgeMinMonthlyUsd, 1200);
  eq('config: the pay floor is parsed from compensation.minimum', cfg.floorMonthlyUsd, 1000);
  eq('config: the triage threshold is read', cfg.threshold, 3.5);
  writeFileSync(profile, yml('null'));
  eq('config: a null bridge threshold stays null', loadRoleTierConfig(profile).bridgeMinMonthlyUsd, null);
  eq('config: a missing profile degrades to empty', loadRoleTierConfig(join(dir, 'nope.yml')).tiers, {});
  writeFileSync(profile, 'role_tiers: [not, a, map\n');
  eq('config: a broken profile degrades to empty', loadRoleTierConfig(profile).tiers, {});
  writeFileSync(profile, yml(1200));

  const ev = evaluateRole({ title: 'Medical Interpreter', score: 4.8, payMonthlyUsd: 1500 }, loadRoleTierConfig(profile));
  eq('evaluateRole: tier, cap and bridge verdict', [ev.label, ev.policy.effectiveScore, ev.policy.verdict], ['T3', 3.5, 'PASS']);

  const seenFile = join(root, 'data', 'seen-jobs.json');
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_SEEN_JOBS: seenFile };
  const cli = (args) => spawnSync(NODE, [join(ROOT, 'role-tier.mjs'), ...args], { encoding: 'utf8', env });

  const c1 = cli(['classify', 'Medical Interpreter', '--score', '4.8', '--pay', '1500']);
  eq('CLI classify: T3 that beats current pay', /^T3/.test(c1.stdout) && /verdict PASS/.test(c1.stdout), true);
  const c2 = cli(['classify', 'Medical Interpreter', '--score', '4.8', '--pay', '1000', '--json']);
  eq('CLI classify --json: at or below current pay is FAIL', JSON.parse(c2.stdout).policy.verdict, 'FAIL');
  eq('CLI classify: an unmatched title says so', /no tier matches/.test(cli(['classify', 'Pastry Chef']).stdout), true);
  eq('CLI classify without a title exits 2', cli(['classify']).status, 2);
  eq('CLI with no command exits 2', cli([]).status, 2);

  // board: a tracker with three applications
  writeFileSync(join(root, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-09-01 | Alpha | Medical Interpreter | 4.6/5 | Applied | ❌ | [1](reports/001-a.md) | |',
    '| 2 | 2026-09-02 | Beta | Senior Backend Engineer | 3.9/5 | Interview | ❌ | [2](reports/002-b.md) | |',
    '| 3 | 2026-09-03 | Gamma | Solutions Architect | 4.5/5 | Evaluated | ❌ | [3](reports/003-c.md) | |',
    '| 4 | 2026-09-04 | Delta | Pastry Chef | 2.0/5 | SKIP | ❌ | [4](reports/004-d.md) | |',
    '',
  ].join('\n'));
  const board = JSON.parse(cli(['board', '--json']).stdout);
  eq('board orders T1, T2, T3, unclassified', board.map((r) => r.company), ['Beta', 'Gamma', 'Alpha', 'Delta']);
  eq('board labels each row', board.map((r) => r.label), ['T1', 'T2', 'T3', '—']);
  eq('board keeps each row\'s raw score', board.map((r) => r.score), [3.9, 4.5, 4.6, 2]);
  eq('board text groups by tier', /T1 — career target[\s\S]*T2 — adjacent[\s\S]*T3 — bridge[\s\S]*Unclassified/.test(cli(['board']).stdout), true);

  // rank-pipeline tags tiers in the state, then shortlist and set-pay use it
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'fakerank');
  writeFileSync(fake, `#!/bin/sh\necho '[{"id":0,"score":4.9,"reason":"great"},{"id":1,"score":4.4,"reason":"good"},{"id":2,"score":4.0,"reason":"ok"}]'\n`);
  chmodSync(fake, 0o755);
  writeFileSync(join(root, 'data', 'pipeline.md'), '## Pending\n- [ ] https://x.test/1 | XCo | Medical Interpreter\n- [ ] https://y.test/2 | YCo | Senior Backend Engineer\n- [ ] https://z.test/3 | ZCo | Solutions Architect\n');
  const rk = spawnSync(NODE, [join(ROOT, 'rank-pipeline.mjs'), '--cli', 'fakerank'], { encoding: 'utf8', env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
  eq('rank-pipeline runs', rk.status, 0);
  const st = loadSeenJobs(seenFile).state;
  eq('rank-pipeline tagged the tiers in the state', [st.jobs[keyFor('https://x.test/1')].tier.tier, st.jobs[keyFor('https://y.test/2')].tier.tier, st.jobs[keyFor('https://z.test/3')].tier.tier], [3, 1, 2]);

  const sl = JSON.parse(cli(['shortlist', '--json']).stdout);
  eq('shortlist puts T1 first even with a lower raw score', sl.map((r) => r.company), ['YCo', 'ZCo', 'XCo']);
  eq('shortlist caps T2 at 4.0 and T3 at 3.5', sl.map((r) => r.score), [4.4, 4, 3.5]);
  eq('shortlist keeps the raw rank', sl.find((r) => r.company === 'XCo').rawScore, 4.9);
  eq('a T3 role with unstated pay is only MARGINAL', sl.find((r) => r.company === 'XCo').verdict, 'MARGINAL');

  eq('set-pay records the pay', cli(['set-pay', 'https://x.test/1', '1800']).status, 0);
  const sl2 = JSON.parse(cli(['shortlist', '--json']).stdout);
  eq('…and the bridge role now PASSes (beats 1200)', sl2.find((r) => r.company === 'XCo').verdict, 'PASS');
  eq('set-pay for an unknown posting exits 1', cli(['set-pay', 'https://nope.test/9', '1800']).status, 1);
  eq('set-pay with a bad amount exits 2', cli(['set-pay', 'https://x.test/1', 'lots']).status, 2);
  eq('seen-jobs list --sort tier uses the tiers', spawnSync(NODE, [join(ROOT, 'seen-jobs.mjs'), 'list', '--sort', 'tier', '--json'], { encoding: 'utf8', env }).stdout.includes('"tier": 1'), true);

  eq('shortlist with no ranked postings exits 1', (rmSync(seenFile, { force: true }), cli(['shortlist']).status), 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
eq('the example profile documents role_tiers', /role_tiers/.test(readFileSync(join(ROOT, 'config/profile.example.yml'), 'utf8')), true);
eq('oferta.md points at the tier command', /role-tier\.mjs classify/.test(readFileSync(join(ROOT, 'modes/oferta.md'), 'utf8')), true);
