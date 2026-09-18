// tests/host-verify.test.mjs — source-host verification (lib/host-verify.mjs)
import { pass, fail } from './helpers.mjs';
import { verifyHost, portalHostsFromConfig, VERIFIED, PORTAL, UNVERIFIED } from '../lib/host-verify.mjs';

console.log('\nhost-verify — official ATS / portal / unverified');

function eq(name, actual, expected) {
  if (actual === expected) pass(name);
  else fail(`${name} — expected ${expected}, got ${actual}`);
}

const cases = [
  // official ATS, including subdomains
  ['greenhouse apex', 'https://greenhouse.io/acme/jobs/1', VERIFIED],
  ['greenhouse board subdomain', 'https://job-boards.greenhouse.io/acme/jobs/1', VERIFIED],
  ['lever', 'https://jobs.lever.co/acme/abc', VERIFIED],
  ['ashby', 'https://jobs.ashbyhq.com/acme/uuid', VERIFIED],
  ['workday tenant', 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/x', VERIFIED],
  ['uppercase host', 'https://JOBS.LEVER.CO/acme/abc', VERIFIED],
  ['trailing-dot host', 'https://jobs.lever.co./acme/abc', VERIFIED],
  ['explicit port', 'https://boards.greenhouse.io:443/acme', VERIFIED],
  // attacks
  ['prefix look-alike', 'https://evil-greenhouse.io/jobs/1', UNVERIFIED],
  ['suffix spoof', 'https://job-boards.greenhouse.io.evil.com/acme', UNVERIFIED],
  ['userinfo trick', 'https://greenhouse.io@evil.com/jobs', UNVERIFIED],
  ['userinfo onto real ats is still flagged', 'https://evil.com@boards.greenhouse.io/x', UNVERIFIED],
  ['embedded apex in path', 'https://evil.com/greenhouse.io/jobs', UNVERIFIED],
  ['embedded apex in query', 'https://evil.com/?u=jobs.lever.co', UNVERIFIED],
  ['lever lookalike', 'https://lever.co.evil.io/x', UNVERIFIED],
  ['punycode', 'https://xn--greenhouse-9t3d.io/x', UNVERIFIED],
  ['raw IP', 'https://192.168.1.10/jobs', UNVERIFIED],
  ['not a url', 'not a url', UNVERIFIED],
  ['ftp scheme', 'ftp://jobs.lever.co/acme', UNVERIFIED],
  ['empty', '', UNVERIFIED],
  ['unknown company site', 'https://careers.example-corp.com/job/1', UNVERIFIED],
  // known boards
  ['linkedin', 'https://www.linkedin.com/jobs/view/123', PORTAL],
  ['weworkremotely', 'https://weworkremotely.com/remote-jobs/x', PORTAL],
];
for (const [name, url, want] of cases) eq(`host: ${name}`, verifyHost(url).class, want);

const http = verifyHost('http://jobs.lever.co/acme/abc');
if (http.class === VERIFIED && http.warnings.some((w) => /http/.test(w))) pass('plain http on a real ATS is verified but warned');
else fail('plain http should keep the class and add a warning');

const ui = verifyHost('https://greenhouse.io@evil.com/jobs');
if (ui.host === 'evil.com' && ui.warnings.some((w) => /userinfo/.test(w))) pass('userinfo: real host reported and warned');
else fail(`userinfo host should be evil.com with a warning, got ${ui.host}`);

if (verifyHost('https://evil.com/x').label.startsWith('⚠ Unverified source host: evil.com')) pass('unverified label names the host plainly');
else fail('unverified label must name the host');

// Configured portals (careers pages from portals.yml)
const hosts = portalHostsFromConfig({ tracked_companies: [{ careers_url: 'https://careers.acme.io/jobs' }, { careers_url: 'nope' }, {}] });
if (hosts.length === 1 && hosts[0] === 'careers.acme.io') pass('portalHostsFromConfig extracts valid hostnames, skips junk');
else fail(`portalHostsFromConfig returned ${JSON.stringify(hosts)}`);
eq('configured careers host is a portal', verifyHost('https://careers.acme.io/jobs/9', { portalHosts: hosts }).class, PORTAL);
eq('a spoof of the configured host stays unverified', verifyHost('https://careers.acme.io.evil.com/jobs/9', { portalHosts: hosts }).class, UNVERIFIED);
eq('no portals config: same host is unverified', verifyHost('https://careers.acme.io/jobs/9').class, UNVERIFIED);
eq('portalHostsFromConfig tolerates no config', portalHostsFromConfig(undefined).length, 0);
