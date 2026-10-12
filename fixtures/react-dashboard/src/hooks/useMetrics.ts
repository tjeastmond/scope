import { useCallback, useEffect } from "react";
import { fetchAlerts, fetchMetrics } from "../api/metrics";
import { dashboardStore, useDashboard } from "../store/store";
import { useInterval } from "./useInterval";

const REFRESH_MS = 30_000;

export function useMetrics() {
  const timeRange = useDashboard((state) => state.timeRange);

  const refresh = useCallback(async () => {
    dashboardStore.set({ loading: true });
    try {
      const [metrics, alerts] = await Promise.all([fetchMetrics(timeRange), fetchAlerts()]);
      dashboardStore.set({ metrics, alerts, loading: false, error: null });
    } catch (error) {
      dashboardStore.set({ loading: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  }, [timeRange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useInterval(refresh, REFRESH_MS);

  return { refresh };
}
