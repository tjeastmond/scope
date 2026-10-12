import { AlertList } from "../components/AlertList";
import { useMetrics } from "../hooks/useMetrics";
import { selectVisibleAlerts } from "../store/selectors";
import { useDashboard } from "../store/store";

export function AlertsPage() {
  useMetrics();
  const alerts = useDashboard(selectVisibleAlerts);
  return (
    <>
      <h1>Alerts</h1>
      <AlertList alerts={alerts} />
    </>
  );
}
