// `bun run eval`: argument parsing for the evaluation runner. All behavior lives in runner.ts.

import { parseArgs } from "node:util";
import { EvalError } from "./freeze.ts";
import { MODES, runEval, SPLITS, type Mode, type SplitChoice } from "./runner.ts";

const USAGE = `Usage: bun run eval [--mode lexical|no-jev|jev ...] [--split tuning|heldout|all] [--fixture <name> ...]
                    [--record <file>] [--replay <file>] [--repeat N] [--out <dir>]

Default modes are lexical and no-jev (offline). The jev mode needs TYPESAFE_API_KEY, or --replay <file>.`;

export function parseEvalArgs(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      mode: { type: "string", multiple: true },
      split: { type: "string", default: "all" },
      fixture: { type: "string", multiple: true },
      record: { type: "string" },
      replay: { type: "string" },
      repeat: { type: "string", default: "1" },
      out: { type: "string", default: "eval-results" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) return undefined;
  const modes = (values.mode?.length ? values.mode : ["lexical", "no-jev"]) as Mode[];
  for (const mode of modes) if (!MODES.includes(mode)) throw new EvalError(`Unknown --mode ${mode}.`);
  if (!SPLITS.includes(values.split as SplitChoice)) throw new EvalError(`Unknown --split ${values.split}.`);
  if (!/^\d+$/.test(values.repeat ?? "")) throw new EvalError("--repeat must be a whole number of at least 1.");
  return {
    modes: [...new Set(modes)],
    split: values.split as SplitChoice,
    fixtures: values.fixture,
    record: values.record,
    replay: values.replay,
    repeat: Number(values.repeat),
    outDir: values.out ?? "eval-results",
  };
}

if (import.meta.main) {
  try {
    const options = parseEvalArgs(process.argv.slice(2));
    if (!options) console.log(USAGE);
    else {
      const { jsonPath, markdownPath } = await runEval(options);
      console.log(`Wrote ${jsonPath}\nWrote ${markdownPath}`);
    }
  } catch (error) {
    if (error instanceof EvalError) console.error(`error: ${error.message}`);
    else if (error instanceof TypeError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS"))
      console.error(`error: ${(error as Error).message}\n\n${USAGE}`);
    else console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  }
}
