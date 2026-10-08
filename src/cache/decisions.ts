import { createHash, createHmac } from "node:crypto";
import { readdir } from "node:fs/promises";
import { JEV_QUESTION_VERSION } from "../config.ts";
import { jevModel, planJevRequests } from "../jev/provider.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../retrieval/config.ts";
import type { CodeChunk, RelevanceJudgment } from "../types.ts";
import { canonical, macEquals, recordMac } from "./integrity.ts";
import { commitRepositoryCache, type RepositoryCache } from "./location.ts";
import { resolveRetention } from "./retention.ts";
import type { CommitOutcome, DocumentType } from "./store.ts";
import { sdkVersion } from "./versions.ts";

/**
 * Decision reuse (#75): a Jev decision is reused only when the task text, the exact candidate payload, the full content
 * of every candidate and the decision configuration all match an earlier decision that is still within its expiry.
 * A similar task never reuses anything: it gets a fresh Jev review.
 *
 * A document holds a key id (a keyed hash, so the task text cannot be guessed from the name) and the validated
 * relevance of each candidate. Never the task text, source code, raw Jev answers, environment variables or keys.
 */

export const DECISION_PREFIX = "decision-";
/** Version of the record shape; a record of another version is ignored. */
export const DECISION_RECORD_VERSION = 1;
/** More than the shortlist of any real run. */
export const MAX_DECISION_JUDGMENTS = 1000;
const MAC_DOMAIN = "decision";
const DAY_MS = 86_400_000;
/** A lookup reads at most this many documents of one key, newest first (one is normal). */
const MAX_LOOKUPS = 3;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
/** `decision-<time as 13 decimal digits>-<64 hex key id>`. */
const NAME = /^decision-([0-9]{13})-([0-9a-f]{64})$/;

export interface DecisionRecord {
  recordVersion: 1;
  keyId: string;
  /** Milliseconds since the epoch when the decision was stored. */
  time: number;
  /** Validated relevance of each candidate, in candidate order. */
  judgments: { chunkId: string; relevance: number }[];
}

interface DecisionDocument {
  record: DecisionRecord;
  /** HMAC of the record and the repository root under the user's integrity key. */
  mac: string;
}

