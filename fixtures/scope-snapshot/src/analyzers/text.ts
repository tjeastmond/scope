import type { AnalysisResult, CodeChunk, Language } from "../types.ts";
import { assembleChunks, type Region } from "./assemble.ts";

/** Preferred window size in lines; a window ends earlier or later only to land on a blank line. */
export const TEXT_WINDOW_LINES = 80;
/** No window is ever longer than this, whatever the content looks like. */
export const TEXT_WINDOW_MAX_LINES = 100;

const isBlank = (line: string): boolean => line.trim() === "";

interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * Splits the 1-based inclusive line range `from..to` into windows of about `TEXT_WINDOW_LINES` lines. A window ends on
 * the blank line nearest the target size when one lies in `[TEXT_WINDOW_LINES / 2, TEXT_WINDOW_MAX_LINES]`, else
 * exactly at the target size. Blank lines at the edges of a window are trimmed and blank-only windows are dropped, so
 * every non-blank line is in exactly one window and windows never overlap.
 */
function windowsOver(lines: readonly string[], from: number, to: number): LineRange[] {
  const windows: LineRange[] = [];
  for (let start = from; start <= to;) {
    let end = to;
    if (to - start + 1 > TEXT_WINDOW_LINES) {
      end = start + TEXT_WINDOW_LINES - 1;
      let best = Infinity;
      const last = Math.min(start + TEXT_WINDOW_MAX_LINES - 1, to - 1);
      for (let k = start + TEXT_WINDOW_LINES / 2 - 1; k <= last; k++) {
        const distance = Math.abs(k - (start + TEXT_WINDOW_LINES - 1));
        if (isBlank(lines[k - 1]!) && distance < best) {
          best = distance;
          end = k;
        }
      }
    }
    let first = start;
    let final = end;
    while (first <= final && isBlank(lines[first - 1]!)) first++;
    while (final >= first && isBlank(lines[final - 1]!)) final--;
    if (first <= final) windows.push({ startLine: first, endLine: final });
    start = end + 1;
  }
  return windows;
}

/**
 * The one text fallback. Splits every line of `source` that no `covered` chunk spans into bounded line windows
 * (`section` chunks, or one `file` chunk when the whole file is a single window), and adds a warning naming the file
 * and `reason`. With no `covered` chunks it handles unsupported languages and failed analyzers; with the chunks an
 * analyzer recovered from a broken file it fills just the gaps. Nothing overlaps `covered`. A file with no non-blank
 * line outside `covered` yields no chunks and no warning.
 */
export function textFallback(
  file: string,
  source: string,
  language: Language,
  reason: string,
  covered: readonly Pick<CodeChunk, "startLine" | "endLine">[] = [],
): AnalysisResult {
  const lines = source.split("\n");
  const taken = new Array<boolean>(lines.length + 2).fill(false);
  for (const { startLine, endLine } of covered) {
    for (let line = Math.max(startLine, 1); line <= Math.min(endLine, lines.length); line++) taken[line] = true;
  }
  const windows: LineRange[] = [];
  for (let line = 1; line <= lines.length; line++) {
    if (taken[line]) continue;
    const start = line;
    while (line < lines.length && !taken[line + 1]) line++;
    windows.push(...windowsOver(lines, start, line));
  }
  if (windows.length === 0) return { chunks: [], warnings: [] };
  const whole = covered.length === 0 && windows.length === 1;
  const regions: Region[] = windows.map((window) => ({ ...window, kind: whole ? "file" : "section" }));
  const { chunks } = assembleChunks(file, source, language, regions, false);
  const where = covered.length === 0 ? "" : " over the lines the parser did not recover";
  return {
    chunks,
    warnings: [`${file}: ${reason}; text fallback produced ${chunks.length} line window(s)${where}`],
  };
}
