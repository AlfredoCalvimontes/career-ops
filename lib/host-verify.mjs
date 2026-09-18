/**
 * lib/host-verify.mjs — is a posting URL hosted where it claims to be?
 *
 * Fake job postings are a scam vector: a page on `evil-greenhouse.io` or
 * `boards.greenhouse.io.evil.com` looks like a Greenhouse board at a glance.
 * This classifies the URL's hostname into one of three classes so the
 * evaluation can name an unverified host plainly instead of drafting an
 * application for it:
 *
 *   ats         — the host IS, or is a subdomain of, a known official ATS apex
 *   portal      — the host is a known job board, or one the caller configured
 *                 (tracked companies' careers hosts from portals.yml)
 *   unverified  — neither. Not proof of a scam; a company's own careers page is
 *                 unverified here too. It means "confirm the employer first".
 *
 * Matching is on the parsed hostname, never a substring: the host must equal
 * the apex or end with `.<apex>`. Prefix tricks (`evil-greenhouse.io`), suffix
 * spoofing (`job-boards.greenhouse.io.evil.com`) and userinfo tricks
 * (`https://greenhouse.io@evil.com/`, where the real host is evil.com) all
 * fail closed. Pure, no I/O.
 */

/** Official ATS apex domains. Extend deliberately: each entry vouches for every subdomain. */
export const ATS_APEXES = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'workday.com',
  'smartrecruiters.com',
  'workable.com',
  'icims.com',
  'jobvite.com',
  'bamboohr.com',
  'recruitee.com',
  'breezy.hr',
  'teamtailor.com',
  'personio.de',
  'personio.com',
  'applytojob.com',
  'pinpointhq.com',
  'comeet.com',
  'rippling.com',
];

/** Well-known job boards (the aggregator/portal class). */
export const PORTAL_APEXES = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'weworkremotely.com',
  'remoteok.com',
  'remotive.com',
  'wellfound.com',
  'ycombinator.com',
  'hnhiring.com',
  'ziprecruiter.com',
  'computrabajo.com',
  'getonbrd.com',
];

export const VERIFIED = 'ats';
export const PORTAL = 'portal';
export const UNVERIFIED = 'unverified';

function normalizeApex(v) {
  return String(v ?? '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function matchesApex(host, apex) {
  return host === apex || host.endsWith(`.${apex}`);
}

/**
 * @param {string} rawUrl
 * @param {{ portalHosts?: string[] }} [opts] extra hostnames/apexes to treat as configured portals
 * @returns {{
 *   class: 'ats'|'portal'|'unverified',
 *   host: string,
 *   apex: string|null,
 *   warnings: string[],
 *   label: string,
 * }}
 */
export function verifyHost(rawUrl, opts = {}) {
  const warnings = [];
  let u;
  try {
    u = new URL(String(rawUrl ?? '').trim());
  } catch {
    return { class: UNVERIFIED, host: '', apex: null, warnings: ['not a valid URL'], label: '⚠ Unverified source host: (invalid URL)' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { class: UNVERIFIED, host: u.hostname, apex: null, warnings: [`unsupported scheme ${u.protocol}`], label: `⚠ Unverified source host: ${u.hostname || '(none)'}` };
  }

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.username || u.password) warnings.push('URL contains userinfo (text before "@"); the real host is what follows it');
  if (u.protocol === 'http:') warnings.push('plain http, not https');
  if (host.split('.').some((l) => l.startsWith('xn--'))) warnings.push('punycode / internationalized hostname (possible look-alike characters)');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) warnings.push('raw IP address, not a hostname');

  const suspicious = warnings.some((w) => /userinfo|punycode|raw IP/.test(w));

  if (!suspicious) {
    for (const apex of ATS_APEXES) {
      if (matchesApex(host, apex)) {
        return { class: VERIFIED, host, apex, warnings, label: `✓ Official ATS host: ${host} (${apex})` };
      }
    }
    const configured = (opts.portalHosts ?? []).map(normalizeApex).filter(Boolean);
    for (const apex of [...PORTAL_APEXES, ...configured]) {
      if (matchesApex(host, apex)) {
        return { class: PORTAL, host, apex, warnings, label: `✓ Known job board: ${host} (${apex})` };
      }
    }
  }

  return {
    class: UNVERIFIED,
    host,
    apex: null,
    warnings,
    label: `⚠ Unverified source host: ${host} - not an installed portal board or known ATS apex`,
  };
}

/** Hostnames of every tracked company's careers URL, from a parsed portals.yml object. */
export function portalHostsFromConfig(cfg) {
  const out = new Set();
  for (const c of cfg?.tracked_companies ?? []) {
    try {
      if (c?.careers_url) out.add(new URL(c.careers_url).hostname.toLowerCase());
    } catch { /* skip malformed entries */ }
  }
  return [...out];
}
