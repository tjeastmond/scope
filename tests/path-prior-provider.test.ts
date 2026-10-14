import { expect, test } from "bun:test";
import { JevCancelledError, JevRequestError, JevResponseError, JevTimeoutError } from "../src/jev/errors.ts";
import { JevPathPriorProvider, planPathPriorLevel } from "../src/jev/path-prior.ts";
import type { JevClient } from "../src/jev/provider.ts";

type Request = Parameters<JevClient["systemOne"]>[0];
type Entries = Record<string, string>;
const directories = (request: Request) =>
  request.state.directories as Record<string, { path: string; entries: Entries }>;

/** Answers every question from a table of probability by entry name (default 0.01). */
function fakeClient(table: Record<string, number> = {}, mutate?: (answers: Record<string, unknown>) => unknown) {
  const requests: Request[] = [];
  const client: JevClient = {
    async systemOne(request) {
      requests.push(request);
      const answers: Record<string, unknown> = {};
      for (const [key, dir] of Object.entries(directories(request))) {
        answers[key] = {
          probabilities: Object.fromEntries(
            Object.entries(dir.entries).map(([label, name]) => [label, table[name] ?? 0.01]),
          ),
        };
      }
      return {
        answers: (mutate?.(answers) ?? answers) as Record<string, unknown>,
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  };
  return { client, requests };
}

const FILES = ["README.md", "docs/x.md", "lib/deep/one.ts", "lib/deep/two.ts", "src/a.ts", "src/b.ts"];
const TABLE = { "src/": 0.6, "lib/": 0.3, "docs/": 0.06, "README.md": 0.04, "a.ts": 0.8, "b.ts": 0.2 };

test("the planner splits a large directory into groups of at most maxFanout entries with a scaled share", () => {
  const entries = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
  const plan = planPathPriorLevel("t", [{ path: "src", entries }], { maxFanout: 10 });
  const questions = plan.flatMap((p) => p.questions);
  expect(questions.map((q) => [q.key, q.start, q.size])).toEqual([
    ["d0g0", 0, 10],
    ["d0g1", 10, 10],
    ["d0g2", 20, 5],
  ]);
  expect(questions.map((q) => q.scale)).toEqual([0.4, 0.4, 0.2]);
  const unsplit = planPathPriorLevel("t", [{ path: "src", entries: entries.slice(0, 3) }], { maxFanout: 10 });
  expect(unsplit[0]!.questions[0]).toMatchObject({ key: "d0", scale: 1 });
});

test("the planner packs questions by maxQuestions and maxChars and refuses an oversize question", () => {
  const dirs = Array.from({ length: 5 }, (_, i) => ({ path: `d${i}`, entries: ["a.ts", "b.ts"] }));
  const byCount = planPathPriorLevel("t", dirs, { maxFanout: 5, maxQuestions: 2 });
  expect(byCount.map((p) => p.questions.length)).toEqual([2, 2, 1]);
  const one = JSON.stringify(planPathPriorLevel("t", [dirs[0]!], { maxFanout: 5 })[0]!.request).length;
  const byChars = planPathPriorLevel("t", dirs, { maxFanout: 5, maxChars: one + 20 });
  expect(byChars.map((p) => p.questions.length)).toEqual([1, 1, 1, 1, 1]);
  expect(() => planPathPriorLevel("t", dirs, { maxFanout: 5, maxChars: 10 })).toThrow(JevRequestError);
});

test("the default run descends level by level and scores the best path highest", async () => {
  const { client, requests } = fakeClient(TABLE);
  const result = await new JevPathPriorProvider({ client }).rank({ task: "fix a", files: FILES });
  expect(result.requestCount).toBe(requests.length);
  expect(result.usage.inputTokens).toBe(10 * requests.length);
  const s = result.scores;
  expect([...s.keys()].sort()).toEqual([...FILES].sort());
  expect(s.get("src/a.ts")).toBe(1);
  expect(s.get("src/a.ts")!).toBeGreaterThan(s.get("src/b.ts")!);
  expect(s.get("src/b.ts")!).toBeGreaterThan(s.get("README.md")!);
  expect(s.get("README.md")!).toBeGreaterThan(s.get("lib/deep/one.ts")!);
  for (const v of s.values()) expect(v >= 0 && v <= 1).toBe(true);
});

test("maxDepth, maxFrontier, minDescend and maxRequests bound the exploration", async () => {
  const run = async (limits: ConstructorParameters<typeof JevPathPriorProvider>[0]) => {
    const { client, requests } = fakeClient(TABLE);
    const result = await new JevPathPriorProvider({ client, ...limits }).rank({ task: "t", files: FILES });
    return { result, paths: requests.flatMap((r) => Object.values(directories(r)).map((d) => d.path)) };
  };
  expect((await run({ limits: { maxDepth: 1 } })).paths).toEqual(["."]);
  expect((await run({ limits: { maxFrontier: 1 } })).paths).toEqual([".", "src"]);
  expect((await run({ limits: { minDescend: 0.5 } })).paths).toEqual([".", "src"]);
  expect((await run({ limits: { maxDepth: 1, minDescend: 0 } })).paths).toEqual(["."]);
  const capped = await run({ limits: { maxRequests: 1 } });
  expect(capped.result.requestCount).toBe(1);
  expect(capped.paths).toEqual(["."]);
  // maxDepth 3 reaches lib/deep, but a deeper default run never asks about a single-entry directory.
  const deep = await run({ limits: { maxDepth: 3, minDescend: 0 } });
  expect(deep.paths).toContain("lib/deep");
});

test("a split directory is asked in groups and its probabilities are scaled to sum to at most 1", async () => {
  const files = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);
  const { client, requests } = fakeClient({ "f0.ts": 0.9 });
  const result = await new JevPathPriorProvider({ client, limits: { maxFanout: 3 } }).rank({ task: "t", files });
  expect(Object.keys(directories(requests[0]!))).toEqual(["d0g0", "d0g1"]);
  expect(result.scores.get("f0.ts")).toBe(1);
  expect(result.scores.get("f3.ts")!).toBeCloseTo(0.01 / 0.9);
});

const BAD: [string, (a: Record<string, unknown>) => unknown][] = [
  ["a missing answer", () => ({})],
  ["an extra question", (a) => ({ ...a, d99: { probabilities: {} } })],
  [
    "an unknown label",
    (a) => ({ d0: { probabilities: { ...(a.d0 as { probabilities: object }).probabilities, zz: 0.5 } } }),
  ],
  ["a missing label", () => ({ d0: { probabilities: { e0: 0.5 } } })],
  ["NaN", () => ({ d0: { probabilities: { e0: Number.NaN, e1: 0.1, e2: 0.1, e3: 0.1 } } })],
  ["an out-of-range probability", () => ({ d0: { probabilities: { e0: 1.5, e1: 0.1, e2: 0.1, e3: 0.1 } } })],
  ["a non-numeric probability", () => ({ d0: { probabilities: { e0: "0.5", e1: 0.1, e2: 0.1, e3: 0.1 } } })],
];
for (const [name, mutate] of BAD) {
  test(`strict validation rejects ${name}`, async () => {
    const { client } = fakeClient(TABLE, mutate);
    await expect(new JevPathPriorProvider({ client }).rank({ task: "t", files: FILES })).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });
}

test("strict validation rejects malformed usage", async () => {
  const client: JevClient = {
    async systemOne(request) {
      const answers = Object.fromEntries(
        Object.entries(directories(request)).map(([k, d]) => [
          k,
          { probabilities: Object.fromEntries(Object.keys(d.entries).map((l) => [l, 0.2])) },
        ]),
      );
      return { answers, usage: { input_tokens: -1, output_tokens: Number.NaN } };
    },
  };
  await expect(new JevPathPriorProvider({ client }).rank({ task: "t", files: FILES })).rejects.toBeInstanceOf(
    JevResponseError,
  );
});

test("cancellation and the overall deadline map to their own errors", async () => {
  const hanging: JevClient = { systemOne: () => new Promise(() => {}) };
  const controller = new AbortController();
  const cancelled = new JevPathPriorProvider({ client: hanging }).rank({
    task: "t",
    files: FILES,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  await expect(cancelled).rejects.toBeInstanceOf(JevCancelledError);
  await expect(
    new JevPathPriorProvider({ client: hanging, deadlineMs: 5 }).rank({ task: "t", files: FILES }),
  ).rejects.toBeInstanceOf(JevTimeoutError);
});

test("instructions and criteria hold no repository names; only the state does", async () => {
  const files = ["zebrafile.ts", "quokka/marsupial.ts", "quokka/wombat.ts"];
  const { client, requests } = fakeClient();
  await new JevPathPriorProvider({ client, limits: { minDescend: 0 } }).rank({ task: "tweak pelican", files });
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    const asked = JSON.stringify(request.questions);
    for (const name of ["zebrafile", "quokka", "marsupial", "wombat", "pelican"]) expect(asked).not.toContain(name);
    expect(request.state.task).toBe("tweak pelican");
  }
  expect(requests.map((r) => JSON.stringify(r.state)).join("")).toContain("zebrafile");
});
