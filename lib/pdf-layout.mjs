/**
 * lib/pdf-layout.mjs — measure a rendered CV/cover-letter PDF instead of eyeballing it.
 *
 * A clean render, a correct page count and a passing ATS text check can all
 * coexist with a page that is visibly broken. These checks read line geometry
 * from the finished PDF (Poppler `pdftotext -bbox-layout`) and report:
 *
 *   orphaned-heading   a heading-like line is the last thing on a non-final page
 *   internal-hole      a large vertical gap between two lines inside a page
 *   page-ends-early    a non-final page stops well short of the bottom margin
 *   final-page-thin    the last page is mostly empty (reads as unfinished)
 *   bottom-edge-text   text in the bottom edge band, likely clipped or trimmed
 *   right-edge-text    text running into the right edge
 *
 * Page COUNT is deliberately not checked here: generate-pdf.mjs already
 * enforces it (--max-pages), and two implementations of one rule drift.
 *
 * Geometry comes from Poppler because word/line bounding boxes have no
 * dependency-free equivalent. Poppler is optional repo-wide; without it (or
 * with an extractor that lacks -bbox-layout, such as xpdf's) the runner
 * reports `skipped` instead of inventing a layout failure.
 *
 * Thresholds are calibrated for the stock HTML CV template; pass overrides for
 * a custom template. `parseBboxLayout` and `analyzeLayout` are pure.
 */

import { execFileSync } from 'child_process';

export const DEFAULTS = {
  endsEarlyFraction: 0.15,   // non-final page: free space above the bottom margin, as a fraction of page height
  thinFinalFraction: 0.2,    // final page filled less than this fraction of the page
  holeMinPt: 60,             // vertical gap floor for an internal hole ...
  holeLineMultiple: 4,       // ... or this many median line-heights, whichever is larger
  bottomMarginPt: 36,        // expected empty band at the bottom of a page
  bottomEdgePt: 14,          // text inside this band from the bottom edge is suspect
  rightEdgePt: 8,            // text inside this band from the right edge is suspect
  headingHeightRatio: 1.2,   // a line this much taller than the median is heading-like
};

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse `pdftotext -bbox-layout` XHTML into pages of lines.
 * @param {string} xml
 * @returns {{width: number, height: number, lines: {text: string, xMin: number, yMin: number, xMax: number, yMax: number}[]}[]}
 */
export function parseBboxLayout(xml) {
  const pages = [];
  const tokens = String(xml ?? '').matchAll(/<page\b([^>]*)>|<line\b([^>]*)>([\s\S]*?)<\/line>/g);
  let cur = null;
  const num = (attrs, name) => {
    const m = attrs.match(new RegExp(`${name}="([-\\d.eE]+)"`));
    return m ? Number(m[1]) : NaN;
  };
  for (const t of tokens) {
    if (t[1] !== undefined) {
      cur = { width: num(t[1], 'width'), height: num(t[1], 'height'), lines: [] };
      pages.push(cur);
    } else if (cur) {
      const words = [...t[3].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/g)].map((w) => decodeEntities(w[1]));
      const line = {
        text: words.join(' ').trim(),
        xMin: num(t[2], 'xMin'),
        yMin: num(t[2], 'yMin'),
        xMax: num(t[2], 'xMax'),
        yMax: num(t[2], 'yMax'),
      };
      if (line.text && [line.xMin, line.yMin, line.xMax, line.yMax].every(Number.isFinite)) cur.lines.push(line);
    }
  }
  for (const p of pages) p.lines.sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
  return pages;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (n) => Math.round(n * 10) / 10;

function looksLikeHeading(line, medianHeight, ratio) {
  const h = line.yMax - line.yMin;
  if (medianHeight > 0 && h >= medianHeight * ratio) return true;
  const letters = line.text.replace(/[^A-Za-z]/g, '');
  const words = line.text.split(/\s+/).length;
  return letters.length >= 4 && line.text === line.text.toUpperCase() && words <= 5;
}

