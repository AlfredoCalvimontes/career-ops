/**
 * lib/mode-lint.mjs — static checks for the prompt files agents obey.
 *
 * Mode and skill files are instructions: an agent will run the script, open the
 * file or read the config key they name. A name that resolves to nothing costs a
 * tool call each time, and the agent cannot tell "renamed" from "wrong
 * directory". These checks find those, plus a few structural slips, without any
 * LLM. Pure functions over file text; the repo walk lives in
 * scripts/lint-modes.mjs.
 *
 * Rules (each finding is {rule, severity, line, message}):
 *   script-ref     error  `node x.mjs` / a backticked x.mjs names no file
 *   npm-script     error  `npm run x` names no package.json script
 *   mode-ref       error  a backticked modes/... .md path names no file
 *   link           error  a relative markdown link names no file
 *   config-key     warn   `profile.yml → a.b` names a key absent from the example profile
 *   frontmatter    error  a SKILL.md without name/description
 *
 * Runtime files a fresh checkout does not have (the user layer, generated data)
 * are exempt: `isUserPath` decides.
 */

const PLACEHOLDER = /[{}<>*$]|\bXX\b|\bxx\b|\.\.\.|…/;

/** Lines of the text with their 1-based numbers. */
function lines(text) {
  return String(text ?? '').split(/\r?\n/).map((t, i) => ({ t, n: i + 1 }));
}

/** Text of a fenced-or-inline code span is where a reference lives; strip nothing, just scan lines. */
export function extractScriptRefs(text) {
  const out = [];
  for (const { t, n } of lines(text)) {
    for (const m of t.matchAll(/`([A-Za-z0-9_./-]+\.mjs)`/g)) out.push({ ref: m[1], line: n });
    for (const m of t.matchAll(/\bnode\s+(?:\.\/)?([A-Za-z0-9_./-]+\.mjs)\b/g)) out.push({ ref: m[1], line: n });
  }
  return dedupe(out);
}

export function extractNpmScripts(text) {
  const out = [];
  for (const { t, n } of lines(text)) {
    for (const m of t.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) out.push({ ref: m[1], line: n });
  }
  return dedupe(out);
}

export function extractModeRefs(text) {
  const out = [];
  for (const { t, n } of lines(text)) {
    for (const m of t.matchAll(/`((?:\.\/)?modes\/[A-Za-z0-9_./-]+\.md)`/g)) out.push({ ref: m[1].replace(/^\.\//, ''), line: n });
  }
  return dedupe(out);
}

export function extractLinks(text) {
  const out = [];
  let inFence = false;
  for (const { t, n } of lines(text)) {
    if (/^\s*```/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // A link inside an inline code span is an example of link syntax, not a link.
    const prose = t.replace(/`[^`]*`/g, '');
    for (const m of prose.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#|tel:)/i.test(target)) continue;
      out.push({ ref: target.split('#')[0], line: n });
    }
  }
  return dedupe(out.filter((r) => r.ref));
}

export function extractConfigKeys(text) {
  const out = [];
  for (const { t, n } of lines(text)) {
    for (const m of t.matchAll(/profile\.yml`?\s*(?:→|->)\s*`?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+)`?/gi)) out.push({ ref: m[1], line: n });
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => {
    const k = `${r.ref}@${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const isPlaceholder = (s) => PLACEHOLDER.test(s);

/**
 * @param {string} file        repo-relative path of the file being checked
 * @param {string} text
 * @param {{
 *   exists: (repoRelative: string) => boolean,
 *   isUserPath: (repoRelative: string) => boolean,
 *   npmScripts: Set<string>,
 *   profileKeys: Set<string>|null,
 *   resolveFrom: (file: string, ref: string) => string,
 * }} ctx
 */
export function lintFile(file, text, ctx) {
  const findings = [];
  const add = (rule, severity, line, message) => findings.push({ rule, severity, line, message });

  for (const { ref, line } of extractScriptRefs(text)) {
    if (isPlaceholder(ref)) continue;
    const path = ref.replace(/^\.\//, '');
    if (ctx.isUserPath(path) || path.startsWith('plugins.local/')) continue;
    // A bare name ("workday.mjs") is prose shorthand for a script in a known directory.
    const candidates = path.includes('/') ? [path] : [path, `providers/${path}`, `lib/${path}`, `scripts/${path}`];
    if (!candidates.some((c) => ctx.exists(c))) add('script-ref', 'error', line, `script not found: ${ref}`);
  }

  for (const { ref, line } of extractNpmScripts(text)) {
    if (!ctx.npmScripts.has(ref)) add('npm-script', 'error', line, `npm script not defined in package.json: ${ref}`);
  }

  for (const { ref, line } of extractModeRefs(text)) {
    if (isPlaceholder(ref) || ctx.isUserPath(ref)) continue;
    if (!ctx.exists(ref)) add('mode-ref', 'error', line, `mode file not found: ${ref}`);
  }

  for (const { ref, line } of extractLinks(text)) {
    if (isPlaceholder(ref)) continue;
    const resolved = ctx.resolveFrom(file, ref);
    if (!resolved || ctx.isUserPath(resolved)) continue;
    if (!ctx.exists(resolved)) add('link', 'error', line, `link target not found: ${ref}`);
  }

  if (ctx.profileKeys) {
    for (const { ref, line } of extractConfigKeys(text)) {
      if (!ctx.profileKeys.has(ref) && ![...ctx.profileKeys].some((k) => k.startsWith(`${ref}.`))) {
        add('config-key', 'warn', line, `key not in config/profile.example.yml: ${ref}`);
      }
    }
  }

  if (/(^|\/)SKILL\.md$/.test(file)) {
    const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const body = fm ? fm[1] : '';
    if (!/^name\s*:\s*\S/m.test(body)) add('frontmatter', 'error', 1, 'SKILL.md frontmatter has no name');
    if (!/^description\s*:\s*\S/m.test(body)) add('frontmatter', 'error', 1, 'SKILL.md frontmatter has no description');
  }
  return findings;
}

/** Dotted key paths in a parsed YAML object, including nested keys. */
export function keyPaths(obj, prefix = '', out = new Set()) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

/** Keys mentioned only in comments (`#   key:`) — optional keys the example documents but leaves unset. */
export function commentedKeys(yamlText) {
  const out = new Set();
  const stack = [];
  for (const raw of String(yamlText ?? '').split(/\r?\n/)) {
    const m = raw.match(/^(\s*)(#\s*)?([a-z_][a-z0-9_]*)\s*:/i);
    if (!m) continue;
    // A commented key keeps the file's own layout: "# " is zero-width, so `# pipeline:`
    // is top level and `#   source:` sits two columns in, exactly like live YAML.
    const indent = m[1].length + (m[2] ? m[2].length - 2 : 0);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[3] });
    if (m[2]) out.add(stack.map((s) => s.key).join('.'));
  }
  return out;
}

/**
 * Translation parity: which English mode files each language directory lacks.
 * @param {string[]} englishFiles  basenames of modes/*.md (excluding underscore-prefixed system files)
 * @param {Record<string, string[]>} byLang  language dir -> basenames it has
 */
export function parityReport(englishFiles, byLang) {
  const report = {};
  for (const [lang, have] of Object.entries(byLang)) {
    const set = new Set(have);
    const missing = englishFiles.filter((f) => !set.has(f));
    report[lang] = { have: have.length, missing };
  }
  return report;
}
