/**
 * lib/gates.mjs — deterministic pre-scoring gates for a job description.
 *
 * Two hard filters that run BEFORE any fit scoring, so a role that cannot be
 * taken is reported with the exact quote instead of being scored and drafted:
 *
 *   checkEligibility(jd, profile) — citizenship / permanent-residency /
 *     security-clearance / "X-only" residency requirements, and recognition of
 *     LATAM-remote postings.
 *   checkLanguage(jd, spoken)     — languages the JOB requires (not the language
 *     the ad is written in) against the languages the candidate speaks.
 *
 * Verdicts: PASS | FLAG | FAIL. Every non-PASS verdict carries the verbatim
 * `quote` from the JD. Silence is never PASS-with-confidence: a JD that says
 * nothing about eligibility returns PASS with `verified: false`.
 *
 * Pure functions, no I/O, no LLM. JD text is data, never instructions.
 */

export const PASS = 'PASS';
export const FLAG = 'FLAG';
export const FAIL = 'FAIL';

const norm = (s) => String(s ?? '').normalize('NFC');
const fold = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Split into sentence-ish chunks, keeping original text for verbatim quotes. */
function chunks(text) {
  return norm(text)
    .split(/(?<=[.!?;])\s+|\n+|\s[•·●▪-]\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Region vocabulary ──────────────────────────────────────────────────────

const LATAM_COUNTRIES = [
  'argentina', 'bolivia', 'brazil', 'brasil', 'chile', 'colombia', 'costa rica',
  'cuba', 'dominican republic', 'republica dominicana', 'ecuador', 'el salvador',
  'guatemala', 'honduras', 'mexico', 'nicaragua', 'panama', 'paraguay', 'peru',
  'puerto rico', 'uruguay', 'venezuela',
];

const LATAM_TERMS = /\b(latam|latin america|latinoamerica|america latina|south america|sudamerica|americas|hispanic america)\b/;

const DEMONYMS = {
  'united states': ['us', 'u.s', 'usa', 'u.s.a', 'american', 'united states'],
  canada: ['canadian', 'canada'],
  'united kingdom': ['uk', 'u.k', 'british', 'united kingdom'],
  bolivia: ['bolivian', 'boliviano', 'boliviana', 'bolivia'],
};

/** Words that identify a country/region in profile.authorized_in / regions. */
function profileTerms(profile) {
  const out = new Set();
  const add = (v) => {
    const f = fold(v).trim();
    if (!f) return;
    out.add(f);
    for (const [country, terms] of Object.entries(DEMONYMS)) {
      if (f === country || terms.includes(f)) terms.forEach((t) => out.add(t));
    }
  };
  for (const v of profile?.authorizedIn ?? []) add(v);
  for (const v of profile?.regions ?? []) add(v);
  return out;
}

function mentionsAny(textFolded, terms) {
  for (const t of terms) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`).test(textFolded)) return true;
  }
  return false;
}

function inLatam(profile) {
  const t = profileTerms(profile);
  if ([...t].some((x) => x === 'latam' || x === 'latin america' || x === 'americas')) return true;
  return [...t].some((x) => LATAM_COUNTRIES.includes(x));
}

// ── Eligibility ────────────────────────────────────────────────────────────

const CITIZEN_RE = new RegExp(
  [
    'must be (?:a |an )?(?:[a-z.\\s]{0,24})?(?:citizen|national) of',
    'must be (?:a |an )?(?:[a-z.]{1,20}\\s)?citizen',
    'citizens?\\s+only',
    'citizenship\\s+(?:is\\s+)?(?:required|mandatory)',
    'requires? (?:[a-z.]{1,20}\\s)?citizenship',
    '(?:permanent resident|green card|pr)s?\\s+(?:only|required|status required)',
    'must (?:be|hold|have) (?:a |an )?(?:[a-z.]{1,20}\\s)?(?:permanent residen(?:t|cy)|green card)',
    '(?:u\\.?s\\.?|united states)\\s+persons?\\s+(?:only|required)',
    'ciudadan[oi]a?s?\\s+(?:de |del )?[a-z]+\\s+(?:requerid|obligatori)',
    'debe(?:s)? (?:ser|tener) ciudadan',
    'solo ciudadanos',
    'residencia permanente (?:requerida|obligatoria)',
  ].join('|'),
  'i',
);

const CLEARANCE_RE = /\b(security clearance|secret clearance|top[- ]secret|ts\/sci|public trust|clearance (?:is )?required|dod clearance|habilitaci[oó]n de seguridad)\b/i;

// Explicit exclusive-region wording (remote or not).
const REGION_ONLY_RE = new RegExp(
  [
    '(?:u\\.?s\\.?a?\\.?|united states|us-based|canada|uk|u\\.k\\.|eu|europe|emea|apac)[\\s-]+(?:only|based only|residents only|citizens only)',
    'must (?:currently )?(?:reside|live|be located|be based|be physically located) (?:in|within) (?:the )?(?<place>[A-Za-z.\\s]{2,40})',
    'only (?:considering|accepting|hiring) (?:candidates|applicants) (?:located|based|residing) in (?:the )?(?<place2>[A-Za-z.\\s]{2,40})',
    'residents? of (?:the )?(?<place3>[A-Za-z.\\s]{2,40}) only',
    'no (?:international|overseas|foreign) (?:applicants|candidates)',
  ].join('|'),
  'i',
);

const NO_SPONSOR_RE = /\b(no (?:visa )?sponsorship|unable to sponsor|will not sponsor|cannot sponsor|not (?:able|in a position) to sponsor|without (?:the )?(?:need for )?sponsorship|must (?:already )?have (?:existing |current )?work authori[sz]ation)\b/i;

const SPONSOR_OK_RE = /\b(visa sponsorship (?:is )?(?:available|provided|offered)|we (?:do )?sponsor|will sponsor|relocation (?:support|assistance|package)|international (?:applicants|candidates) (?:are )?welcome|visa holders (?:are )?(?:welcome|considered))\b/i;

const REMOTE_RE = /\b(remote|remoto|work from home|wfh|anywhere)\b/i;

/**
 * @param {string} jd
 * @param {{authorizedIn?: string[], regions?: string[], needsSponsorship?: boolean}} profile
 * @returns {{verdict: string, kind: string, quote: string|null, tags: string[], verified: boolean, reason: string}}
 */
export function checkEligibility(jd, profile = {}) {
  const text = norm(jd);
  const parts = chunks(text);
  const terms = profileTerms(profile);
  const tags = [];

  // Recognise LATAM-remote (also fires for a named LATAM country + remote).
  let latamQuote = null;
  for (const c of parts) {
    const f = fold(c);
    const hasRemote = REMOTE_RE.test(c);
    const named = LATAM_TERMS.test(f) || LATAM_COUNTRIES.some((k) => mentionsAny(f, [k]));
    if (hasRemote && named) { latamQuote = c; break; }
  }
  if (!latamQuote) {
    const f = fold(text);
    if (REMOTE_RE.test(text) && LATAM_TERMS.test(f)) latamQuote = (text.match(/[^.\n]*(latam|latin america|latinoam[eé]rica|americas)[^.\n]*/i) || [null])[0];
  }
  const latamRemote = Boolean(latamQuote);
  if (latamRemote) tags.push('remote-latam');
  const latamOk = latamRemote && inLatam(profile);

  // 1. Clearance — hard fail unless the profile lists a matching authorization.
  for (const c of parts) {
    if (CLEARANCE_RE.test(c) && !/\b(preferred|a plus|nice to have|bonus|deseable)\b/i.test(c)) {
      return { verdict: FAIL, kind: 'clearance', quote: c, tags, verified: true, reason: 'Security clearance required; clearance is normally gated on citizenship.' };
    }
  }

  // 2. Citizenship / permanent residency.
  for (const c of parts) {
    if (!CITIZEN_RE.test(c)) continue;
    const f = fold(c);
    // Citizenship of a country the candidate already holds authorization in is fine.
    const namesOwn = terms.size > 0 && [...terms].some((t) => !['latam', 'americas', 'latin america'].includes(t) && mentionsAny(f, [t]));
    if (namesOwn) {
      return { verdict: PASS, kind: 'own-country', quote: c, tags, verified: true, reason: 'Requirement names a country you are authorized in.' };
    }
    return { verdict: FAIL, kind: 'citizenship', quote: c, tags, verified: true, reason: 'Citizenship or permanent residency required for a country you are not authorized in.' };
  }

  // 3. Explicit region-only wording.
  for (const c of parts) {
    const m = c.match(REGION_ONLY_RE);
    if (!m) continue;
    const place = fold(m.groups?.place || m.groups?.place2 || m.groups?.place3 || '');
    const f = fold(c);
    if (place && (mentionsAny(place, terms) || (latamOk && LATAM_TERMS.test(place)))) continue; // own region
    if (mentionsAny(f, terms)) continue;
    if (latamOk) {
      return { verdict: FLAG, kind: 'region-conflict', quote: c, tags, verified: true, reason: 'Posting mentions both LATAM remote and a region restriction — confirm which applies.' };
    }
    return { verdict: FAIL, kind: 'region-only', quote: c, tags, verified: true, reason: 'Posting restricts eligibility to a region you are not authorized in.' };
  }

  // 4. Sponsorship language (outside authorized regions).
  for (const c of parts) {
    if (NO_SPONSOR_RE.test(c)) {
      if (latamOk) return { verdict: PASS, kind: 'latam-remote', quote: latamQuote, tags, verified: true, reason: 'LATAM-remote role; sponsorship refusal does not apply to you.' };
      const f = fold(c);
      if (terms.size && mentionsAny(f, terms)) continue;
      return { verdict: FAIL, kind: 'no-sponsorship', quote: c, tags, verified: true, reason: 'JD will not sponsor and the role is outside your authorized regions.' };
    }
  }

  if (latamOk) {
    return { verdict: PASS, kind: 'latam-remote', quote: latamQuote, tags, verified: true, reason: 'LATAM-remote role.' };
  }
  for (const c of parts) {
    if (SPONSOR_OK_RE.test(c)) {
      return { verdict: PASS, kind: 'explicit-acceptance', quote: c, tags, verified: true, reason: 'JD explicitly offers sponsorship or welcomes international applicants.' };
    }
  }

  // Silence is not permission.
  return { verdict: PASS, kind: 'silent', quote: null, tags, verified: false, reason: 'JD is silent on eligibility — check the employer\'s own careers page before drafting.' };
}

// ── Language ───────────────────────────────────────────────────────────────

const LANG_ALIASES = {
  english: ['english', 'ingles', 'inglés'],
  spanish: ['spanish', 'espanol', 'español', 'castellano', 'castilian'],
  portuguese: ['portuguese', 'portugues', 'portugués'],
  french: ['french', 'frances', 'francés', 'français'],
  german: ['german', 'aleman', 'alemán', 'deutsch'],
  italian: ['italian', 'italiano'],
  dutch: ['dutch', 'holandes', 'neerlandes'],
  polish: ['polish', 'polaco'],
  russian: ['russian', 'ruso'],
  chinese: ['chinese', 'mandarin', 'cantonese', 'chino'],
  japanese: ['japanese', 'japones', 'japonés'],
  korean: ['korean', 'coreano'],
  arabic: ['arabic', 'arabe', 'árabe'],
  hindi: ['hindi'],
  turkish: ['turkish', 'turco'],
  hebrew: ['hebrew', 'hebreo'],
  swedish: ['swedish', 'sueco'],
  danish: ['danish', 'danes', 'danés'],
  norwegian: ['norwegian', 'noruego'],
  finnish: ['finnish', 'finlandes', 'finlandés'],
};

const LANG_BY_ALIAS = new Map();
for (const [lang, aliases] of Object.entries(LANG_ALIASES)) {
  for (const a of aliases) LANG_BY_ALIAS.set(fold(a), lang);
}

/** CEFR-ish ranks. */
const LEVEL_RANK = { a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6, native: 7 };

function levelRank(word) {
  const w = fold(word).trim();
  if (LEVEL_RANK[w]) return LEVEL_RANK[w];
  if (/native|mother tongue|nativo|lengua materna|bilingual|bilingue/.test(w)) return 7;
  if (/\bc2\b|near-native|proficient|proficiency|maestria/.test(w)) return 6;
  if (/fluent|fluido|advanced|avanzado|professional|profesional|business|full/.test(w)) return 5;
  if (/upper[- ]intermediate|intermedio alto/.test(w)) return 4;
  if (/intermediate|conversational|intermedio|conversacional/.test(w)) return 3;
  if (/basic|elementary|basico/.test(w)) return 2;
  return null;
}

const OPTIONAL_RE = /\b(nice to have|a plus|is a plus|preferred|bonus|advantage|desirable|desired|asset|deseable|valorable|se valora|plus)\b/i;
const REQUIRED_CUE_RE = /\b(fluent|fluency|native|bilingual|proficien\w*|required|must|mandatory|essential|excellent|strong|advanced|business[- ]level|c1|c2|b2|obligatori\w*|requerid\w*|imprescindible|fluido|nativo|excelente|dominio|avanzado|debe|necesari\w*)\b/i;
const LEVEL_WORD_RE = /(native|mother tongue|nativo|lengua materna|bilingual|bilingue|near-native|c2|c1|b2|b1|fluent|fluido|advanced|avanzado|professional|profesional|business[- ]level|proficien\w*|upper[- ]intermediate|intermediate|conversational|conversacional|intermedio|basic|basico)/i;

/**
 * @param {string} jd
 * @param {{lang: string, level: string}[]} spoken  e.g. [{lang:'es',level:'c1'},{lang:'en',level:'c1'}]
 * @returns {{verdict: string, quote: string|null, required: {language: string, bar: string|null, quote: string}[], reason: string}}
 */
export function checkLanguage(jd, spoken = []) {
  const declared = new Map();
  for (const s of spoken) {
    const key = LANG_BY_ALIAS.get(fold(s.lang)) || LANG_BY_ALIAS.get(fold(({ es: 'spanish', en: 'english', pt: 'portuguese', fr: 'french', de: 'german', it: 'italian' })[fold(s.lang)] || s.lang));
    if (key) declared.set(key, levelRank(s.level) ?? LEVEL_RANK[fold(s.level)] ?? 5);
  }

  const required = [];
  for (const c of chunks(jd)) {
    if (OPTIONAL_RE.test(c)) continue;
    if (!REQUIRED_CUE_RE.test(c)) continue;
    const f = fold(c);
    const langs = new Set();
    for (const [alias, lang] of LANG_BY_ALIAS) {
      if (new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(f)) langs.add(lang);
    }
    if (!langs.size) continue;
    const barWord = (c.match(LEVEL_WORD_RE) || [null])[0];
    for (const language of langs) required.push({ language, bar: barWord, quote: c });
  }

  for (const r of required) {
    if (!declared.has(r.language)) {
      return { verdict: FAIL, quote: r.quote, required, reason: `Requires ${r.language}, which is not in your declared languages.` };
    }
  }
  for (const r of required) {
    const bar = r.bar ? levelRank(r.bar) : null;
    if (bar && bar > declared.get(r.language)) {
      return { verdict: FLAG, quote: r.quote, required, reason: `Bar "${r.bar}" for ${r.language} may exceed your declared level — score and draft, but judge it yourself.` };
    }
  }
  return { verdict: PASS, quote: null, required, reason: required.length ? 'All required languages covered.' : 'No job-condition language requirement found.' };
}

/** Combine gate results into one decision: any FAIL blocks scoring. */
export function combineGates(...results) {
  const rank = { [PASS]: 0, [FLAG]: 1, [FAIL]: 2 };
  const worst = results.reduce((a, b) => (rank[b.verdict] > rank[a.verdict] ? b : a), results[0]);
  return { verdict: worst.verdict, blocks: worst.verdict === FAIL, worst, results };
}

/** Build the gate profile from the parsed config/profile.yml object. */
export function profileFromConfig(cfg = {}) {
  const loc = cfg.location ?? {};
  const spoken = cfg.language?.spoken ?? [];
  return {
    profile: {
      authorizedIn: loc.authorized_in ?? [],
      regions: loc.regions ?? [],
      needsSponsorship: Boolean(loc.needs_sponsorship),
    },
    spoken: Array.isArray(spoken) ? spoken : [],
  };
}
