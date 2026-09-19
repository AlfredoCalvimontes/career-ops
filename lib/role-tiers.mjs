/**
 * lib/role-tiers.mjs — rank roles by how much you want them, not just how well they fit.
 *
 * A fit score answers "could I do this job?". Tiers answer "do I want this job?":
 *
 *   T1  the career you are aiming for          (preferred)
 *   T2  adjacent technical roles               (less preferred; score capped)
 *   T3  "bridge" roles, e.g. language/support work you take as a stopgap. Only
 *       worth it when it pays MORE than your current job.
 *
 * The lists live in config/profile.yml → role_tiers (the user's own data). This
 * module classifies a job title against them and applies the tier policy. Pure
 * functions: no I/O, no LLM, deterministic.
 *
 * Matching is by phrase. A tier entry expands to alternatives ("Medical / English
 * Interpreter" → "medical interpreter", "english interpreter"; parentheticals and
 * seniority words are dropped), and a title matches an alternative when it
 * contains all of the alternative's words. The most specific match wins, and a
 * tie between tiers goes to the WORSE tier: a mistaken lift is costlier than a
 * mistaken demotion.
 */

const SENIORITY = new Set(['senior', 'sr', 'staff', 'lead', 'principal', 'junior', 'jr', 'mid', 'associate', 'entry', 'level', 'ii', 'iii', 'iv', 'i']);
const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'at', 'with', 'remote', 'hybrid', 'onsite', 'on-site', 'full-time', 'part-time', 'contract']);

export const TIER_KEYS = { 1: 'tier_1', 2: 'tier_2', 3: 'tier_3_bridge' };
export const TIER_LABEL = { 1: 'T1', 2: 'T2', 3: 'T3' };

/** Score caps per tier (a T2/T3 role never outranks an equally good T1 role). */
export const TIER_SCORE_CAP = { 1: 5, 2: 4.0, 3: 3.5 };

const DEFAULT_THRESHOLD = 3.5;
const MARGINAL_FLOOR = 3.0;

