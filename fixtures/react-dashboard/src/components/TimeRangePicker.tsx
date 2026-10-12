import type { TimeRange } from "../api/types";
import { dashboardStore, useDashboard } from "../store/store";

const OPTIONS: TimeRange[] = ["15m", "1h", "24h", "7d"];

export function TimeRangePicker() {
  const selected = useDashboard((state) => state.timeRange);
  return (
    <div role="group" aria-label="Time range">
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === selected}
          onClick={() => dashboardStore.set({ timeRange: option })}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
