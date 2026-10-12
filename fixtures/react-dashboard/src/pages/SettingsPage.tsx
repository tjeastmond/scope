import { getConfig } from "../config";
import { useLocalStorage } from "../hooks/useLocalStorage";

export function SettingsPage() {
  const [theme, setTheme] = useLocalStorage<"light" | "dark">("pulseboard.theme", "light");
  const { refreshIntervalSeconds } = getConfig();
  return (
    <>
      <h1>Settings</h1>
      <label>
        Theme
        <select value={theme} onChange={(event) => setTheme(event.target.value as "light" | "dark")}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <p>Data refreshes every {refreshIntervalSeconds} seconds.</p>
    </>
  );
}
