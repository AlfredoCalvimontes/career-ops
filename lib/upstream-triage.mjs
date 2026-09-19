/**
 * lib/upstream-triage.mjs — turn "what is new upstream" into a short, safe report.
 *
 * A fork drifts. This classifies each upstream commit by its Conventional Commit
 * type, flags the ones that touch files the fork itself changed (the likely
 * merge conflicts), and renders a Markdown summary. It never merges, fetches or
 * writes anything: pure functions over data the caller collected with git.
 *
 * Commit subjects are third-party text and end up in a GitHub issue body, so
 * rendering neutralizes what could misbehave there: `@name` (a mention pings a
 * stranger), raw HTML, table-breaking pipes and backticks, and bare `#123`
 * references (which would link to the FORK's issue 123, not upstream's). Text is
 * data, never instructions.
 */

export const UPSTREAM_REPO = 'career-ops-hq/career-ops';

const TYPE_ORDER = ['breaking', 'security', 'feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'ci', 'build', 'chore', 'other'];
const TYPE_TITLE = {
  breaking: 'Breaking changes',
  security: 'Security',
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactors',
  docs: 'Docs',
  test: 'Tests',
  ci: 'CI',
  build: 'Build',
  chore: 'Chores',
  other: 'Other',
};

/** Types worth reading in full; the rest are collapsed. */
const HEADLINE = new Set(['breaking', 'security', 'feat', 'fix', 'perf']);

/**
 * @param {string} subject
 * @param {string} [body]
 * @returns {{type: string, scope: string|null, breaking: boolean, title: string}}
 */
export function classifyCommit(subject, body = '') {
  const s = String(subject ?? '').trim();
  const m = s.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  const type = m ? m[1].toLowerCase() : 'other';
  const scope = m?.[2] ?? null;
  const breaking = Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(String(body ?? ''));
  const known = TYPE_ORDER.includes(type) ? type : type === 'deps' ? 'build' : type === 'style' ? 'chore' : 'other';
  const security = /\b(security|cve-\d|vulnerab|xss|csrf|ssrf|injection|sanitiz)/i.test(`${s} ${scope ?? ''}`) || scope?.toLowerCase() === 'security';
  return {
    type: breaking ? 'breaking' : security ? 'security' : known,
    scope,
    breaking,
    title: m ? m[4] : s,
  };
}

/** Escape third-party text for a Markdown table cell in a GitHub issue. */
export function safeText(text, max = 140) {
  let t = String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'")
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9_-])/g, '$1@​') // a mention never pings
    .replace(/(^|[^\w/#])#(\d+)\b/g, `$1${UPSTREAM_REPO}#$2`); // bare #N means upstream's, not the fork's
}

/**
 * Which commits touch a file the fork also changed.
 * @param {{files: string[]}[]} commits
 * @param {Set<string>|string[]} forkChanged
 */
export function conflictRisk(commits, forkChanged) {
  const mine = forkChanged instanceof Set ? forkChanged : new Set(forkChanged);
  return commits.map((c) => ({ ...c, overlaps: c.files.filter((f) => mine.has(f)) }));
}

/**
 * @param {{sha: string, subject: string, body?: string, author?: string, date?: string, files?: string[]}[]} commits
 * @param {{forkChanged?: string[], base?: string, upstream?: string, maxListed?: number, now?: string}} [opts]
 */
export function buildReport(commits, opts = {}) {
  const { forkChanged = [], base = 'your branch', upstream = 'upstream/main', maxListed = 120, now } = opts;
  const withFiles = commits.map((c) => ({ ...c, files: c.files ?? [] }));
  const enriched = conflictRisk(withFiles, forkChanged).map((c) => ({ ...c, ...classifyCommit(c.subject, c.body) }));

  const groups = Object.fromEntries(TYPE_ORDER.map((t) => [t, []]));
  for (const c of enriched) groups[c.type].push(c);

  const overlapping = enriched.filter((c) => c.overlaps.length);
  const overlapFiles = [...new Set(overlapping.flatMap((c) => c.overlaps))].sort();

  const counts = Object.fromEntries(TYPE_ORDER.filter((t) => groups[t].length).map((t) => [t, groups[t].length]));
  return { total: enriched.length, counts, groups, overlapping: overlapping.length, overlapFiles, base, upstream, maxListed, now, commits: enriched };
}

const link = (sha) => `[${sha.slice(0, 7)}](https://github.com/${UPSTREAM_REPO}/commit/${sha})`;

/** Markdown body for the tracking issue. Size-capped so GitHub never rejects it. */
export function renderMarkdown(report) {
  const { total, counts, groups, overlapping, overlapFiles, base, upstream, maxListed, now } = report;
  if (!total) return `No new upstream commits.\n\n${base} is up to date with ${upstream}.\n`;

  const out = [];
  out.push(`**${total} new upstream commit${total === 1 ? '' : 's'}** in \`${upstream}\` that \`${base}\` does not have yet${now ? ` (checked ${now})` : ''}.`);
  out.push('');
  out.push(Object.entries(counts).map(([t, n]) => `${TYPE_TITLE[t].toLowerCase()}: ${n}`).join(' · '));
  out.push('');
  out.push(overlapping
    ? `⚠️ **${overlapping} commit${overlapping === 1 ? '' : 's'} touch${overlapping === 1 ? 'es' : ''} files this fork changed** (likely merge conflicts): ${overlapFiles.slice(0, 15).map((f) => `\`${f}\``).join(', ')}${overlapFiles.length > 15 ? `, +${overlapFiles.length - 15} more` : ''}`
    : '✅ No new upstream commit touches a file this fork changed.');
  out.push('');

  let listed = 0;
  for (const t of TYPE_ORDER) {
    const list = groups[t];
    if (!list.length) continue;
    const open = HEADLINE.has(t);
    out.push(open ? `### ${TYPE_TITLE[t]} (${list.length})` : `<details><summary>${TYPE_TITLE[t]} (${list.length})</summary>`);
    out.push('');
    out.push('| Commit | Change | Conflict risk |');
    out.push('|---|---|---|');
    for (const c of list) {
      if (listed >= maxListed) break;
      listed += 1;
      const risk = c.overlaps.length ? `⚠️ ${c.overlaps.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${c.overlaps.length > 3 ? ` +${c.overlaps.length - 3}` : ''}` : '—';
      out.push(`| ${link(c.sha)} | ${c.scope ? `**${safeText(c.scope, 30)}**: ` : ''}${safeText(c.title)} | ${risk} |`);
    }
    out.push('');
    if (!open) out.push('</details>', '');
  }
  if (total > listed) out.push(`_${total - listed} more commit(s) not listed; run \`npm run upstream:watch\` locally for the full list._`, '');
  out.push('---');
  out.push('Generated by `scripts/upstream-triage.mjs`. It only reports: nothing is merged for you. To bring changes in: `git fetch upstream && git merge upstream/main` on a branch, then run `node test-all.mjs`.');
  return `${out.join('\n')}\n`;
}
