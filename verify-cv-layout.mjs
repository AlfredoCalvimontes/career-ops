#!/usr/bin/env node
/**
 * verify-cv-layout.mjs — measure a generated PDF's page layout.
 *
 *   node verify-cv-layout.mjs <file.pdf> [--json]
 *        [--ends-early=0.15] [--thin-final=0.2] [--hole=60] [--bottom-margin=36]
 *
 * Catches what a clean compile, the page count and the ATS text check all miss:
 * an orphaned heading at the bottom of a page, a big hole in the middle of one,
 * a page that stops early, a nearly empty last page, and text against the page
 * edge. See lib/pdf-layout.mjs for the checks. Page count is not checked here
 * (generate-pdf.mjs --max-pages owns it).
 *
 * Exit 0 = clean, 1 = layout problem, 2 = bad invocation or no usable Poppler
 * (reported as "skipped:", never as a layout failure).
 */

import { existsSync } from 'fs';
import { analyzeLayout, extractPdfLines } from './lib/pdf-layout.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

function flag(args, name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const v = Number(a.slice(name.length + 3));
  return Number.isFinite(v) ? v : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node verify-cv-layout.mjs <file.pdf> [--json]');
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`verify-cv-layout: no such file: ${file}`);
    process.exit(2);
  }
  const overrides = {};
  const map = { 'ends-early': 'endsEarlyFraction', 'thin-final': 'thinFinalFraction', hole: 'holeMinPt', 'bottom-margin': 'bottomMarginPt' };
  for (const [cli, key] of Object.entries(map)) {
    const v = flag(args, cli);
    if (v !== undefined) overrides[key] = v;
  }

  const ext = extractPdfLines(file);
  if (!ext.ok) {
    if (json) console.log(JSON.stringify({ skipped: true, reason: ext.reason }));
    else console.log(`skipped: ${ext.reason}`);
    process.exit(2);
  }
  const problems = analyzeLayout(ext.pages, overrides);
  if (json) {
    console.log(JSON.stringify({ pages: ext.pages.length, problems }, null, 2));
  } else if (!problems.length) {
    console.log(`✅ layout clean (${ext.pages.length} page${ext.pages.length === 1 ? '' : 's'})`);
  } else {
    console.log(`⚠️  ${problems.length} layout problem${problems.length === 1 ? '' : 's'} (${ext.pages.length} pages):`);
    for (const p of problems) console.log(`  page ${p.page}: ${p.type} — ${p.detail}`);
  }
  process.exit(problems.length ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
