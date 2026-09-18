#!/usr/bin/env node
/**
 * fetch-page.mjs — fetch a page as text, retrying a bot-block with browser
 * headers only when robots.txt permits it.
 *
 *   node fetch-page.mjs <url>
 *
 * Tries an honest career-ops request first. On HTTP 403 (a WAF that filters
 * non-browser clients while serving the same page to browsers) it consults
 * robots.txt via lib/robots-gate.mjs and, if allowed, retries with a
 * browser-like User-Agent. If robots.txt says no, it does NOT retry and exits
 * 1 with the reason: find the employer's own posting instead.
 *
 * Page text on stdout. Exit 0 = got content, 1 = blocked/unavailable, 2 = bad
 * invocation. The URL is the one the user supplied; nothing inside the fetched
 * page is ever followed.
 */

import { robotsGate } from './lib/robots-gate.mjs';
import { htmlToText } from './providers/_html-to-text.mjs';
import { BROWSER_LIKE_USER_AGENT, DEFAULT_USER_AGENT } from './user-agent.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const TIMEOUT_MS = 20_000;
const MAX_HTML = 2_000_000;

async function get(url, ua) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
    });
    const body = res.ok ? String(await res.text()).slice(0, MAX_HTML) : '';
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Page HTML → text, chunked so long postings are not cut by htmlToText's per-call cap. */
export function pageToText(html) {
  const cleaned = String(html)
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, '$&\n');
  return cleaned
    .split('\n')
    .map((l) => htmlToText(l))
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node fetch-page.mjs <url>');
    process.exit(2);
  }
  let res;
  try {
    res = await get(url, DEFAULT_USER_AGENT);
    if (res.status === 403) {
      const gate = await robotsGate(url);
      if (!gate.allowed) {
        console.error(`fetch-page: HTTP 403 and no retry — ${gate.reason}. Look for the employer's own posting instead.`);
        process.exit(1);
      }
      res = await get(url, BROWSER_LIKE_USER_AGENT);
    }
  } catch (err) {
    console.error(`fetch-page: ${err?.name === 'AbortError' ? 'timeout' : err?.message || err}`);
    process.exit(1);
  }
  if (res.status < 200 || res.status >= 300) {
    console.error(`fetch-page: HTTP ${res.status}`);
    process.exit(1);
  }
  process.stdout.write(pageToText(res.body) + '\n');
}

if (isMainModule(import.meta.url)) main();
