import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MAX_CANDIDATES } from "../src/config.ts";
import { RetrievalConfigError } from "../src/errors.ts";
import { DEFAULT_RETRIEVAL_CONFIG, resolveRetrievalConfig } from "../src/retrieval/config.ts";
import { runScope } from "../src/scope.ts";
import { FIXTURES } from "./helpers/labels.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

describe("DEFAULT_RETRIEVAL_CONFIG", () => {
  test("holds the documented illustrative values and is valid", () => {
    expect(DEFAULT_RETRIEVAL_CONFIG.version).toBe("retrieval-v3");
    expect(DEFAULT_RETRIEVAL_CONFIG.weights).toEqual({
      symbol: 0.3,
      lexical: 0.2,
      path: 0.15,
      dependency: 0.2,
      test: 0.1,
      proximity: 0.05,
    });
    expect(Object.values(DEFAULT_RETRIEVAL_CONFIG.weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);
    expect(DEFAULT_RETRIEVAL_CONFIG.weakShortlistTotal).toBe(0.1);
    expect(DEFAULT_RETRIEVAL_CONFIG.expansion).toEqual({ seedCount: 5, maxNeighborsPerSeed: 4, maxExpanded: 10 });
    expect(resolveRetrievalConfig()).toEqual(DEFAULT_RETRIEVAL_CONFIG);
  });

  test("the shortlist size is the single source of the candidate cap", () => {
    expect(DEFAULT_RETRIEVAL_CONFIG.shortlistSize).toBe(30);
    expect(MAX_CANDIDATES).toBe(DEFAULT_RETRIEVAL_CONFIG.shortlistSize);
  });

  test("is deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_RETRIEVAL_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RETRIEVAL_CONFIG.weights)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RETRIEVAL_CONFIG.expansion)).toBe(true);
  });
});

describe("resolveRetrievalConfig", () => {
  test("merges partial overrides over the defaults, deeply", () => {
    const config = resolveRetrievalConfig({
      version: "retrieval-test",
      weights: { path: 0.5 },
      shortlistSize: 20,
      expansion: { maxExpanded: 3 },
    });
    expect(config.version).toBe("retrieval-test");
    expect(config.weights).toEqual({ ...DEFAULT_RETRIEVAL_CONFIG.weights, path: 0.5 });
    expect(config.shortlistSize).toBe(20);
    expect(config.expansion).toEqual({ ...DEFAULT_RETRIEVAL_CONFIG.expansion, maxExpanded: 3 });
  });

  test("never mutates the defaults or shares their nested objects", () => {
    const config = resolveRetrievalConfig({ weights: { symbol: 0.9 } });
    expect(DEFAULT_RETRIEVAL_CONFIG.weights.symbol).toBe(0.3);
    expect(config.weights).not.toBe(DEFAULT_RETRIEVAL_CONFIG.weights);
    expect(() => {
      (DEFAULT_RETRIEVAL_CONFIG.weights as { symbol: number }).symbol = 1;
    }).toThrow();
  });

  const invalid: [string, Parameters<typeof resolveRetrievalConfig>[0], string][] = [
    ["negative weight", { weights: { symbol: -0.1 } }, "weights.symbol"],
    ["NaN weight", { weights: { lexical: Number.NaN } }, "weights.lexical"],
    ["infinite weight", { weights: { dependency: Number.POSITIVE_INFINITY } }, "weights.dependency"],
    [
      "all-zero weights",
      { weights: { symbol: 0, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 } },
      "weights",
    ],
    ["fractional shortlist", { shortlistSize: 2.5 }, "shortlistSize"],
    ["zero shortlist", { shortlistSize: 0 }, "shortlistSize"],
    ["negative seed count", { expansion: { seedCount: -1 } }, "expansion.seedCount"],
    ["fractional neighbors", { expansion: { maxNeighborsPerSeed: 1.5 } }, "expansion.maxNeighborsPerSeed"],
    ["NaN expansion cap", { expansion: { maxExpanded: Number.NaN } }, "expansion.maxExpanded"],
    [
      "expansion larger than the shortlist",
      { shortlistSize: 5, expansion: { maxExpanded: 6, seedCount: 2 } },
      "expansion.maxExpanded",
    ],
    [
      "seeds larger than the shortlist",
      { shortlistSize: 3, expansion: { maxExpanded: 3, seedCount: 4 } },
      "expansion.seedCount",
    ],
    ["blank version", { version: "  " }, "version"],
    ["weak threshold above 1", { weakShortlistTotal: 1.5 }, "weakShortlistTotal"],
    ["negative weak threshold", { weakShortlistTotal: -0.1 }, "weakShortlistTotal"],
    ["NaN weak threshold", { weakShortlistTotal: Number.NaN }, "weakShortlistTotal"],
  ];
  test.each(invalid)("rejects %s and names the field", (_name, overrides, field) => {
    let error: unknown;
    try {
      resolveRetrievalConfig(overrides);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RetrievalConfigError);
    expect((error as RetrievalConfigError).field).toBe(field);
    expect((error as Error).message).toContain(field);
  });

  test("a single zero weight is allowed", () => {
    expect(resolveRetrievalConfig({ weights: { test: 0 } }).weights.test).toBe(0);
  });
});

test("runScope reports the retrieval config version", async () => {
  const { result } = await runScope({
    task: "Show the due date in the invoice list",
    repo: join(FIXTURES, "mixed-app"),
    provider: fakeProvider({ fallback: 0.9 }),
  });
  expect(result.retrievalConfigVersion).toBe(DEFAULT_RETRIEVAL_CONFIG.version);
});
