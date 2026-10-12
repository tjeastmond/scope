# Scope evaluation report

## Provenance

| Field                      | Value                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| Scope version              | 0.0.0                                                            |
| Retrieval config version   | retrieval-v3                                                     |
| Jev question version       | relevance-v1                                                     |
| `@typesafe-ai/sdk` version | 0.6.0                                                            |
| Model                      | jev-latest                                                       |
| Git commit                 | 44351220d8d8ef3eebb7661798f8c2a8a9849f73                         |
| Labels checksum            | cb15a242d1143d34acd72233359edd4447fdee9f6df68abbd6b4d329c73b0a75 |
| Modes                      | jev                                                              |
| Split                      | tuning                                                           |
| Fixtures                   | scope-snapshot                                                   |
| Repeat                     | 3                                                                |
| Lexical top-k              | 10                                                               |
| Coverage threshold         | 0.8                                                              |
| Started                    | 2026-10-12T19:24:15.076Z                                         |
| Finished                   | 2026-10-12T19:24:18.266Z                                         |

Fixture revisions (`tasks/fixtures.lock.json`):

| Fixture        | sha256                                                             |
| -------------- | ------------------------------------------------------------------ |
| scope-snapshot | `28ef3a3c04a53c2c767e34e44a7bfcf4514f5cf1692a5befe420707df29bd85e` |

## Full-repository baseline

Eligible characters are the decoded text of every file Scope's own scan keeps (ignored, secret, binary, lockfile, minified, oversized and build paths excluded). Sizes are characters, not tokens. A directory skipped as a whole counts once.

| Fixture        | Eligible files | Eligible characters | Exclusions (paths per reason) |
| -------------- | -------------- | ------------------- | ----------------------------- |
| scope-snapshot | 52             | 251,719             | none                          |

## Scope with Jev

### Per task

| Task                               | Split  | Required recall | Precision   | Irrelevant rate | Unlabeled share | Selected chars | Size reduction |
| ---------------------------------- | ------ | --------------- | ----------- | --------------- | --------------- | -------------- | -------------- |
| scope-snapshot/jev-timeout-message | tuning | 100.0% (2/2)    | 66.7% (4/6) | 0.0%            | 18.7%           | 7,080          | 97.2%          |
| scope-snapshot/max-candidates-flag | tuning | 0.0% (0/4)      | 12.5% (1/8) | 0.0%            | 85.7%           | 8,687          | 96.5%          |
| scope-snapshot/min-relevance-flag  | tuning | 0.0% (0/4)      | 25.0% (1/4) | 0.0%            | 97.9%           | 1,621          | 99.4%          |
| scope-snapshot/redact-more-secrets | tuning | 0.0% (0/1)      | 0.0% (0/1)  | 0.0%            | 100.0%          | 1,357          | 99.5%          |

### Aggregates

| Split  | Tasks | Recall (mean of tasks) | Recall (pooled) | Precision (mean of tasks) | Irrelevant rate | Unlabeled share | Selected chars (total) | Selected chars (mean) | Size reduction (mean) |
| ------ | ----- | ---------------------- | --------------- | ------------------------- | --------------- | --------------- | ---------------------- | --------------------- | --------------------- |
| tuning | 4     | 25.0%                  | 18.2% (2/11)    | 26.0% (4 tasks)           | 0.0%            | 75.6%           | 18,745                 | 4,686                 | 98.1%                 |

## Jev overhead

Latency is the wall clock of the whole Jev decision for the task, in milliseconds. Tokens are as reported by Jev, summed over its requests, and are reported separately from the size of the selected context. Cost is omitted: current Jev pricing has not been verified, so no price-based cost is computed.

| Task                               | Split  | Latency (ms) | Input tokens | Output tokens | Combined tokens |
| ---------------------------------- | ------ | ------------ | ------------ | ------------- | --------------- |
| scope-snapshot/jev-timeout-message | tuning | 220          | 9,503        | 538           | 10,041          |
| scope-snapshot/max-candidates-flag | tuning | 174          | 10,047       | 538           | 10,585          |
| scope-snapshot/min-relevance-flag  | tuning | 172          | 10,997       | 538           | 11,535          |
| scope-snapshot/redact-more-secrets | tuning | 197          | 9,548        | 538           | 10,086          |

| Split  | Tasks | Total latency (ms) | Mean latency (ms) | Input tokens | Output tokens | Combined tokens |
| ------ | ----- | ------------------ | ----------------- | ------------ | ------------- | --------------- |
| tuning | 4     | 763                | 191               | 40,095       | 2,152         | 42,247          |

## Variability (3 repeats)

Each cell is min / mean / max over the repeats of one live Jev task. The per-task tables above show the first run.

| Task                               | Runs | Recall                   | Precision             | Selected chars        | Latency (ms)    | Input tokens             | Output tokens   |
| ---------------------------------- | ---- | ------------------------ | --------------------- | --------------------- | --------------- | ------------------------ | --------------- |
| scope-snapshot/jev-timeout-message | 3    | 100.0% / 100.0% / 100.0% | 66.7% / 66.7% / 66.7% | 7,080 / 7,080 / 7,080 | 155 / 185 / 220 | 9,503 / 9,503 / 9,503    | 538 / 538 / 538 |
| scope-snapshot/max-candidates-flag | 3    | 0.0% / 0.0% / 0.0%       | 11.1% / 12.0% / 12.5% | 8,687 / 8,844 / 9,157 | 154 / 167 / 174 | 10,047 / 10,047 / 10,047 | 538 / 538 / 538 |
| scope-snapshot/min-relevance-flag  | 3    | 0.0% / 0.0% / 0.0%       | 25.0% / 33.3% / 50.0% | 1,125 / 1,666 / 2,253 | 166 / 172 / 178 | 10,997 / 10,997 / 10,997 | 538 / 538 / 538 |
| scope-snapshot/redact-more-secrets | 3    | 0.0% / 0.0% / 0.0%       | 0.0% / 0.0% / 0.0%    | 1,357 / 1,357 / 1,357 | 150 / 180 / 197 | 9,548 / 9,548 / 9,548    | 538 / 538 / 538 |

## Notes

- Sizes are characters of source. Output-format overhead (headers, fences, JSON structure) is excluded, so size reduction compares selected source with eligible repository source only.
- A labeled unit is covered when the selection contains at least the coverage threshold of its lines; precision counts a selected chunk when it cover-matches a required or useful unit in either direction. See `docs/evaluation.md`.
- Precision is n/a (not 0 or 1) for a task that selected nothing. Means skip n/a values.
- A selected line inside both a required or useful unit and an irrelevant one counts as wanted, not irrelevant.
- Tuning and heldout tasks are always aggregated separately; the overall row is shown only when both ran.
