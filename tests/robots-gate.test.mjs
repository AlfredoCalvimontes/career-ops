// tests/robots-gate.test.mjs — robots.txt gate for browser-header retries (lib/robots-gate.mjs)
import { pass, fail } from './helpers.mjs';
import { parseRobots, isAllowed, robotsGate } from '../lib/robots-gate.mjs';

console.log('\nrobots-gate — RFC 9309 rules and fail-closed behaviour');

function eq(name, actual, expected) {
  if (actual === expected) pass(name);
  else fail(`${name} — expected ${expected}, got ${actual}`);
}
const allowed = (txt, path) => isAllowed(parseRobots(txt), path).allowed;

// ── parsing / matching ────────────────────────────────────────────────────
eq('no rules = allowed', allowed('', '/jobs/1'), true);
eq('Disallow: / blocks everything', allowed('User-agent: *\nDisallow: /', '/jobs/1'), false);
eq('empty Disallow allows everything', allowed('User-agent: *\nDisallow:', '/jobs/1'), true);
eq('prefix Disallow', allowed('User-agent: *\nDisallow: /cs/', '/cs/job/1'), false);
eq('prefix Disallow does not touch other paths', allowed('User-agent: *\nDisallow: /cs/', '/jobs/1'), true);
eq('longest match wins: Allow beats shorter Disallow', allowed('User-agent: *\nDisallow: /jobs\nAllow: /jobs/public', '/jobs/public/1'), true);
eq('longest match wins: Disallow beats shorter Allow', allowed('User-agent: *\nAllow: /\nDisallow: /cs/', '/cs/x'), false);
eq('tie goes to Disallow', allowed('User-agent: *\nAllow: /jobs\nDisallow: /jobs', '/jobs'), false);
eq('wildcard pattern', allowed('User-agent: *\nDisallow: /*/apply', '/acme/apply'), false);
eq('$ anchors the end', allowed('User-agent: *\nDisallow: /*.pdf$', '/cv.pdf'), false);
eq('$ anchor does not over-match', allowed('User-agent: *\nDisallow: /*.pdf$', '/cv.pdf.html'), true);
eq('query string is part of the path', allowed('User-agent: *\nDisallow: /search?', '/search?q=x'), false);
eq('percent-escape case is normalized', allowed('User-agent: *\nDisallow: /a%2fb', '/a%2Fb'), false);
eq('comments and BOM are ignored', allowed('﻿User-agent: * # everyone\nDisallow: /x # nope', '/x'), false);

// The case Python's urllib.robotparser gets wrong: blank lines inside a record,
// and Allow listed before Disallow (Barclays-style).
const barclays = 'User-agent: *\n\nAllow: /\n\nDisallow: /cs/\n\nDisallow: /private/\n';
eq('blank lines inside a record do not end it (Disallow still applies)', allowed(barclays, '/cs/job/1'), false);
eq('…and the rest of the site stays allowed', allowed(barclays, '/en/careers'), true);

// agent groups
eq('Disallow for Claude-User blocks even when * allows', allowed('User-agent: *\nAllow: /\n\nUser-agent: Claude-User\nDisallow: /', '/jobs/1'), false);
eq('Disallow for career-ops blocks', allowed('User-agent: career-ops\nDisallow: /', '/jobs/1'), false);
eq('Disallow for an unrelated bot does not block us', allowed('User-agent: Googlebot\nDisallow: /', '/jobs/1'), true);
eq('stacked User-agent lines share one group', allowed('User-agent: Googlebot\nUser-agent: Claude-User\nDisallow: /', '/x'), false);
eq('rules before any User-agent are ignored', allowed('Disallow: /\n', '/x'), true);

// ── the gate: fetch behaviour, with an injected fetch ─────────────────────
function fakeFetch(map) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ua: init?.headers?.['user-agent'] });
    const r = map(url, init);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body ?? '' };
  };
  fn.calls = calls;
  return fn;
}
const NOENV = {};

