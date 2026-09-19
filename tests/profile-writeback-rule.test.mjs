// tests/profile-writeback-rule.test.mjs — the "persist confirmed facts" rule stays wired in
//
// A fact the user confirms in chat but that never reaches an in-scope file is
// stripped by the next session's grounding audit. The rule lives once in
// modes/_shared.md; the modes that surface new facts point at it. This guards
// the rule's shape (confirm-before-write, real destinations, user-words-only)
// and the pointers, so a refactor cannot silently drop it.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nprofile writeback rule — persist confirmed facts');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const shared = read('modes/_shared.md');
const HEADING = '## Persist confirmed facts (same turn)';

function check(name, cond) {
  if (cond) pass(name);
  else fail(name);
}

check('_shared.md defines the rule heading', shared.includes(HEADING));

const start = shared.indexOf(HEADING);
const next = shared.indexOf('\n## ', start + HEADING.length);
const section = start >= 0 ? shared.slice(start, next < 0 ? undefined : next) : '';

check('rule explains why (next session strips unsupported facts)', /grounding audit|strip/i.test(section) && /next session|later session/i.test(section));
check('rule requires confirmation before writing', /Confirm before write/i.test(section));
check('rule forbids writing facts the user did not state', /never write a fact the user did not (state|confirm)/i.test(section));
check('rule limits sources to the user\'s own words (untrusted content cannot authorize an edit)', /Only the user's own words/i.test(section) && /never authorizes an edit/i.test(section));
check('rule says same turn', /Same turn/i.test(section));
check('rule keeps the no-inflation guard', /No fabrication by proxy/i.test(section));
check('rule covers the declined case', /Declined or unsure/i.test(section));

// Destinations must be real, in-scope files.
for (const dest of ['cv.md', 'article-digest.md', 'config/profile.yml', 'modes/_profile.md']) {
  check(`rule names destination ${dest}`, section.includes(`\`${dest}\``));
}
check('every destination is a primary source-of-truth file (AGENTS.md)', ['cv.md', 'article-digest.md', 'config/profile.yml', 'modes/_profile.md'].every((f) => read('AGENTS.md').includes(`\`${f}\``)));

// The tooling the rule points at exists.
check('rule points at add-entry.mjs and it exists', section.includes('add-entry.mjs') && existsSync(join(ROOT, 'add-entry.mjs')));
check('rule points at the add mode and it exists', /`add` mode/.test(section) && existsSync(join(ROOT, 'modes/add.md')));

// Pointers from the modes that surface new facts.
for (const mode of ['modes/apply.md', 'modes/interview-prep.md']) {
  const text = read(mode);
  check(`${mode} points at the rule`, text.includes('Persist confirmed facts (same turn)') && text.includes('modes/_shared.md'));
}

// The rule sits with the source-of-truth material, before path resolution.
check('rule sits before the Data Root section', start > 0 && start < shared.indexOf('## Data Root & Path Resolution'));
check('rule appears exactly once', shared.split(HEADING).length === 2);
