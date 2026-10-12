import { apiGet, apiPost } from "./client";
import type { Alert, Metric, TimeRange } from "./types";

export function fetchMetrics(range: TimeRange): Promise<Metric[]> {
  return apiGet<Metric[]>("/metrics", { range });
}

export function fetchAlerts(): Promise<Alert[]> {
  return apiGet<Alert[]>("/alerts");
}

export function acknowledgeAlert(id: string): Promise<Alert> {
  return apiPost<Alert>(`/alerts/${id}/acknowledge`, {});
}
