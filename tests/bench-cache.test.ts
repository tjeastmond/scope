// Structural claims of the M6 benchmark (scripts/bench-cache.ts), offline with one repeat on mixed-app: the cache
// reparses nothing when nothing changed, an identical repeat makes no provider call, memory only appends candidates,
// and no feedback is ever submitted for a held-out task. Timings and recall numbers are not asserted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createContext,
  scenarioParse,
  scenarioRelated,
  scenarioRepeat,
  scenarioUnseen,
  submitTuningFeedback,
  type BenchContext,
  type Measured,
} from "../scripts/bench-cache.ts";
import { FIXTURES, loadLabeledTasks } from "./helpers/labels.ts";

const FIXTURE = "mixed-app";
let ctx: BenchContext;

beforeAll(async () => {
  ctx = await createContext({ live: false, repeats: 1 });
});
afterAll(async () => {
  await ctx.dispose();
});

describe("cache benchmark (offline, mixed-app, one repeat)", () => {
  test("warm reparses no file and has the cold inventory; an edit reparses exactly one", async () => {
    const [row] = await scenarioParse(ctx, [{ name: FIXTURE, source: join(FIXTURES, FIXTURE) }]);
    expect(row!.equal).toBe(true);
    expect(row!.cold[0]!.reused).toBe(0);
    expect(row!.warm[0]!.analyzed).toBe(0);
    expect(row!.warm[0]!.reused).toBe(row!.cold[0]!.analyzed);
    expect(row!.edit[0]!.analyzed).toBe(1);
  }, 30_000);

  test("an identical repeat makes no provider call, reports decisionsReusedFrom, selects the same", async () => {
    const rows = await scenarioRepeat(ctx, FIXTURE);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.first[0]!.providerCalls).toBe(1);
      expect(row.second[0]!.providerCalls).toBe(0);
      expect(row.second[0]!.jevRequests).toBe(0);
      expect(row.second[0]!.decisionsReusedFrom).toBeDefined();
      expect(row.sameSelection).toBe(true);
      expect(row.forced[0]!.providerCalls).toBe(1);
    }
  }, 30_000);

  test("memory on and off differ only by appended memory candidates", async () => {
    for (const row of await scenarioRelated(ctx, FIXTURE)) {
      expect(row.onlyAppended).toBe(true);
      expect(row.addedByMemory[0]!.length).toBe(row.memoryOn[0]!.measure.memoryCandidates);
      expect(row.memoryOff[0]!.measure.memoryCandidates).toBe(0);
    }
  }, 30_000);

  test("history does not lower the candidate recall of unseen tasks", async () => {
    for (const row of await scenarioUnseen(ctx, FIXTURE)) expect(row.recallHeld).toBe(true);
  }, 60_000);

  test("feedback is never submitted for a held-out task", async () => {
    expect(ctx.feedbackLog.length).toBeGreaterThan(0);
    expect(ctx.feedbackLog.every((entry) => entry.split === "tuning")).toBe(true);
    const heldout = (await loadLabeledTasks(FIXTURE)).find((task) => task.split === "heldout")!;
    const run = { measure: { runId: "1700000000000-0123abcd" } } as Measured;
    await expect(submitTuningFeedback(ctx, FIXTURE, join(FIXTURES, FIXTURE), heldout, run)).rejects.toThrow(
      /feedback refused/,
    );
    expect(ctx.feedbackLog.some((entry) => entry.split === "heldout")).toBe(false);
  });
});
