/**
 * lib/answer-limits.mjs — count an application answer against a portal's hard limit.
 *
 * Models miscount characters and words, and portals truncate silently, so the
 * count for a free-text field is computed, not estimated. Pure functions.
 *
 *   countChars   Unicode code points (an emoji or accented letter is one), plus the
 *                CRLF variant some portals use (a newline counts as two)
 *   countWords   whitespace-separated tokens
 *   checkLimit   counts + how far over each limit the text is
 *   trimPlan     which trailing sentences to cut, in order, so the answer fits
 *                without ever cutting mid-sentence
 */

export function countChars(text) {
  const t = String(text ?? '');
  const codePoints = [...t].length;
  const newlines = (t.match(/\n/g) || []).length - (t.match(/\r\n/g) || []).length;
  return { chars: codePoints, charsCRLF: codePoints + Math.max(newlines, 0) };
}

export function countWords(text) {
  const t = String(text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * @param {string} text
 * @param {{chars?: number, words?: number}} limit  hard limits; omit a key for no limit on it
 */
export function checkLimit(text, limit = {}) {
  const { chars, charsCRLF } = countChars(text);
  const words = countWords(text);
  const over = {
    chars: limit.chars != null ? Math.max(0, Math.max(chars, charsCRLF) - limit.chars) : 0,
    words: limit.words != null ? Math.max(0, words - limit.words) : 0,
  };
  return { chars, charsCRLF, words, limit, over, ok: over.chars === 0 && over.words === 0 };
}

/** Split into sentences, keeping terminal punctuation. Never returns empty strings. */
export function splitSentences(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  // A sentence ends at . ! ? … (plus closing quotes/brackets) followed by whitespace,
  // so "Node.js", "3.5" and "e.g." mid-word never split; a blank line always splits.
  return t
    .split(/(?<=[.!?…]["')\]]*)[ \t]+(?=\S)|\n{2,}|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Plan trailing cuts so the text fits. The first sentence is never cut: it is the
 * answer's opening, and an answer with no opening is worse than one slightly over.
 * @returns {{fits: boolean, cutOrder: string[], trimmed: string, remainingOver: {chars: number, words: number}}}
 */
export function trimPlan(text, limit = {}) {
  const sentences = splitSentences(text);
  const cutOrder = [];
  let kept = [...sentences];
  const join = (arr) => arr.join(' ');
  while (kept.length > 1 && !checkLimit(join(kept), limit).ok) {
    cutOrder.push(kept.pop());
  }
  const trimmed = join(kept);
  const final = checkLimit(trimmed, limit);
  return { fits: final.ok, cutOrder, trimmed, remainingOver: final.over };
}
