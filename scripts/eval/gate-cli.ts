// `bun run eval:gate`: the offline release gate. Replays the committed Jev recording (no key, no network), requires
// docs/evaluation-report.md to match it byte for byte, and checks every threshold in gates.ts. Exits 1 on any failure.

import { EvalError } from "./freeze.ts";
import { checkGates, type GateResult } from "./gates.ts";
import { applyReport, generateReportWithOutput, REPO_ROOT, REPORT_PATH } from "./report-cli.ts";

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function formatGate(gate: GateResult): string {
  const detail = gate.message ? ` (${gate.message})` : "";
  const op = gate.name.includes("exceeds") ? ">" : ">=";
  return `${gate.pass ? "PASS" : "FAIL"} ${gate.name}: ${pct(gate.measured)} ${op} ${pct(gate.threshold)}${detail}`;
}

if (import.meta.main) {
  try {
    process.chdir(REPO_ROOT);
    const { text, output } = await generateReportWithOutput();
    let failed = false;

    const { upToDate } = await applyReport(text, { check: true });
    if (upToDate) console.log(`PASS ${REPORT_PATH} matches the committed recording`);
    else {
      failed = true;
      console.log(
        `FAIL ${REPORT_PATH} differs from a fresh offline evaluation. Run bun run eval:report, ` +
          "and record Jev again (bun run eval --mode jev --split all --record eval-recordings/jev-baseline.json) " +
          "if the candidates changed.",
      );
    }

    for (const gate of checkGates(output)) {
      console.log(formatGate(gate));
      if (!gate.pass) failed = true;
    }
    if (failed) process.exitCode = 1;
  } catch (error) {
    if (error instanceof EvalError) console.error(`error: ${error.message}`);
    else console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  }
}
