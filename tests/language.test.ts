import { expect, test } from "bun:test";
import { classifyFile } from "../src/repository/language.ts";

// path, head, expected language, expected strategy
const cases: [string, string | undefined, string | undefined, string][] = [
  ["a.ts", undefined, "typescript", "semantic"],
  ["a.d.ts", undefined, "typescript", "semantic"],
  ["a.mts", undefined, "typescript", "semantic"],
  ["a.cts", undefined, "typescript", "semantic"],
  ["src/App.tsx", undefined, "typescript", "semantic"],
  ["a.js", undefined, "javascript", "semantic"],
  ["a.jsx", undefined, "javascript", "semantic"],
  ["a.mjs", undefined, "javascript", "semantic"],
  ["a.cjs", undefined, "javascript", "semantic"],
  ["a.py", undefined, "python", "semantic"],
  ["a.pyi", undefined, "python", "semantic"],
  ["a.sql", undefined, "sql", "structural"],
  ["a.html", undefined, "html", "structural"],
  ["a.htm", undefined, "html", "structural"],
  ["a.css", undefined, "css", "structural"],
  ["a.scss", undefined, "scss", "structural"],
  ["a.json", undefined, "json", "structural"],
  ["a.yaml", undefined, "yaml", "structural"],
  ["a.yml", undefined, "yaml", "structural"],
  ["a.toml", undefined, "toml", "structural"],
  ["a.md", undefined, "markdown", "structural"],
  ["a.markdown", undefined, "markdown", "structural"],
  ["a.go", undefined, "go", "text"],
  ["a.rs", undefined, "rust", "text"],
  ["a.java", undefined, "java", "text"],
  ["a.sh", undefined, "text", "text"],
  ["a.txt", undefined, "text", "text"],
  // Case, directories, and only the last extension counts.
  ["SRC/Main.TS", undefined, "typescript", "semantic"],
  ["README.MD", undefined, "markdown", "structural"],
  ["a.test.ts", undefined, "typescript", "semantic"],
  ["a.ts.txt", undefined, "text", "text"],
  ["dir.ts/notes.txt", undefined, "text", "text"],
  // The extension beats a shebang.
  ["run.py", "#!/usr/bin/env node\n", "python", "semantic"],
  // Well-known extensionless names and dotfiles.
  ["Dockerfile", undefined, "text", "text"],
  ["docker/dockerfile", undefined, "text", "text"],
  ["Makefile", undefined, "text", "text"],
  ["README", undefined, "text", "text"],
  ["LICENSE", undefined, "text", "text"],
  [".gitignore", undefined, "text", "text"],
  [".editorconfig", undefined, "text", "text"],
  // Shebang sniffing for extensionless files.
  ["bin/tool", "#!/usr/bin/env python3\nprint(1)\n", "python", "semantic"],
  ["bin/tool", "#!/usr/bin/python3.12\n", "python", "semantic"],
  ["bin/tool", "#!/usr/bin/env -S node --no-warnings\n", "javascript", "semantic"],
  ["bin/tool", "#!/usr/local/bin/node\r\nconsole.log(1)\r\n", "javascript", "semantic"],
  ["bin/tool", "#!/usr/bin/env tsx\n", "typescript", "semantic"],
  ["bin/tool", "#!/bin/bash\n", "text", "text"],
  ["bin/tool", "#!/usr/bin/env FOO=1 ruby\n", "text", "text"],
  ["bin/tool", "#!/usr/bin/env lolcode\n", "text", "text"],
  ["script.weird", "#!/usr/bin/env python\n", "python", "semantic"],
  // Unknown files are text only when the content looks like text.
  ["notes", "just some words\n", "text", "text"],
  ["data.xyz", "plain text\nwith lines\n", "text", "text"],
  ["data.xyz", "tab\tseparated\r\n", "text", "text"],
  ["notes", "", "text", "text"],
  ["notes", undefined, undefined, "skip"],
  ["data.xyz", undefined, undefined, "skip"],
  ["blob.bin", "abc\u0000def", undefined, "skip"],
  ["blob.bin", "abc\u0001def", undefined, "skip"],
  ["blob.bin", "abc�def", undefined, "skip"],
  ["trailing.", "words", "text", "text"],
  [".bashrc", undefined, undefined, "skip"],
  [".bashrc", "export A=1\n", "text", "text"],
  [".env.example", "KEY=value\n", "text", "text"],
];

test.each(cases)("classifies %p with head %p as %p / %p", (path, head, language, strategy) => {
  const result = classifyFile(path, head);
  expect(result.language).toBe(language as never);
  expect(result.strategy).toBe(strategy as never);
  expect(result.reason.length).toBeGreaterThan(0);
});

test("explains each kind of decision", () => {
  expect(classifyFile("a.ts").reason).toBe("extension .ts");
  expect(classifyFile("Dockerfile").reason).toBe("well-known file name Dockerfile");
  expect(classifyFile("t", "#!/usr/bin/env python3.12\n").reason).toBe("shebang python");
  expect(classifyFile("t", "#!/usr/bin/env lolcode\n").reason).toBe("script with shebang lolcode");
  expect(classifyFile("x.abc", "hi").reason).toBe("unknown extension .abc, content looks like text");
  expect(classifyFile("x.abc").reason).toBe("unknown extension .abc, content not available to check");
  expect(classifyFile("x", "\u0000").reason).toBe("no extension, content is not text");
});
