// tests/seen-jobs.test.mjs — persistent rank/gate/gap state (lib/seen-jobs.mjs, seen-jobs.mjs,
// and its use by rank-pipeline.mjs)
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import {
  emptyState, sanitizeState, keyFor, touch, setRank, getRank, setGates, setGaps, setExpired,
  listJobs, prune, gapSummary, loadSeenJobs, saveSeenJobs, withSeenJobs,
} from '../lib/seen-jobs.mjs';

console.log('\nseen-jobs — persistent per-posting state');

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name);
  else fail(`${name} — expected ${e}, got ${a}`);
}

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-10T00:00:00.000Z';

// ── pure operations ───────────────────────────────────────────────────────
let s = emptyState();
const k = touch(s, { url: 'https://Jobs.Lever.co/acme/123/?utm_source=x', company: 'Acme', title: 'Backend' }, T0);
eq('touch keys by the canonical URL (tracking params dropped, host lowercased)', k, 'https://jobs.lever.co/acme/123');
eq('a second spelling of the same URL is the same key', touch(s, { url: 'https://jobs.lever.co/acme/123' }, T1), k);
eq('touch refreshes lastSeen and keeps firstSeen', [s.jobs[k].firstSeen, s.jobs[k].lastSeen], [T0, T1]);
eq('an unkeyable URL yields no key', touch(s, { url: 'N/A' }), '');
eq('…and stores nothing', Object.keys(s.jobs).length, 1);

eq('a rank needs a reason', setRank(s, k, { score: 4, reason: '  ' }), false);
eq('a rank needs a numeric score', setRank(s, k, { score: 'abc', reason: 'x' }), false);
eq('a rank on an unknown key is refused', setRank(s, 'https://nope.test/x', { score: 4, reason: 'x' }), false);
eq('a good rank is stored', setRank(s, k, { score: 4.26, reason: 'strong python fit', cli: 'claude' }, T1), true);
eq('score is clamped to one decimal', getRank(s, k).score, 4.3);
eq('score above range is clamped', (setRank(s, k, { score: 9, reason: 'x' }), getRank(s, k).score), 5);
eq('a newline in the reason cannot survive', (setRank(s, k, { score: 3, reason: 'a\nb' }), getRank(s, k).reason), 'a b');

eq('gates are stored with verdicts', setGates(s, k, {
  eligibility: { verdict: 'PASS', kind: 'latam-remote', quote: 'Remote - LATAM', tags: ['remote-latam'], verified: true },
  language: { verdict: 'FLAG', quote: 'Native Spanish' },
}, T1), true);
eq('gate tags survive', s.jobs[k].gates.eligibility.tags, ['remote-latam']);
eq('an invalid verdict degrades to FLAG, never PASS', (setGates(s, k, { eligibility: { verdict: 'MAYBE' }, language: { verdict: 'PASS' } }), s.jobs[k].gates.eligibility.verdict), 'FLAG');

eq('gaps are deduped', (setGaps(s, k, ['Kubernetes', 'Kubernetes', 'Go', '']), s.jobs[k].gaps), ['Kubernetes', 'Go']);

const k2 = touch(s, { url: 'https://boards.greenhouse.io/beta/jobs/9', company: 'Beta', title: 'Full Stack' }, T0);
setRank(s, k2, { score: 2.0, reason: 'weak' }, T1);
setGaps(s, k2, ['Kubernetes', 'Rust']);
const k3 = touch(s, { url: 'https://example.com/jobs/3', company: 'Gamma', title: 'SRE' }, T0);
setGaps(s, k3, ['Terraform']);
setExpired(s, k3, 'closed', T1);

eq('list sorts by rank, best first', listJobs(s).map((j) => j.company), ['Acme', 'Beta', 'Gamma']);
eq('list --min-rank filters', listJobs(s, { minRank: 3 }).map((j) => j.company), ['Acme']);
eq('an unranked job never matches a min-rank filter', listJobs(s, { minRank: 0 }).some((j) => j.company === 'Gamma'), false);
eq('list --gate matches either gate', listJobs(s, { gate: 'FLAG' }).map((j) => j.company), ['Acme']);
eq('list --active hides expired', listJobs(s, { expired: false }).map((j) => j.company), ['Acme', 'Beta']);
eq('list --expired shows only expired', listJobs(s, { expired: true }).map((j) => j.company), ['Gamma']);

const gs = gapSummary(s);
eq('gap summary counts live postings only', gs.jobs, 2);
eq('gap summary is most-frequent first', gs.gaps[0], { skill: 'Kubernetes', count: 2 });
eq('an expired posting contributes no gaps', gs.gaps.some((g) => g.skill === 'Terraform'), false);
eq('gap summary honours a rank floor', gapSummary(s, { minRank: 3 }).gaps.map((g) => g.skill), ['Go', 'Kubernetes']);

