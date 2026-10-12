import { useSyncExternalStore } from "react";
import type { Alert, Metric, TimeRange } from "../api/types";
import { getConfig } from "../config";

export interface DashboardState {
  metrics: Metric[];
  alerts: Alert[];
  timeRange: TimeRange;
  loading: boolean;
  error: string | null;
}

type Listener = () => void;

export function createStore<S>(initial: S) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(update: Partial<S>) {
      state = { ...state, ...update };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const dashboardStore = createStore<DashboardState>({
  metrics: [],
  alerts: [],
  timeRange: getConfig().defaultTimeRange,
  loading: false,
  error: null,
});

export function useDashboard<T>(select: (state: DashboardState) => T): T {
  return useSyncExternalStore(dashboardStore.subscribe, () => select(dashboardStore.get()));
}
