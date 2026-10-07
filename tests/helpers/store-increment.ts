// Child process for the cache-store concurrency test: increments a counter document `times` times, each as a
// read-modify-write commit, retrying whenever the store reports it was busy.
import { DocumentStore, type DocumentType } from "../../src/cache/store.ts";

const counter: DocumentType<{ value: number }> = {
  name: "counter",
  schemaVersion: 1,
  validate: (payload): payload is { value: number } =>
    typeof payload === "object" && payload !== null && typeof (payload as { value?: unknown }).value === "number",
};

const [directory, times] = process.argv.slice(2);
const store = new DocumentStore(directory as string);
for (let i = 0; i < Number(times); i++) {
  for (;;) {
    const outcome = await store.commit(
      async (tx) => tx.write(counter, { value: ((await tx.read(counter))?.value ?? 0) + 1 }),
      { lockWaitMs: 10_000 },
    );
    if (outcome.committed) break;
  }
}
