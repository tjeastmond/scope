#!/usr/bin/env node
import { main } from "./main.ts";

// The first Ctrl-C cancels the run cleanly; `once` removes the listener, so a second Ctrl-C terminates the process.
const controller = new AbortController();
const onInterrupt = () => controller.abort();
process.once("SIGINT", onInterrupt);

// A reader that stops early (`scope ... | head`) closes stdout. That is not a Scope failure: stop quietly with the exit
// code the run already has. Any other stdout error is reported.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit();
  process.stderr.write(`scope: could not write to stdout: ${error.message}\n`);
  process.exit(1);
});

try {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
  });
} finally {
  process.removeListener("SIGINT", onInterrupt);
}
