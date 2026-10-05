#!/usr/bin/env node
import { runScope } from "./scope.ts";

const HELP = `Usage: scope "<task>" [--repo <path>] [--budget <tokens>] [--no-jev]

Select the smallest useful code context for a task.

Options:
  --repo <path>      Repository to analyze (default: current directory)
  --budget <tokens>  Estimated token budget (default: 8000)
  --no-jev           Skip Jev and use the deterministic baseline (no credentials or network)
  -h, --help         Show this help
`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help") || args.length === 0) {
  process.stdout.write(HELP);
} else {
  process.stdout.write(await runScope({ task: args[0] ?? "" }));
}
