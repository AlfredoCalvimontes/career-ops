// tests/mode-lint.test.mjs — mode/skill linter (lib/mode-lint.mjs, scripts/lint-modes.mjs)
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import {
  extractScriptRefs, extractNpmScripts, extractModeRefs, extractLinks, extractConfigKeys,
  lintFile, keyPaths, commentedKeys, parityReport,
} from '../lib/mode-lint.mjs';

console.log('\nmode linter — dead references and structure');

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name);
  else fail(`${name} — expected ${e}, got ${a}`);
}
const refs = (list) => list.map((r) => r.ref);

// ── extraction ────────────────────────────────────────────────────────────
eq('backticked .mjs is a script ref', refs(extractScriptRefs('Run `scan.mjs` now.')), ['scan.mjs']);
eq('`node x.mjs` in a fence is a script ref', refs(extractScriptRefs('```bash\nnode tracker.mjs sync\n```')), ['tracker.mjs']);
eq('`node ./x.mjs` drops the ./', refs(extractScriptRefs('node ./find.mjs foo')), ['find.mjs']);
eq('a path with directories is kept whole', refs(extractScriptRefs('`lib/gates.mjs`')), ['lib/gates.mjs']);
eq('prose without backticks or `node` is not a ref', refs(extractScriptRefs('the scan.mjs script')), []);
eq('the same ref on two lines is two findings (line-accurate)', extractScriptRefs('`a.mjs`\n`a.mjs`').map((r) => r.line), [1, 2]);

eq('npm run names are extracted', refs(extractNpmScripts('npm run verify:host -- url\nnpm run lint')), ['verify:host', 'lint']);
eq('mode refs need backticks and modes/', refs(extractModeRefs('See `modes/apply.md` and modes/nope.md')), ['modes/apply.md']);
eq('a leading ./ is dropped from a mode ref', refs(extractModeRefs('`./modes/scan.md`')), ['modes/scan.md']);

eq('relative links are extracted', refs(extractLinks('[a](docs/X.md) and [b](https://x.io) and [c](#top)')), ['docs/X.md']);
eq('a link fragment is stripped', refs(extractLinks('[a](docs/X.md#sec)')), ['docs/X.md']);
eq('links inside code fences are ignored', refs(extractLinks('```\n[a](docs/X.md)\n```')), []);
eq('links inside inline code are examples, not links', refs(extractLinks('use `[001](reports/001.md)` syntax')), []);
eq('images are not links', refs(extractLinks('![img](a.png)')), []);
eq('mailto is skipped', refs(extractLinks('[m](mailto:a@b.co)')), []);

eq('config keys use the arrow form', refs(extractConfigKeys('`config/profile.yml → location.authorized_in`')), ['location.authorized_in']);
eq('the ascii arrow works too', refs(extractConfigKeys('profile.yml -> latex.source')), ['latex.source']);
eq('a single word is not a key path', refs(extractConfigKeys('profile.yml → language')), []);

// ── lintFile ──────────────────────────────────────────────────────────────
const present = new Set(['scan.mjs', 'providers/workday.mjs', 'modes/apply.md', 'docs/OK.md', 'modes/docs/rel.md']);
const ctx = {
  exists: (p) => present.has(p),
  isUserPath: (p) => p.startsWith('reports/') || p === 'cv.md' || p === 'modes/_profile.md',
  npmScripts: new Set(['lint', 'verify:host']),
  profileKeys: new Set(['location', 'location.authorized_in', 'latex', 'latex.source']),
  resolveFrom: (file, ref) => (ref.startsWith('docs/') ? ref : ref.startsWith('../') ? ref.slice(3) : `modes/${ref}`),
};
const lint = (file, text) => lintFile(file, text, ctx).map((f) => `${f.rule}:${f.line}`);

eq('a real script passes', lint('modes/a.md', '`scan.mjs`'), []);
eq('a missing script is an error', lint('modes/a.md', '`nope.mjs`'), ['script-ref:1']);
eq('a bare name is found under providers/', lint('modes/a.md', '`workday.mjs`'), []);
eq('a placeholder script name is skipped', lint('modes/a.md', '`{name}.mjs` and `<x>.mjs`'), []);
eq('a script under plugins.local/ is user-created, exempt', lint('modes/a.md', '`plugins.local/x/index.mjs`'), []);
eq('an undefined npm script is an error', lint('modes/a.md', 'npm run nothing'), ['npm-script:1']);
eq('a defined npm script passes', lint('modes/a.md', 'npm run lint'), []);
eq('a missing mode file is an error', lint('modes/a.md', '`modes/ghost.md`'), ['mode-ref:1']);
eq('a user-layer mode file is exempt (absent in a fresh checkout)', lint('modes/a.md', '`modes/_profile.md`'), []);
eq('a dead link is an error', lint('modes/a.md', '[x](docs/GONE.md)'), ['link:1']);
eq('a live link passes', lint('modes/a.md', '[x](docs/OK.md)'), []);
eq('a link into the user layer is exempt', lint('modes/a.md', '[x](../reports/001.md)'), []);
eq('an unknown config key is a warning', lint('modes/a.md', '`config/profile.yml → location.nope`'), ['config-key:1']);
eq('a known config key passes', lint('modes/a.md', '`config/profile.yml → location.authorized_in`'), []);
eq('a parent of known keys passes', lint('modes/a.md', '`config/profile.yml → latex.source`'), []);
eq('severity: config keys warn, scripts error', [lintFile('m.md', '`nope.mjs` profile.yml → location.zz', ctx).map((f) => f.severity)].flat().sort(), ['error', 'warn']);
eq('findings carry the message', lintFile('m.md', '`nope.mjs`', ctx)[0].message, 'script not found: nope.mjs');

