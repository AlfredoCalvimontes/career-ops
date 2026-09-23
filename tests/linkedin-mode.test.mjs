// tests/linkedin-mode.test.mjs — the `linkedin` mode (modes/linkedin.md), linkedin-keywords.mjs, and registration
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, rmSync, ROOT, NODE } from './helpers.mjs';

console.log('\nlinkedin mode — content contract, keyword script, registration');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function check(name, cond) { if (cond) pass(name); else fail(name); }

const mode = read('modes/linkedin.md');
const skill = read('.agents/skills/career-ops/SKILL.md');

// ── content contract ──────────────────────────────────────────────────────
check('has the six steps', [1, 2, 3, 4, 5, 6].every((n) => new RegExp(`## Step ${n} `).test(mode)));
check('headline step asks for five labelled versions', /recruiter-friendly[\s\S]*keyword-focused[\s\S]*personal-brand[\s\S]*minimal[\s\S]*bold/.test(mode));
check('experience step forbids invented numbers and asks one question', /Do not invent numbers/.test(mode) && /\*\*one\*\* question/.test(mode));
check('keywords step never adds a gap keyword', /`gap` keyword is reported[\s\S]*never added/.test(mode));
check('cv.md and friends are the only fact source', /only\*\* source of facts/.test(mode));
check('story-bank is phrasing only', /story-bank\.md`\s+is\s+phrasing\s+only/.test(mode));
check('draft-only, no LinkedIn automation', /never logs in/.test(mode) && /No LinkedIn automation/.test(mode));
check('pasted profile and JDs are untrusted data', /untrusted external content/i.test(mode));
check('recruiter test asks for the 3 final improvements', /\*\*three\*\* most important final improvements/.test(mode));

// ── every script the mode names exists ────────────────────────────────────
for (const script of ['linkedin-keywords.mjs', 'intake.mjs', 'story-provenance-check.mjs']) {
  let ok = true;
  try { readFileSync(join(ROOT, script)); } catch { ok = false; }
  check(`referenced script exists: ${script}`, ok);
}

// ── keyword script behaviour (isolated data root) ─────────────────────────
try {
  execFileSync(NODE, [join(ROOT, 'linkedin-keywords.mjs'), '--self-test'], { stdio: 'pipe', timeout: 30000 });
  pass('linkedin-keywords --self-test passes');
} catch (e) { fail(`linkedin-keywords --self-test failed: ${e.stdout || e.message}`); }

const dir = mkdtempSync(join(tmpdir(), 'linkedin-kw-'));
try {
  mkdirSync(join(dir, 'reports'));
  writeFileSync(join(dir, 'cv.md'), '# Skills\nPython, Docker\n\n# Experience\nBuilt FastAPI services on Kubernetes.\n');
  const jd = `## Requirements\n- Python, FastAPI, Kubernetes, Rust\n${'Filler description text. '.repeat(20)}\n`;
  writeFileSync(join(dir, 'reports', '002-acme-2026-01-01.md'), `# 002\n\n## Job Description (archived verbatim)\n${jd}\n## Block A\nnot jd\n`);
  writeFileSync(join(dir, 'profile.txt'), 'Backend engineer. Python and Docker.');
  const out = JSON.parse(execFileSync(
    NODE, [join(ROOT, 'linkedin-keywords.mjs'), '--profile', join(dir, 'profile.txt')],
    { env: { ...process.env, CAREER_OPS_ROOT: dir }, encoding: 'utf8', timeout: 30000 },
  ));
  const row = (k) => out.keywords.find((r) => r.keyword === k);
  check('reads the archived JD section from reports/', out.jdCount === 1 && out.sources[0] === 'reports/002-acme-2026-01-01.md');
  check('keyword already in profile is flagged', row('Python')?.inProfile === true);
  check('proven keyword missing from profile gets a placement', row('FastAPI')?.inProfile === false && row('FastAPI')?.proof === 'supportedByResume');
  check('keyword with no cv.md proof is never suggested', /do not add/.test(row('Rust')?.placement || ''));

  let exit = 0;
  try {
    execFileSync(NODE, [join(ROOT, 'linkedin-keywords.mjs')], { env: { ...process.env, CAREER_OPS_ROOT: dir }, stdio: 'pipe', timeout: 30000 });
  } catch (e) { exit = e.status; }
  check('missing --profile exits 2 with usage', exit === 2);
} catch (e) {
  fail(`linkedin-keywords CLI run failed: ${e.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── registration ──────────────────────────────────────────────────────────
check('router argument-hint lists linkedin', /argument-hint:[^\n]*\blinkedin\b/.test(skill));
check('router maps linkedin to its mode', /\| `linkedin` \| `linkedin` \|/.test(skill));
check('discovery menu documents linkedin', /\/career-ops linkedin /.test(skill));
check('context-loading list includes linkedin', /Applies to: `tracker`[^\n]*`linkedin`/.test(skill));
check('modes/README.md lists linkedin', /`linkedin\.md` \| `linkedin`/.test(read('modes/README.md')));
const sysPaths = (read('update-system.mjs').match(/SYSTEM_PATHS\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1];
check('update-system ships modes/linkedin.md', sysPaths.includes("'modes/linkedin.md'"));
check('update-system ships linkedin-keywords.mjs', sysPaths.includes("'linkedin-keywords.mjs'"));
check('DATA_CONTRACT lists modes/linkedin.md as system layer', read('DATA_CONTRACT.md').includes('`modes/linkedin.md`'));
check('AGENTS.md has the linkedin Skill Modes row', /\| Wants to audit or rewrite their LinkedIn profile[^\n]*\| `linkedin`/.test(read('AGENTS.md')));
check('AGENTS.md documents linkedin-keywords.mjs', read('AGENTS.md').includes('`linkedin-keywords.mjs`'));
