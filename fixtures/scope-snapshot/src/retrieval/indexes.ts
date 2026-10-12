// In-memory indexes over normalized chunks: symbol names, file paths and source text. Built from sorted input so the
// result does not depend on input order. Plain arrays and Maps of primitives, so they can be serialized and
// incrementally updated later.

import type { CodeChunk } from "../types.ts";
import { splitIdentifier, stem, stemmedWords, tokenizeText } from "./terms.ts";

export interface Posting {
  chunkId: string;
  tf: number;
}

export interface TextIndex {
  /** Stemmed term -> postings in chunk order. */
  postings: Map<string, Posting[]>;
  /** Chunk id -> number of indexed tokens. */
  docLength: Map<string, number>;
  avgDocLength: number;
  docCount: number;
}

export interface SymbolIndex {
  /** Lowercase name, name without punctuation, joined stemmed words, and the same for the last dotted segment. */
  exact: Map<string, string[]>;
  /** Single stemmed word of a name -> chunk ids. */
  words: Map<string, string[]>;
}

export interface PathIndex {
  /** Stemmed directory, file-name and extension-less base-name words -> files. */
  words: Map<string, string[]>;
  /** Lowercase base name, with and without extension -> files. */
  basenames: Map<string, string[]>;
  /** File -> chunk ids in chunk order. */
  chunksByFile: Map<string, string[]>;
}

export interface RetrievalIndexes {
  /** Sorted by file, start line, then id. */
  chunks: CodeChunk[];
  byId: Map<string, CodeChunk>;
  symbols: SymbolIndex;
  paths: PathIndex;
  text: TextIndex;
}

const K1 = 1.2;
const B = 0.75;

/** Append to a key's list unless it is already the last entry; input is visited in order, so this dedupes. */
function addTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (list[list.length - 1] !== value) list.push(value);
}

function compareChunks(a: CodeChunk, b: CodeChunk): number {
  return a.file.localeCompare(b.file, "en") || a.startLine - b.startLine || a.id.localeCompare(b.id, "en");
}

function nameKeys(name: string): string[] {
  const lower = name.toLowerCase();
  return [lower, lower.replace(/[^\p{L}\p{N}]/gu, ""), stemmedWords(name).join("")];
}

/** Keys under which a name or a looked-up term is matched exactly, including its last dotted segment alone. */
function exactKeys(name: string): string[] {
  const member = name.slice(name.lastIndexOf(".") + 1);
  return [...new Set([...nameKeys(name), ...nameKeys(member)].filter((key) => key.length > 0))];
}

function buildSymbolIndex(chunks: readonly CodeChunk[]): SymbolIndex {
  const exact = new Map<string, string[]>();
  const words = new Map<string, string[]>();
  for (const chunk of chunks) {
    if (!chunk.name) continue;
    for (const key of exactKeys(chunk.name)) addTo(exact, key, chunk.id);
    for (const word of stemmedWords(chunk.name)) addTo(words, word, chunk.id);
  }
  return { exact, words };
}

function buildPathIndex(chunks: readonly CodeChunk[]): PathIndex {
  const words = new Map<string, string[]>();
  const basenames = new Map<string, string[]>();
  const chunksByFile = new Map<string, string[]>();
  const seenFiles = new Set<string>();
  for (const chunk of chunks) {
    addTo(chunksByFile, chunk.file, chunk.id);
    if (seenFiles.has(chunk.file)) continue;
    seenFiles.add(chunk.file);
    const base = chunk.file.slice(chunk.file.lastIndexOf("/") + 1).toLowerCase();
    const dot = base.lastIndexOf(".");
    const stripped = dot > 0 ? chunk.file.slice(0, chunk.file.length - (base.length - dot)) : chunk.file;
    addTo(basenames, base, chunk.file);
    if (dot > 0) addTo(basenames, base.slice(0, dot), chunk.file);
    for (const word of new Set(stemmedWords(stripped))) addTo(words, word, chunk.file);
  }
  return { words, basenames, chunksByFile };
}

function buildTextIndex(chunks: readonly CodeChunk[]): TextIndex {
  const postings = new Map<string, Posting[]>();
  const docLength = new Map<string, number>();
  let total = 0;
  for (const chunk of chunks) {
    const tokens = tokenizeText(chunk.content);
    docLength.set(chunk.id, tokens.length);
    total += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [term, tf] of counts) {
      const list = postings.get(term);
      if (list) list.push({ chunkId: chunk.id, tf });
      else postings.set(term, [{ chunkId: chunk.id, tf }]);
    }
  }
  return { postings, docLength, avgDocLength: chunks.length ? total / chunks.length : 0, docCount: chunks.length };
}

export function buildIndexes(chunks: readonly CodeChunk[]): RetrievalIndexes {
  const sorted = [...chunks].sort(compareChunks);
  return {
    chunks: sorted,
    byId: new Map(sorted.map((chunk) => [chunk.id, chunk])),
    symbols: buildSymbolIndex(sorted),
    paths: buildPathIndex(sorted),
    text: buildTextIndex(sorted),
  };
}

/** Distinct values across lists, in first-seen order. */
function union(lists: (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

/** Chunk ids whose name equals the term, ignoring case, punctuation and word style (`listByStatus`, `list_by_status`). */
export function lookupSymbolExact(indexes: RetrievalIndexes, term: string): string[] {
  return union(exactKeys(term).map((key) => indexes.symbols.exact.get(key)));
}

/** Chunk ids whose name contains the term as one of its words (`status` finds `listByStatus`). */
export function lookupSymbolWord(indexes: RetrievalIndexes, term: string): string[] {
  return union(splitIdentifier(term).map((word) => indexes.symbols.words.get(stem(word))));
}

/** Files with a path segment word (directory or file name) matching the term. */
export function lookupPathWord(indexes: RetrievalIndexes, term: string): string[] {
  return union(splitIdentifier(term).map((word) => indexes.paths.words.get(stem(word))));
}

/** Files whose base name equals the name, with or without extension (`Invoice.ts` and `invoice`). */
export function lookupBasename(indexes: RetrievalIndexes, name: string): string[] {
  return indexes.paths.basenames.get(name.toLowerCase()) ?? [];
}

function termScore(text: TextIndex, df: number, { chunkId, tf }: Posting): number {
  const idf = Math.log(1 + (text.docCount - df + 0.5) / (df + 0.5));
  const length = text.docLength.get(chunkId) ?? 0;
  const norm = text.avgDocLength > 0 ? 1 - B + (B * length) / text.avgDocLength : 1;
  return (idf * tf * (K1 + 1)) / (tf + K1 * norm);
}

/** BM25 contribution of one already tokenized term to one chunk; 0 when the chunk lacks the term. */
export function bm25(indexes: RetrievalIndexes, term: string, chunkId: string): number {
  const postings = indexes.text.postings.get(term);
  const posting = postings?.find((entry) => entry.chunkId === chunkId);
  return postings && posting ? termScore(indexes.text, postings.length, posting) : 0;
}

/** Sum of BM25 scores per chunk over distinct, already tokenized query terms; chunks with no match are absent. */
export function scoreText(indexes: RetrievalIndexes, terms: readonly string[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const term of new Set(terms)) {
    const postings = indexes.text.postings.get(term);
    if (!postings) continue;
    for (const posting of postings) {
      const score = termScore(indexes.text, postings.length, posting);
      scores.set(posting.chunkId, (scores.get(posting.chunkId) ?? 0) + score);
    }
  }
  return scores;
}