eq('SKILL.md without frontmatter fails both fields', lint('.claude/skills/x/SKILL.md', '# no frontmatter'), ['frontmatter:1', 'frontmatter:1']);
eq('SKILL.md with name and description passes', lint('.claude/skills/x/SKILL.md', '---\nname: x\ndescription: does x\n---\n# x'), []);
eq('SKILL.md missing only a description fails once', lint('.claude/skills/x/SKILL.md', '---\nname: x\n---\n'), ['frontmatter:1']);
eq('frontmatter is only required of SKILL.md', lint('modes/a.md', '# plain mode'), []);
eq('no profile keys available disables the key check', lintFile('m.md', 'profile.yml → a.b', { ...ctx, profileKeys: null }).length, 0);

// ── YAML helpers ──────────────────────────────────────────────────────────
eq('keyPaths lists nested keys', [...keyPaths({ a: { b: 1, c: { d: 2 } }, e: 3 })].sort(), ['a', 'a.b', 'a.c', 'a.c.d', 'e']);
eq('keyPaths ignores arrays and scalars', [...keyPaths({ a: [1, 2], b: 'x' })].sort(), ['a', 'b']);
eq('commented keys are found with their parents', [...commentedKeys('# pipeline:\n#   triage_threshold: 3.5\nlocation:\n  # regions: [X]\n')].sort(), ['location.regions', 'pipeline', 'pipeline.triage_threshold']);
eq('a commented top-level key is not nested under the previous live key', [...commentedKeys('language:\n  output: en\n# latex:\n#   source: r.tex\n')].sort(), ['latex', 'latex.source']);

// ── parity ────────────────────────────────────────────────────────────────
const par = parityReport(['a.md', 'b.md', 'c.md'], { es: ['a.md', 'b.md'], de: ['a.md', 'b.md', 'c.md'], fr: [] });
eq('parity lists what a language lacks', par.es, { have: 2, missing: ['c.md'] });
eq('a complete language lacks nothing', par.de.missing, []);
eq('an empty language lacks everything', par.fr.missing, ['a.md', 'b.md', 'c.md']);

// ── the CLI and the real repository ───────────────────────────────────────
const run = (args) => spawnSync(NODE, [join(ROOT, 'scripts/lint-modes.mjs'), ...args], { encoding: 'utf8' });
const strict = run(['--strict']);
eq('the repository has no lint errors (strict, no baseline)', strict.status, 0);
const js = JSON.parse(run(['--json']).stdout);
eq('--json reports counts', typeof js.errors === 'number' && typeof js.warnings === 'number', true);
eq('the repo has no dead script, mode or link references', js.findings.filter((f) => f.severity === 'error').length, 0);
eq('--parity lists translation folders', /Translation parity/.test(run(['--parity']).stdout), true);
eq('--rule needs a name', run(['--rule']).status, 2);
eq('--rule filters findings', JSON.parse(run(['--json', '--rule', 'link']).stdout).findings.every((f) => f.rule === 'link'), true);

// A planted dead reference is caught (proves the gate can fail), then removed.
const tmp = mkdtempSync(join(tmpdir(), 'career-ops-lint-'));
try {
  const target = join(ROOT, 'modes', '_lint-fixture.tmp.md');
  writeFileSync(target, 'Run `definitely-missing-script.mjs` and see `modes/missing-mode.md`.\n');
  const bad = run(['--strict']);
  eq('a planted dead reference fails the run', bad.status, 1);
  eq('…and is named with file and line', /_lint-fixture\.tmp\.md:1 \[script-ref\]/.test(bad.stderr), true);
  rmSync(target, { force: true });
  eq('removing it restores a clean run', run(['--strict']).status, 0);
} finally {
  rmSync(join(ROOT, 'modes', '_lint-fixture.tmp.md'), { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
eq('the baseline file is valid JSON when present', (() => { try { JSON.parse(readFileSync(join(ROOT, 'scripts/lint-modes-baseline.json'), 'utf8')); return true; } catch (e) { return e.code === 'ENOENT'; } })(), true);
