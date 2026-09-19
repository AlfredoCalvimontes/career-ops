#!/usr/bin/env node
/**
 * scripts/security-guards.mjs — make dangerous changes LOUD, not impossible.
 *
 * This repo ships code every user runs (`npm install`, agent skills, CI
 * workflows) and personal-data rules every user relies on. These guards fail
 * when one of those surfaces widens. A change that genuinely needs one must
 * update the allowlists below in the SAME diff, so the widening is explicit and
 * reviewable instead of buried in a large PR.
 *
 *   1. Agent permissions — `.claude/settings.json` (and `opencode.json`), when
 *      tracked: every `permissions.allow` entry must be allowlisted, and the
 *      `hooks` key must be empty. A hook runs automatically with no prompt, so
 *      it is strictly more dangerous than a pre-approved permission.
 *   2. Skill / agent grants — `allowed-tools` / `tools` in `.claude/**` and
 *      `.github/agents` frontmatter: every grant must be allowlisted.
 *   3. Install-time code — every tracked package.json: lifecycle scripts
 *      (preinstall, install, postinstall, prepare, prepack, ...) must match the
 *      allowlist exactly, `trustedDependencies` is forbidden, and dependencies
 *      may not point at a git URL, tarball or local path.
 *   4. Personal data — the files a user creates (cv.md, config/profile.yml,
 *      tracker, reports, documents, ...) must still be git-ignored, and every
 *      `!negation` in .gitignore must be allowlisted (a stray `!data/` would
 *      silently start committing a user's tracker).
 *   5. CI — a `pull_request_target` workflow must not check out the PR's head:
 *      that runs untrusted code with a privileged token.
 *
 * Zero dependencies. Exit 0 when clean, 1 with a failure list otherwise.
 * `npm run guards`.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Allowlists. Widening any of these is the point of the diff that does it. ──

/** Exact `permissions.allow` entries a tracked settings file may carry. */
export const ALLOWED_PERMISSIONS = new Set([
  // none: the repo ships no pre-approved agent permissions
]);

/** `allowed-tools` / `tools` grants a tracked skill or agent file may declare, per file. */
export const ALLOWED_SKILL_TOOLS = {
  '.github/agents/docs-drift.agent.md': ['read', 'search', 'execute'],
  '.github/agents/i18n-sync.agent.md': ['read', 'search', 'edit', 'execute'],
  '.github/agents/pr-brief.agent.md': ['read', 'search', 'github'],
  '.github/agents/repro.agent.md': ['read', 'search', 'execute'],
};

/** Exact lifecycle-script values, per package.json path. Anything else fails. */
export const ALLOWED_LIFECYCLE = {
  'package.json': {
    postinstall: 'npx playwright install chromium --with-deps || npx playwright install chromium --with-deps',
  },
};

export const LIFECYCLE_KEYS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'];

/** Every `!pattern` allowed in .gitignore. */
export const ALLOWED_NEGATIONS = new Set([
  '!data/.gitkeep', '!data/offers/', '!data/parser-output/', '!data/offers/.gitkeep',
  '!data/parser-output/**/', '!data/parser-output/.gitkeep', '!data/parser-output/**/.gitkeep',
  '!reports/.gitkeep', '!output/.gitkeep', '!batch/logs/.gitkeep', '!batch/tracker-additions/.gitkeep',
  '!jds/.gitkeep', '!interview-prep/', '!interview-prep/.gitkeep', '!interview-prep/sessions/',
  '!interview-prep/sessions/.gitkeep', '!interview-prep/sessions/README.md', '!writing-samples/README.md',
  '!web/package-lock.json', '!test-fixtures/**',
  '!documents/.gitkeep', '!documents/README.md',
]);

/** Paths a user creates. Each must resolve as git-ignored (checked with `git check-ignore`). */
export const MUST_BE_IGNORED = [
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'modes/_brief.md',
  'portals.yml',
  'article-digest.md',
  'data/applications.md',
  'data/pipeline.md',
  'data/contacts.tsv',
  'reports/001-example.md',
  'output/cv-example.pdf',
  'jds/example.md',
  'interview-prep/example.md',
  'documents/photo/profile.jpeg',
  'documents/equipment/desk.jpeg',
  'writing-samples/example.md',
];

// ── Pure checks (exported for tests). Each returns a list of failure strings. ──

export function checkPermissions(file, json) {
  const errors = [];
  let cfg;
  try {
    cfg = JSON.parse(json);
  } catch {
    return [`${file}: not valid JSON`];
  }
  for (const entry of cfg?.permissions?.allow ?? []) {
    if (!ALLOWED_PERMISSIONS.has(entry)) errors.push(`${file}: permissions.allow entry not allowlisted: ${JSON.stringify(entry)}`);
  }
  const hooks = cfg?.hooks;
  if (hooks && (Array.isArray(hooks) ? hooks.length : Object.keys(hooks).length)) {
    errors.push(`${file}: "hooks" must be empty; a hook runs automatically with no prompt`);
  }
  return errors;
}

