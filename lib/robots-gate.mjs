/**
 * lib/robots-gate.mjs — may we retry a blocked fetch with browser-like headers?
 *
 * A 403 on a posting has two very different causes: a WAF default on a site
 * whose published policy allows access, or a site that has actually said no.
 * Retrying with browser headers is reasonable for the first and circumvents the
 * site's stated preference in the second. This reads and applies robots.txt so
 * the caller can tell them apart. Rules (RFC 9309), deliberately on the
 * cautious side:
 *
 *   - the longest matching rule wins; on equal length Disallow beats Allow
 *   - `*` and `$` work in patterns; an empty Disallow allows everything
 *   - a Disallow for EITHER `*` or one of our own tokens blocks
 *   - blank lines inside a record do not end it (Python's urllib.robotparser
 *     drops rules there and fails open — the case the tests pin)
 *   - 404/410 = no published policy = permission
 *   - any other failure to read robots.txt leaves permission unconfirmed: no retry
 *   - a WAF that blocks robots.txt itself (403) is read again as a browser; a
 *     policy we are prevented from reading cannot be honored, and robots.txt is
 *     not the protected resource. What it says is then obeyed strictly.
 *
 * The owner may override for a single run with CAREER_OPS_IGNORE_ROBOTS=1. That
 * is the operator's decision to make; the default is to respect the site.
 */

import { BROWSER_LIKE_USER_AGENT, DEFAULT_USER_AGENT } from '../user-agent.mjs';

/** Product tokens whose groups apply to us (lowercase), besides `*`. */
export const OWN_AGENTS = ['career-ops', 'claude-user'];

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 512 * 1024;

/**
 * Parse robots.txt text into groups: [{ agents: string[], rules: {allow: boolean, path: string}[] }].
 * Consecutive User-agent lines share a group; blank lines and comments never end one.
 */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!cur) continue; // rule before any User-agent: ignore
      cur.rules.push({ allow: field === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function normPath(p) {
  // Uppercase percent-escape hex so %2f and %2F compare equal (RFC 9309 §2.2.2).
  return String(p).replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

/** Does robots pattern `pattern` match `path`? Returns match length or -1. */
function matchLen(pattern, path) {
  if (pattern === '') return -1; // empty rule matches nothing
  let anchored = false;
  let pat = normPath(pattern);
  if (pat.endsWith('$')) {
    anchored = true;
    pat = pat.slice(0, -1);
  }
  const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  // RFC 9309: specificity is the pattern's length in octets, wildcards included.
  return re.test(normPath(path)) ? pattern.length : -1;
}

function decide(rules, path) {
  let best = null; // {len, allow}
  for (const r of rules) {
    const len = matchLen(r.path, path);
    if (len < 0) continue;
    if (!best || len > best.len || (len === best.len && !r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/**
 * Is `path` (with query) allowed for us? Blocks when either the `*` group or a
 * group naming one of our tokens disallows it.
 * @returns {{allowed: boolean, by: string|null}}
 */
export function isAllowed(groups, path, agents = OWN_AGENTS) {
  const wildcard = groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
  const own = groups.filter((g) => g.agents.some((a) => agents.includes(a))).flatMap((g) => g.rules);
  if (!decide(wildcard, path)) return { allowed: false, by: '*' };
  if (!decide(own, path)) return { allowed: false, by: 'career-ops/claude-user' };
  return { allowed: true, by: null };
}

async function fetchText(url, ua, fetchFn) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': ua, accept: 'text/plain,*/*' },
    });
    const buf = res.status === 200 ? String(await res.text()).slice(0, MAX_BYTES) : '';
    return { status: res.status, body: buf };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether a browser-header retry of `url` may proceed.
 * @param {string} url
 * @param {{fetchFn?: typeof fetch, env?: Record<string,string|undefined>}} [opts]
 * @returns {Promise<{allowed: boolean, reason: string, status?: number}>}
 */
export async function robotsGate(url, opts = {}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const env = opts.env ?? process.env;
  if (env.CAREER_OPS_IGNORE_ROBOTS === '1') {
    return { allowed: true, reason: 'override: CAREER_OPS_IGNORE_ROBOTS=1' };
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid URL' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { allowed: false, reason: `unsupported scheme ${target.protocol}` };
  }
  // Built from the origin only: whatever the path/query holds never reaches this request.
  const robotsUrl = `${target.protocol}//${target.host}/robots.txt`;
  const path = target.pathname + target.search;

  let res;
  try {
    res = await fetchText(robotsUrl, DEFAULT_USER_AGENT, fetchFn);
    if (res.status === 401 || res.status === 403) {
      res = await fetchText(robotsUrl, BROWSER_LIKE_USER_AGENT, fetchFn);
    }
  } catch (err) {
    return { allowed: false, reason: `robots.txt unreadable (${err?.name === 'AbortError' ? 'timeout' : err?.message || 'network error'}); permission unconfirmed` };
  }

  if (res.status === 404 || res.status === 410) {
    return { allowed: true, reason: 'no robots.txt published (permission)', status: res.status };
  }
  if (res.status !== 200) {
    return { allowed: false, reason: `robots.txt returned HTTP ${res.status}; permission unconfirmed`, status: res.status };
  }
  const verdict = isAllowed(parseRobots(res.body), path);
  if (!verdict.allowed) {
    return { allowed: false, reason: `robots.txt disallows ${path} for ${verdict.by}`, status: 200 };
  }
  return { allowed: true, reason: 'robots.txt permits this path', status: 200 };
}
