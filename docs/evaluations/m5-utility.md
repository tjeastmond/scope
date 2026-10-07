# M5 utility: relevance threshold and blending (issue #63)

Jev relevance stays the only selection criterion. This report picks the minimum-relevance threshold (`MIN_RELEVANCE`)
from labeled tasks and tests whether blending Scope's deterministic retrieval score into Jev's relevance helps.

**Conclusion: keep `MIN_RELEVANCE = 0.5`; do not adopt blending.** The evidence is thin (see Limits), so this is a
"nothing here justifies a change" result, not a proof that 0.5 is optimal.

## Data and limits

- One fixture, `fixtures/mixed-app`, with the three labeled tasks in `tasks/mixed-app.json`: two `tuning`
  (`due-date-column`, `configurable-reminder-retries`) and one `heldout` (`localized-csv-export`).
- Each task was judged by the real Jev path 3 times (9 live decisions, model `jev-latest`, question version
  `relevance-v1`, 2026-10-07; 60,537 input and 4,842 output tokens in all, about 0.2 s per decision). Every decision
  covers the 30-candidate shortlist exactly as `runScope` builds it. The runs are cached in
  `docs/evaluations/m5-runs.json` (chunk ids and numbers only).
- The sweep re-selects from the cached scores with the real `selectByRelevance`, so supporting-declaration pull-ins
  count. Averages are over runs (tasks x repeats); ranges are min to max over those runs.
- The token budget was removed in #165, so the issue's "relevance/cost trade-off" is measured as output size: the
  selected characters against the `--no-jev` baseline (every candidate, plus its supports), as "size reduction".
  No tokens are estimated.
- Metrics: required recall is the share of required labels whose chunk is selected (a label counts when any chunk it
  resolves to is selected). Useful recall is the same for useful labels. Precision is selected chunks labeled required
  or useful over selected chunks carrying any label. Unlabeled selected chunks are reported apart: the labels do not
  cover every chunk, and some unlabeled chunks look relevant (for example `Billing.Status` for a "status column" task).
- Limits: two tuning tasks, one held-out task, one fixture, three repeats. The held-out task is a single data point:
  any held-out difference between settings is one task's behavior, and cannot support a general claim. Precision is 100%
  at every setting because Jev scored no irrelevant-labeled chunk above 0.3, so precision does not discriminate between
  thresholds here.

## Threshold sweep (Jev only, thresholds 0.30 to 0.80)

Tuning tasks:

| threshold | required recall | useful recall | precision | irrelevant | unlabeled     | selected         | size reduction |
| --------- | --------------- | ------------- | --------- | ---------- | ------------- | ---------------- | -------------- |
| 0.30      | 100%            | 63% (50%-67%) | 100%      | 0.0        | 3.7 (3.0-5.0) | 12.0 (11.0-13.0) | 57% (47%-67%)  |
| 0.35      | 100%            | 53% (44%-67%) | 100%      | 0.0        | 3.2 (2.0-4.0) | 10.7 (10.0-12.0) | 60% (49%-72%)  |
| 0.40      | 100%            | 43% (33%-50%) | 100%      | 0.0        | 2.7 (2.0-4.0) | 9.3 (7.0-11.0)   | 63% (49%-77%)  |
| 0.45      | 100%            | 28% (22%-38%) | 100%      | 0.0        | 1.5 (1.0-2.0) | 6.8 (6.0-8.0)    | 76% (69%-82%)  |
| 0.50      | 100%            | 22% (13%-25%) | 100%      | 0.0        | 1.0 (0.0-2.0) | 5.8 (5.0-6.0)    | 81% (79%-82%)  |
| 0.55      | 100%            | 17% (13%-22%) | 100%      | 0.0        | 1.0 (0.0-2.0) | 5.5 (5.0-6.0)    | 82% (81%-82%)  |
| 0.60      | 100%            | 14% (11%-22%) | 100%      | 0.0        | 0.8 (0.0-2.0) | 5.0 (4.0-6.0)    | 82% (81%-84%)  |
| 0.65      | 100%            | 10% (0%-13%)  | 100%      | 0.0        | 0.7 (0.0-2.0) | 4.5 (3.0-5.0)    | 83% (81%-86%)  |
| 0.70      | 100%            | 6% (0%-13%)   | 100%      | 0.0        | 0.2 (0.0-1.0) | 3.7 (2.0-5.0)    | 86% (81%-94%)  |
| 0.75      | 100%            | 6% (0%-13%)   | 100%      | 0.0        | 0.0           | 3.5 (2.0-5.0)    | 88% (81%-94%)  |
| 0.80      | 100%            | 6% (0%-13%)   | 100%      | 0.0        | 0.0           | 3.5 (2.0-5.0)    | 88% (81%-94%)  |