eq('prune drops only stale postings (last seen before the cutoff)', (() => { const c = structuredClone(s); return prune(c, 5, Date.parse('2026-09-12T00:00:00Z')).sort(); })(), ['https://boards.greenhouse.io/beta/jobs/9', 'https://example.com/jobs/3']);
eq('prune keeps everything when nothing is old', prune(structuredClone(s), 365, Date.parse('2026-09-12T00:00:00Z')).length, 0);

// ── sanitizing ────────────────────────────────────────────────────────────
const dirty = sanitizeState({ version: 1, jobs: {
  'https://ok.test/1': { url: 'https://ok.test/1', company: 'Ok', title: 'T', firstSeen: T0, lastSeen: T1, rank: { score: 4, reason: 'fine', rankedAt: T1 } },
  'not-a-url': { url: 'x' },
  'https://bad.test/2': 'a string, not an object',
  'https://norank.test/3': { url: 'https://norank.test/3', rank: { score: 4, reason: '' } },
  'https://nan.test/4': { url: 'https://nan.test/4', rank: { score: null, reason: 'x' } },
} });
eq('sanitize keeps well-formed entries', Object.keys(dirty.jobs).filter((x) => dirty.jobs[x].rank).length, 1);
eq('sanitize drops entries whose key is not a URL and non-objects', Object.keys(dirty.jobs).sort(), ['https://nan.test/4', 'https://norank.test/3', 'https://ok.test/1']);
eq('sanitize drops a rank with no reason', dirty.jobs['https://norank.test/3'].rank, undefined);
eq('sanitize drops a null score instead of storing 0', dirty.jobs['https://nan.test/4'].rank, undefined);
eq('sanitize of garbage is an empty state', sanitizeState('junk'), emptyState());
eq('sanitize of null is an empty state', sanitizeState(null), emptyState());

