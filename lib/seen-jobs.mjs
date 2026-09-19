/**
 * lib/seen-jobs.mjs — persistent per-posting state (data/seen-jobs.json).
 *
 * `data/pipeline.md` is an inbox: rows are consumed, rewritten and dropped, so
 * anything learned about a posting (its rank, whether it passed the eligibility
 * and language gates, which skills it needs that the CV lacks, whether the link
 * died) is lost with the row. This keeps that knowledge, keyed by the canonical
 * posting URL (url-key.mjs), so an unchanged job is never re-scored and a
 * ranked-but-never-applied job can still feed `upskill`.
 *
 * It only ever ADDS knowledge about postings. It never deletes a pipeline row,
 * never changes a tracker status, and holds no personal data beyond what the
 * posting itself says. User layer: `data/` is gitignored.
 *
 * Shape (version 1):
 *   { version: 1, jobs: { "<url-key>": {
 *       url, company, title, firstSeen, lastSeen,
 *       rank?:   { score, reason, rankedAt, cli? },
 *       gates?:  { eligibility: {verdict, kind, quote, tags, verified},
 *                  language:    {verdict, quote}, checkedAt },
 *       gaps?:   string[],           // JD skills with no trace in cv.md
 *       expired?: { at, reason }
 *   } } }
 *
 * Pure operations work on an in-memory state; load/save are the only I/O. Writes
 * are atomic (temp file + rename) and serialized with the same directory lock
 * the pipeline uses. A corrupt file is moved aside, never silently overwritten.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import normalizeUrl from '../url-key.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';

export const SEEN_VERSION = 1;
const REASON_MAX = 200;
const QUOTE_MAX = 300;

export function emptyState() {
  return { version: SEEN_VERSION, jobs: {} };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 300) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** Key for a URL, or '' when the URL cannot identify a posting. */
export function keyFor(url) {
  return normalizeUrl(url);
}

/**
 * Keep only well-formed entries. Anything malformed is dropped rather than
 * repaired, because a repaired guess about a posting is worse than none.
 */
export function sanitizeState(raw) {
  const out = emptyState();
  if (!isObj(raw) || !isObj(raw.jobs)) return out;
  for (const [key, j] of Object.entries(raw.jobs)) {
    if (!isObj(j) || typeof key !== 'string' || !key.startsWith('http')) continue;
    const job = {
      url: str(j.url || key, 2000),
      company: str(j.company),
      title: str(j.title),
      firstSeen: iso(j.firstSeen) ?? new Date(0).toISOString(),
      lastSeen: iso(j.lastSeen) ?? iso(j.firstSeen) ?? new Date(0).toISOString(),
    };
    if (isObj(j.rank) && Number.isFinite(j.rank.score) && str(j.rank.reason)) {
      job.rank = { score: clampScore(j.rank.score), reason: str(j.rank.reason, REASON_MAX), rankedAt: iso(j.rank.rankedAt) ?? job.lastSeen };
      if (j.rank.cli) job.rank.cli = str(j.rank.cli, 40);
    }
    if (isObj(j.gates) && isObj(j.gates.eligibility) && isObj(j.gates.language)) {
      job.gates = {
        eligibility: cleanGate(j.gates.eligibility, true),
        language: cleanGate(j.gates.language, false),
        checkedAt: iso(j.gates.checkedAt) ?? job.lastSeen,
      };
    }
    if (Array.isArray(j.gaps)) job.gaps = [...new Set(j.gaps.map((g) => str(g, 80)).filter(Boolean))];
    if (isObj(j.expired)) job.expired = { at: iso(j.expired.at) ?? job.lastSeen, reason: str(j.expired.reason, 120) };
    out.jobs[key] = job;
  }
  return out;
}

function clampScore(n) {
  return Math.round(Math.min(5, Math.max(0, Number(n))) * 10) / 10;
}

function cleanGate(g, withTags) {
  const verdict = ['PASS', 'FLAG', 'FAIL'].includes(g.verdict) ? g.verdict : 'FLAG';
  const out = { verdict, quote: g.quote ? str(g.quote, QUOTE_MAX) : null };
  if (withTags) {
    out.kind = str(g.kind, 40);
    out.tags = Array.isArray(g.tags) ? g.tags.map((t) => str(t, 40)).filter(Boolean) : [];
    out.verified = Boolean(g.verified);
  }
  return out;
}

// ── pure operations ───────────────────────────────────────────────────────

/** Create the job or refresh lastSeen/company/title. Returns the key, or '' if the URL cannot be keyed. */
export function touch(state, { url, company, title }, now = new Date().toISOString()) {
  const key = keyFor(url);
  if (!key) return '';
  const cur = state.jobs[key];
  if (cur) {
    cur.lastSeen = now;
    if (company) cur.company = str(company);
    if (title) cur.title = str(title);
  } else {
    state.jobs[key] = { url: str(url, 2000), company: str(company), title: str(title), firstSeen: now, lastSeen: now };
  }
  return key;
}

