import type { Alert, Metric } from "../api/types";
import { getConfig } from "../config";
import type { DashboardState } from "./store";

export function selectMetricById(state: DashboardState, id: string): Metric | undefined {
  return state.metrics.find((metric) => metric.id === id);
}

export function selectVisibleAlerts(state: DashboardState): Alert[] {
  const { hideAcknowledged, pageSize } = getConfig().alerts;
  return state.alerts
    .filter((alert) => !(hideAcknowledged && alert.acknowledged))
    .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
    .slice(0, pageSize);
}

export function selectCriticalCount(state: DashboardState): number {
  return state.alerts.filter((alert) => alert.severity === "critical" && !alert.acknowledged).length;
}
