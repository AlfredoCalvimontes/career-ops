// tests/upstream-triage.test.mjs — upstream drift report (lib/upstream-triage.mjs, scripts/upstream-triage.mjs)
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { classifyCommit, safeText, conflictRisk, buildReport, renderMarkdown, UPSTREAM_REPO } from '../lib/upstream-triage.mjs';
import { safeRef, upstreamCommits, forkChangedFiles } from '../scripts/upstream-triage.mjs';

console.log('\nupstream triage — classification, escaping, conflict risk, git integration');

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name);
  else fail(`${name} — expected ${e}, got ${a}`);
}

// ── classification ────────────────────────────────────────────────────────
eq('feat', classifyCommit('feat(scan): add a provider').type, 'feat');
eq('fix with scope', classifyCommit('fix(doctor): pin locale').scope, 'doctor');
eq('the title drops the prefix', classifyCommit('docs: update the guide').title, 'update the guide');
eq('a bang is breaking', classifyCommit('feat(api)!: drop v1').type, 'breaking');
eq('a BREAKING CHANGE footer is breaking', classifyCommit('refactor: rework', 'notes\n\nBREAKING CHANGE: config moved').type, 'breaking');
eq('an unprefixed subject is other', classifyCommit('Update readme').type, 'other');
eq('an unknown type is other', classifyCommit('wip: stuff').type, 'other');
eq('deps maps to build', classifyCommit('deps: bump x').type, 'build');
eq('style maps to chore', classifyCommit('style: format').type, 'chore');
eq('a security keyword promotes the commit', classifyCommit('fix(providers): sanitize html in titles').type, 'security');
eq('a security scope promotes the commit', classifyCommit('fix(security): tighten paths').type, 'security');
eq('breaking outranks security', classifyCommit('fix(security)!: change token format').type, 'breaking');
eq('empty subject does not throw', classifyCommit('').type, 'other');
eq('null subject does not throw', classifyCommit(undefined).type, 'other');

