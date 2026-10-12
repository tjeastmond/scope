import { acknowledgeAlert } from "../api/metrics";
import type { Alert } from "../api/types";
import { formatDuration } from "../lib/dates";
import { dashboardStore } from "../store/store";
import styles from "../styles/alerts.module.css";
import { AlertBadge } from "./AlertBadge";

interface AlertListProps {
  alerts: Alert[];
}

async function acknowledge(id: string): Promise<void> {
  const updated = await acknowledgeAlert(id);
  dashboardStore.set({
    alerts: dashboardStore.get().alerts.map((alert) => (alert.id === id ? updated : alert)),
  });
}

export function AlertList({ alerts }: AlertListProps) {
  if (alerts.length === 0) {
    return <p className={styles.empty}>No open alerts.</p>;
  }
  return (
    <ul className={styles.list}>
      {alerts.map((alert) => (
        <li key={alert.id} className={styles.item}>
          <AlertBadge severity={alert.severity} />
          <span className={styles.title}>{alert.title}</span>
          <time className={styles.age}>{formatDuration(alert.raisedAt)}</time>
          <button type="button" onClick={() => void acknowledge(alert.id)}>
            Acknowledge
          </button>
        </li>
      ))}
    </ul>
  );
}
