import type { Severity } from "../api/types";
import styles from "../styles/alerts.module.css";

interface AlertBadgeProps {
  severity: Severity;
  count?: number;
}

export function AlertBadge({ severity, count }: AlertBadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[severity]}`}>
      {severity}
      {count !== undefined ? ` (${count})` : ""}
    </span>
  );
}
