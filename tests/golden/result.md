# Scope context

Task:

```text
Validate invoice totals
```

- Mode: jev
- Regions: 1
- Retrieval config: ` golden-1 `

## Warnings

- ` src/legacy.ts: 2 syntax errors; text fallback used. `

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

- 9 candidate(s) scored below the relevance minimum and are not listed.
