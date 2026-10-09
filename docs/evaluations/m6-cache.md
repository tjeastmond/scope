# M6 cache and memory benchmark (issue #82)

This report measures the M6 cache (analysis reuse, exact decision reuse, retrieval memory, adaptive weights) with
`bun run bench:cache` and checks each clause of the plan's M6 acceptance line against that evidence and the tests.

**Conclusion: the mechanics work as specified.** Warm runs reparse nothing and equal cold runs, an identical repeat
makes zero provider calls and discloses the reuse (live: no Jev request, about 200 ms saved), and memory never lowered recall. The benchmark also shows what the cache does not do: a cold run with the cache is slower than one without it, memory helped one of two tuning tasks by one chunk offline and none live, and the adaptive gate promoted nothing. The held-out set is one task, so nothing here is a claim about general
retrieval quality.

## Data and limits

- Offline run (the default): a deterministic fake decision provider built from the task labels (required and useful
  0.9, irrelevant 0.05, others 0.1). It makes no network call, so recall numbers repeat exactly; timings do not.
  Offline latency therefore excludes any Jev time. A live run with real Jev (`--live`, 2 repeats, 2026-10-09) is reported in its own section below.
- Run on 2026-10-08, darwin/arm64, Apple M3 Max (14 cores), bun 1.3.14, node 24.3.0, 5 repeats per scenario. Times
  are mean (min-max) in milliseconds.
- Data: `fixtures/mixed-app` (41 files, 125 chunks) with the three labeled tasks in `tasks/mixed-app.json`: two
  `tuning` (`due-date-column`, `configurable-reminder-retries`) and one `heldout` (`localized-csv-export`). This
  repository's own `src/` (66 files, 719 chunks) is copied in as a larger code base for parse timing only. The other
  fixtures have no labeled tasks, so they are not used.
- The related-task scenario uses one hand-written paraphrase per tuning task (in `scripts/bench-cache.ts`, next to the
  task id). Their term overlap (Jaccard) with the originals is 0.50 and 0.62, above the 0.3 memory threshold.
- Held-out isolation: feedback is submitted only for `tuning` tasks. The held-out task is run, never fed back. The
  script refuses to submit feedback for a held-out task and fails the run if any was submitted; this run submitted 64
  tuning and 0 held-out feedback entries.
- Every run uses a mkdtemp copy of a fixture and a temporary `XDG_STATE_HOME`; copies are removed at the end. No real
  cache, history or key is touched. The key is never read from the environment in offline mode and never printed.
- No tokens are estimated. The only token figures are those Jev reports, and the offline provider reports none.
- Limits: two tuning tasks, one held-out task, one labeled fixture, one machine. Freshly copied files are inside the
  cache's racy-timestamp margin, so warm runs reuse by content hash and the stat shortcut (`statHits` stays 0) is not
  measured. Real warm runs of an older tree would skip hashing too and be at least this fast.
- Raw numbers: `docs/evaluations/m6-runs.json` (ids, counts, timings; no task text, source or key).

## 1. Cold versus warm parse

`loadChunks` on a copy: cache off, cold (empty store), warm (filled), and warm after appending a comment to one
`.ts` file. Reused and parsed counts are the analysis counters, the same numbers `cache.files` reports.

| repo      | files | chunks | off ms           | cold ms             | warm ms          | edit ms          | warm reused/parsed | edit reused/parsed |
| --------- | ----- | ------ | ---------------- | ------------------- | ---------------- | ---------------- | ------------------ | ------------------ |
| mixed-app | 41    | 125    | 9.4 (8.4-11.5)   | 22.7 (20.1-30.1)    | 8.5 (7.4-9.8)    | 11.4 (10.8-12.5) | 41/0               | 40/1               |
| scope src | 66    | 719    | 75.0 (73.0-77.0) | 117.2 (105.3-154.7) | 31.0 (29.9-32.5) | 40.6 (39.1-42.3) | 66/0               | 65/1               |

- The chunk inventory of the cold, warm and edited runs equals an uncached load of the same tree in every repeat.
- Warm against off: about 0.9x on mixed-app (no gain, the tree is tiny) and 2.4x faster on `src/`. Warm against cold:
  2.7x and 3.8x faster. The edited run reparses exactly one file.
- Live: not applicable (parsing does not call Jev).

## 2. Repeated identical task

The task runs with no cache, then twice with the cache (1st, 2nd), then once with `--fresh` (reuse off).

| task                          | no cache ms      | 1st ms           | 2nd ms           | --fresh ms       | 2nd calls | 2nd Jev reqs | same selection |
| ----------------------------- | ---------------- | ---------------- | ---------------- | ---------------- | --------- | ------------ | -------------- |
| due-date-column               | 17.5 (12.4-36.5) | 29.8 (28.1-31.4) | 14.6 (12.6-17.2) | 18.2 (16.3-21.2) | 0         | 0            | yes            |
| configurable-reminder-retries | 11.2 (10.6-11.7) | 27.5 (26.0-31.9) | 12.1 (11.2-12.6) | 16.2 (15.0-17.9) | 0         | 0            | yes            |

