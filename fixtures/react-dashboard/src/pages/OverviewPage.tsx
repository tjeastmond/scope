import { MetricCard } from "../components/MetricCard";
import { TimeRangePicker } from "../components/TimeRangePicker";
import { getConfig } from "../config";
import { useMetrics } from "../hooks/useMetrics";
import { selectMetricById } from "../store/selectors";
import { useDashboard } from "../store/store";

export function OverviewPage() {
  useMetrics();
  const state = useDashboard((s) => s);
  const { widgets } = getConfig();
  return (
    <>
      <h1>Overview</h1>
      <TimeRangePicker />
      {state.error ? <p role="alert">{state.error}</p> : null}
      {widgets.map((widget) => (
        <MetricCard key={widget.id} title={widget.title} metric={selectMetricById(state, widget.id)} />
      ))}
    </>
  );
}