/**
 * @param {ReturnType<typeof parseBboxLayout>} pages
 * @param {Partial<typeof DEFAULTS>} [overrides]
 * @returns {{page: number, type: string, detail: string}[]} problems (empty = clean)
 */
export function analyzeLayout(pages, overrides = {}) {
  const o = { ...DEFAULTS, ...overrides };
  const problems = [];
  const add = (page, type, detail) => problems.push({ page, type, detail });

  const allHeights = pages.flatMap((p) => p.lines.map((l) => l.yMax - l.yMin));
  const medH = median(allHeights);

  pages.forEach((page, i) => {
    const n = i + 1;
    const last = i === pages.length - 1;
    const lines = page.lines;
    if (!lines.length) {
      add(n, 'blank-page', 'page has no text');
      return;
    }
    const usableBottom = page.height - o.bottomMarginPt;
    const bottomOfContent = Math.max(...lines.map((l) => l.yMax));

    // Bottom-edge and right-edge text.
    const low = lines.filter((l) => l.yMax > page.height - o.bottomEdgePt);
    if (low.length) add(n, 'bottom-edge-text', `"${low[0].text.slice(0, 50)}" ends ${round1(page.height - low[0].yMax)}pt from the bottom edge`);
    const wide = lines.filter((l) => l.xMax > page.width - o.rightEdgePt);
    if (wide.length) add(n, 'right-edge-text', `"${wide[0].text.slice(0, 50)}" runs to ${round1(page.width - wide[0].xMax)}pt from the right edge`);

    // Internal holes.
    const gapLimit = Math.max(o.holeMinPt, o.holeLineMultiple * medH);
    let prevBottom = lines[0].yMax;
    for (let k = 1; k < lines.length; k++) {
      const gap = lines[k].yMin - prevBottom;
      if (gap > gapLimit) {
        add(n, 'internal-hole', `${round1(gap)}pt gap between "${lines[k - 1].text.slice(0, 40)}" and "${lines[k].text.slice(0, 40)}"`);
      }
      prevBottom = Math.max(prevBottom, lines[k].yMax);
    }

    if (!last) {
      // Orphaned heading: last line of a non-final page reads as a heading.
      const tail = lines[lines.length - 1];
      if (looksLikeHeading(tail, medH, o.headingHeightRatio)) {
        add(n, 'orphaned-heading', `"${tail.text.slice(0, 50)}" is the last line on page ${n}; its content starts on the next page`);
      }
      // Page ends early.
      const free = usableBottom - bottomOfContent;
      if (free > page.height * o.endsEarlyFraction) {
        add(n, 'page-ends-early', `content stops ${round1(free)}pt above the bottom margin (${Math.round((free / page.height) * 100)}% of the page)`);
      }
    } else if (pages.length > 1) {
      const topOfContent = Math.min(...lines.map((l) => l.yMin));
      const filled = (bottomOfContent - topOfContent) / page.height;
      if (filled < o.thinFinalFraction) {
        add(n, 'final-page-thin', `last page is only ${Math.round(filled * 100)}% filled; trim or rebalance so it does not read as unfinished`);
      }
    }
  });
  return problems;
}

/**
 * Extract line geometry from a PDF with Poppler.
 * @returns {{ok: true, pages: ReturnType<typeof parseBboxLayout>} | {ok: false, reason: string}}
 */
export function extractPdfLines(pdfPath, exec = execFileSync) {
  let xml;
  try {
    xml = exec('pdftotext', ['-bbox-layout', '--', pdfPath, '-'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'pdftotext (Poppler) is not installed' };
    const msg = String(err?.stderr || err?.message || '').trim().split('\n')[0];
    return { ok: false, reason: `pdftotext could not read the PDF with -bbox-layout (${msg || 'unknown error'})` };
  }
  const pages = parseBboxLayout(xml);
  if (!pages.length) return { ok: false, reason: 'pdftotext produced no page geometry (an xpdf build without -bbox-layout, or an image-only PDF)' };
  return { ok: true, pages };
}
