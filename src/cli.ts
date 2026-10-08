#!/usr/bin/env node
import { readBoundedText } from "./bounded-input.ts";
import { main } from "./main.ts";

// The first Ctrl-C cancels the run cleanly; `once` removes the listener, so a second Ctrl-C terminates the process.
const controller = new AbortController();
const onInterrupt = () => controller.abort();
process.once("SIGINT", onInterrupt);

try {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
    readStdin: (maxBytes) => readBoundedText(process.stdin, maxBytes, "standard input", controller.signal),
  });
} finally {
  process.removeListener("SIGINT", onInterrupt);
}
