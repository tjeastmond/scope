import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChunks } from "../src/scope.ts";
import { EvalError } from "../scripts/eval/freeze.ts";
import { FIXTURES } from "../scripts/eval/labels.ts";
import {
  inputFingerprint,
  readRecording,
  recordingProvider,
  replayProvider,
  type RecordedDecision,
} from "../scripts/eval/recording.ts";
import { renderReport } from "../scripts/eval/report.ts";
import { LEXICAL_TOP_K, lexicalSelect, runEval, validateOptions, type EvalOptions } from "../scripts/eval/runner.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "scope-eval-run-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const base: EvalOptions = { modes: ["lexical", "no-jev"], split: "tuning", repeat: 1, outDir: "unused", log: () => {} };

describe("option validation", () => {
  test("the default offline combination is valid", () => {
    expect(() => validateOptions(base)).not.toThrow();
  });

  test("record and replay need the jev mode", () => {
    expect(() => validateOptions({ ...base, record: "r.json" })).toThrow(EvalError);
    expect(() => validateOptions({ ...base, replay: "r.json" })).toThrow(EvalError);
  });

  test("record and replay are mutually exclusive", () => {
    expect(() => validateOptions({ ...base, modes: ["jev"], record: "a", replay: "b" })).toThrow(EvalError);
  });

  test("repeat is valid only with jev, and not with replay or record", () => {
    expect(() => validateOptions({ ...base, repeat: 3 })).toThrow(EvalError);
    expect(() => validateOptions({ ...base, modes: ["jev"], repeat: 3, replay: "r.json" })).toThrow(EvalError);
    expect(() => validateOptions({ ...base, modes: ["jev"], repeat: 3, record: "r.json" })).toThrow(EvalError);
    expect(() => validateOptions({ ...base, modes: ["jev"], repeat: 3 })).not.toThrow();
    expect(() => validateOptions({ ...base, repeat: 0 })).toThrow(EvalError);
  });
});

describe("lexical baseline", () => {
  test("selects at most the top-k chunks, deterministically", async () => {
    const { chunks } = await loadChunks(join(FIXTURES, "webhook-service"));
    const first = lexicalSelect("verify the webhook signature before processing", { chunks });
    const second = lexicalSelect("verify the webhook signature before processing", { chunks });
    expect(first.length).toBeLessThanOrEqual(LEXICAL_TOP_K);
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((chunk) => chunk.id)).toEqual(first.map((chunk) => chunk.id));
  });
});

describe("record and replay", () => {
  test("a replay reproduces the recorded results byte for byte", async () => {
    const dir = await scratch();
    const file = join(dir, "rec.json");
    const common = { split: "tuning", fixtures: ["webhook-service"], repeat: 1, outDir: dir, log: () => {} } as const;
    const recorded = await runEval({
      ...common,
      modes: ["lexical", "no-jev", "jev"],
      record: file,
      provider: fakeProvider({ fallback: 0.9 }),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const recording = await readRecording(file);
    expect(Object.keys(recording.tasks).length).toBeGreaterThan(0);

    const replayed = await runEval({
      ...common,
      modes: ["lexical", "no-jev", "jev"],
      replay: file,
      now: () => new Date("2026-02-02T00:00:00Z"),
    });
    expect(JSON.stringify(replayed.results)).toBe(JSON.stringify(recorded.results));
    expect(replayed.run.startedAt).not.toBe(recorded.run.startedAt);

    const onDisk = JSON.parse(await readFile(replayed.jsonPath, "utf8"));
    expect(JSON.stringify(onDisk.results)).toBe(JSON.stringify(recorded.results));
    const report = renderReport(replayed);
    expect(report).toContain("## Jev impact");
    expect(report).toContain("## Jev overhead");
    expect(report).toContain("Cost is omitted");
  });

  test("a replay fails loudly when the candidate set differs", async () => {
    const dir = await scratch();
    const file = join(dir, "rec.json");
    const common = { split: "tuning", fixtures: ["webhook-service"], repeat: 1, outDir: dir, log: () => {} } as const;
    await runEval({ ...common, modes: ["jev"], record: file, provider: fakeProvider({ fallback: 0.9 }) });
    const recording = await readRecording(file);
    for (const task of Object.values(recording.tasks)) task.candidateIds = ["not-a-candidate"];
    await writeFile(file, JSON.stringify(recording));
    const error = await runEval({ ...common, modes: ["jev"], replay: file }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvalError);
  });

  test("a replay fails when the task text or a candidate's code changed, even with the same candidate ids", async () => {
    const { chunks } = await loadChunks(join(FIXTURES, "webhook-service"));
    const candidates = chunks.slice(0, 3);
    const tasks: Record<string, RecordedDecision> = {};
    await recordingProvider(fakeProvider({ fallback: 0.9 }), "t", tasks).decide({ task: "add retries", candidates });
    const recording = { version: 1, model: "m", sdkVersion: "s", recordedAt: "", commit: "", tasks } as const;
    const replay = replayProvider(recording, "t");

    await expect(replay.decide({ task: "add retries", candidates })).resolves.toBeDefined();
    await expect(replay.decide({ task: "remove retries", candidates })).rejects.toThrow(EvalError);
    const edited = [{ ...candidates[0]!, content: `${candidates[0]!.content}\n// edited` }, ...candidates.slice(1)];
    await expect(replay.decide({ task: "add retries", candidates: edited })).rejects.toThrow(EvalError);
  });

  test("the fingerprint changes with what Jev would be sent, such as the truncation limit", async () => {
    const { chunks } = await loadChunks(join(FIXTURES, "webhook-service"));
    const request = { task: "add retries", candidates: chunks.slice(0, 3) };
    expect(inputFingerprint(request)).toBe(inputFingerprint(request));
    expect(inputFingerprint(request, { candidateMaxChars: 10 })).not.toBe(inputFingerprint(request));
    expect(inputFingerprint(request, { batchMaxQuestions: 1 })).not.toBe(inputFingerprint(request));
  });
});

describe("output files", () => {
  test("two runs started in the same second never overwrite each other", async () => {
    const dir = await scratch();
    const now = () => new Date("2026-03-03T00:00:00Z");
    const options = { ...base, fixtures: ["webhook-service"], modes: ["lexical"], outDir: dir, now } as const;
    const first = await runEval(options);
    const second = await runEval(options);
    expect(second.jsonPath).not.toBe(first.jsonPath);
    expect(second.markdownPath).not.toBe(first.markdownPath);
    expect(JSON.parse(await readFile(first.jsonPath, "utf8")).run.startedAt).toBe(now().toISOString());
    expect(await readFile(second.markdownPath, "utf8")).toContain("# ");
  });
});
