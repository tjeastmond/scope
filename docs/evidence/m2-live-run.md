# M2 live Jev run on the mixed fixture

Three real runs of the compiled CLI against `fixtures/mixed-app` (43 files, TSX, TypeScript, Python, SQL, config, Markdown), with TJ's `TYPESAFE_API_KEY` (not recorded here). SDK `@typesafe-ai/sdk` 0.6.0, Node v24.7.0, run 2026-10-06. Companion to [m1-live-run.md](m1-live-run.md), which covers the M1 fixture.

```bash
node dist/cli.js "Show each invoice due date in the invoice list" --repo fixtures/mixed-app
```

## Result

The default path works on a real multi-language repository. The scan produced 125 eligible chunks, above the candidate cap of 30, so Scope pre-filtered them lexically and warned that retrieval is provisional (`125 eligible chunks exceed the candidate cap of 30 ...`). Jev judged those 30 and kept 12, 10 and 11 chunks in the three runs, across the TSX frontend, the TypeScript API and SQL. The `--no-jev` baseline keeps all 30 candidates, so Jev removed 18–20 of them.

Both chunks labeled required for this task in `tasks/mixed-app.json` (`InvoiceRow`, `InvoiceDto`) were kept in every run, with relevance 0.87 or more. The Python worker, the config files and the unrelated duplicate-named helpers (`format`, `validate`) were not selected.

| Run | Latency | Input tokens | Output tokens | Chunks kept |
| --- | ------- | ------------ | ------------- | ----------- |
| 1   | 269 ms  | 6206         | 534           | 12          |
| 2   | 289 ms  | 6206         | 534           | 10          |
| 3   | 239 ms  | 6206         | 534           | 11          |

Relevance by chunk (blank = not selected, so scored below the 0.5 minimum):

| Chunk                              | Run 1 | Run 2 | Run 3 |
| ---------------------------------- | ----- | ----- | ----- |
| `InvoiceRow`                       | 0.92  | 0.92  | 0.93  |
| `Billing.Invoice`                  | 0.89  | 0.89  | 0.89  |
| `InvoiceDto`                       | 0.87  | 0.89  | 0.89  |
| `InvoiceList`                      | 0.82  | 0.82  | 0.84  |
| `listInvoices`                     | 0.82  | 0.78  | 0.79  |
| `InvoiceListProps`                 | 0.74  | 0.75  | 0.77  |
| `InvoiceService.listByStatus`      | 0.75  | 0.73  | 0.74  |
| `select from invoices` (SQL query) | 0.67  | 0.69  | 0.70  |
| `invoices` (SQL table)             | 0.57  | 0.54  | 0.63  |
| `App`                              | 0.55  | 0.53  | 0.60  |
| `InvoiceService.create`            | 0.50  |       |       |
| `InvoiceService.dueDateFrom`       | 0.50  |       |       |
| `InvoiceService` (class header)    |       |       | 0.50  |

## Observations

- **Variability.** The eight chunks scoring 0.67 or more were the same in all runs and moved by at most 0.05. Chunks at 0.50 flip in and out, as in the M1 run, so the selected set is not reproducible at the 0.5 minimum. Threshold tuning belongs to #63.
- **Provisional retrieval.** The pre-filter is lexical, so a chunk with no task wording can be cut before Jev sees it. It happened for `InvoiceDto` under the fixture's own task text but not under the wording used here. Candidate retrieval in M3 replaces it.
- **Scan warnings.** The run also warned about the intentionally broken file (`api/src/broken/report.ts`), `web/src/main.tsx` (analyzer extracted nothing, one text-fallback window) and `worker/requirements.txt` (no analyzer for the language). All are expected for this fixture; fallback-warning noise is tracked in #139.
- **Source unchanged.** The fixture is not modified by a run; `tests/pipeline.test.ts` asserts this with a hash snapshot.
