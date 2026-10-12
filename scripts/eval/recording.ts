// Record and replay of Jev decisions, so a Jev run can be reproduced offline without credentials or network.
// A recording keeps, per task id, the candidate chunk ids Jev was shown and what it answered.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { planJevRequests, type JevRequestLimits } from "../../src/jev/provider.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../../src/types.ts";
import { EvalError } from "./freeze.ts";

export interface RecordedDecision {
  /** Candidate chunk ids in the order the provider received them. */
  candidateIds: string[];
  /** {@link inputFingerprint} of the request: a replay whose Jev request bodies would differ in any way fails. */
  fingerprint: string;
  /** Relevance per candidate. The provider's raw answers are not kept. */
  judgments: { chunkId: string; relevance: number }[];
  usage?: DecisionResult["usage"];
  latencyMs?: number;
  requests?: DecisionResult["requests"];
}

export interface Recording {
  version: 1;
  /** Model id and SDK version of the live run that produced the decisions. */
  model: string;
  sdkVersion: string;
  recordedAt: string;
  commit: string;
  /** Decisions by task id (task ids are unique across `tasks/*.json`). */
  tasks: Record<string, RecordedDecision>;
}

/**
 * sha256 over the exact request bodies Jev is sent for this task and these candidates: task text, candidate metadata and
 * truncated code, question wording, batching and model. Labels are not part of it, so relabeling and rescoring still
 * replay.
 */
export function inputFingerprint(
  { task, candidates }: Pick<DecisionRequest, "task" | "candidates">,
  limits?: JevRequestLimits,
): string {
  return createHash("sha256")
    .update(JSON.stringify(planJevRequests(task, candidates, limits)))
    .digest("hex");
}

/** Wraps a provider and stores its decision for `taskId` in `into`. A failing provider records nothing. */
export function recordingProvider(
  inner: DecisionProvider,
  taskId: string,
  into: Record<string, RecordedDecision>,
): DecisionProvider {
  return {
    async decide(request) {
      const decision = await inner.decide(request);
      into[taskId] = {
        candidateIds: request.candidates.map((chunk) => chunk.id),
        fingerprint: inputFingerprint(request),
        judgments: decision.judgments.map(({ chunkId, relevance }) => ({ chunkId, relevance })),
        ...(decision.usage === undefined ? {} : { usage: decision.usage }),
        ...(decision.latencyMs === undefined ? {} : { latencyMs: decision.latencyMs }),
        ...(decision.requests === undefined ? {} : { requests: decision.requests }),
      };
      return decision;
    },
  };
}

/** Returns the recorded decision for `taskId`, and fails loudly if the candidates are not the ones recorded. */
export function replayProvider(recording: Recording, taskId: string): DecisionProvider {
  return {
    async decide(request) {
      const { candidates } = request;
      const recorded = recording.tasks[taskId];
      if (!recorded) throw new EvalError(`The recording has no decision for task ${taskId}.`);
      const ids = candidates.map((chunk) => chunk.id);
      const same = ids.length === recorded.candidateIds.length && ids.every((id, i) => id === recorded.candidateIds[i]);
      if (!same) {
        const have = new Set(ids);
        const had = new Set(recorded.candidateIds);
        const added = ids.filter((id) => !had.has(id));
        const removed = recorded.candidateIds.filter((id) => !have.has(id));
        throw new EvalError(
          `Candidates for task ${taskId} differ from the recording (${ids.length} now, ${recorded.candidateIds.length} recorded; ` +
            `${added.length} new, ${removed.length} missing${added.length + removed.length === 0 ? ", same set in a different order" : ""}). ` +
            "Retrieval or the chunking changed since it was recorded; record again.",
        );
      }
      if (inputFingerprint(request) !== recorded.fingerprint)
        throw new EvalError(
          `The Jev requests for task ${taskId} changed since it was recorded (task text, candidate code, questions, batching or model); record again.`,
        );
      return {
        judgments: recorded.judgments.map(({ chunkId, relevance }) => ({ chunkId, relevance })),
        ...(recorded.usage === undefined ? {} : { usage: recorded.usage }),
        ...(recorded.latencyMs === undefined ? {} : { latencyMs: recorded.latencyMs }),
        ...(recorded.requests === undefined ? {} : { requests: recorded.requests }),
      };
    },
  };
}

export async function readRecording(file: string): Promise<Recording> {
  let parsed: Recording;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as Recording;
  } catch (error) {
    throw new EvalError(`Cannot read the recording ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.version !== 1 || typeof parsed.tasks !== "object" || parsed.tasks === null)
    throw new EvalError(`${file} is not a version 1 recording.`);
  return parsed;
}

export async function writeRecording(file: string, recording: Recording): Promise<void> {
  const tasks = Object.fromEntries(Object.entries(recording.tasks).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await writeFile(file, `${JSON.stringify({ ...recording, tasks }, null, 2)}\n`);
}