// ── escaping third-party text ─────────────────────────────────────────────
eq('a mention never pings', /@​bob/.test(safeText('thanks @bob')), true);
eq('an email-like @ mid-word is left alone', safeText('mail a@b.co').includes('a@b.co'), true);
eq('pipes cannot break the table', safeText('a | b'), 'a \\| b');
eq('html is escaped', safeText('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
eq('backticks cannot open a code span', safeText('use `rm -rf`'), "use 'rm -rf'");
eq('a bare #N points at upstream, not the fork', safeText('fix crash (#4112)'), `fix crash (${UPSTREAM_REPO}#4112)`);
eq('an existing owner/repo#N is not double-rewritten', safeText('see other/repo#5'), 'see other/repo#5');
eq('a url fragment with # is not rewritten', safeText('https://x.io/a#12').includes(UPSTREAM_REPO), false);
eq('newlines collapse', safeText('a\nb\r\nc'), 'a b c');
eq('long text is truncated with an ellipsis', safeText('x'.repeat(300)).length, 140);

// ── conflict risk ─────────────────────────────────────────────────────────
const cr = conflictRisk([{ files: ['a.mjs', 'b.mjs'] }, { files: ['c.mjs'] }], ['b.mjs', 'z.mjs']);
eq('overlap lists the shared files', cr.map((c) => c.overlaps), [['b.mjs'], []]);
eq('a Set works too', conflictRisk([{ files: ['a'] }], new Set(['a']))[0].overlaps, ['a']);

// ── report / markdown ─────────────────────────────────────────────────────
const mk = (sha, subject, files = [], body = '') => ({ sha: sha.padEnd(40, '0'), subject, body, files, author: 'x', date: '2026-09-01T00:00:00Z' });
const commits = [
  mk('a1', 'feat(providers): new board', ['providers/x.mjs']),
  mk('b2', 'fix(oferta): score bug (#12)', ['modes/oferta.md']),
  mk('c3', 'docs: typo', ['README.md']),
  mk('d4', 'feat(api)!: drop v1', ['api.mjs']),
];
const rep = buildReport(commits, { forkChanged: ['modes/oferta.md'], base: 'upgrades', upstream: 'upstream/main', now: '2026-09-19' });
eq('total', rep.total, 4);
eq('counts by group', rep.counts, { breaking: 1, feat: 1, fix: 1, docs: 1 });
eq('one commit overlaps', rep.overlapping, 1);
eq('overlap files are listed', rep.overlapFiles, ['modes/oferta.md']);
const md = renderMarkdown(rep);
eq('markdown headlines the counts', /4 new upstream commits/.test(md), true);
eq('markdown flags the conflict risk', /1 commit touches files this fork changed/.test(md), true);
eq('markdown names the risky file', md.includes('`modes/oferta.md`'), true);
eq('breaking changes come first', md.indexOf('Breaking changes') < md.indexOf('Features'), true);
eq('docs are collapsed', /<details><summary>Docs \(1\)/.test(md), true);
eq('commit links point at upstream', md.includes(`https://github.com/${UPSTREAM_REPO}/commit/`), true);
eq('the issue ref is rewritten to upstream', md.includes(`${UPSTREAM_REPO}#12`), true);
eq('it says nothing is merged for you', /nothing is merged for you/.test(md), true);
eq('an empty report says up to date', /up to date/.test(renderMarkdown(buildReport([], { base: 'b', upstream: 'u' }))), true);
eq('a clean report says no overlap', /No new upstream commit touches/.test(renderMarkdown(buildReport([mk('e5', 'fix: y', ['q.mjs'])], { forkChanged: ['other'] }))), true);

const many = Array.from({ length: 200 }, (_, i) => mk(`f${i}`, `fix: change ${i}`, [`f${i}.mjs`]));
const big = renderMarkdown(buildReport(many, { maxListed: 50 }));
eq('a long list is capped', (big.match(/\| \[/g) || []).length, 50);
eq('…and says how many were left out', /150 more commit/.test(big), true);
eq('the capped body stays far below the GitHub limit', big.length < 60_000, true);

// hostile subjects cannot inject into the rendered table
const hostile = renderMarkdown(buildReport([mk('h1', 'fix: </details>| evil |@admin `x` #7', ['a'])], {}));
eq('a hostile subject keeps its row intact', /\| \[h100000\]/.test(hostile), true);
eq('…no raw html', hostile.includes('</details>| evil') === false && /&lt;\/details&gt;/.test(hostile), true);
eq('…no live mention', /@admin/.test(hostile) === false || /@​admin/.test(hostile), true);

// ── safeRef ───────────────────────────────────────────────────────────────
eq('a plain ref passes', safeRef('upstream/main'), 'upstream/main');
for (const bad of ['--upload-pack=x', '-x', 'a b', 'a..b', 'a;b\n', 'a~1', 'a^', 'a:b', '', 'a[0]', 'a\\b']) {
  let threw = false;
  try { safeRef(bad); } catch { threw = true; }
  eq(`safeRef rejects ${JSON.stringify(bad)}`, threw, true);
}

// ── real git: an upstream, a fork that diverged, and the report ───────────
const dir = mkdtempSync(join(tmpdir(), 'career-ops-upstream-'));
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.io', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.io', LC_ALL: 'C' } });
const write = (cwd, file, text) => { mkdirSync(join(cwd, file, '..'), { recursive: true }); writeFileSync(join(cwd, file), text); };
try {
  const up = join(dir, 'upstream');
  mkdirSync(up);
  g(up, 'init', '-q', '-b', 'main');
  write(up, 'a.txt', '1\n'); write(up, 'shared.txt', 'x\n');
  g(up, 'add', '-A'); g(up, 'commit', '-q', '-m', 'chore: initial');

  const fork = join(dir, 'fork');
  g(dir, 'clone', '-q', up, fork);
  g(fork, 'checkout', '-q', '-b', 'upgrades');
  write(fork, 'shared.txt', 'x fork edit\n'); write(fork, 'mine.txt', 'mine\n');
  g(fork, 'add', '-A'); g(fork, 'commit', '-q', '-m', 'feat: fork change');

  // upstream moves on: a fix touching a file the fork changed, a body with a blank line, a merge commit.
  write(up, 'shared.txt', 'x upstream edit\n');
  g(up, 'add', '-A'); g(up, 'commit', '-q', '-m', 'fix(core): change shared (#9)', '-m', 'first paragraph\n\nsecond paragraph');
  g(up, 'checkout', '-q', '-b', 'side');
  write(up, 'side.txt', 's\n'); g(up, 'add', '-A'); g(up, 'commit', '-q', '-m', 'docs: side note');
  g(up, 'checkout', '-q', 'main');
  g(up, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #10 from x/side', 'side');
  write(up, 'b.txt', '2\n'); g(up, 'add', '-A'); g(up, 'commit', '-q', '-m', 'feat(x)!: big change', '-m', 'BREAKING CHANGE: things moved');
  g(fork, 'fetch', '-q', 'origin', 'main');

  const found = upstreamCommits('upgrades', 'origin/main', fork);
  eq('three non-merge upstream commits are found', found.length, 3);
  eq('the merge commit is excluded', found.some((c) => /^Merge pull request/.test(c.subject)), false);
  eq('subjects are parsed', found.map((c) => c.subject).sort(), ['docs: side note', 'feat(x)!: big change', 'fix(core): change shared (#9)']);
  const fixC = found.find((c) => c.subject.startsWith('fix(core)'));
  eq('a multi-paragraph body survives with its blank line', fixC.body, 'first paragraph\n\nsecond paragraph');
  eq('files are attributed to the right commit', fixC.files, ['shared.txt']);
  eq('the breaking footer is in the body', found.find((c) => c.subject.startsWith('feat(x)')).body.includes('BREAKING CHANGE'), true);
  eq('fork-changed files are relative to the merge base', forkChangedFiles('upgrades', 'origin/main', fork).sort(), ['mine.txt', 'shared.txt']);

  const report = buildReport(found, { forkChanged: forkChangedFiles('upgrades', 'origin/main', fork), base: 'upgrades', upstream: 'origin/main' });
  eq('the fixture report has one conflict-risk commit', report.overlapping, 1);
  eq('…on shared.txt', report.overlapFiles, ['shared.txt']);
  eq('the breaking commit is grouped as breaking', report.counts.breaking, 1);

  // up to date: no commits
  eq('nothing new when base already has upstream', upstreamCommits('origin/main', 'origin/main', fork).length, 0);

  // an unsafe ref never reaches git
  let threw = false;
  try { upstreamCommits('--upload-pack=touch /tmp/pwned', 'origin/main', fork); } catch { threw = true; }
  eq('an option-shaped ref is refused before git runs', threw, true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── CLI usage and the workflow ────────────────────────────────────────────
const bad = spawnSync(NODE, [join(ROOT, 'scripts/upstream-triage.mjs'), '--base', '--evil'], { encoding: 'utf8' });
eq('the CLI refuses an option-shaped base with exit 2', bad.status, 2);
const wf = readFileSync(join(ROOT, '.github/workflows/upstream-watch.yml'), 'utf8');
eq('the workflow never runs on the upstream repo', /github\.repository != 'career-ops-hq\/career-ops'/.test(wf), true);
eq('the workflow is read-only on contents', /contents: read/.test(wf) && !/contents: write/.test(wf), true);
eq('the workflow does not use pull_request_target', /pull_request_target/.test(wf), false);
eq('report text goes through --body-file, never a shell string', /--body-file/.test(wf) && !/--body "/.test(wf), true);
eq('no workflow input is interpolated into a run script', !/run:[^\n]*\$\{\{ *inputs\./.test(wf) && !/run: \|[\s\S]{0,400}\$\{\{ *inputs\./.test(wf.split('- name: Pick the base branch')[0] || ''), true);
eq('the workflow never merges or pushes', !/git (merge|push|rebase|pull)\b/.test(wf), true);