Held-out task:

| threshold | required recall | useful recall | precision | irrelevant | unlabeled     | selected       | size reduction |
| --------- | --------------- | ------------- | --------- | ---------- | ------------- | -------------- | -------------- |
| 0.30      | 33%             | 50%           | 100%      | 0.0        | 8.0           | 10.0           | 72%            |
| 0.35      | 33%             | 50%           | 100%      | 0.0        | 7.7 (7.0-8.0) | 9.7 (9.0-10.0) | 73% (72%-73%)  |
| 0.40      | 33%             | 50%           | 100%      | 0.0        | 6.7 (6.0-7.0) | 8.7 (8.0-9.0)  | 74% (73%-75%)  |
| 0.45      | 33%             | 50%           | 100%      | 0.0        | 5.0           | 7.0            | 79%            |
| 0.50      | 33%             | 50%           | 100%      | 0.0        | 4.0           | 6.0            | 84%            |
| 0.55      | 33%             | 50%           | 100%      | 0.0        | 3.3 (3.0-4.0) | 5.3 (5.0-6.0)  | 85% (84%-86%)  |
| 0.60      | 33%             | 50%           | 100%      | 0.0        | 2.7 (2.0-3.0) | 4.7 (4.0-5.0)  | 88% (86%-91%)  |
| 0.65      | 33%             | 50%           | 100%      | 0.0        | 1.0           | 3.0            | 92%            |
| 0.70      | 33%             | 0%            | 100%      | 0.0        | 0.0           | 1.0            | 94%            |
| 0.75      | 11% (0%-33%)    | 0%            | 100%      | 0.0        | 0.0           | 0.3 (0.0-1.0)  | 98% (94%-100%) |
| 0.80      | 0%              | 0%            | n/a       | 0.0        | 0.0           | 0.0            | 100%           |

Variability: across the 3 repeats most scores moved by about 0.02. Only one candidate moved by 0.1 or more
(`config/app.toml::workers[0]`, unlabeled, 0.32 to 0.43). Scores sitting at the 0.5 line flip in and out between runs:
`Architecture > Worker > Retries` (useful) scored 0.46, 0.50, 0.50, and `InvoiceService` (unlabeled) 0.55, 0.53, 0.50.
Both are marginal context rather than required code.

Findings:

- Required recall on the tuning tasks is 100% in every repeat up to 0.80: the lowest required chunk scored 0.86.
  Tuning therefore does not constrain the threshold from above. On the held-out task, the one required chunk that is in
  the shortlist (`toCsv`) scored 0.70 to 0.75, so it is lost at 0.75 and above.
- Held-out required recall is 33% at every threshold up to 0.70 because two of its three required chunks
  (`translate`, `messages`) are not in the 30-candidate shortlist. That is a retrieval gap (see `bun run recall`), outside
  what the threshold or blending of shortlisted candidates can fix.
- Lowering the threshold below 0.5 only adds unlabeled and marginal chunks: from 0.50 to 0.40 the tuning size reduction
  falls from 81% to 63% (held-out 84% to 74%) while required recall and precision do not change. Raising it from 0.50
  to 0.60 gains about 1 point of size reduction on tuning (4 on held-out) and loses useful chunks (`Billing.Invoice`,
  the SQL query chunk, whose repeats scored 0.58 to 0.69).

## Chosen default

Rule: the highest threshold that keeps 100% required recall on every tuning repeat, preferring a margin from scores that
flip between runs. Applied literally, the first part allows up to 0.80, but the held-out task loses its one reachable
required chunk from 0.75, and useful context is lost steadily as the threshold rises. A threshold of 0.5 keeps a 0.2
margin below the lowest reachable required chunk across all tasks (0.70), keeps every required chunk in every
repeat, and sits where the size reduction has largely flattened (about 81 to 84%) on the way up. The chunks that flip at
0.50 are marginal context, so the flipping costs little. `MIN_RELEVANCE` stays at 0.5.

## Blending

`final = jev + w * deterministic`, the deterministic retrieval total divided by the largest total among the run's
candidates (so in [0, 1]), with w in {0, 0.05, 0.1, 0.2} on the held-out task, at 0.5 and two neighbors on each side.

