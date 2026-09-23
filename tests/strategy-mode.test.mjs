// tests/strategy-mode.test.mjs — the `strategy` mode (modes/strategy.md) and its registration
import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nstrategy mode — content contract and registration');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function check(name, cond) { if (cond) pass(name); else fail(name); }

const mode = read('modes/strategy.md');
const skill = read('.agents/skills/career-ops/SKILL.md');

// ── content contract ──────────────────────────────────────────────────────
check('reads the compact brief first', /1\. `modes\/_brief\.md`/.test(mode));
check('cv.md is the only evidence source', /`cv\.md`[^\n]*only[^\n]*evidence/i.test(mode));
check('story-bank is phrasing only, never a number source', /story-bank\.md[^\n]*phrasing only/.test(mode));
check('applies the T1/T2/T3 policy (T3 needs pay above current job)', /T3[\s\S]*bridge_min_monthly_usd/.test(mode));
check('T1 outranks T2 outranks T3', /T1 by fit, then T2, then T3 by pay/.test(mode));
check('market claims are labelled unverified', /unverified/.test(mode));
check('read-only with a confirm gate for tier changes', /Read-only\./.test(mode) && /explicit yes/.test(mode));
check('web content is untrusted data', /untrusted external content/i.test(mode));
check('output contract has the ranking table', /\| # \| Role family \| Tier \| Fit \| Reachable \| Money \| Main risk \|/.test(mode));

// ── every script the mode names exists ────────────────────────────────────
for (const script of ['role-tier.mjs', 'analyze-patterns.mjs']) {
  let ok = true;
  try { readFileSync(join(ROOT, script)); } catch { ok = false; }
  check(`referenced script exists: ${script}`, ok);
}

// ── registration ──────────────────────────────────────────────────────────
check('router argument-hint lists strategy', /argument-hint:[^\n]*\bstrategy\b/.test(skill));
check('router maps strategy to its mode', /\| `strategy` \| `strategy` \|/.test(skill));
check('discovery menu documents strategy', /\/career-ops strategy /.test(skill));
check('context-loading list includes strategy', /Applies to: `tracker`[^\n]*`strategy`/.test(skill));
check('modes/README.md lists strategy', /`strategy\.md` \| `strategy`/.test(read('modes/README.md')));
const sysPaths = (read('update-system.mjs').match(/SYSTEM_PATHS\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1];
check('update-system SYSTEM_PATHS ships modes/strategy.md', sysPaths.includes("'modes/strategy.md'"));
check('DATA_CONTRACT lists modes/strategy.md as system layer', read('DATA_CONTRACT.md').includes('`modes/strategy.md`'));
check('AGENTS.md has the strategy Skill Modes row', /\| Asks which roles to target[^\n]*\| `strategy`/.test(read('AGENTS.md')));
