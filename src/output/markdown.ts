import type { ScopeRegion, ScopeResult, SelectedChunk } from "../types.ts";
import { belowThresholdLine, leftOutLines, sanitizeInline, summaryLines, unmetLines } from "./report.ts";
import { labelOf } from "./text.ts";

/** Longest run of consecutive backticks anywhere in `text` (0 when there are none). */
export function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** A backtick fence strictly longer than any backtick run in `content`, and never shorter than 3. */
export const fenceFor = (content: string): string => "`".repeat(Math.max(3, longestBacktickRun(content) + 1));

/**
 * Inline code span that cannot be broken out of: the delimiter is a backtick run longer than any run inside, and one
 * space of padding on each side (CommonMark strips exactly one) keeps leading or trailing backticks from merging.
 */
export function codeSpan(text: string): string {
  const clean = sanitizeInline(text);
  const delimiter = "`".repeat(longestBacktickRun(clean) + 1);
  return `${delimiter} ${clean} ${delimiter}`;
}

/** A fenced block. The fence is chosen from the content; `info` must be a plain word. */
function fenced(content: string, info = ""): string {
  const fence = fenceFor(content);
  return `${fence}${info}\n${content}\n${fence}`;
}

function renderRegion(region: ScopeRegion, byId: ReadonlyMap<string, SelectedChunk>): string {
  const lines = [`## ${codeSpan(`${region.file}:${region.startLine}-${region.endLine}`)}`, ""];
  lines.push(`- Language: ${region.language}`);
  for (const id of region.chunkIds) {
    const item = byId.get(id);
    if (!item) continue;
    const { chunk } = item;
    const name = chunk.name ? codeSpan(chunk.name) : "(unnamed)";
    lines.push(`- ${name}, ${chunk.kind}, lines ${chunk.startLine}-${chunk.endLine}: ${labelOf(item)}`);
  }
  lines.push("", fenced(region.content, region.language));
  return lines.join("\n");
}

/**
 * Markdown artifact: a `# Scope context` heading, the task and a summary, then each region under a
 * `## path:start-end` heading with its provenance and the source in a backtick fence longer than any backtick run
 * in that source. Text from the repository (paths, symbol names) appears only inside code spans or fences.
 */
export function renderMarkdown(result: ScopeResult): string {
  const byId = new Map(result.chunks.map((item) => [item.chunk.id, item]));
  const out = [
    "# Scope context",
    "",
    "Task:",
    "",
    fenced(result.task, "text"),
    "",
    ...summaryLines(result, codeSpan).map((line) => `- ${line}`),
  ];
  if (result.warnings.length > 0) {
    out.push("", "## Warnings", "", ...result.warnings.map((warning) => `- ${codeSpan(warning)}`));
  }
  for (const region of result.regions) out.push("", renderRegion(region, byId));
  const leftOut = leftOutLines(result, codeSpan);
  const below = belowThresholdLine(result);
  if (leftOut.length > 0 || below !== undefined) {
    out.push(
      "",
      "## Left out",
      "",
      ...leftOut.map((line) => `- ${line}`),
      ...(below === undefined ? [] : [`- ${below}`]),
    );
  }
  const unmet = unmetLines(result, codeSpan);
  if (unmet.length > 0) out.push("", "## Unmet coherence", "", ...unmet.map((line) => `- ${line}`));
  return `${out.join("\n")}\n`;
}
