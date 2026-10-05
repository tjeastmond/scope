import { chmod, rm } from "node:fs/promises";

const run = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) process.exit(1);
};

await rm("dist", { recursive: true, force: true });
await run(["bunx", "tsc", "-p", "tsconfig.build.json"]);
await chmod("dist/cli.js", 0o755);
