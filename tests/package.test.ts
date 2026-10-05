import { expect, test } from "bun:test";
import pkg from "../package.json";

test("package targets Node 24+ and the official TypeSafe SDK", () => {
  expect(pkg.engines.node).toBe(">=24");
  expect(Object.keys(pkg.dependencies)).toContain("@typesafe-ai/sdk");
});
