import { describe, expect, it } from "vitest";
import type { Alert } from "../src/api/types";
import { selectCriticalCount } from "../src/store/selectors";
import { createStore, type DashboardState } from "../src/store/store";

const alert = (id: string, severity: Alert["severity"], acknowledged = false): Alert => ({
  id,
  title: id,
  severity,
  raisedAt: "2025-06-03T09:30:00Z",
  acknowledged,
});

describe("store", () => {
  it("notifies subscribers on set", () => {
    const store = createStore({ count: 0 });
    let calls = 0;
    store.subscribe(() => calls++);
    store.set({ count: 1 });
    expect(calls).toBe(1);
    expect(store.get().count).toBe(1);
  });

  it("counts only open critical alerts", () => {
    const state = {
      alerts: [alert("a", "critical"), alert("b", "critical", true), alert("c", "info")],
    } as DashboardState;
    expect(selectCriticalCount(state)).toBe(1);
  });
});
