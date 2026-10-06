import type { TokenEstimator } from "../types.ts";

/** Id of the default estimator. Changing the algorithm or its constants must bump this (M6 cache invalidation). */
export const HEURISTIC_ESTIMATOR_ID = "scope-heuristic-v1";

/** Characters per token assumed for a letter segment (a word or one camelCase part). Real BPE averages 4+ on prose. */
const LETTERS_PER_TOKEN = 4;
/** Digits per token. Real tokenizers group up to three digits. */
const DIGITS_PER_TOKEN = 2;
/** Symbols per token in a run of adjacent ASCII punctuation. */
const SYMBOLS_PER_TOKEN = 2;
/** Tokens charged for each BMP non-ASCII code point (accents, CJK, symbols). */
const NON_ASCII_TOKENS = 2;
/** Tokens charged for each astral code point (emoji and rare scripts) and each lone surrogate. */
const ASTRAL_TOKENS = 3;
/** Indentation or space runs cost one extra token per this many characters. */
const SPACES_PER_EXTRA_TOKEN = 8;
/** Chars-based floor: never estimate fewer than length / this. */
const FLOOR_CHARS_PER_TOKEN = 3;

const isLower = (c: number) => c >= 97 && c <= 122;
const isUpper = (c: number) => c >= 65 && c <= 90;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isLetter = (c: number) => isLower(c) || isUpper(c);

/**
 * Deterministic, conservative token estimate for code and prose, in a single linear pass.
 *
 * - Letter runs are split at lowercase-to-uppercase boundaries (camelCase) and cost ceil(len / 4) per segment.
 * - Digit runs cost ceil(len / 2). Every other ASCII symbol, including "_", costs one token.
 * - A single space is free (real tokenizers merge it into the next word); longer space runs, tabs, and each newline
 *   cost one token, plus one per 8 characters of a long run.
 * - Non-ASCII code points cost 2 (BMP) or 3 (astral, lone surrogates); control characters such as NUL cost one.
 * - The result is the larger of that sum and ceil(length / 3).
 */
const estimate = (text: string): number => {
  const length = text.length;
  let tokens = 0;
  let i = 0;
  while (i < length) {
    const c = text.charCodeAt(i);
    if (isLetter(c)) {
      let segment = 0;
      while (i < length) {
        const d = text.charCodeAt(i);
        if (!isLetter(d)) break;
        // A new camelCase segment starts at an uppercase letter that follows a lowercase one.
        if (isUpper(d) && segment > 0 && isLower(text.charCodeAt(i - 1))) {
          tokens += Math.ceil(segment / LETTERS_PER_TOKEN);
          segment = 0;
        }
        segment++;
        i++;
      }
      tokens += Math.ceil(segment / LETTERS_PER_TOKEN);
    } else if (isDigit(c)) {
      const start = i;
      while (i < length && isDigit(text.charCodeAt(i))) i++;
      tokens += Math.ceil((i - start) / DIGITS_PER_TOKEN);
    } else if (c === 10 || c === 13 || c === 32 || c === 9) {
      // Whitespace run. Newlines and the indentation after them merge in real tokenizers, so a run costs one token
      // plus one per extra newline, plus one per 8 characters of spaces. A lone space between words is free.
      const start = i;
      let newlines = 0;
      while (i < length) {
        const d = text.charCodeAt(i);
        if (d === 10) newlines++;
        else if (d !== 13 && d !== 32 && d !== 9) break;
        i++;
      }
      const run = i - start;
      if (run > 1 || c !== 32) tokens += 1 + Math.max(0, newlines - 1) + Math.floor(run / SPACES_PER_EXTRA_TOKEN);
    } else if (c < 128) {
      // Runs of ASCII punctuation, control characters and symbols: adjacent symbols such as "();" often merge.
      const start = i;
      while (i < length) {
        const d = text.charCodeAt(i);
        if (d >= 128 || isLetter(d) || isDigit(d) || d === 10 || d === 13 || d === 32 || d === 9) break;
        i++;
      }
      tokens += Math.ceil((i - start) / SYMBOLS_PER_TOKEN);
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      tokens += ASTRAL_TOKENS;
      i += 2;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      tokens += ASTRAL_TOKENS;
      i++;
    } else {
      tokens += NON_ASCII_TOKENS;
      i++;
    }
  }
  return Math.max(tokens, Math.ceil(length / FLOOR_CHARS_PER_TOKEN));
};

/**
 * The default estimator. Over-estimates general code and prose so a token budget is enforced conservatively.
 * It is a heuristic, not a model tokenizer; see docs/token-estimator.md.
 */
export const heuristicEstimator: TokenEstimator = {
  id: HEURISTIC_ESTIMATOR_ID,
  count: estimate,
};
