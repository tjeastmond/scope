// Live measurements of Jev's operational behavior for docs/jev-sdk-notes.md (issue #58). Dev script, not shipped.
// Run: bun scripts/measure-jev.ts   (needs TYPESAFE_API_KEY; sends this repository's src/ chunks to Jev)
// Prints request sizes, usage, latency and error classes. The API key is never printed.

import { noul, TypeSafeClient, VERSION } from "@typesafe-ai/sdk";
import { JEV_BATCH_MAX_CHARS } from "../src/config.ts";
import { JevDecisionProvider, type JevClient } from "../src/jev/provider.ts";
import { selectCandidates } from "../src/retrieval/candidates.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.log("TYPESAFE_API_KEY is not set; nothing measured.");
  process.exit(0);
}

const REPEATS = 3;
const CANDIDATES = 25;
const TASK = "Cap each candidate's code at a fixed size in the Jev request builder, marking truncated code";

interface RequestRecord {
  chars: number;
  questions: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

/** Wraps the real client to record each request's serialized size, usage, model and latency. */
function recordingClient(sdk: TypeSafeClient, records: RequestRecord[]): JevClient {
  return {
    async systemOne(request, options) {
      const started = performance.now();
      const response = await sdk.systemOne(request as never, options);
      records.push({
        chars: JSON.stringify(request).length,
        questions: Object.keys(request.questions).length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Math.round(performance.now() - started),
        model: response.model,
      });
      return response;
    },
  };
}

/** The error's class and HTTP status only; messages and bodies can echo request content. */
function describeError(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `${name} (HTTP ${status})` : name;
}

const sdk = new TypeSafeClient({ logLevel: "off", timeout: 60_000, retry: { maxRetries: 0 } });
const { chunks } = await loadChunks(".");
const source = chunks.filter((chunk) => chunk.file.startsWith("src/"));
const candidates = selectCandidates(TASK, source).candidates.slice(0, CANDIDATES);
const codeChars = candidates.reduce((sum, chunk) => sum + chunk.content.length, 0);
console.log(`SDK ${VERSION} under Bun ${Bun.version}`);
console.log(`${candidates.length} candidates from src/, ${codeChars} code characters in total`);

const largest = [...source].sort((a, b) => b.content.length - a.content.length).slice(0, CANDIDATES);
const largeChars = largest.reduce((sum, chunk) => sum + chunk.content.length, 0);
console.log(`${largest.length} largest src/ chunks, ${largeChars} code characters in total`);

async function run(label: string, candidates: CodeChunk[], batchMaxChars: number) {
  console.log(`\n## ${label} (batchMaxChars=${batchMaxChars})`);
  for (let i = 1; i <= REPEATS; i++) {
    const records: RequestRecord[] = [];
    const provider = new JevDecisionProvider({ client: recordingClient(sdk, records), batchMaxChars });
    const result = await provider.decide({ task: TASK, candidates });
    const kept = result.judgments.filter((j) => j.relevance >= 0.5).length;
    console.log(`run ${i}: ${result.latencyMs} ms end-to-end, ${records.length} request(s), ${kept} >= 0.5`);
    for (const r of records) {
      const ratio = (r.chars / r.inputTokens).toFixed(2);
      console.log(
        `  ${r.questions} questions, ${r.chars} chars, ${r.inputTokens} in / ${r.outputTokens} out tokens ` +
          `(${ratio} chars/token), ${r.latencyMs} ms, ${r.model}`,
      );
    }
  }
}

await run("shortlist, single request", candidates, Number.MAX_SAFE_INTEGER);
await run("shortlist, batched (default)", candidates, JEV_BATCH_MAX_CHARS);
await run("largest chunks, single request", largest, Number.MAX_SAFE_INTEGER);
await run("largest chunks, batched (default)", largest, JEV_BATCH_MAX_CHARS);

console.log("\n## question count");
for (const count of [100, 300, 1000]) {
  const questions = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`q${i}`, noul(`Does \`numbers\` contain the number ${i}?`)]),
  );
  const started = performance.now();
  try {
    const response = await sdk.systemOne({ state: { numbers: [3, 14, 15, 92] }, questions });
    const answered = Object.keys(response.answers).length;
    const ms = Math.round(performance.now() - started);
    console.log(`${count} questions: ok, ${answered} answers, ${response.usage.input_tokens} in tokens, ${ms} ms`);
  } catch (error) {
    console.log(`${count} questions: ${describeError(error)}`);
  }
}

console.log("\n## state size sweep (one question)");
const filler = source.map((chunk) => chunk.content).join("\n");
for (const size of [60_000, 90_000, 100_000, 110_000, 130_000, 240_000]) {
  const code = filler.repeat(Math.ceil(size / filler.length)).slice(0, size);
  try {
    const response = await sdk.systemOne({ state: { code }, questions: { q: noul("Is `code` TypeScript?") } });
    const ratio = (size / response.usage.input_tokens).toFixed(2);
    console.log(`${size} chars: accepted, ${response.usage.input_tokens} in tokens (${ratio} chars/token)`);
  } catch (error) {
    console.log(`${size} chars: ${describeError(error)}`);
  }
}

console.log("\n## timeout and cancellation");
const tiny = { state: "The sky is blue.", questions: { q: noul("Is the sky blue?") } };
try {
  await sdk.systemOne(tiny, { timeout: 1 });
  console.log("1 ms timeout: completed (unexpected)");
} catch (error) {
  console.log(`1 ms timeout, no retries: ${describeError(error)}`);
}
try {
  await sdk.systemOne(tiny, { signal: AbortSignal.timeout(5) });
  console.log("abort after 5 ms: completed (unexpected)");
} catch (error) {
  console.log(`abort after 5 ms: ${describeError(error)}`);
}
const retrying = performance.now();
try {
  await sdk.systemOne(tiny, { timeout: 1, retry: { maxRetries: 2 } });
} catch (error) {
  const ms = Math.round(performance.now() - retrying);
  console.log(`1 ms timeout, 2 retries (default backoff): ${describeError(error)} after ${ms} ms`);
}
