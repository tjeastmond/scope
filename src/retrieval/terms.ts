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
 * `-s` (not `-ss`, `-us` or `-is`, so `status` and `analysis` stay whole and meet `statuses`) drops the `s`; `-ing` and `-ed` are dropped when at least 3 characters remain.
 */
export function stem(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:[sxz]|ch|sh)es$/u.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(?:ss|us|is)$/u.test(word)) return word.slice(0, -1);
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

export interface TaskTerms {
  /** High-priority exact terms as written (case kept), deduped in order of appearance. */
  exact: string[];
  /** Stemmed content words of the prose and of every exact term, deduped in order of first appearance. */
  words: string[];
  /** Lowercase joins of adjacent content words (`due date` -> `duedate`) and of multi-word exact terms. */
  variants: string[];
}

/**
 * Function words and task filler that never help find code. Deliberately conservative: articles, prepositions,
 * conjunctions, pronouns, auxiliaries and a few filler words. Domain words (`make`, `add`, `show`, `list`) stay.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  `a an the and or but nor so yet if then else than as of in on at to for from by with without into onto over under
   about above after before between through during against within up down out off per via is am are was were be been
   being do does did doing done have has had having will would shall should can could may might must i me my we us our
   you your he him his she her it its they them their this that these those there here which who whom whose what when
   where why how not no all any both each few more most other some such only own same too very just also instead
   already still even`.split(/\s+/u),
);

const BACKTICK_SPAN = /`([^`\n]+)`/gu;
/** Double-quoted, or single-quoted when the quotes are not apostrophes inside words. */
const QUOTED_PHRASE = /["“]([^"”\n]{2,})["”]|(?<![\p{L}\p{N}])'([^'\n]{2,})'(?![\p{L}\p{N}])/gu;

/** Extensions that make a dotted token a file name (`app.toml`) instead of a member access (`Billing.Invoice`). */
const FILE_EXTENSIONS = new Set(
  "ts tsx js jsx mjs cjs py go rs java sql css scss html json yaml yml toml md txt xml sh lock env".split(" "),
);

const DOTTED = /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)+$/u;

function isContentWord(word: string): boolean {
  return word.length >= 2 && !/^\p{N}+$/u.test(word) && !STOP_WORDS.has(word);
}

function contentWords(text: string): string[] {
  return splitIdentifier(text).filter(isContentWord).map(stem);
}

/** The exact terms a single prose token stands for: empty for ordinary words. */
function codeTerms(raw: string): string[] {
  let token = raw.replace(/^[^\p{L}\p{N}_$/]+/u, "").replace(/[^\p{L}\p{N}_$/)]+$/u, "");
  const call = token.endsWith("()");
  token = token.replace(/\(\)$/u, "").replace(/[^\p{L}\p{N}_$/]+$/u, "");
  if (!/\p{L}/u.test(token)) return [];
  if (token.includes("/")) return [token];
  if (DOTTED.test(token) && token.split(".").every((part) => part.length >= 2)) {
    const parts = token.split(".");
    if (FILE_EXTENSIONS.has((parts.at(-1) ?? "").toLowerCase())) return [token];
    return [token, ...parts.filter((part) => part.length >= 2)];
  }
  const looksLikeCode = call || /\p{Ll}\p{Lu}/u.test(token) || /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(token);
  return looksLikeCode ? [token] : [];
}

/** Lowercase joins of adjacent content words, unstemmed and stemmed. Stop words and clause punctuation break runs. */
function adjacentJoins(prose: string): string[] {
  const joins: string[] = [];
  const flush = (run: string[]) => {
    for (let i = 0; i < run.length - 1; i++) {
      for (const size of [2, 3]) {
        const slice = run.slice(i, i + size);
        if (slice.length === size) joins.push(slice.join(""), slice.map(stem).join(""));
      }
    }
  };
  for (const segment of prose.split(/[,;:!?()\n]|\.(?=\s|$)/u)) {
    let run: string[] = [];
    for (const word of splitIdentifier(segment)) {
      if (isContentWord(word)) run.push(word);
      else {
        flush(run);
        run = [];
      }
    }
    flush(run);
  }
  return joins;
}

/**
 * Turns a task description into search terms: exact terms (code spans, quoted phrases, code-looking tokens), stemmed
 * content words, and joined variants for matching symbol and file names. Pure and deterministic.
 */
export function extractTaskTerms(task: string): TaskTerms {
  const found: { index: number; term: string }[] = [];
  // Code spans are blanked so their contents are never scanned as prose; their words are added from the exact terms.
  let prose = task.replace(BACKTICK_SPAN, (match: string, inner: string, index: number) => {
    found.push({ index, term: inner.trim() });
    return " ".repeat(match.length);
  });
  // Quoted phrases are exact terms but their words still read as prose, so only the quote marks are blanked.
  prose = prose.replace(
    QUOTED_PHRASE,
    (match: string, double: string | undefined, single: string | undefined, index: number) => {
      found.push({ index, term: (double ?? single ?? "").trim() });
      return ` ${match.slice(1, -1)} `;
    },
  );
  for (const token of prose.matchAll(/\S+/gu)) {
    for (const term of codeTerms(token[0])) found.push({ index: token.index, term });
  }
  const exact = [...new Set(found.sort((a, b) => a.index - b.index).map((entry) => entry.term))].filter(Boolean);
  const words = [...new Set([...contentWords(prose), ...exact.flatMap(contentWords)])];
  const exactJoins = exact
    .filter((term) => !term.includes("/") && splitIdentifier(term).length >= 2)
    .map((term) => splitIdentifier(term).join(""));
  const variants = [...new Set([...adjacentJoins(prose), ...exactJoins])];
  return { exact, words, variants };
}
