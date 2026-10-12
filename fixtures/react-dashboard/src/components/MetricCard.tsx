import type { Metric } from "../api/types";
import { formatDelta, formatValue } from "../lib/format";
import styles from "../styles/metric-card.module.css";
import { Sparkline } from "./Sparkline";

interface MetricCardProps {
  title: string;
  metric: Metric | undefined;
}

export function MetricCard({ title, metric }: MetricCardProps) {
  const delta = metric ? formatDelta(metric.value, metric.previous) : "";
  return (
    <section className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.value}>{metric ? formatValue(metric.value, metric.unit) : ""}</p>
      <p className={styles.delta}>{delta}</p>
      {metric ? <Sparkline points={metric.history} /> : null}
    </section>
  );
}