/** Record a rank. A rank without a reason is refused: an unexplained number is not stored. */
export function setRank(state, key, { score, reason, cli }, now = new Date().toISOString()) {
  const job = state.jobs[key];
  const n = Number(score);
  if (!job || !Number.isFinite(n) || !str(reason)) return false;
  job.rank = { score: clampScore(n), reason: str(reason, REASON_MAX), rankedAt: now, ...(cli ? { cli: str(cli, 40) } : {}) };
  return true;
}

export function getRank(state, key) {
  return state.jobs[key]?.rank ?? null;
}

/** Store gate results as produced by lib/gates.mjs. */
export function setGates(state, key, { eligibility, language }, now = new Date().toISOString()) {
  const job = state.jobs[key];
  if (!job || !isObj(eligibility) || !isObj(language)) return false;
  job.gates = { eligibility: cleanGate(eligibility, true), language: cleanGate(language, false), checkedAt: now };
  return true;
}

export function setGaps(state, key, gaps) {
  const job = state.jobs[key];
  if (!job || !Array.isArray(gaps)) return false;
  job.gaps = [...new Set(gaps.map((g) => str(g, 80)).filter(Boolean))];
  return true;
}

export function setExpired(state, key, reason = '', now = new Date().toISOString()) {
  const job = state.jobs[key];
  if (!job) return false;
  job.expired = { at: now, reason: str(reason, 120) };
  return true;
}

/**
 * Filter jobs. All filters are ANDed; a missing field never matches a filter on it.
 * @returns {Array<{key: string} & object>}
 */
export function listJobs(state, { minRank, gate, expired, hasGaps } = {}) {
  return Object.entries(state.jobs)
    .map(([key, j]) => ({ key, ...j }))
    .filter((j) => (minRank == null ? true : j.rank && j.rank.score >= minRank))
    .filter((j) => (gate == null ? true : j.gates && (j.gates.eligibility.verdict === gate || j.gates.language.verdict === gate)))
    .filter((j) => (expired == null ? true : Boolean(j.expired) === expired))
    .filter((j) => (hasGaps == null ? true : Boolean(j.gaps?.length) === hasGaps))
    .sort((a, b) => (b.rank?.score ?? -1) - (a.rank?.score ?? -1) || a.key.localeCompare(b.key));
}

/** Drop entries last seen more than `days` ago. Returns the removed keys. */
export function prune(state, days, nowMs = Date.now()) {
  const cutoff = nowMs - days * 86_400_000;
  const removed = [];
  for (const [key, j] of Object.entries(state.jobs)) {
    if (Date.parse(j.lastSeen) < cutoff) {
      delete state.jobs[key];
      removed.push(key);
    }
  }
  return removed;
}

/** Skill gaps across ranked-but-unexpired jobs, most frequent first. Feeds `upskill`. */
export function gapSummary(state, { minRank = 0 } = {}) {
  const counts = new Map();
  let jobs = 0;
  for (const j of Object.values(state.jobs)) {
    if (j.expired || !j.gaps?.length) continue;
    if (minRank && !(j.rank && j.rank.score >= minRank)) continue;
    jobs += 1;
    for (const g of j.gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return {
    jobs,
    gaps: [...counts.entries()].map(([skill, count]) => ({ skill, count })).sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill)),
  };
}

// ── I/O ───────────────────────────────────────────────────────────────────

/**
 * Load the state. Missing file = empty. A corrupt file is copied aside as
 * `<path>.corrupt-<timestamp>` and the returned state is empty with `recovered`
 * set, so nothing is lost and nothing is silently overwritten.
 */
export function loadSeenJobs(path, now = Date.now()) {
  if (!existsSync(path)) return { state: emptyState(), recovered: null };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { state: emptyState(), recovered: `unreadable (${err.code || err.message})` };
  }
  try {
    const parsed = JSON.parse(text);
    if (!isObj(parsed) || !isObj(parsed.jobs)) throw new Error('unexpected shape');
    return { state: sanitizeState(parsed), recovered: null };
  } catch {
    const backup = `${path}.corrupt-${now}`;
    try { copyFileSync(path, backup); } catch { /* best effort */ }
    return { state: emptyState(), recovered: `corrupt; original kept at ${backup}` };
  }
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
export function saveSeenJobs(path, state) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Read-modify-write under the pipeline-style directory lock. `fn` may mutate
 * the state in place; its return value is passed through.
 */
export async function withSeenJobs(path, fn, options = {}) {
  return withPipelineLock(path, async () => {
    const { state, recovered } = loadSeenJobs(path);
    const result = await fn(state, { recovered });
    saveSeenJobs(path, state);
    return result;
  }, options);
}
