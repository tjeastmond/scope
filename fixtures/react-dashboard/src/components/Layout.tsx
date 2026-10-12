import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { ROUTES } from "../routes";
import { selectCriticalCount } from "../store/selectors";
import { useDashboard } from "../store/store";
import styles from "../styles/layout.module.css";
import { AlertBadge } from "./AlertBadge";

export function Layout({ children }: { children: ReactNode }) {
  const critical = useDashboard(selectCriticalCount);
  return (
    <div className={styles.shell}>
      <nav className={styles.nav}>
        {ROUTES.map((route) => (
          <NavLink key={route.path} to={route.path} className={styles.link}>
            {route.label}
            {route.path === "/alerts" && critical > 0 ? <AlertBadge severity="critical" count={critical} /> : null}
          </NavLink>
        ))}
      </nav>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
