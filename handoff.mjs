#!/usr/bin/env node
/**
 * handoff.mjs — export a self-contained prompt for a cheaper AI.
 *
 *   node handoff.mjs <strategy|market|practice|outreach> [options]
 *
 *   --input <file>       untrusted DATA (a job description, a contact's profile);
 *                        repeatable, up to 10. `market` needs at least one.
 *   --with-cv            also include cv.md as FACTS (default: only modes/_brief.md)
 *   --role "<title>"     practice: the role being interviewed for
 *   --company "<name>"   practice: the company
 *   --round <type>       practice: screening | hiring-manager | technical | design | behavioral
 *   --contact <type>     outreach: recruiter | hiring-manager | peer
 *   --limit <n>          outreach: connection-note character limit (default 300; 200 on a free account)
 *   --keep-contact       do not redact emails and phone numbers from FACTS
 *   --out <file>         write the prompt to a file instead of stdout (refuses to overwrite without --force)
 *   --json               print {prompt, tokens, redacted, warnings} as JSON
 *
 * FACTS are read from primary, user-authored files only: modes/_brief.md, and cv.md
 * with --with-cv. story-bank.md is never included — its numbers are unverified by
 * design (AGENTS.md → Source-of-Truth Boundary). Read-only, no network, no LLM.
 * Exit 0 ok, 1 a required source is missing, 2 bad usage.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { buildPrompt, CONTACT_TYPES, MAX_INPUTS, ROUNDS, TASKS } from './lib/handoff.mjs';

const SYSTEM_ROOT = dirname(fileURLToPath(import.meta.url));
const VALUE_FLAGS = ['--input', '--role', '--company', '--round', '--contact', '--limit', '--out'];
const BOOL_FLAGS = ['--with-cv', '--keep-contact', '--json', '--force', '--help'];

class UsageError extends Error {}
class MissingSource extends Error {}

/** Every value of a repeatable flag, in argv order (`--f v` and `--f=v`). */
export function flagValues(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new UsageError(`${flag} needs a value`); out.push(args[++i]); }
    else if (args[i].startsWith(`${flag}=`)) out.push(args[i].slice(flag.length + 1));
  }
  return out;
}

function validate(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const name = a.split('=')[0];
    if (BOOL_FLAGS.includes(name)) continue;
    if (VALUE_FLAGS.includes(name)) { if (!a.includes('=')) i += 1; continue; }
    throw new UsageError(`unknown flag: ${name}`);
  }
}

function readText(path, what) {
  if (!existsSync(path)) throw new MissingSource(`${what} not found: ${path}`);
  if (!statSync(path).isFile()) throw new UsageError(`${what} is not a file: ${path}`);
  return readFileSync(path, 'utf8');
}

function outputLanguage(root) {
  try {
    const p = join(root, 'config', 'profile.yml');
    if (!existsSync(p)) return 'en';
    const lang = yaml.load(readFileSync(p, 'utf8'))?.language?.output;
    return typeof lang === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(lang) ? lang : 'en';
  } catch { return 'en'; }
}

/** Run the CLI logic. Returns { stdout, stderr, code } and touches disk only for --out. */
export function run(argv, { root = getCareerOpsRoot(), systemRoot = SYSTEM_ROOT } = {}) {
  const err = [];
  try {
    const args = [...argv];
    if (args.length === 0 || hasFlag(args, '--help')) {
      return { stdout: `usage: node handoff.mjs <${Object.keys(TASKS).join('|')}> [options]\n`, stderr: '', code: args.length === 0 ? 2 : 0 };
    }
    const task = args.shift();
    if (!TASKS[task]) throw new UsageError(`unknown task: ${task} (expected ${Object.keys(TASKS).join(', ')})`);
    validate(args);

    const round = flagValue(args, '--round');
    if (round !== undefined && !ROUNDS.includes(round)) throw new UsageError(`--round must be one of: ${ROUNDS.join(', ')}`);
    const contact = flagValue(args, '--contact');
    if (contact !== undefined && !CONTACT_TYPES.includes(contact)) throw new UsageError(`--contact must be one of: ${CONTACT_TYPES.join(', ')}`);
    const limitRaw = flagValue(args, '--limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limitRaw !== undefined && !(Number.isInteger(limit) && limit >= 50 && limit <= 2000)) throw new UsageError('--limit must be an integer from 50 to 2000');

    const inputPaths = flagValues(args, '--input');
    if (inputPaths.length > MAX_INPUTS) throw new UsageError(`too many --input files (max ${MAX_INPUTS})`);
    const inputs = inputPaths.map((p) => ({ label: basename(p), text: readText(resolve(p), 'input file') }));

    const brief = join(root, 'modes', '_brief.md');
    if (!existsSync(brief)) throw new MissingSource('modes/_brief.md is missing — run `node doctor.mjs` to create it, then fill it in');
    const facts = [{ name: 'modes/_brief.md', text: readText(brief, 'brief') }];
    if (hasFlag(args, '--with-cv')) facts.push({ name: 'cv.md', text: readText(join(root, 'cv.md'), 'cv.md') });

    const dir = join(systemRoot, 'templates', 'handoff');
    const templates = { _frame: readText(join(dir, '_frame.md'), 'frame template'), [task]: readText(join(dir, `${task}.md`), `${task} template`) };

    const built = buildPrompt({
      task, templates, facts, inputs, language: outputLanguage(root),
      redact: !hasFlag(args, '--keep-contact'),
      params: { role: flagValue(args, '--role'), company: flagValue(args, '--company'), round, contactType: contact, limit },
    });

    const { prompt, redacted } = built;
    err.push(`handoff: ${task} prompt, ~${built.tokens} tokens; ${hasFlag(args, '--keep-contact') ? 'contact details KEPT (--keep-contact)' : `redacted ${redacted.emails} email(s), ${redacted.phones} phone number(s)`}`);
    for (const w of built.warnings) err.push(`handoff: warning: ${w}`);

    const out = flagValue(args, '--out');
    if (out !== undefined) {
      if (!out) throw new UsageError('--out needs a path');
      const target = resolve(out);
      if (existsSync(target) && !hasFlag(args, '--force')) throw new UsageError(`${out} exists; pass --force to overwrite`);
      writeFileSync(target, prompt);
      err.push(`handoff: wrote ${out}`);
      return { stdout: '', stderr: err.join('\n') + '\n', code: 0 };
    }
    if (hasFlag(args, '--json')) return { stdout: JSON.stringify({ task, tokens: built.tokens, redacted, warnings: built.warnings, prompt }, null, 2) + '\n', stderr: err.join('\n') + '\n', code: 0 };
    return { stdout: prompt, stderr: err.join('\n') + '\n', code: 0 };
  } catch (e) {
    if (e instanceof UsageError) return { stdout: '', stderr: `handoff: ${e.message}\n`, code: 2 };
    if (e instanceof MissingSource) return { stdout: '', stderr: `handoff: ${e.message}\n`, code: 1 };
    if (/^(unknown task|too many inputs|task ".*" needs|no facts)/.test(e.message)) return { stdout: '', stderr: `handoff: ${e.message}\n`, code: 2 };
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
