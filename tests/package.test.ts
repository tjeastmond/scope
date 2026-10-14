import { expect, test } from "bun:test";
import pkg from "../package.json";

test("package targets Node 24+ and the official TypeSafe SDK", () => {
  expect(pkg.engines.node).toBe(">=24");
  expect(Object.keys(pkg.dependencies)).toContain("@typesafe-ai/sdk");
});

test("only built code and the release documents are published, and the bin points at compiled JavaScript", () => {
  expect(pkg.files).toEqual(["dist", "!dist/**/*.map", "README.md", "CHANGELOG.md", "LICENSE"]);
  expect(pkg.bin.scope).toBe("dist/cli.js");
  expect(pkg.scripts.prepack).toBe("bun run build");
});

test("the package is published publicly as @tjeastmond/scope with provenance and no peer dependencies", () => {
  expect(pkg.name).toBe("@tjeastmond/scope");
  expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
  expect(pkg.repository.url).toBe("git+https://github.com/tjeastmond/scope.git");
  // npm installs peer dependencies, so a peer here would ship to every user of the CLI.
  expect("peerDependencies" in pkg).toBe(false);
});
