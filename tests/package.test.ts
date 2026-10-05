import { expect, test } from "bun:test";
import pkg from "../package.json";

test("package targets Node 24+ and the official TypeSafe SDK", () => {
  expect(pkg.engines.node).toBe(">=24");
  expect(Object.keys(pkg.dependencies)).toContain("@typesafe-ai/sdk");
});

test("only built code and the README are published, and the bin points at compiled JavaScript", () => {
  expect(pkg.files).toEqual(["dist", "!dist/**/*.map", "README.md"]);
  expect(pkg.bin.scope).toBe("dist/cli.js");
  expect(pkg.scripts.prepack).toBe("bun run build");
});
