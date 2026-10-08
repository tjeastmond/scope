# Scope context

Task:

```text
nightly batch job reconcile ledger
```

- Mode: jev
- Regions: 3
- Run ` RUN-1 ` (scope feedback ` RUN-1 ` --useful <chunk-id> ...)
- cache: 6 files reused, 1 refreshed, 0 removed; 2 memory candidates
- Cache versions: ` analyzer ` ` analyzer-golden `, ` grammar:typescript ` ` 1.0.0 `, ` scope ` ` 0.0.0 `, ` store ` ` 1 `, ` treeSitter ` ` tree-sitter-golden `
- Cache weights: ` baseline `
- Cache refreshed files: ` src/misc/filler0.ts `
- Retrieval config: ` retrieval-v4 `
- Jev questions: ` relevance-v1 `
- Jev requests: 1
- Jev latency: 3 ms (wall clock)
- Jev tokens: 5 input / 1 output

## ` src/ledger/reconcile.ts:1-3 `

- Language: typescript
- ` reconcileLedger `, function, lines 1-3: relevance 0.90

```typescript
export function reconcileLedger(x: number) {
  return x + 1;
}
```

## ` src/misc/zebra.ts:1-3 `

- Language: typescript
- ` frobnicateWidgets `, function, lines 1-3: relevance 0.90

```typescript
export function frobnicateWidgets(x: number) {
  return x * 2;
}
```

## ` src/misc/zebra2.ts:1-3 `

- Language: typescript
- ` frobnicateGadgets `, function, lines 1-3: relevance 0.80

```typescript
export function frobnicateGadgets(x: number) {
  return x * 3;
}
```

## Explanation

### ` src/ledger/reconcile.ts:1-3 reconcileLedger `

- Signals: dependency 0.00, lexical 1.00, path 0.40, proximity 0.00, symbol 1.00, test 0.00
- Jev relevance: 0.90
- Score: 0.90
- Origin: direct (dependency distance 0)
- Reason: ` Jev relevance 0.90 `

### ` src/misc/zebra.ts:1-3 frobnicateWidgets `

- Signals: dependency 0.00, lexical 0.00, memory 1.00, path 0.00, proximity 0.00, symbol 0.00, test 0.00
- Jev relevance: 0.90
- Score: 0.90
- Origin: ` memory: similar task RUN-2 `
- Reason: ` Jev relevance 0.90 `
- Memory: useful, confirmed useful in a similar task (run ` RUN-2 `, similarity 0.43)
- Memory feedback: 1 useful, 0 irrelevant, 0 missing from ` user `

### ` src/misc/zebra2.ts:1-3 frobnicateGadgets `

- Signals: dependency 0.00, lexical 0.00, memory 1.00, path 0.00, proximity 0.00, symbol 0.00, test 0.00
- Jev relevance: 0.80
- Score: 0.80
- Origin: ` memory: missing in similar task RUN-2 `
- Reason: ` Jev relevance 0.80 `
- Memory: missing, reported missing in a similar task (run ` RUN-2 `, similarity 0.43)
- Memory feedback: 0 useful, 0 irrelevant, 1 missing from ` agent:review-bot `
