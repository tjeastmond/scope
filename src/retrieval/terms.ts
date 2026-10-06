// Low-level text helpers shared by the retrieval indexes and task-term extraction. Pure and deterministic.

/**
 * Lowercase words of an identifier or any string. Splits camelCase, PascalCase, acronym boundaries (`HTTPServer` ->
 * `http`, `server`), letter/digit boundaries (`sha256Hash` -> `sha`, `256`, `hash`) and every non-letter, non-digit
 * separator (`_`, `-`, `.`, `/`, whitespace). Unicode letters and digits are kept.
 */
export function splitIdentifier(text: string): string[] {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length > 0);
}

/**
 * Deliberately light stemming so `retries`, `retrying` and `retry` meet. No dictionary and no ML; first match wins:
 * words shorter than 4 characters are untouched; `-ies` -> `-y`; `-es` after s, x, z, ch or sh drops `es`; a trailing
 * `-s` (not `-ss`) drops the `s`; `-ing` and `-ed` are dropped when at least 3 characters remain.
 */
export function stem(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:[sxz]|ch|sh)es$/u.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.endsWith("ing") && word.length - 3 >= 3) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length - 2 >= 3) return word.slice(0, -2);
  return word;
}

/** Stemmed words of an identifier, in order. */
export function stemmedWords(text: string): string[] {
  return splitIdentifier(text).map(stem);
}

/**
 * Searchable tokens of arbitrary source or prose: split, stemmed, with tokens under 2 characters and pure numbers
 * dropped. Duplicates are kept in order because term frequencies need them.
 */
export function tokenizeText(text: string): string[] {
  return stemmedWords(text).filter((token) => token.length >= 2 && !/^\p{N}+$/u.test(token));
}
