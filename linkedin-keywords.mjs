#!/usr/bin/env node

/**
 * linkedin-keywords.mjs — Zero-LLM keyword table for the `linkedin` mode.
 *
 * Extracts the skills the target JDs ask for (same extractor as
 * jd-skill-gap.mjs), counts how many JDs each appears in, then answers three
 * questions per keyword:
 *
 *   inProfile — does the pasted LinkedIn profile text already say it?
 *   proof     — does cv.md back it (existing / supportedByResume / gap)?
 *   placement — where it may go, or "do not add" when cv.md has no trace
 *
 * A keyword with no cv.md proof is never suggested for the profile: the table
 * exists to surface visibility gaps, not to invent claims. Read-only.
 *
 * JD sources (first match wins):
 *   1. explicit file arguments
 *   2. reports/*.md   — the "## Job Description (archived verbatim)" section
 *      jds/*.md       — whole file
 *
 * Usage:
 *   node linkedin-keywords.mjs --profile documents/linkedin/profile.txt
 *   node linkedin-keywords.mjs --profile p.txt jds/acme.md jds/globex.md --summary
 *   node linkedin-keywords.mjs --profile - < profile.txt      # stdin
 *   node linkedin-keywords.mjs --self-test
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { extractJdSkills, skillMentionedInText, classifySkillGaps } from './jd-skill-gap.mjs';
import { canonicalize, extractSkills } from './skill-extract.mjs';
import { extractStrippedJdSection } from './check-jd-archive.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const MIN_JD_CHARS = 200;

/**
 * Text of the archived-JD section of a report, or '' when absent, a pointer to
 * a jds/ capture (that file is read separately), or too thin to trust. Uses the
 * validator's extractor so a JD's own "## Requirements" heading does not
 * truncate the section.
 */
function jdFromReport(text) {
  const body = extractStrippedJdSection(text);
  return body && body.length >= MIN_JD_CHARS ? body : '';
}

/** Does the profile text already carry this skill (alias-safe)? */
function inProfileText(skill, profileText, profileCanon) {
  return profileCanon.has(canonicalize(skill)) || skillMentionedInText(skill, profileText);
}

/**
 * Deterministic placement hint. Never suggests a keyword cv.md cannot back.
 * @param {'existing'|'supportedByResume'|'gap'} proof
 */
function placementFor(proof, freq, total, present) {
  if (proof === 'gap') return 'do not add — no proof in cv.md';
  if (present) return 'already in profile';
  const common = total > 0 && freq / total >= 0.5;
  if (proof === 'existing') return common ? 'headline, About, Skills' : 'Skills, Experience';
  return common ? 'Experience bullet, then Skills' : 'Experience bullet';
}

/**
 * @param {{jds: {source: string, text: string}[], profileText: string, cvText: string}} input
 */
function buildKeywordTable({ jds, profileText, cvText }) {
  const freq = new Map();
  for (const { text } of jds) {
    const seen = new Set(extractJdSkills(text).map(canonicalize));
    for (const s of seen) freq.set(s, (freq.get(s) || 0) + 1);
  }
  const skills = [...freq.keys()];
  const cls = classifySkillGaps(skills, cvText);
  const proofOf = (s) => (cls.existing.includes(s) ? 'existing'
    : cls.supportedByResume.includes(s) ? 'supportedByResume' : 'gap');
  const profileCanon = extractSkills(profileText);

  return skills
    .map((keyword) => {
      const inProfile = inProfileText(keyword, profileText, profileCanon);
      const proof = proofOf(keyword);
      return {
        keyword,
        jds: freq.get(keyword),
        inProfile,
        proof,
        placement: placementFor(proof, freq.get(keyword), jds.length, inProfile),
      };
    })
    .sort((a, b) => b.jds - a.jds || a.keyword.localeCompare(b.keyword));
}

function collectJds(root, files) {
  if (files.length) {
    return files.map((f) => ({ source: f, text: readFileSync(f, 'utf8') }));
  }
  const out = [];
  const reportsDir = join(root, 'reports');
  if (existsSync(reportsDir)) {
    for (const f of readdirSync(reportsDir).filter((n) => n.endsWith('.md')).sort()) {
      const text = jdFromReport(readFileSync(join(reportsDir, f), 'utf8'));
      if (text) out.push({ source: `reports/${f}`, text });
    }
  }
  const jdsDir = join(root, 'jds');
  if (existsSync(jdsDir)) {
    for (const f of readdirSync(jdsDir).filter((n) => n.endsWith('.md')).sort()) {
      out.push({ source: `jds/${f}`, text: readFileSync(join(jdsDir, f), 'utf8') });
    }
  }
  return out;
}

