# Scope context

Task:

```text
Validate invoice totals
```

- Mode: jev
- Budget: 900 estimated tokens
- Artifact: 312 estimated tokens (estimator ` scope-heuristic-v1 `), 1100 characters, 40 lines
- Regions: 1
- Retrieval config: ` golden-1 `

## Warnings

- ` 7 relevant chunk(s) were left out to stay within the budget. `

## ` src/invoices.ts:3-9 `

- Language: typescript
- ` total `, function, lines 3-5: relevance 0.91
- ` due `, function, lines 7-9: score 0.40

```typescript
function total(a: number, b: number) {
  return a + b;
}

function due(day: string) {
  return day;
}
```

## Left out

- ` src/big.ts:10-15 big1 ` (relevance 0.89): 101 estimated tokens, fits alone in a budget of 401
- ` src/big.ts:20-25 big2 ` (relevance 0.88): 102 estimated tokens, fits alone in a budget of 402
- ` src/big.ts:30-35 big3 ` (relevance 0.87): 103 estimated tokens, fits alone in a budget of 403
- ` src/big.ts:40-45 big4 ` (relevance 0.86): 104 estimated tokens, fits alone in a budget of 404
- ` src/big.ts:50-55 big5 ` (relevance 0.85): 105 estimated tokens, fits alone in a budget of 405
- and 2 more left out; --format json lists every one.
- 2 candidate(s) scored below the relevance minimum and are not listed.

## Unmet coherence

- ` src/invoices.ts:3-5 total ` needs chunk ` src/types.ts#Money `: too large to include as a supporting declaration (too-large)
- ` src/invoices.ts:7-9 due ` needs ` src/big.ts:10-15 big1 `: did not fit the budget (over-budget)
