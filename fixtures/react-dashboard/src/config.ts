import type { TimeRange } from "./api/types";

export interface WidgetConfig {
  id: string;
  title: string;
  unit: "rps" | "ms" | "percent";
}

export interface DashboardConfig {
  refreshIntervalSeconds: number;
  defaultTimeRange: TimeRange;
  widgets: WidgetConfig[];
  alerts: { pageSize: number; hideAcknowledged: boolean };
}

const FALLBACK_CONFIG: DashboardConfig = {
  refreshIntervalSeconds: 30,
  defaultTimeRange: "1h",
  widgets: [],
  alerts: { pageSize: 25, hideAcknowledged: true },
};

let current: DashboardConfig = FALLBACK_CONFIG;

export async function loadConfig(): Promise<DashboardConfig> {
  try {
    const response = await fetch("/dashboard.config.json");
    if (response.ok) {
      current = { ...FALLBACK_CONFIG, ...(await response.json()) };
    }
  } catch {
    current = FALLBACK_CONFIG;
  }
  return current;
}

export function getConfig(): DashboardConfig {
  return current;
}
