export type TimeRange = "15m" | "1h" | "24h" | "7d";

export type Severity = "info" | "warning" | "critical";

export interface Metric {
  id: string;
  value: number;
  previous: number;
  unit: "rps" | "ms" | "percent";
  history: number[];
  updatedAt: string;
}

export interface Alert {
  id: string;
  title: string;
  severity: Severity;
  raisedAt: string;
  acknowledged: boolean;
}
