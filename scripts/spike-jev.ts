// Throwaway spike for issue #2. Not shipped. Sends 3 Noul questions to Jev and prints the raw response.
// Run: TYPESAFE_API_KEY=... bun scripts/spike-jev.ts
// The API key is never printed; it is read by the SDK from the environment.
import { APIConnectionError, APIError, APIUserAbortError, TypeSafeClient, TypeSafeError, noul } from "@typesafe-ai/sdk";

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.log("TYPESAFE_API_KEY is not set; skipping the live Jev call (live verification is blocked).");
  process.exit(0);
}

const task = "Add retry with exponential backoff to the HTTP fetch helper";
const candidates = [
  {
    ref: "c1",
    path: "src/http/fetch.ts",
    symbol: "fetchJson",
    code: "export async function fetchJson(url: string) { return (await fetch(url)).json(); }",
  },
  {
    ref: "c2",
    path: "src/format/date.ts",
    symbol: "formatDate",
    code: "export function formatDate(d: Date) { return d.toISOString(); }",
  },
  {
    ref: "c3",
    path: "src/http/retry.ts",
    symbol: "sleep",
    code: "export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));",
  },
];

// Question ids are not sent to the model, so each question names its candidate explicitly.
const questions = Object.fromEntries(
  candidates.map((c) => [
    c.ref,
    noul({
      question: `Would a developer need to read or change candidate \`${c.ref}\` (${c.path}, ${c.symbol}) to complete the task in \`task\`?`,
      task,
      [c.ref]: { path: c.path, symbol: c.symbol, code: c.code },
    }),
  ]),
);

const client = new TypeSafeClient({ logLevel: "off", timeout: 30_000, retry: { maxRetries: 2 } });
const controller = new AbortController();
try {
  const started = performance.now();
  const response = await client.systemOne({ state: { task, candidates }, questions }, { signal: controller.signal });
  console.log(JSON.stringify(response, null, 2));
  console.log(`latency_ms=${Math.round(performance.now() - started)}`);
} catch (error) {
  if (error instanceof APIError) {
    console.error(`${error.constructor.name} status=${error.status} request=${error.requestId}`);
  } else if (error instanceof APIConnectionError) {
    console.error(`${error.constructor.name}: ${error.message}`);
  } else if (error instanceof APIUserAbortError) {
    console.error("Aborted");
  } else if (error instanceof TypeSafeError) {
    console.error(`TypeSafeError: ${error.message}`);
  } else {
    throw error;
  }
  process.exit(1);
}