/** Lowercase tokens: hyphens split, punctuation dropped, plural "s" folded, seniority/stop words removed. */
export function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    // Spelling variants that mean the same thing, applied to titles and tier entries alike.
    .replace(/\bfull[\s-]?stack\b/g, 'fullstack')
    .replace(/\bback[\s-]?end\b/g, 'backend')
    .replace(/\bfront[\s-]?end\b/g, 'frontend')
    .replace(/\b(developers?|devs?|programmers?|swe)\b/g, 'engineer')
    .replace(/[^a-z0-9+#\s/-]/g, ' ')
    .replace(/[-/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .filter((t) => !SENIORITY.has(t) && !STOP.has(t));
}

/**
 * Expand one tier entry into its alternative phrases (each a token list).
 * A lone leading word before a "/" borrows the head noun of the last alternative
 * ("Medical / English Interpreter" → medical interpreter, english interpreter).
 */
export function expandEntry(entry) {
  const cleaned = String(entry ?? '').replace(/\([^)]*\)/g, ' ');
  const parts = cleaned.split(/\s*\/\s*|\s+or\s+/i).map((p) => tokens(p)).filter((t) => t.length);
  if (!parts.length) return [];
  const last = parts[parts.length - 1];
  const head = last.length > 1 ? last[last.length - 1] : null;
  return parts.map((p, i) => (i < parts.length - 1 && p.length === 1 && head && p[0] !== head ? [...p, head] : p));
}

/**
 * @param {string} title
 * @param {{tier_1?: string[], tier_2?: string[], tier_3_bridge?: string[]}} tiers  config/profile.yml → role_tiers
 * @returns {{tier: 1|2|3|null, matched: string|null, ambiguous: boolean}}
 */
export function classifyTier(title, tiers = {}) {
  const titleTokens = new Set(tokens(title));
  if (!titleTokens.size) return { tier: null, matched: null, ambiguous: false };

  const hits = [];
  for (const tier of [1, 2, 3]) {
    for (const entry of tiers?.[TIER_KEYS[tier]] ?? []) {
      for (const alt of expandEntry(entry)) {
        if (alt.length && alt.every((t) => titleTokens.has(t))) hits.push({ tier, entry, specificity: alt.length });
      }
    }
  }
  if (!hits.length) return { tier: null, matched: null, ambiguous: false };

  const top = Math.max(...hits.map((h) => h.specificity));
  const best = hits.filter((h) => h.specificity === top);
  const tiersAtTop = new Set(best.map((h) => h.tier));
  const tier = Math.max(...tiersAtTop); // tie between tiers: the worse tier
  const winner = best.find((h) => h.tier === tier);
  return { tier, matched: winner.entry, ambiguous: tiersAtTop.size > 1 };
}

/** First monthly USD amount in text like "USD 1,000/month (about 6,000 Bs)" or "$1000". */
export function parseMonthlyUsd(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = String(value ?? '').match(/(?:usd|us\$|\$)\s*([\d][\d,]*(?:\.\d+)?)/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

const VERDICT_RANK = { PASS: 2, MARGINAL: 1, FAIL: 0 };
const worse = (a, b) => (VERDICT_RANK[a] <= VERDICT_RANK[b] ? a : b);

function verdictFor(score, threshold) {
  if (score >= threshold) return 'PASS';
  if (score >= MARGINAL_FLOOR) return 'MARGINAL';
  return 'FAIL';
}

/**
 * Apply the tier policy to a fit score.
 * @param {{
 *   score: number, tier: 1|2|3|null, payMonthlyUsd?: number|null,
 *   bridgeMinMonthlyUsd?: number|null, floorMonthlyUsd?: number|null, threshold?: number
 * }} input
 * @returns {{effectiveScore: number, verdict: 'PASS'|'MARGINAL'|'FAIL', notes: string[]}}
 */
export function applyTierPolicy(input) {
  const { score, tier, payMonthlyUsd = null, bridgeMinMonthlyUsd = null, floorMonthlyUsd = null, threshold = DEFAULT_THRESHOLD } = input;
  const notes = [];
  const n = Number(score);
  if (!Number.isFinite(n)) return { effectiveScore: 0, verdict: 'FAIL', notes: ['no usable fit score'] };

  let effective = Math.min(5, Math.max(0, n));
  const cap = TIER_SCORE_CAP[tier] ?? 5;
  if (effective > cap) {
    notes.push(`${TIER_LABEL[tier]} roles are capped at ${cap.toFixed(1)} so they never outrank an equally good higher tier`);
    effective = cap;
  }
  effective = Math.round(effective * 10) / 10;
  let verdict = verdictFor(effective, threshold);

  // Hard pay floor applies to every tier.
  if (floorMonthlyUsd != null && payMonthlyUsd != null && payMonthlyUsd < floorMonthlyUsd) {
    notes.push(`pay ${payMonthlyUsd} USD/month is below your floor of ${floorMonthlyUsd}`);
    verdict = 'FAIL';
  }

  if (tier === 3) {
    if (bridgeMinMonthlyUsd == null) {
      notes.push('bridge role: set role_tiers.bridge_min_monthly_usd (your current monthly pay) so it can be judged; until then it is at best MARGINAL');
      verdict = worse(verdict, 'MARGINAL');
    } else if (payMonthlyUsd == null) {
      notes.push(`bridge role with unstated pay: only worth taking if it pays more than ${bridgeMinMonthlyUsd} USD/month; find out first`);
      verdict = worse(verdict, 'MARGINAL');
    } else if (payMonthlyUsd <= bridgeMinMonthlyUsd) {
      notes.push(`bridge role pays ${payMonthlyUsd} USD/month, not more than your current ${bridgeMinMonthlyUsd}: no reason to switch`);
      verdict = 'FAIL';
    } else {
      notes.push(`bridge role beats your current pay by ${payMonthlyUsd - bridgeMinMonthlyUsd} USD/month`);
    }
  }
  return { effectiveScore: effective, verdict, notes };
}

/**
 * Comparator for shortlists: T1 before T2 before T3 (unclassified last); within
 * T1/T2 by effective score; within T3 by pay, then score. Rows are
 * `{tier, score, payMonthlyUsd?}`.
 */
export function compareByTier(a, b) {
  const ta = a.tier ?? 9;
  const tb = b.tier ?? 9;
  if (ta !== tb) return ta - tb;
  if (ta === 3) {
    const pa = a.payMonthlyUsd ?? -1;
    const pb = b.payMonthlyUsd ?? -1;
    if (pa !== pb) return pb - pa;
  }
  return (b.score ?? -1) - (a.score ?? -1);
}
