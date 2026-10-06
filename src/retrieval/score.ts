// Lexical candidate scoring: symbol-name, source-text and file-path signals, each normalized to [0, 1] and kept
// separate so a score can be explained. Graph signals (dependency, test) are added by later stages.

import {
  lookupBasename,
  lookupPathWord,
  lookupSymbolExact,
  lookupSymbolWord,
  scoreText,
  type RetrievalIndexes,
} from "./indexes.ts";
import { stemmedWords, type TaskTerms } from "./terms.ts";

export interface ScoringWeights {
  symbol: number;
  lexical: number;
  path: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = { symbol: 0.3, lexical: 0.25, path: 0.15 };

type Signal = keyof ScoringWeights;

export interface ChunkScore {
  chunkId: string;
  /** Each signal normalized to [0, 1] per query before weighting. */
  signals: Record<Signal, number>;
  /** Weight times signal. */
  contributions: Record<Signal, number>;
  /** Exactly the sum of the contributions. */
  total: number;
}

/** Ceiling for a name matched only by words: an exact name match always outranks any partial one. */
const PARTIAL_NAME_CEILING = 0.9;
/** Added to the path signal when a term equals the file's base name (`invoice` -> `invoice.ts`). */
const BASENAME_BONUS = 0.5;

type Signals = Map<string, number>;

function raise(signals: Signals, key: string, value: number): void {
  if (value > (signals.get(key) ?? 0)) signals.set(key, value);
}

/**
 * Symbol signal. 1.0 when the name (or its last dotted member) equals an exact term or a joined variant, ignoring
 * case and word style. Otherwise the share of the member name's words that the task mentions, scaled by
 * `covered / (covered + 1)` so a fully covered multi-word name (`sendReminder` for "send reminder") beats a single
 * incidental word, and capped at {@link PARTIAL_NAME_CEILING}.
 */
function symbolSignals(terms: TaskTerms, indexes: RetrievalIndexes): Signals {
  const signals: Signals = new Map();
  for (const term of [...terms.exact, ...terms.variants]) {
    for (const id of lookupSymbolExact(indexes, term)) signals.set(id, 1);
  }
  const taskWords = new Set(terms.words);
  const candidates = new Set(terms.words.flatMap((word) => lookupSymbolWord(indexes, word)));
  for (const id of candidates) {
    if (signals.get(id) === 1) continue;
    const name = indexes.byId.get(id)?.name ?? "";
    const nameWords = [...new Set(stemmedWords(name.slice(name.lastIndexOf(".") + 1)))];
    const covered = nameWords.filter((word) => taskWords.has(word)).length;
    if (covered === 0) continue;
    raise(signals, id, (PARTIAL_NAME_CEILING * covered * covered) / (nameWords.length * (covered + 1)));
  }
  return signals;
}

/** Lexical signal: BM25 over the task's content words, divided by the best score so the top chunk is 1. */
function lexicalSignals(terms: TaskTerms, indexes: RetrievalIndexes): Signals {
  const scores = scoreText(indexes, terms.words);
  const max = Math.max(0, ...scores.values());
  return new Map(max > 0 ? [...scores].map(([id, score]) => [id, score / max]) : []);
}

/**
 * Path signal, per file: the share of distinct task words found among the path's directory and file-name words, plus
 * a bonus when an exact term or variant is the base name, and 1 when the task names the path itself (`app.toml`
 * matches `config/app.toml`). Every chunk of the file gets the file's signal.
 */
function pathSignals(terms: TaskTerms, indexes: RetrievalIndexes): Signals {
  const files: Signals = new Map();
  const hits = new Map<string, number>();
  for (const word of terms.words) {
    for (const file of lookupPathWord(indexes, word)) hits.set(file, (hits.get(file) ?? 0) + 1);
  }
  for (const [file, count] of hits) files.set(file, count / terms.words.length);
  for (const term of [...terms.exact, ...terms.variants]) {
    if (term.includes("/") || term.includes(".")) {
      for (const file of indexes.paths.chunksByFile.keys()) {
        if (file === term || file.endsWith(`/${term}`)) files.set(file, 1);
      }
    }
    for (const file of lookupBasename(indexes, term)) raise(files, file, (files.get(file) ?? 0) + BASENAME_BONUS);
  }
  const signals: Signals = new Map();
  for (const [file, value] of files) {
    for (const id of indexes.paths.chunksByFile.get(file) ?? []) signals.set(id, Math.min(1, value));
  }
  return signals;
}

/**
 * Scores every chunk that any signal matches. Sorted by total descending, then file, start line and id, so equal
 * scores never depend on input order.
 */
export function scoreChunks(
  terms: TaskTerms,
  indexes: RetrievalIndexes,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): ChunkScore[] {
  const all = {
    symbol: symbolSignals(terms, indexes),
    lexical: lexicalSignals(terms, indexes),
    path: pathSignals(terms, indexes),
  };
  const ids = new Set([...all.symbol.keys(), ...all.lexical.keys(), ...all.path.keys()]);
  const scores: ChunkScore[] = [];
  for (const chunkId of ids) {
    const signals = {
      symbol: all.symbol.get(chunkId) ?? 0,
      lexical: all.lexical.get(chunkId) ?? 0,
      path: all.path.get(chunkId) ?? 0,
    };
    const contributions = {
      symbol: weights.symbol * signals.symbol,
      lexical: weights.lexical * signals.lexical,
      path: weights.path * signals.path,
    };
    const total = contributions.symbol + contributions.lexical + contributions.path;
    if (total > 0) scores.push({ chunkId, signals, contributions, total });
  }
  // `indexes.chunks` is already sorted by file, start line and id, which is the tie-break order.
  const position = new Map(indexes.chunks.map((chunk, index) => [chunk.id, index]));
  return scores.sort((a, b) => b.total - a.total || (position.get(a.chunkId) ?? 0) - (position.get(b.chunkId) ?? 0));
}