/** Test seam: replaces parts of the key material so a test can show that each part changes the key. */
export interface DecisionKeyOverrides {
  sdkVersion?: string;
  model?: string;
  questionVersion?: string;
  retrievalConfigVersion?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

const isJudgment = (value: unknown): value is DecisionRecord["judgments"][number] =>
  isObject(value) &&
  onlyKeys(value, ["chunkId", "relevance"]) &&
  typeof value.chunkId === "string" &&
  typeof value.relevance === "number" &&
  Number.isFinite(value.relevance) &&
  value.relevance >= 0 &&
  value.relevance <= 1;

/** Shape check of a record. A record that fails is ignored by readers. */
export function isDecisionRecord(value: unknown): value is DecisionRecord {
  return (
    isObject(value) &&
    onlyKeys(value, ["recordVersion", "keyId", "time", "judgments"]) &&
    value.recordVersion === DECISION_RECORD_VERSION &&
    typeof value.keyId === "string" &&
    KEY_PATTERN.test(value.keyId) &&
    typeof value.time === "number" &&
    Number.isInteger(value.time) &&
    value.time >= 0 &&
    Array.isArray(value.judgments) &&
    value.judgments.length <= MAX_DECISION_JUDGMENTS &&
    value.judgments.every(isJudgment)
  );
}

const isDecisionDocument = (payload: unknown): payload is DecisionDocument =>
  isObject(payload) &&
  onlyKeys(payload, ["record", "mac"]) &&
  typeof payload.mac === "string" &&
  KEY_PATTERN.test(payload.mac) &&
  isDecisionRecord(payload.record);

const decisionType = (name: string): DocumentType<DecisionDocument> => ({
  name,
  schemaVersion: 1,
  validate: isDecisionDocument,
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const pad = (time: number) => String(Math.min(Math.max(Math.trunc(time), 0), 9_999_999_999_999)).padStart(13, "0");
const documentName = (time: number, keyId: string) => `${DECISION_PREFIX}${pad(time)}-${keyId}`;

function parseName(name: string): { time: number; keyId: string } | undefined {
  const match = NAME.exec(name);
  return match ? { time: Number(match[1]), keyId: match[2]! } : undefined;
}

/**
 * The key of a decision: a keyed hash (HMAC-SHA256 under the integrity key, bound to the repository root) of the exact
 * task, the exact request payload, the full content of every candidate and the versions that shape a decision.
 * The payload truncates long candidates, so the content fingerprints are part of the key as well.
 */
export async function decisionKeyId(
  cache: RepositoryCache,
  task: string,
  candidates: readonly CodeChunk[],
  overrides: DecisionKeyOverrides = {},
): Promise<string> {
  const material = {
    task,
    payload: sha256(canonical(planJevRequests(task, candidates))),
    candidates: candidates.map((chunk) => ({ id: chunk.id, content: sha256(chunk.content) })),
    sdkVersion: overrides.sdkVersion ?? (await sdkVersion()),
    model: overrides.model ?? jevModel(),
    questionVersion: overrides.questionVersion ?? JEV_QUESTION_VERSION,
    retrievalConfigVersion: overrides.retrievalConfigVersion ?? DEFAULT_RETRIEVAL_CONFIG.version,
    scopeVersion: cache.keys.scope,
  };
  return createHmac("sha256", cache.integrityKey)
    .update(canonical(["decision-key", cache.root, material]))
    .digest("hex");
}

const decisionMac = (cache: RepositoryCache, record: DecisionRecord) =>
  recordMac(cache.integrityKey, MAC_DOMAIN, { root: cache.root, record });

/** Whether a read document is a record this user signed for this repository, under the name it was written with. */
const isVerified = (cache: RepositoryCache, name: string, document: DecisionDocument | undefined) =>
  document !== undefined &&
  documentName(document.record.time, document.record.keyId) === name &&
  macEquals(document.mac, decisionMac(cache, document.record));

/** Whether decisions are kept at all under these bounds. */
export function decisionsEnabled(env?: NodeJS.ProcessEnv): boolean {
  const { max, maxDays } = resolveRetention(env).bounds.decisions;
  return max > 0 && maxDays > 0;
}

/**
 * The stored decision for `keyId`, or undefined for any reason it cannot be reused: disabled, none, expired, unreadable,
 * not signed by this user for this repository, or not covering exactly the current candidates. Never throws.
 */
export async function lookupDecision(
  cache: RepositoryCache,
  keyId: string,
  candidates: readonly CodeChunk[],
  options: { env?: NodeJS.ProcessEnv; now: number },
): Promise<{ judgments: RelevanceJudgment[]; time: number } | undefined> {
  try {
    const { max, maxDays } = resolveRetention(options.env).bounds.decisions;
    if (max <= 0 || maxDays <= 0) return undefined;
    const oldest = options.now - maxDays * DAY_MS;
    const names = (await readdir(cache.directory))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((name) => {
        const parsed = parseName(name);
        return parsed !== undefined && parsed.keyId === keyId && parsed.time >= oldest && parsed.time <= options.now;
      })
      .sort()
      .reverse()
      .slice(0, MAX_LOOKUPS);
    const ids = new Set(candidates.map((chunk) => chunk.id));
    for (const name of names) {
      const { value } = await cache.store.read(decisionType(name));
      if (!isVerified(cache, name, value)) continue;
      const { record } = value!;
      const covered = new Set(record.judgments.map((judgment) => judgment.chunkId));
      if (
        record.judgments.length !== candidates.length ||
        covered.size !== ids.size ||
        record.judgments.some((judgment) => !ids.has(judgment.chunkId))
      ) {
        continue;
      }
      return {
        judgments: record.judgments.map(({ chunkId, relevance }) => ({ chunkId, relevance })),
        time: record.time,
      };
    }
  } catch {
    // Any read problem is a miss.
  }
  return undefined;
}

/**
 * Stores a decision and prunes, in one commit. Kept: the newest `max` verified decisions, none older than `maxDays`,
 * and only one per key (the new one replaces older ones). A `decision-*` name that does not parse, an expired or
 * unverified document is removed, so a planted name never takes a retention slot. With a bound at 0 nothing is
 * written and all decisions are removed. Never throws.
 */
export async function recordDecision(
  cache: RepositoryCache,
  decision: { keyId: string; judgments: { chunkId: string; relevance: number }[] } | undefined,
  options: { env?: NodeJS.ProcessEnv; now: number },
): Promise<CommitOutcome> {
  try {
    const { max, maxDays } = resolveRetention(options.env).bounds.decisions;
    const enabled = max > 0 && maxDays > 0;
    const record: DecisionRecord | undefined =
      enabled && decision
        ? {
            recordVersion: DECISION_RECORD_VERSION,
            keyId: decision.keyId,
            time: options.now,
            judgments: decision.judgments.slice(0, MAX_DECISION_JUDGMENTS),
          }
        : undefined;
    const newName = record ? documentName(record.time, record.keyId) : undefined;
    return await commitRepositoryCache(
      cache,
      async (tx) => {
        const keep: string[] = [];
        for (const name of (await tx.list()).filter((entry) => entry.startsWith(DECISION_PREFIX))) {
          const parsed = parseName(name);
          // A document takes a retention slot only once verified, so planted names never evict real decisions.
          const usable =
            enabled &&
            parsed !== undefined &&
            name !== newName &&
            parsed.keyId !== record?.keyId &&
            parsed.time >= options.now - maxDays * DAY_MS &&
            isVerified(cache, name, await tx.read(decisionType(name)));
          if (usable) keep.push(name);
          else if (name !== newName) tx.removeName(name);
        }
        // Names sort by time, so the newest come first once reversed; the new decision takes one of the slots.
        const slots = Math.max(max - (record ? 1 : 0), 0);
        const survivors = keep.sort().reverse().slice(0, slots);
        for (const name of keep) if (!survivors.includes(name)) tx.removeName(name);
        if (record && newName) tx.write(decisionType(newName), { record, mac: decisionMac(cache, record) });
      },
      { now: options.now },
    );
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
    return { committed: false, warning: message };
  }
}
