// tests/gates.test.mjs — pre-scoring eligibility + language gates (lib/gates.mjs)
import { pass, fail } from './helpers.mjs';
import { checkEligibility, checkLanguage, combineGates, profileFromConfig, PASS, FLAG, FAIL } from '../lib/gates.mjs';

console.log('\ngates — eligibility + language');

// Fictional profile: authorized in Bolivia, LATAM region, Spanish + English C1.
const { profile, spoken } = profileFromConfig({
  location: { authorized_in: ['Bolivia'], regions: ['LATAM'], needs_sponsorship: true },
  language: { spoken: [{ lang: 'es', level: 'c1' }, { lang: 'en', level: 'c1' }] },
});

function eq(name, actual, expected) {
  if (actual === expected) pass(name);
  else fail(`${name} — expected ${expected}, got ${actual}`);
}

const elig = [
  ['US citizen only', 'Requirements: Must be a US citizen. 5+ years Node.', FAIL],
  ['citizens only', 'Citizens only. Remote.', FAIL],
  ['permanent resident', 'Applicants must hold a permanent resident status in Canada.', FAIL],
  ['clearance', 'Active Secret security clearance required.', FAIL],
  ['clearance as bonus', 'TS/SCI clearance is a plus.', PASS],
  ['US-only remote', 'This remote role is US only.', FAIL],
  ['must reside in US', 'You must reside in the United States.', FAIL],
  ['no sponsorship, onsite abroad', 'Berlin office. We are unable to sponsor visas.', FAIL],
  ['LATAM remote', 'Remote - LATAM. Work from anywhere in Latin America.', PASS],
  ['LATAM remote + no sponsor', 'Remote (LATAM). No visa sponsorship.', PASS],
  ['LATAM + US-only conflict', 'Remote, LATAM friendly. Must be located in the US only.', FLAG],
  ['Bolivia citizen requirement', 'Must be a citizen of Bolivia.', PASS],
  ['sponsors', 'Visa sponsorship is available for the right candidate.', PASS],
  ['Spanish phrasing', 'Debes tener ciudadanía estadounidense.', FAIL],
  ['silent', 'Build APIs with Node and Postgres.', PASS],
];
for (const [name, jd, want] of elig) eq(`eligibility: ${name}`, checkEligibility(jd, profile).verdict, want);

const r1 = checkEligibility('Build APIs with Node and Postgres.', profile);
if (r1.verified === false) pass('silent JD is PASS but unverified'); else fail('silent JD must be unverified');
const r2 = checkEligibility('Remote - LATAM role.', profile);
if (r2.tags.includes('remote-latam')) pass('LATAM remote is tagged'); else fail('LATAM remote must carry remote-latam tag');
const r3 = checkEligibility('Applicants must be a US citizen.', profile);
if (r3.quote && r3.quote.includes('US citizen')) pass('FAIL carries the verbatim quote'); else fail('FAIL must quote the JD');

const lang = [
  ['English fluent (C1 declared)', 'Fluent English required.', PASS],
  ['Spanish native bar', 'Native Spanish speaker required.', FLAG],
  ['Portuguese required', 'Fluent Portuguese is required to talk to our Brazil team.', FAIL],
  ['German nice to have', 'German is a plus.', PASS],
  ['Spanish phrasing missing lang', 'Inglés fluido y alemán obligatorio.', FAIL],
  ['English C2', 'C2 level English required.', FLAG],
  ['no requirement', 'You will build dashboards.', PASS],
  ['ad language irrelevant', 'Estamos buscando un ingeniero de datos con Python y SQL.', PASS],
];
for (const [name, jd, want] of lang) eq(`language: ${name}`, checkLanguage(jd, spoken).verdict, want);

const fq = checkLanguage('Fluent Portuguese is required.', spoken);
if (fq.quote && fq.quote.includes('Portuguese')) pass('language FAIL carries the quote'); else fail('language FAIL must quote');

const c = combineGates(checkEligibility('Citizens only.', profile), checkLanguage('You will build dashboards.', spoken));
if (c.blocks && c.verdict === FAIL) pass('combineGates: any FAIL blocks'); else fail('combineGates must block on FAIL');
const c2 = combineGates(checkEligibility('Remote LATAM.', profile), checkLanguage('Native Spanish required.', spoken));
if (!c2.blocks && c2.verdict === FLAG) pass('combineGates: FLAG does not block'); else fail('combineGates FLAG must not block');

// Missing profile keys degrade gracefully.
const empty = profileFromConfig({});
eq('empty profile: eligibility does not throw', typeof checkEligibility('Remote.', empty.profile).verdict, 'string');
eq('empty profile: no spoken languages -> English requirement FAILs', checkLanguage('Fluent English required.', empty.spoken).verdict, FAIL);