| threshold / weight | required recall | useful recall | precision | irrelevant | unlabeled     | selected       | size reduction |
| ------------------ | --------------- | ------------- | --------- | ---------- | ------------- | -------------- | -------------- |
| 0.40 / w=0         | 33%             | 50%           | 100%      | 0.0        | 6.7 (6.0-7.0) | 8.7 (8.0-9.0)  | 74% (73%-75%)  |
| 0.40 / w=0.05      | 33%             | 50%           | 100%      | 0.0        | 7.0 (6.0-8.0) | 9.0 (8.0-10.0) | 74% (72%-75%)  |
| 0.40 / w=0.1       | 33%             | 50%           | 100%      | 0.0        | 7.7 (7.0-8.0) | 9.7 (9.0-10.0) | 73% (72%-73%)  |
| 0.40 / w=0.2       | 33%             | 50%           | 100%      | 0.0        | 8.0           | 10.0           | 72%            |
| 0.45 / w=0         | 33%             | 50%           | 100%      | 0.0        | 5.0           | 7.0            | 79%            |
| 0.45 / w=0.05      | 33%             | 50%           | 100%      | 0.0        | 5.0           | 7.0            | 79%            |
| 0.45 / w=0.1       | 33%             | 50%           | 100%      | 0.0        | 5.3 (5.0-6.0) | 7.3 (7.0-8.0)  | 78% (77%-79%)  |
| 0.45 / w=0.2       | 33%             | 50%           | 100%      | 0.0        | 7.7 (7.0-8.0) | 9.7 (9.0-10.0) | 73% (72%-73%)  |
| 0.50 / w=0         | 33%             | 50%           | 100%      | 0.0        | 4.0           | 6.0            | 84%            |
| 0.50 / w=0.05      | 33%             | 50%           | 100%      | 0.0        | 4.0           | 6.0            | 84%            |
| 0.50 / w=0.1       | 33%             | 50%           | 100%      | 0.0        | 4.3 (4.0-5.0) | 6.3 (6.0-7.0)  | 82% (79%-84%)  |
| 0.50 / w=0.2       | 33%             | 50%           | 100%      | 0.0        | 5.3 (5.0-6.0) | 7.3 (7.0-8.0)  | 78% (77%-79%)  |
| 0.55 / w=0         | 33%             | 50%           | 100%      | 0.0        | 3.3 (3.0-4.0) | 5.3 (5.0-6.0)  | 85% (84%-86%)  |
| 0.55 / w=0.05      | 33%             | 50%           | 100%      | 0.0        | 3.7 (3.0-4.0) | 5.7 (5.0-6.0)  | 85% (84%-86%)  |
| 0.55 / w=0.1       | 33%             | 50%           | 100%      | 0.0        | 3.7 (3.0-4.0) | 5.7 (5.0-6.0)  | 85% (84%-86%)  |
| 0.55 / w=0.2       | 33%             | 50%           | 100%      | 0.0        | 4.0           | 6.0            | 84%            |
| 0.60 / w=0         | 33%             | 50%           | 100%      | 0.0        | 2.7 (2.0-3.0) | 4.7 (4.0-5.0)  | 88% (86%-91%)  |
| 0.60 / w=0.05      | 33%             | 50%           | 100%      | 0.0        | 3.0           | 5.0            | 86%            |
| 0.60 / w=0.1       | 33%             | 50%           | 100%      | 0.0        | 3.0           | 5.0            | 86%            |
| 0.60 / w=0.2       | 33%             | 50%           | 100%      | 0.0        | 3.7 (3.0-4.0) | 5.7 (5.0-6.0)  | 85% (84%-86%)  |

Verdict: no benefit. Required recall, useful recall and precision are identical at every weight; blending only lifts
unlabeled chunks over the line, so the selection grows (for example at 0.50, w=0.2: 7.3 chunks and 78% size reduction
against 6.0 and 84%). The deterministic score cannot recover the two required chunks that are outside the shortlist,
because blending only re-scores shortlisted candidates. With a single held-out task the result is weak evidence, but
the direction (more output, no gain) is consistent with keeping Jev as the only criterion. Blending is not adopted.

## Reproduce

- `bun scripts/utility-sweep.ts` (or `bun run utility`) reads `docs/evaluations/m5-runs.json` and prints the tables
  above; it needs no network and accepts `--threshold <t>` to move the blending neighborhood.
- `bun scripts/utility-sweep.ts --collect` re-runs the 9 live decisions (needs `TYPESAFE_API_KEY`; sends the fixture's
  shortlisted code to Jev) and rewrites the cache. The cache should be rebuilt when `JEV_QUESTION_VERSION` or the
  retrieval configuration changes.
