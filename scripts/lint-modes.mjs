#!/usr/bin/env node
/**
 * scripts/lint-modes.mjs — lint the mode and skill files agents obey.
 *
 *   node scripts/lint-modes.mjs [--strict] [--json] [--parity] [--rule <name>]
 *
 * Checks every English mode (modes/**\/*.md outside the translation folders) and
 * every file under .claude/skills for dead script / npm / mode / link references
 * and missing SKILL.md frontmatter (see lib/mode-lint.mjs). The top-level agent
 * docs' script references are covered by tests/agent-docs-script-refs.test.mjs. Known,
 * accepted findings live in scripts/lint-modes-baseline.json, so the check gates
 * NEW problems without demanding the whole backlog be fixed first.
 *
 *   default   report; exit 1 only on a NEW error (not in the baseline)
 *   --strict  ignore the baseline; exit 1 on any error
 *   --parity  also report how many English modes each translation folder lacks
 *             (info only; add --verbose to list the file names)
 *   --write-baseline   record the current errors as the accepted baseline
 *
 * Exit 0 clean, 1 new error(s), 2 bad usage.
 */

import { existsSync, globSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, posix } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { commentedKeys, keyPaths, lintFile, parityReport } from '../lib/mode-lint.mjs';
import { USER_PATHS } from '../update-system.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { isUnderNestedCheckout } from '../lib/mjs-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'lint-modes-baseline.json');

/** Translation folders under modes/ (ISO-ish language codes). */
const LANG_DIRS = ['ar', 'da', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'tr', 'ua', 'zh', 'zh-TW'];

const isUserPath = (p) => USER_PATHS.some((u) => (u.endsWith('/') ? p.startsWith(u) : p === u));
const exists = (p) => existsSync(join(ROOT, p));

/** Repo-relative markdown files matching a glob (fs.globSync: Node 22+, like the other validators). */
function markdownGlob(pattern) {
  // A nested checkout (a worktree or clone inside this tree) is not this repository's source.
  return globSync(pattern, { cwd: ROOT })
    .map((p) => p.split('\\').join('/'))
    .filter((rel) => !isUnderNestedCheckout(ROOT, rel));
}

export function collectTargets() {
  const modes = markdownGlob('modes/**/*.md').filter((f) => !LANG_DIRS.includes(f.split('/')[1]));
  return [...modes, ...markdownGlob('.claude/skills/**/*.md')].sort();
}

function profileKeys() {
  const p = join(ROOT, 'config', 'profile.example.yml');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  try {
    return new Set([...keyPaths(yaml.load(text) ?? {}), ...commentedKeys(text)]);
  } catch {
    return null;
  }
}

export function lintRepo() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ctx = {
    exists,
    isUserPath,
    npmScripts: new Set([...Object.keys(pkg.scripts ?? {}), 'test', 'start', 'install', 'ci']),
    profileKeys: profileKeys(),
    resolveFrom: (file, ref) => (ref.startsWith('/') ? ref.slice(1) : posix.normalize(posix.join(posix.dirname(file), ref))),
  };
  const findings = [];
  for (const file of collectTargets()) {
    for (const f of lintFile(file, readFileSync(join(ROOT, file), 'utf8'), ctx)) findings.push({ file, ...f });
  }
  return findings;
}

/** Stable identity of a finding for baselining (line numbers drift, so they are excluded). */
export const fingerprint = (f) => `${f.file}|${f.rule}|${f.message}`;

function loadBaseline() {
  try {
    return new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).accepted ?? []);
  } catch {
    return new Set();
  }
}

function parity() {
  const modesDir = join(ROOT, 'modes');
  const english = readdirSync(modesDir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md');
  const byLang = {};
  for (const lang of LANG_DIRS) {
    const d = join(modesDir, lang);
    if (existsSync(d)) byLang[lang] = readdirSync(d).filter((f) => f.endsWith('.md'));
  }
  return parityReport(english, byLang);
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const json = args.includes('--json');
  const ri = args.indexOf('--rule');
  const only = ri >= 0 ? args[ri + 1] : null;
  if (ri >= 0 && !only) {
    console.error('lint-modes: --rule needs a name');
    process.exit(2);
  }

  let findings = lintRepo();
  if (only) findings = findings.filter((f) => f.rule === only);

  if (args.includes('--write-baseline')) {
    const accepted = [...new Set(findings.filter((f) => f.severity === 'error').map(fingerprint))].sort();
    writeFileSync(BASELINE, `${JSON.stringify({ note: 'Accepted lint-modes errors. Fix them and re-run --write-baseline to shrink this list; never grow it to hide a new problem.', accepted }, null, 2)}\n`);
    console.log(`lint-modes: baseline written (${accepted.length} accepted error(s))`);
    return 0;
  }

  const baseline = strict ? new Set() : loadBaseline();
  const errors = findings.filter((f) => f.severity === 'error');
  const newErrors = errors.filter((f) => !baseline.has(fingerprint(f)));
  const warns = findings.filter((f) => f.severity === 'warn');
  const stale = [...baseline].filter((fp) => !errors.some((e) => fingerprint(e) === fp));

  if (json) {
    console.log(JSON.stringify({ errors: errors.length, newErrors: newErrors.length, warnings: warns.length, staleBaseline: stale.length, findings, ...(args.includes('--parity') ? { parity: parity() } : {}) }, null, 2));
  } else {
    for (const f of newErrors) console.error(`✗ ${f.file}:${f.line} [${f.rule}] ${f.message}`);
    for (const f of warns) console.log(`⚠ ${f.file}:${f.line} [${f.rule}] ${f.message}`);
    if (args.includes('--parity')) {
      console.log('\nTranslation parity (English modes each language folder lacks):');
      for (const [lang, r] of Object.entries(parity())) console.log(`  ${lang.padEnd(6)} has ${String(r.have).padStart(2)}, missing ${r.missing.length}${r.missing.length && args.includes('--verbose') ? `: ${r.missing.join(', ')}` : ''}`);
    }
    const accepted = errors.length - newErrors.length;
    console.log(`\nlint-modes: ${collectTargets().length} files, ${newErrors.length} new error(s), ${accepted} accepted (baseline), ${warns.length} warning(s)${stale.length ? `, ${stale.length} baseline entr(ies) now fixed — re-run --write-baseline` : ''}`);
  }
  return newErrors.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exit(main());
