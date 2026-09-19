#!/usr/bin/env node
/**
 * scripts/upstream-triage.mjs — what is new upstream, and will it conflict?
 *
 *   node scripts/upstream-triage.mjs [--base upgrades] [--upstream upstream/main]
 *                                    [--fetch] [--json] [--out report.md]
 *
 * Lists upstream commits your base branch does not have (non-merge commits),
 * classifies them by Conventional Commit type, and flags the ones that touch
 * files your branch changed since the two diverged. Prints Markdown (or JSON).
 * It only reads git history: it never merges, rebases, commits or pushes.
 * `--fetch` first runs `git fetch <remote> <branch>` for the upstream ref.
 *
 * Exit 0 on success (even with new commits), 2 on bad usage or a git failure.
 * `npm run upstream:watch`. The weekly workflow (.github/workflows/upstream-watch.yml)
 * uses `--out` to fill a single tracking issue.
 */

import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildReport, renderMarkdown } from '../lib/upstream-triage.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEP = '\x1f';
const REC = '\x1e';
const GS = '\x1d';

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
}

/** A ref name is never allowed to look like an option or contain whitespace/control characters. */
export function safeRef(ref) {
  const r = String(ref ?? '');
  if (!r || r.startsWith('-') || /[\s\x00-\x1f~^:?*[\\]/.test(r) || r.includes('..')) throw new Error(`unsafe ref: ${JSON.stringify(ref)}`);
  return r;
}

/**
 * Commits in `upstream` that `base` lacks, with the files each one touched.
 * @returns {{sha: string, author: string, date: string, subject: string, body: string, files: string[]}[]}
 */
export function upstreamCommits(base, upstream, cwd = ROOT) {
  safeRef(base);
  safeRef(upstream);
  // Record = RS sha US author US date US subject US body GS, then --name-only's file list.
  const raw = git(['log', '--no-merges', `--format=%x1e%H${SEP}%an${SEP}%aI${SEP}%s${SEP}%b%x1d`, '--name-only', `${base}..${upstream}`], cwd);
  return raw
    .split(REC)
    .filter((r) => r.trim())
    .map((rec) => {
      const [head, fileBlock = ''] = rec.split(GS);
      const [sha, author, date, subject, ...bodyParts] = head.split(SEP);
      return {
        sha: sha.trim(),
        author,
        date,
        subject,
        body: bodyParts.join(SEP).trim(),
        files: fileBlock.split('\n').map((l) => l.trim()).filter(Boolean),
      };
    });
}

/** Files the base branch changed since it diverged from upstream. */
export function forkChangedFiles(base, upstream, cwd = ROOT) {
  safeRef(base);
  safeRef(upstream);
  const mb = git(['merge-base', base, upstream], cwd).trim();
  return git(['diff', '--name-only', `${mb}..${base}`], cwd).split('\n').map((l) => l.trim()).filter(Boolean);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const base = flag(args, '--base') ?? 'upgrades';
  const upstream = flag(args, '--upstream') ?? 'upstream/main';
  try {
    if (args.includes('--fetch')) {
      const [remote, ...branch] = safeRef(upstream).split('/');
      git(['fetch', '--no-tags', '--quiet', remote, branch.join('/')]);
    }
    const commits = upstreamCommits(base, upstream);
    const forkChanged = forkChangedFiles(base, upstream);
    const report = buildReport(commits, { forkChanged, base, upstream, now: new Date().toISOString().slice(0, 10) });
    const text = args.includes('--json')
      ? JSON.stringify({ total: report.total, counts: report.counts, overlapping: report.overlapping, overlapFiles: report.overlapFiles, commits: report.commits }, null, 2)
      : renderMarkdown(report);
    const out = flag(args, '--out');
    if (out) writeFileSync(out, text);
    else process.stdout.write(text);
    if (out) console.error(`upstream-triage: ${report.total} new commit(s), ${report.overlapping} touching files this fork changed -> ${out}`);
    return 0;
  } catch (err) {
    console.error(`upstream-triage: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exit(main());