function toSummary(table, jdCount) {
  const lines = [
    `${table.length} keywords across ${jdCount} JD(s)`,
    '',
    '| Keyword | JDs | In profile | Proof (cv.md) | Placement |',
    '|---------|-----|------------|---------------|-----------|',
  ];
  for (const r of table) {
    lines.push(`| ${r.keyword} | ${r.jds}/${jdCount} | ${r.inProfile ? 'yes' : 'no'} | ${r.proof} | ${r.placement} |`);
  }
  return lines.join('\n');
}

function runSelfTest() {
  let passed = 0;
  let failed = 0;
  const eq = (label, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
    else { failed++; console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
  };
  const jd = '## Requirements\n- Python, FastAPI, Kubernetes, Rust\n';
  const cv = '# Skills\nPython\n\n# Experience\nShipped FastAPI endpoints on Kubernetes.\n';
  const table = buildKeywordTable({
    jds: [{ source: 'a', text: jd }, { source: 'b', text: jd }],
    profileText: 'Backend engineer. Python, Docker.',
    cvText: cv,
  });
  const row = (k) => table.find((r) => r.keyword === k);
  eq('Python is proven and already in profile', [row('Python').proof, row('Python').inProfile], ['existing', true]);
  eq('FastAPI proven by prose, missing from profile', [row('FastAPI').proof, row('FastAPI').inProfile], ['supportedByResume', false]);
  eq('FastAPI placed in an Experience bullet', row('FastAPI').placement.startsWith('Experience bullet'), true);
  eq('Rust has no proof so is never suggested', row('Rust').placement, 'do not add — no proof in cv.md');
  eq('frequency counts JDs, not mentions', row('Python').jds, 2);
  eq('archived-JD section survives its own sub-headings', jdFromReport(`# R\n## Job Description (archived verbatim)\n## Requirements\n${'x'.repeat(250)}\n## Block A\nno`).includes('## Requirements'), true);
  eq('thin archived-JD section ignored', jdFromReport('## Job Description (archived verbatim)\nshort\n'), '');
  console.log(`linkedin-keywords self-test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return runSelfTest();

  const summary = args.includes('--summary');
  const pIdx = args.indexOf('--profile');
  const profileArg = pIdx === -1 ? null : args[pIdx + 1];
  const files = args.filter((a, i) => !a.startsWith('--') && i !== pIdx + 1);

  if (!profileArg) {
    console.error('Usage: node linkedin-keywords.mjs --profile <file|-> [jd files…] [--summary]\n'
      + 'Save your pasted LinkedIn profile text to a file first (PDF export: node intake.mjs --text <pdf>).');
    process.exit(2);
  }

  const root = getCareerOpsRoot();
  const cvPath = join(root, 'cv.md');
  if (!existsSync(cvPath)) {
    console.error(`cv.md not found at ${cvPath} — every proof check compares against it.`);
    process.exit(2);
  }
  const profileText = profileArg === '-' ? readFileSync(0, 'utf8') : readFileSync(profileArg, 'utf8');
  const jds = collectJds(root, files);
  if (!jds.length) {
    console.error('No JDs found: pass files, or evaluate offers first (reports/ needs an archived JD section; jds/*.md also works).');
    process.exit(2);
  }

  const table = buildKeywordTable({ jds, profileText, cvText: readFileSync(cvPath, 'utf8') });
  if (!table.length) {
    console.error('LOW CONFIDENCE: no known skills were extracted from these JDs. That is not "no gaps": nothing was classified. Read the JDs and pick keywords by hand.');
  }
  if (summary) console.log(toSummary(table, jds.length));
  else console.log(JSON.stringify({ jdCount: jds.length, sources: jds.map((j) => j.source), keywords: table }, null, 2));
}

export { buildKeywordTable, jdFromReport, placementFor };

if (isMainModule(import.meta.url)) main();
