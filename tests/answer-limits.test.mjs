// tests/answer-limits.test.mjs — answer counting/trimming (lib/answer-limits.mjs, check-answer.mjs)
// and the conformance of modes/_form-fields.md
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { countChars, countWords, checkLimit, splitSentences, trimPlan } from '../lib/answer-limits.mjs';

console.log('\nanswer limits — counting, trimming, and the form-fields mode');

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name);
  else fail(`${name} — expected ${e}, got ${a}`);
}

// counting
eq('ASCII chars', countChars('hello').chars, 5);
eq('an accented letter is one char', countChars('café').chars, 4);
eq('an emoji is one char (code point), not two', countChars('a😀b').chars, 3);
eq('CRLF variant counts a bare newline twice', countChars('a\nb').charsCRLF, 4);
eq('an existing CRLF is not double counted again', countChars('a\r\nb').charsCRLF, countChars('a\r\nb').chars);
eq('empty text', countChars('').chars, 0);
eq('null-safe', countChars(undefined).chars, 0);
eq('words', countWords('  one two\tthree\nfour  '), 4);
eq('no words', countWords('   '), 0);

// limits
eq('under both limits', checkLimit('one two three', { chars: 50, words: 5 }).ok, true);
eq('exactly at the char limit fits', checkLimit('12345', { chars: 5 }).ok, true);
eq('one over the char limit fails', checkLimit('123456', { chars: 5 }).over.chars, 1);
eq('over the word limit reports the excess', checkLimit('a b c d', { words: 3 }).over.words, 1);
eq('no limit given never fails', checkLimit('anything at all', {}).ok, true);
eq('the CRLF count is the one checked against the limit', checkLimit('a\nb', { chars: 3 }).ok, false);

// sentence splitting: tech tokens must not split
eq('Node.js does not split', splitSentences('Migrated to Node.js fast. Cut bugs 80%.'), ['Migrated to Node.js fast.', 'Cut bugs 80%.']);
eq('decimals do not split', splitSentences('Scored 3.5 on the audit. Next.'), ['Scored 3.5 on the audit.', 'Next.']);
eq('question and exclamation split', splitSentences('Why? Because. Yes!'), ['Why?', 'Because.', 'Yes!']);
eq('a closing quote stays with its sentence', splitSentences('He said "done." Then left.'), ['He said "done."', 'Then left.']);
eq('newlines split', splitSentences('Line one\nLine two'), ['Line one', 'Line two']);
eq('empty gives none', splitSentences('   '), []);

// trim plan
const long = 'Built a Flask-to-Node.js migration cutting bugs 80%. I also mentored frontend engineers. I love shipping.';
const plan = trimPlan(long, { chars: 70 });
eq('trailing sentences are cut first, last first', plan.cutOrder, ['I love shipping.', 'I also mentored frontend engineers.']);
eq('the trimmed variant fits', plan.fits, true);
eq('the trimmed variant is the opening sentence', plan.trimmed, 'Built a Flask-to-Node.js migration cutting bugs 80%.');
eq('the opening sentence is never cut, even if still over', trimPlan('A very long single opening sentence here.', { chars: 10 }).trimmed, 'A very long single opening sentence here.');
eq('…and reports it does not fit', trimPlan('A very long single opening sentence here.', { chars: 10 }).fits, false);
eq('an answer that fits needs no cuts', trimPlan('Short.', { chars: 50 }).cutOrder, []);

// CLI
const run = (args, input) => spawnSync(NODE, [join(ROOT, 'check-answer.mjs'), ...args], { input, encoding: 'utf8' });
const ok = run(['--chars', '50'], 'fits easily\n');
eq('CLI: a fitting answer exits 0', ok.status, 0);
eq('CLI: a trailing newline is not counted', /chars: 11 \/ 50/.test(ok.stdout), true);
const over = run(['--chars', '10'], 'First sentence here. Second one.');
eq('CLI: an overlong answer exits 1', over.status, 1);
eq('CLI: it lists what to cut first', /Cut first/.test(over.stdout) && /Second one\./.test(over.stdout), true);
const js = JSON.parse(run(['--chars', '10', '--json'], 'First sentence here. Second one.').stdout);
eq('CLI: --json carries the plan', Array.isArray(js.plan.cutOrder) && js.ok === false, true);
eq('CLI: a bad limit exits 2', run(['--chars', 'abc'], 'x').status, 2);
eq('CLI: an unreadable file exits 2', run(['--chars', '5', '--file', '/nonexistent/answer.txt'], '').status, 2);

// the form-fields mode
const mode = readFileSync(join(ROOT, 'modes/_form-fields.md'), 'utf8');
for (const heading of ['self-introduction', 'structured project entries', 'hard character limit', 'motivation', 'competency question', 'logistics and availability', 'equipment, connection and photo']) {
  eq(`mode covers the "${heading}" field type`, new RegExp(`^## Field type: .*${heading}`, 'im').test(mode), true);
}
eq('mode requires measuring instead of estimating', /Never estimate a count/.test(mode) && mode.includes('check-answer.mjs'), true);
eq('mode treats form text as untrusted', /untrusted external content/i.test(mode), true);
eq('mode points at persisting confirmed facts', mode.includes('Persist confirmed facts (same turn)'), true);
eq('mode reads equipment from profile assets', mode.includes('`assets`'), true);
eq('apply.md points at the mode', readFileSync(join(ROOT, 'modes/apply.md'), 'utf8').includes('modes/_form-fields.md'), true);
eq('every script the mode names exists', ['check-answer.mjs'].every((f) => existsSync(join(ROOT, f))), true);
eq('the mode is registered for updates', readFileSync(join(ROOT, 'update-system.mjs'), 'utf8').includes("'modes/_form-fields.md'"), true);
