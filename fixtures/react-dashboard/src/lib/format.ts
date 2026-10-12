export function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(value % 1 === 0 ? 0 : 1);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** The change between two readings, shown on a metric card next to an arrow. */
export function formatDelta(current: number, previous: number): string {
  if (previous === 0) return "n/a";
  const change = ((current - previous) / previous) * 100;
  return `+${change.toFixed(1)}%`;
}

export function formatValue(value: number, unit: "rps" | "ms" | "percent"): string {
  switch (unit) {
    case "ms":
      return formatDuration(value);
    case "percent":
      return formatPercent(value);
    default:
      return `${formatNumber(value)}/s`;
  }
}
