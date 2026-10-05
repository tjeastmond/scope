import { expect, test } from "bun:test";
import { redactSecrets } from "../src/repository/redact.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";

test.each([
  ['const apiKey = "abcd1234efgh5678";', "abcd1234efgh5678"],
  ['const apiKey: string = "abcd1234efgh5678";', "abcd1234efgh5678"],
  ["const token = `abcd1234efgh5678`;", "abcd1234efgh5678"],
  ['{ "password": "hunter2hunter2" }', "hunter2hunter2"],
  ['const k = "sk-proj-abcdefghijklmnopqrstuv";', "abcdefghijklmnopqrstuv"],
  ["const id = AKIAABCDEFGHIJKLMNOP;", "AKIAABCDEFGHIJKLMNOP"],
  ["const t = ghp_abcdefghijklmnopqrstuvwxyz0123456789;", "abcdefghijklmnopqrstuvwxyz0123456789"],
  ["const j = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3.abcdefghijklmnop;", "eyJzdWIiOiIxMjM0NTY3"],
])("redacts %s", (source, secret) => {
  const redacted = redactSecrets(source);
  expect(redacted).not.toContain(secret);
  expect(redacted).toContain("[REDACTED]");
});

test("keeps the line count and leaves ordinary code alone", () => {
  const source = `const a = 1;\n${PEM}\nconst b = "short";\nconst token = computeToken(user);\n`;
  const redacted = redactSecrets(source);
  expect(redacted.split("\n")).toHaveLength(source.split("\n").length);
  expect(redacted).not.toContain("abc\ndef");
  expect(redacted).toContain('const b = "short";');
  expect(redacted).toContain("computeToken(user)");
});