- In all 5 repeats of both tasks the second run made 0 provider calls and 0 Jev requests, reported
  `decisionsReusedFrom` (`cache.decision.reused`), and selected the same chunks. The 1st run and `--fresh` made 1
  provider call each.
- Offline latency is not a Jev saving: the fake provider takes no time. The second run is about as fast as an uncached
  run, and the first cached run is slower (it writes the store). The live run shows the Jev saving (see Live run).

## 3. Related task

For each tuning task: run the original, submit feedback as a user would (`--useful` for the required labels Jev
selected, `--missing` for those it missed), then run the paraphrase with memory on and with `SCOPE_MEMORY=off`
(`reuseDecisions` off, so Jev is asked either way). Shortlist recall is over the candidates Jev was shown.

| task                          | feedback            | memory | shortlist recall    | memory cands | cands | ms               | Jev reqs |
| ----------------------------- | ------------------- | ------ | ------------------- | ------------ | ----- | ---------------- | -------- |
| due-date-column               | 2 useful, 0 missing | on     | 2/2 req, 9/9 useful | 0            | 29    | 16.7 (16.1-17.8) | 1        |
| due-date-column               | 2 useful, 0 missing | off    | 2/2 req, 9/9 useful | 0            | 29    | 17.2 (14.7-20.9) | 1        |
| configurable-reminder-retries | 4 useful, 0 missing | on     | 4/4 req, 6/8 useful | 1            | 31    | 15.9 (14.8-17.0) | 1        |
| configurable-reminder-retries | 4 useful, 0 missing | off    | 4/4 req, 5/8 useful | 0            | 30    | 15.5 (14.7-18.6) | 1        |

- Selected recall equals shortlist recall in all four rows (the fake provider keeps what is labeled).
- Memory on and off differ only by appended memory candidates (asserted by the test): for
  `configurable-reminder-retries` one extra candidate raised useful recall from 5/8 to 6/8. Required recall was already
  complete. For `due-date-column` memory added nothing and changed nothing.
- Latency and Jev request count are the same either way. The live run gives the same result with real Jev (see Live run).

## 4. Unseen task

Each of the three tasks on an empty store and on a store with history from the other tuning tasks (never the held-out
task), memory on and off.

| task                          | split   | empty, on           | empty, off          | history, on         | history, off        | mem cands |
| ----------------------------- | ------- | ------------------- | ------------------- | ------------------- | ------------------- | --------- |
| due-date-column               | tuning  | 2/2 req, 9/9 useful | 2/2 req, 9/9 useful | 2/2 req, 9/9 useful | 2/2 req, 9/9 useful | 0         |
| configurable-reminder-retries | tuning  | 4/4 req, 6/8 useful | 4/4 req, 6/8 useful | 4/4 req, 6/8 useful | 4/4 req, 6/8 useful | 0         |
| localized-csv-export          | heldout | 1/3 req, 1/2 useful | 1/3 req, 1/2 useful | 1/3 req, 1/2 useful | 1/3 req, 1/2 useful | 0         |

- Recall with history is never below recall on the empty store, in every arm and repeat. Memory offered no candidate
  for these unrelated tasks. The held-out task's recall is low (1/3 required) with or without history: a retrieval gap
  that memory neither causes nor fixes.

## 5. Adaptive weights

The #78 held-out gate was run on the feedback from scenario 3 and promoted only into the temp copy.

- 4 feedback runs gave a learned proposal (multipliers between 0.98 and 1.04: symbol 1.040, lexical 0.996, path 1.016,
  dependency 1.026, test 0.993, proximity 0.983).
- Held-out recall: baseline 1/3, proposal 1/3 (one held-out task). Not promoted: the proposal does not beat the
  baseline. This shows the gate works; it shows no feedback-driven retrieval gain.

## Live run

`bun run bench:cache -- --live --repeats 2 --out docs/evaluations/m6-runs-live.json` on 2026-10-09, same machine,
with real Jev decisions. Token figures below are Jev's own reported usage; nothing is estimated. Raw numbers:
`docs/evaluations/m6-runs-live.json`.

