import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEURISTIC_ESTIMATOR_ID, heuristicEstimator } from "../src/context/tokens.ts";

const count = (text: string) => heuristicEstimator.count(text);

const PROSE = "The quick brown fox jumps over the lazy dog while the committee reviews the quarterly budget proposal.";
const CODE = `export async function handleStripeWebhook(req: Request): Promise<Response> {
  const { id, type } = await req.json();
  if (!id || type !== "invoice.paid") return new Response(null, { status: 400 });
  return withRetry(() => processEvent(id), { attempts: 3, backoffMs: 250 });
}
`;

test("the id is the exported constant", () => {
  expect(heuristicEstimator.id).toBe("scope-heuristic-v1");
  expect(HEURISTIC_ESTIMATOR_ID).toBe(heuristicEstimator.id);
});

test("is deterministic and always a non-negative integer", () => {
  for (const text of ["", " ", "\n", PROSE, CODE, "\0\0", "\ud800", "日本語", "😀"]) {
    const n = count(text);
    expect(n).toBe(count(text));
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  }
});

test("empty string is zero and whitespace-only text is not free", () => {
  expect(count("")).toBe(0);
  expect(count(" ")).toBeGreaterThan(0);
  expect(count("\n\n\n")).toBeGreaterThanOrEqual(1);
  expect(count(" ".repeat(400))).toBeGreaterThan(count(" ".repeat(40)));
});

test("a long identifier costs more than one token and camelCase and snake_case parts add up", () => {
  expect(count("a".repeat(40))).toBeGreaterThanOrEqual(10);
  expect(count("computeExponentialBackoffDelay")).toBeGreaterThanOrEqual(5);
  expect(count("compute_exponential_backoff_delay")).toBeGreaterThanOrEqual(7);
  expect(count("1234567890")).toBeGreaterThanOrEqual(5);
});

test("CJK and emoji cost at least one token per code point", () => {
  expect(count("日本語のテキスト")).toBeGreaterThanOrEqual(8);
  expect(count("😀😀😀")).toBeGreaterThanOrEqual(6);
  expect(count("é".repeat(10))).toBeGreaterThanOrEqual(10);
});

test("lone surrogates, CRLF and NUL are handled", () => {
  expect(count("\ud800")).toBeGreaterThan(0);
  expect(count("\udc00x")).toBeGreaterThan(0);
  expect(count("a\r\nb\r\nc")).toBeGreaterThanOrEqual(count("a\nb\nc"));
  expect(count("\0".repeat(30))).toBeGreaterThanOrEqual(10);
});

test("a minified single long line is not under-counted", () => {
  const minified = Array.from({ length: 2000 }, (_, i) => `a${i}=function(b){return b*${i}+1}`).join(";");
  expect(count(minified)).toBeGreaterThanOrEqual(Math.ceil(minified.length / 3));
});

test("huge inputs finish in linear time", () => {
  const text = "ab ".repeat(2_000_000) + " ".repeat(1_000_000);
  const start = performance.now();
  count(text);
  expect(performance.now() - start).toBeLessThan(2000);
});

test("appending text never decreases the count", () => {
  const pieces = [
    "a",
    "B",
    "7",
    " ",
    "\t",
    "\n",
    "\r",
    "(",
    ";",
    "é",
    "日",
    "\ud83d",
    "\ude00",
    "\0",
    "  ",
    "fooBar",
    "9",
  ];
  let text = "";
  let previous = 0;
  for (let i = 0; i < 400; i++) {
    text += pieces[(i * 7 + (i >> 2)) % pieces.length];
    const n = count(text);
    expect(n).toBeGreaterThanOrEqual(previous);
    previous = n;
  }
  for (const sample of [PROSE, CODE]) {
    let acc = "";
    let last = 0;
    for (const ch of sample) {
      acc += ch;
      const n = count(acc);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  }
});

test("estimates are conservative relative to chars/4 on prose and code", () => {
  expect(count(PROSE)).toBeGreaterThanOrEqual(Math.ceil(PROSE.length / 4));
  expect(count(CODE)).toBeGreaterThanOrEqual(Math.ceil(CODE.length / 3));
  expect(count(CODE) / CODE.length).toBeGreaterThan(count(PROSE) / PROSE.length);
});

test("fixture file estimates stay within a sane multiple of chars/4", () => {
  const root = join(import.meta.dir, "../fixtures/webhook-service/src");
  const source = readFileSync(join(root, "logger.ts"), "utf8");
  const n = count(source);
  expect(n).toBeGreaterThanOrEqual(Math.ceil(source.length / 4));
  expect(n).toBeLessThanOrEqual(source.length);
});

test("camelCase parts are charged separately", () => {
  expect(heuristicEstimator.count("aAaAaAaA")).toBe(5);
});

test("each blank line costs a token", () => {
  expect(heuristicEstimator.count("a\n\n\n\nb")).toBe(6);
});
