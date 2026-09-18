// tests/pdf-layout.test.mjs — per-PDF layout checks (lib/pdf-layout.mjs, verify-cv-layout.mjs)
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { pass, fail, warn, ROOT, NODE, rmSync } from './helpers.mjs';
import { parseBboxLayout, analyzeLayout, extractPdfLines } from '../lib/pdf-layout.mjs';

console.log('\npdf-layout — orphaned headings, holes, early page ends, thin last page');

// ── synthetic geometry (pure, no Poppler needed) ──────────────────────────
const W = 595;
const H = 842;
const line = (text, yMin, opts = {}) => ({ text, xMin: 40, xMax: opts.xMax ?? 400, yMin, yMax: yMin + (opts.h ?? 12) });
const body = (from, count, step = 14) => Array.from({ length: count }, (_, i) => line(`body ${from + i}`, from + i * step));
const page = (lines) => ({ width: W, height: H, lines });
const types = (pages, o) => analyzeLayout(pages, o).map((p) => `${p.page}:${p.type}`);

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name);
  else fail(`${name} — expected ${e}, got ${a}`);
}

eq('a full single page is clean', types([page(body(40, 50))]), []);
eq('a full two-page CV is clean', types([page(body(40, 55)), page(body(40, 30))]), []);

eq('internal hole is reported', types([page([...body(40, 6), ...body(400, 6)])]), ['1:internal-hole']);
eq('normal section spacing is not a hole', types([page([...body(40, 6), ...body(140, 30)])]), []);

eq('a non-final page that stops short is reported', types([page(body(40, 20)), page(body(40, 40))]), ['1:page-ends-early']);
eq('a single page is never "ends early"', types([page(body(40, 20))]), []);
eq('a full non-final page is not "ends early"', types([page(body(40, 55)), page(body(40, 40))]), []);

eq('a nearly empty last page is reported', types([page(body(40, 55)), page(body(40, 2))]), ['2:final-page-thin']);

const pg1 = [...body(40, 54), line('EXPERIENCE', 40 + 54 * 14, { h: 18 })];
eq('a tall heading as the last line of a page is an orphan', types([page(pg1), page(body(40, 40))]), ['1:orphaned-heading']);
const pg1caps = [...body(40, 54), line('EXPERIENCE', 40 + 54 * 14)];
eq('an all-caps short last line is an orphan even at body height', types([page(pg1caps), page(body(40, 40))]), ['1:orphaned-heading']);
eq('a body line at the bottom is not an orphan', types([page(body(40, 55)), page(body(40, 40))]), []);
eq('a heading on the FINAL page bottom is fine', types([page(body(40, 55)), page([...body(40, 40), line('EDUCATION', 620, { h: 18 })])]), []);

eq('text at the bottom edge is reported', types([page([...body(40, 40), line('page footer', H - 10)])]).includes('1:bottom-edge-text'), true);
eq('text against the right edge is reported', types([page([...body(40, 40), line('overflowing line', 700, { xMax: W - 2 })])]).includes('1:right-edge-text'), true);
eq('an empty page is reported', types([page(body(40, 55)), page([])]), ['2:blank-page']);

eq('thresholds are overridable', types([page([...body(40, 6), ...body(400, 6)])], { holeMinPt: 500 }), []);

// ── parsing ───────────────────────────────────────────────────────────────
const xml = `<doc><page width="595.000000" height="842.000000"><flow><block xMin="40" yMin="40" xMax="300" yMax="66">
<line xMin="40.5" yMin="40" xMax="120" yMax="52"><word xMin="40.5" yMin="40" xMax="70" yMax="52">A &amp; B</word><word xMin="72" yMin="40" xMax="120" yMax="52">C&lt;D</word></line>
<line xMin="40" yMin="54" xMax="90" yMax="66"><word xMin="40" yMin="54" xMax="90" yMax="66">second</word></line>
</block></flow></page><page width="595" height="842"><flow><block><line xMin="1" yMin="2" xMax="3" yMax="4"><word>x</word></line></block></flow></page></doc>`;
const parsed = parseBboxLayout(xml);
eq('parser reads the page count', parsed.length, 2);
eq('parser reads page size', [parsed[0].width, parsed[0].height], [595, 842]);
eq('parser joins words and decodes entities', parsed[0].lines[0].text, 'A & B C<D');
eq('parser keeps line order', parsed[0].lines.map((l) => l.text), ['A & B C<D', 'second']);
eq('parser survives garbage', parseBboxLayout('not xml at all').length, 0);
eq('parser survives undefined', parseBboxLayout(undefined).length, 0);