| measure                                     | result                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated task, 1st run (Jev asked)          | due-date-column 214 ms, 1 Jev request, 7108 in / 538 out; configurable-reminder-retries 197 ms, 1 request, 6251 in / 538 out                               |
| Repeated task, 2nd run (exact decision hit) | 17.8 ms and 16.0 ms, 0 Jev requests, no usage, `decisionsReusedFrom` reported, same selection in every repeat                                              |
| Repeated task, `--fresh`                    | 188 ms and 157 ms, 1 Jev request each, the same usage as the 1st run                                                                                       |
| Related task, memory on versus off          | identical: 0 memory candidates, the same shortlist and selection, 1 Jev request each, the same usage (7100 and 6258 in, 538 out); latency within noise     |
| Related task recall (real Jev)              | due-date-column 2/2 required, 9/9 useful in the shortlist, 2/2 and 1/9 selected; configurable-reminder-retries 4/4 and 5/8 shortlist, 4/4 and 2/8 selected |
| Unseen task recall (real Jev)               | the same as offline in every arm: history never lowered recall; the held-out task stays at 1/3 required                                                    |
| Adaptive gate                               | the same proposal as offline; 1/3 against 1/3, not promoted                                                                                                |

- The exact decision cache saves the whole Jev request: about 200 ms and 6000 to 7000 input tokens per repeated task
  on this fixture, and the repeat is about 11x faster end to end.
- Live, memory added no candidate for either paraphrase. Real Jev selected fewer of the useful labels than the
  offline provider, so the remembered selection held nothing the fresh shortlist lacked; the offline +1 useful chunk
  for `configurable-reminder-retries` does not reproduce live.
- Parse timings in the live run match the offline ones (parsing never calls Jev).

## Regressions and no-gain cases

- Cold with the cache is slower than without: 22.7 ms against 9.4 ms on mixed-app (2.4x) and 117 ms against 75 ms on
  `src/` (1.6x). The first run pays for hashing and writing the store; the benefit comes from later runs.
- On the 41-file fixture a warm run (8.5 ms) is no faster than an uncached run (9.4 ms): no gain at that size.
- The second run of a repeated task is no faster than an uncached run offline, because the fake provider is instant.
  Live, it skips the Jev request and is about 11x faster.
- Live, memory added no candidate to either related task, so it gave no gain with real Jev.
- Memory gave no gain on `due-date-column` (recall already complete) and one useful chunk on
  `configurable-reminder-retries`; it added no candidate in the unseen-task arms. It never lost recall.
- The held-out task keeps 1/3 required recall in every arm; the cache does not change it.
- The adaptive gate did not promote (1/3 against 1/3), so no feedback-driven weight change is evidenced.
- Stat-shortcut hits were not exercised (racy margin on fresh copies); only content-hash reuse is measured.
- No selection changed between cached and uncached runs, and no bug was found in `src/`.

## M6 acceptance

| Clause                                                                                             | Evidence                                                                                                                                                                                                                                                                                        | Verdict                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Unchanged code is reused without reparsing                                                         | Section 1 (41/0 and 66/0); `tests/cache-invalidation.test.ts` "a cold run parses, a no-change warm run parses nothing"; `tests/bench-cache.test.ts` "warm reparses no file and has the cold inventory; an edit reparses exactly one"                                                            | met                                                                  |
| Changed code produces current content and exact ranges                                             | Section 1 (edit run parses 1, inventory equal); `tests/cache-invalidation.test.ts` "an edited TypeScript file costs exactly the parses of analyzing that file alone"; `tests/cache-robustness.test.ts` "each change makes the warm run equal the cold run, and deleted code is gone everywhere" | met                                                                  |
| Deleted code never appears from stale memory                                                       | `tests/cache-memory.test.ts` "a deleted chunk is not a candidate and nothing references it"; `tests/cache-robustness.test.ts` "deleted code is not offered by memory or a reused decision on the next Jev run"                                                                                  | met                                                                  |
| The default path still uses Jev or a disclosed exact decision-cache hit                            | Section 2 (first run 1 call, repeat 0 calls with `decisionsReusedFrom`); `tests/cache-decisions.test.ts` "an identical rerun makes no Jev call, selects the same context and discloses the reuse" and "scope reuses by default and --fresh asks again, end to end"                              | met                                                                  |
| History does not suppress discovery of unseen code                                                 | Section 4 (recall never below the empty store); `tests/cache-memory.test.ts` "a new file that matches the task is still found next to the remembered chunks" and "fresh candidates keep their order, signals, scores and origin"                                                                | met (one held-out task)                                              |
| Warm-run speedups have benchmark evidence                                                          | Section 1: warm 2.4x faster than off on `src/`, 2.7x to 3.8x faster than cold; no gain on the 41-file fixture; cold is slower                                                                                                                                                                   | partly met (no gain on small repositories; stat shortcut unmeasured) |
| Feedback-driven retrieval changes have benchmark evidence without unacceptable quality regressions | Sections 3 and 5 and the live run: +1 useful chunk on one task offline, none live, no loss anywhere, no promoted weights                                                                                                                                                                        | partly met (no live gain; mechanics and no-regression shown)         |
