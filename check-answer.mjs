#!/usr/bin/env node
/**
 * check-answer.mjs — count an application answer against a portal's hard limit.
 *
 *   node check-answer.mjs --chars 140 [--words 200] [--file answer.txt] [--json]
 *   echo "my answer" | node check-answer.mjs --chars 140
 *
 * Reads the answer from --file or stdin. Reports characters (code points, plus
 * the CRLF count some portals use), words, how far over each limit it is, and,
 * when over, which trailing sentences to cut first and the trimmed variant.
 * Exit 0 = fits, 1 = over the limit, 2 = bad invocation.
 */

import { readFileSync } from 'fs';
import { checkLimit, trimPlan } from './lib/answer-limits.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

function num(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = Number(args[i + 1]);
  return Number.isInteger(v) && v > 0 ? v : NaN;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const chars = num(args, 'chars');
  const words = num(args, 'words');
  if (Number.isNaN(chars) || Number.isNaN(words)) {
    console.error('check-answer: --chars/--words need a positive integer');
    process.exit(2);
  }
  const fi = args.indexOf('--file');
  let text;
  try {
    text = fi >= 0 ? readFileSync(args[fi + 1], 'utf8') : readFileSync(0, 'utf8');
  } catch (err) {
    console.error(`check-answer: cannot read input: ${err.message}`);
    process.exit(2);
  }
  text = text.replace(/\r?\n$/, ''); // a piped/file trailing newline is not part of the answer
  const limit = { chars, words };
  const res = checkLimit(text, limit);
  const plan = res.ok ? null : trimPlan(text, limit);
  if (json) {
    console.log(JSON.stringify({ ...res, plan }, null, 2));
  } else {
    const lim = (v) => (v == null ? '—' : v);
    console.log(`chars: ${res.chars}${res.charsCRLF !== res.chars ? ` (${res.charsCRLF} if newlines count double)` : ''} / ${lim(chars)}   words: ${res.words} / ${lim(words)}`);
    if (res.ok) console.log('✅ fits');
    else {
      console.log(`❌ over by ${res.over.chars} chars, ${res.over.words} words`);
      if (plan.cutOrder.length) {
        console.log('Cut first (in order):');
        plan.cutOrder.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
        console.log(`Trimmed variant${plan.fits ? '' : ' (STILL over: shorten the opening sentence by hand)'}:\n${plan.trimmed}`);
      } else {
        console.log('A single sentence is over the limit: rewrite it shorter.');
      }
    }
  }
  process.exit(res.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) main();