// ── extractor failure modes ───────────────────────────────────────────────
const enoent = extractPdfLines('/x.pdf', () => { const e = new Error('spawn pdftotext ENOENT'); e.code = 'ENOENT'; throw e; });
eq('missing Poppler is reported, not thrown', enoent.ok === false && /not installed/.test(enoent.reason), true);
const xpdf = extractPdfLines('/x.pdf', () => { const e = new Error('bad'); e.stderr = 'Error: Unknown option'; throw e; });
eq('an extractor without -bbox-layout is reported', xpdf.ok === false && /-bbox-layout/.test(xpdf.reason), true);
const none = extractPdfLines('/x.pdf', () => '<doc></doc>');
eq('no geometry is reported', none.ok === false && /no page geometry/.test(none.reason), true);

// ── the CLI on invalid input ──────────────────────────────────────────────
const noArg = spawnSync(NODE, [join(ROOT, 'verify-cv-layout.mjs')], { encoding: 'utf8' });
eq('CLI with no argument exits 2', noArg.status, 2);
const missing = spawnSync(NODE, [join(ROOT, 'verify-cv-layout.mjs'), '/nonexistent/file.pdf'], { encoding: 'utf8' });
eq('CLI with a missing file exits 2', missing.status, 2);

// ── real PDFs (needs Poppler + Chromium; skipped otherwise) ───────────────
let havePoppler = true;
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch (e) { if (e?.code === 'ENOENT') havePoppler = false; }
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }

if (!havePoppler || !chromium) {
  warn('real-PDF layout checks skipped (need Poppler pdftotext + playwright)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-layout-'));
  let browser;
  try {
    browser = await chromium.launch();
    const p = await browser.newPage();
    const para = (i) => `<p style="margin:0;font:11pt sans-serif">Bullet line ${i} lorem ipsum dolor sit amet</p>`;
    const paras = (n) => Array.from({ length: n }, (_, i) => para(i)).join('');
    const render = async (name, inner) => {
      await p.setContent(`<html><body style="margin:0">${inner}</body></html>`);
      const out = join(dir, `${name}.pdf`);
      await p.pdf({ path: out, format: 'a4', margin: { top: '50px', bottom: '50px', left: '50px', right: '50px' } });
      return out;
    };
    const run = (f) => spawnSync(NODE, [join(ROOT, 'verify-cv-layout.mjs'), f, '--json'], { encoding: 'utf8' });

    const clean = run(await render('clean', '<h1>Jane Doe</h1>' + paras(20)));
    eq('real PDF: a clean one-pager exits 0', clean.status, 0);

    const hole = run(await render('hole', '<h1>Jane Doe</h1>' + paras(6) + '<div style="height:300pt"></div>' + paras(6)));
    eq('real PDF: a mid-page hole exits 1', hole.status, 1);
    eq('real PDF: …and is typed internal-hole', JSON.parse(hole.stdout).problems.some((x) => x.type === 'internal-hole'), true);

    const orphan = run(await render('orphan', '<h1>Jane Doe</h1>' + paras(50) + '<h2 style="margin:0;font:20pt sans-serif;break-after:avoid">EXPERIENCE</h2><div style="break-before:page"></div>' + paras(2)));
    const t = JSON.parse(orphan.stdout).problems.map((x) => x.type);
    eq('real PDF: an orphaned heading is found', t.includes('orphaned-heading'), true);
    eq('real PDF: a thin final page is found', t.includes('final-page-thin'), true);
    eq('real PDF: files exist for the run', existsSync(join(dir, 'orphan.pdf')), true);
  } catch (err) {
    warn(`real-PDF layout checks skipped: ${err.message.split('\n')[0]}`);
  } finally {
    await browser?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
