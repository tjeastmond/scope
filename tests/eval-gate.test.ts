import { beforeAll, describe, expect, test } from "bun:test";
import { checkGates, THRESHOLDS } from "../scripts/eval/gates.ts";
import { generateReportWithOutput } from "../scripts/eval/report-cli.ts";
import type { Aggregate, EvalOutput } from "../scripts/eval/runner.ts";

let real: EvalOutput;
beforeAll(async () => {
  real = (await generateReportWithOutput()).output;
}, 60_000);

const clone = (output: EvalOutput): EvalOutput => structuredClone(output);
const failing = (output: EvalOutput) => checkGates(output).filter((gate) => !gate.pass);
const aggregate = (output: EvalOutput, mode: "jev" | "no-jev", split: "tuning" | "heldout"): Aggregate => {
  const found = output.results.aggregates[mode]?.[split];
  if (!found) throw new Error(`evaluation lacks ${mode} ${split}`);
  return found;
};

describe("release gates", () => {
  test("pass on the committed evaluation", () => {
    expect(failing(real)).toEqual([]);
    expect(checkGates(real)).toHaveLength(10);
  });

  test("fail the jev recall gate when recall drops below its floor", () => {
    const output = clone(real);
    aggregate(output, "jev", "heldout").recall.micro = THRESHOLDS.jevRecall.heldout - 0.01;
    expect(failing(output).map((gate) => gate.name)).toEqual(["jev heldout pooled required recall"]);
  });

  test("fail the precision and size gates", () => {
    const output = clone(real);
    aggregate(output, "jev", "tuning").precision.macro = THRESHOLDS.jevPrecision.tuning - 0.01;
    aggregate(output, "jev", "heldout").sizeReduction.macro = THRESHOLDS.jevSizeReduction.heldout - 0.01;
    expect(failing(output).map((gate) => gate.name)).toEqual([
      "jev tuning mean precision",
      "jev heldout mean size reduction",
    ]);
  });

  test("fail the no-jev candidate recall gate", () => {
    const output = clone(real);
    aggregate(output, "no-jev", "tuning").recall.micro = THRESHOLDS.noJevRecall.tuning - 0.01;
    expect(failing(output).map((gate) => gate.name)).toEqual(["no-jev tuning pooled required recall"]);
  });

  test("fail when jev precision no longer exceeds no-jev precision", () => {
    const output = clone(real);
    const noJev = aggregate(output, "no-jev", "heldout").precision.macro;
    aggregate(output, "jev", "heldout").precision.macro = noJev;
    expect(failing(output).map((gate) => gate.name)).toContain("jev heldout mean precision exceeds no-jev");
  });

  test("fail on a missing aggregate or value instead of passing", () => {
    const missing = clone(real);
    delete missing.results.aggregates.jev?.heldout;
    const results = failing(missing);
    expect(results).toHaveLength(4);
    expect(results.every((gate) => gate.pass === false && gate.message?.includes("heldout"))).toBe(true);

    const nulled = clone(real);
    aggregate(nulled, "jev", "tuning").recall.micro = null;
    const [gate, ...rest] = failing(nulled);
    expect(rest).toEqual([]);
    expect(gate?.name).toBe("jev tuning pooled required recall");
    expect(gate?.measured).toBeNull();
  });
});