/** Pull `allowed-tools` / `tools` grants out of a markdown file's YAML frontmatter. */
export function frontmatterToolGrants(md) {
  const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const grants = [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const k = lines[i].match(/^(allowed-tools|allowed_tools|tools)\s*:\s*(.*)$/i);
    if (!k) continue;
    const inline = k[2].trim();
    if (inline) {
      grants.push(...inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
    } else {
      for (let j = i + 1; j < lines.length && /^\s+-\s+/.test(lines[j]); j++) {
        grants.push(lines[j].replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
      }
    }
  }
  return grants;
}

export function checkSkillGrants(file, md) {
  const allowed = new Set(ALLOWED_SKILL_TOOLS[file] ?? []);
  return frontmatterToolGrants(md)
    .filter((g) => !allowed.has(g))
    .map((g) => `${file}: tool grant not allowlisted: ${JSON.stringify(g)}`);
}

export function checkPackageJson(file, json) {
  const errors = [];
  let pkg;
  try {
    pkg = JSON.parse(json);
  } catch {
    return [`${file}: not valid JSON`];
  }
  const allowed = ALLOWED_LIFECYCLE[file] ?? {};
  for (const key of LIFECYCLE_KEYS) {
    const val = pkg?.scripts?.[key];
    if (val === undefined) continue;
    if (allowed[key] !== val) errors.push(`${file}: lifecycle script "${key}" is not allowlisted (${JSON.stringify(val)})`);
  }
  for (const key of ['trustedDependencies', 'trustedDeps']) {
    if (pkg?.[key] !== undefined) errors.push(`${file}: "${key}" is forbidden`);
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg?.[section] ?? {})) {
      if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|\.{1,2}\/|\/)/i.test(String(spec)) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(String(spec))) {
        errors.push(`${file}: ${section}.${name} points outside the registry (${JSON.stringify(spec)})`);
      }
    }
  }
  return errors;
}

export function checkGitignoreNegations(gitignore) {
  return String(gitignore)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('!') && !ALLOWED_NEGATIONS.has(l))
    .map((l) => `.gitignore: negation not allowlisted: ${l} (it could re-include personal data)`);
}

export function checkWorkflow(file, yml) {
  const text = String(yml);
  if (!/^\s*pull_request_target\s*:/m.test(text) && !/\bpull_request_target\b/.test(text.split(/^jobs:/m)[0])) return [];
  const errors = [];
  // A checkout whose ref/repository comes from the PR head runs untrusted code with a write token.
  const checkoutBlocks = text.split(/uses:\s*actions\/checkout/).slice(1);
  for (const block of checkoutBlocks) {
    const step = block.split(/\n\s*-\s+(?:name|uses|run):/)[0];
    if (/github\.event\.pull_request\.head\.(sha|ref|repo)|github\.head_ref/.test(step)) {
      errors.push(`${file}: pull_request_target workflow checks out the PR head (untrusted code with a privileged token)`);
      break;
    }
  }
  return errors;
}

// ── Repo walk ─────────────────────────────────────────────────────────────

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null; // not a git checkout
  }
}

function isIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (err) {
    return err?.status === 1 ? false : null;
  }
}

export function runAll(root = ROOT) {
  const errors = [];
  const notes = [];
  const tracked = trackedFiles();
  if (tracked === null) {
    // A guard over what is COMMITTED means nothing outside a git checkout.
    return { errors: [], notes: ['not a git checkout: nothing tracked to guard, skipped'] };
  }
  const read = (f) => readFileSync(join(root, f), 'utf8');

  for (const f of tracked.filter((f) => /^(\.claude\/settings\.json|opencode\.json)$/.test(f))) {
    if (existsSync(join(root, f))) errors.push(...checkPermissions(f, read(f)));
  }
  if (!tracked.some((f) => f === '.claude/settings.json')) notes.push('no tracked .claude/settings.json (nothing pre-approved)');

  for (const f of tracked.filter((f) => /^(\.claude\/.+\.md|\.github\/agents\/.+\.md)$/i.test(f))) {
    if (existsSync(join(root, f))) errors.push(...checkSkillGrants(f, read(f)));
  }

  for (const f of tracked.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules/'))) {
    if (existsSync(join(root, f))) errors.push(...checkPackageJson(f, read(f)));
  }

  if (existsSync(join(root, '.gitignore'))) errors.push(...checkGitignoreNegations(read('.gitignore')));

  for (const p of MUST_BE_IGNORED) {
    if (isIgnored(p) === false) errors.push(`.gitignore: ${p} is NOT ignored; a user's personal data would be committed`);
  }

  for (const f of tracked.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f))) {
    if (existsSync(join(root, f))) errors.push(...checkWorkflow(f, read(f)));
  }
  return { errors, notes };
}

function main() {
  const { errors, notes } = runAll();
  for (const n of notes) console.log(`  · ${n}`);
  if (errors.length) {
    console.error('✗ security guards failed:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('\nIf the change is intentional, update the allowlists in scripts/security-guards.mjs in the same diff.');
    process.exit(1);
  }
  console.log('✓ security guards passed');
}

if (isMainModule(import.meta.url)) main();