// ── I/O ───────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'career-ops-seen-'));
try {
  const file = join(dir, 'seen-jobs.json');
  eq('a missing file loads as empty', loadSeenJobs(file), { state: emptyState(), recovered: null });

  saveSeenJobs(file, s);
  eq('save then load round-trips', Object.keys(loadSeenJobs(file).state.jobs).sort(), Object.keys(s.jobs).sort());
  eq('save leaves no temp file behind', readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0);

  writeFileSync(file, '{ this is not json');
  const rec = loadSeenJobs(file, 42);
  eq('a corrupt file loads as empty with a note', [Object.keys(rec.state.jobs).length, /corrupt/.test(rec.recovered)], [0, true]);
  eq('the corrupt original is kept, not overwritten', readFileSync(join(dir, 'seen-jobs.json.corrupt-42'), 'utf8'), '{ this is not json');
  writeFileSync(file, '[1,2,3]');
  eq('valid JSON of the wrong shape is also recovered', /corrupt/.test(loadSeenJobs(file, 43).recovered), true);

  // Concurrent read-modify-write under the lock must lose nothing.
  const cfile = join(dir, 'concurrent.json');
  await Promise.all(Array.from({ length: 12 }, (_, i) => withSeenJobs(cfile, (st) => {
    touch(st, { url: `https://x.test/job/${i}`, company: `C${i}`, title: 'T' });
  }, { timeoutMs: 20_000, retryMs: 10 })));
  eq('12 concurrent writers lose no posting', Object.keys(loadSeenJobs(cfile).state.jobs).length, 12);
  eq('the lock is released afterwards', existsSync(`${cfile}.lock`), false);

  // ── CLI ─────────────────────────────────────────────────────────────────
  const root = join(dir, 'root');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), 'location:\n  authorized_in: [Bolivia]\n  regions: [LATAM]\nlanguage:\n  spoken:\n    - { lang: es, level: native }\n    - { lang: en, level: c1 }\n');
  writeFileSync(join(root, 'cv.md'), '# CV\n\n## Skills\n- Python, PostgreSQL, Flask\n');
  const seenFile = join(root, 'data', 'seen-jobs.json');
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_SEEN_JOBS: seenFile };
  const cli = (args, input) => spawnSync(NODE, [join(ROOT, 'seen-jobs.mjs'), ...args], { encoding: 'utf8', env, input });

  const jdFile = join(dir, 'jd.md');
  writeFileSync(jdFile, 'Remote - LATAM.\n\nRequirements:\n- Python\n- Kubernetes\n- Terraform\n\nMust be a US citizen.');
  const g = cli(['record-gates', 'https://jobs.lever.co/acme/9?utm_source=z', '--jd', jdFile, '--company', 'Acme', '--title', 'Backend']);
  eq('CLI record-gates exits 0', g.status, 0);
  const shown = JSON.parse(cli(['show', 'https://jobs.lever.co/acme/9', '--json']).stdout);
  eq('CLI stored the eligibility verdict', shown.gates.eligibility.verdict, 'FAIL');
  eq('CLI stored the company and title', [shown.company, shown.title], ['Acme', 'Backend']);
  const gp = cli(['record-gaps', 'https://jobs.lever.co/acme/9', '--jd', jdFile]);
  eq('CLI record-gaps exits 0', gp.status, 0);
  const gapped = JSON.parse(cli(['show', 'https://jobs.lever.co/acme/9', '--json']).stdout);
  eq('CLI found skills the CV lacks', gapped.gaps.includes('Kubernetes') || gapped.gaps.includes('Terraform'), true);
  eq('CLI list --gate FAIL finds it', JSON.parse(cli(['list', '--gate', 'FAIL', '--json']).stdout).length, 1);
  eq('CLI expire marks it', cli(['expire', 'https://jobs.lever.co/acme/9', '--reason', 'closed']).status, 0);
  eq('CLI list --active hides it', JSON.parse(cli(['list', '--active', '--json']).stdout).length, 0);
  eq('CLI show of an unknown URL exits 1', cli(['show', 'https://nope.test/x']).status, 1);
  eq('CLI rejects an unkeyable URL with exit 2', cli(['record-gates', 'N/A', '--jd', jdFile]).status, 2);
  eq('CLI with no command exits 2', cli([]).status, 2);
  eq('CLI prune needs --days', cli(['prune']).status, 2);

  // ── rank-pipeline reuses stored ranks ───────────────────────────────────
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const counter = join(dir, 'calls.txt');
  const fake = join(bin, 'fakerank');
  writeFileSync(fake, `#!/bin/sh\necho x >> "${counter}"\necho '[{"id":0,"score":4.2,"reason":"good fit"},{"id":1,"score":3.1,"reason":"ok fit"}]'\n`);
  chmodSync(fake, 0o755);
  const pipeline = join(root, 'data', 'pipeline.md');
  const rows = ['- [ ] https://a.test/1 | Alpha | Backend Engineer', '- [ ] https://b.test/2 | Beta | Full Stack'];
  writeFileSync(pipeline, `## Pending\n${rows.join('\n')}\n`);
  const rank = () => spawnSync(NODE, [join(ROOT, 'rank-pipeline.mjs'), '--cli', 'fakerank'], { encoding: 'utf8', env: { ...env, PATH: `${bin}:${process.env.PATH}` } });

  const r1 = rank();
  eq('rank-pipeline scores new rows', r1.status, 0);
  eq('…with one CLI call', readFileSync(counter, 'utf8').trim().split('\n').length, 1);
  eq('…annotating the pipeline', /rank: 4\.2\/5 — good fit/.test(readFileSync(pipeline, 'utf8')), true);
  const stored = loadSeenJobs(seenFile).state;
  eq('…and recording the ranks in the state', [getRank(stored, keyFor('https://a.test/1')).score, getRank(stored, keyFor('https://b.test/2')).score], [4.2, 3.1]);
  eq('…with the company and title', stored.jobs[keyFor('https://a.test/1')].company, 'Alpha');

  // The rows come back un-annotated (re-added by a scan): the stored rank is reused, no CLI call.
  writeFileSync(pipeline, `## Pending\n${rows.join('\n')}\n`);
  const r2 = rank();
  eq('a re-added, already-ranked row costs no CLI call', readFileSync(counter, 'utf8').trim().split('\n').length, 1);
  eq('…and is annotated from the stored rank', /rank: 4\.2\/5 — good fit/.test(readFileSync(pipeline, 'utf8')), true);
  eq('…and says so', /reused a stored rank/.test(r2.stdout), true);

  // A new row alongside cached ones: only the new one is scored.
  writeFileSync(pipeline, `## Pending\n${rows.join('\n')}\n- [ ] https://c.test/3 | Gamma | Node Engineer\n`);
  rank();
  eq('a new row alongside cached ones costs exactly one more call', readFileSync(counter, 'utf8').trim().split('\n').length, 2);

  // A cached-only run must not need any CLI at all.
  writeFileSync(pipeline, `## Pending\n${rows.join('\n')}\n`);
  const noCli = spawnSync(NODE, [join(ROOT, 'rank-pipeline.mjs')], { encoding: 'utf8', env: { ...env, PATH: '/nonexistent' } });
  eq('a fully cached run needs no agent CLI', noCli.status, 0);
  eq('…and still annotates', /rank: 4\.2\/5/.test(readFileSync(pipeline, 'utf8')), true);

  // A corrupt state file must not break ranking.
  writeFileSync(seenFile, '{ nope');
  writeFileSync(pipeline, `## Pending\n${rows.join('\n')}\n`);
  const r3 = rank();
  eq('a corrupt rank state does not break ranking', r3.status, 0);
  eq('…it says so on stderr', /rank state corrupt/.test(r3.stderr), true);
  eq('…and the original is kept', readdirSync(join(root, 'data')).some((f) => f.startsWith('seen-jobs.json.corrupt-')), true);

  // Dry runs write no state.
  rmSync(seenFile, { force: true });
  writeFileSync(pipeline, `## Pending\n${rows.join('\n')}\n`);
  spawnSync(NODE, [join(ROOT, 'rank-pipeline.mjs'), '--cli', 'fakerank', '--dry-run'], { encoding: 'utf8', env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
  eq('--dry-run writes no rank state', existsSync(seenFile), false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