let f = fakeFetch(() => ({ status: 404 }));
let g = await robotsGate('https://acme.com/jobs/1', { fetchFn: f, env: NOENV });
eq('404 robots.txt = permission', g.allowed, true);
eq('robots URL is built from the origin only', f.calls[0].url, 'https://acme.com/robots.txt');

f = fakeFetch(() => ({ status: 410 }));
eq('410 robots.txt = permission', (await robotsGate('https://acme.com/x', { fetchFn: f, env: NOENV })).allowed, true);

f = fakeFetch(() => ({ status: 200, body: 'User-agent: *\nDisallow: /cs/' }));
eq('policy allows the path', (await robotsGate('https://acme.com/jobs/1', { fetchFn: f, env: NOENV })).allowed, true);
g = await robotsGate('https://acme.com/cs/job/1', { fetchFn: f, env: NOENV });
eq('policy disallows the path', g.allowed, false);
if (/disallows \/cs\/job\/1/.test(g.reason)) pass('block reason names the path'); else fail(`reason: ${g.reason}`);

f = fakeFetch(() => ({ status: 500 }));
eq('500 = unconfirmed = no retry', (await robotsGate('https://acme.com/x', { fetchFn: f, env: NOENV })).allowed, false);
f = fakeFetch(() => ({ status: 429 }));
eq('429 = unconfirmed = no retry', (await robotsGate('https://acme.com/x', { fetchFn: f, env: NOENV })).allowed, false);
f = fakeFetch(() => new Error('ECONNRESET'));
eq('network error = unconfirmed = no retry', (await robotsGate('https://acme.com/x', { fetchFn: f, env: NOENV })).allowed, false);

// WAF blocks robots.txt for the honest UA → read it as a browser, then obey it.
f = fakeFetch((url, init) => (/career-ops/.test(init.headers['user-agent'])
  ? { status: 403 }
  : { status: 200, body: 'User-agent: *\nDisallow: /cs/' }));
g = await robotsGate('https://bank.example/cs/x', { fetchFn: f, env: NOENV });
eq('WAF-blocked robots.txt is re-read as a browser and still obeyed', g.allowed, false);
eq('…it took two requests, the second with a browser UA', f.calls.length === 2 && /Mozilla\/5\.0 \(Windows/.test(f.calls[1].ua), true);
f = fakeFetch((url, init) => (/career-ops/.test(init.headers['user-agent'])
  ? { status: 403 }
  : { status: 200, body: 'User-agent: *\nAllow: /' }));
eq('WAF-blocked robots.txt that a browser can read and permits', (await robotsGate('https://bank.example/en/x', { fetchFn: f, env: NOENV })).allowed, true);
f = fakeFetch(() => ({ status: 403 }));
eq('robots.txt 403 even for a browser = unconfirmed', (await robotsGate('https://bank.example/en/x', { fetchFn: f, env: NOENV })).allowed, false);

// input hygiene
f = fakeFetch(() => ({ status: 200, body: '' }));
eq('invalid URL is refused', (await robotsGate('not a url', { fetchFn: f, env: NOENV })).allowed, false);
eq('non-http scheme is refused', (await robotsGate('file:///etc/passwd', { fetchFn: f, env: NOENV })).allowed, false);
eq('a refused URL makes no request', f.calls.length, 0);
f = fakeFetch(() => ({ status: 404 }));
await robotsGate('https://acme.com/a?x=$(rm -rf)&y=`id`', { fetchFn: f, env: NOENV });
eq('path and query never reach the robots request', f.calls[0].url, 'https://acme.com/robots.txt');

// operator override
f = fakeFetch(() => ({ status: 200, body: 'User-agent: *\nDisallow: /' }));
g = await robotsGate('https://acme.com/x', { fetchFn: f, env: { CAREER_OPS_IGNORE_ROBOTS: '1' } });
eq('CAREER_OPS_IGNORE_ROBOTS=1 overrides', g.allowed, true);
eq('…without making any request', f.calls.length, 0);
g = await robotsGate('https://acme.com/x', { fetchFn: f, env: { CAREER_OPS_IGNORE_ROBOTS: 'true' } });
eq('only the exact value 1 overrides', g.allowed, false);
