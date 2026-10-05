import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ECMASCRIPT_EXTENSIONS, extractEcmascript, TYPESCRIPT_EXTENSIONS } from "../src/analyzers/ecmascript.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import { scanRepository } from "../src/repository/files.ts";
import type { CodeChunk } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/webhook-service");

async function chunksOf(path: string, source: string): Promise<CodeChunk[]> {
  return (await extractEcmascript(path, source, charsPerTokenEstimator)).chunks;
}

async function extractFixture(): Promise<CodeChunk[]> {
  const { files: all } = await scanRepository(FIXTURE);
  const files = all.filter((f) => TYPESCRIPT_EXTENSIONS.some((ext) => f.endsWith(ext)));
  const perFile = await Promise.all(
    files.map(async (file) => chunksOf(file, await readFile(join(FIXTURE, file), "utf8"))),
  );
  return perFile.flat();
}

const inventory = (chunks: CodeChunk[]) =>
  chunks.map((c) => `${c.file}#${c.kind}:${c.name}@${c.startLine}-${c.endLine}`);

test("extracts the expected chunk inventory from the fixture", async () => {
  expect(inventory(await extractFixture())).toEqual([
    "src/dates/utils.ts#function:format@1-3",
    "src/dates/utils.ts#function:addDays@5-9",
    "src/email/format.ts#function:format@1-3",
    "src/email/sender.ts#function:sendWithRetry@4-16",
    "src/email/sender.ts#function:deliver@18-26",
    "src/logger.ts#class:Logger@1-15",
    "src/logger.ts#method:Logger.info@4-6",
    "src/logger.ts#method:Logger.warn@8-10",
    "src/logger.ts#method:Logger.error@12-14",
    "src/logger.ts#config:logger@17-17",
    "src/stripe/handler.ts#function:handleStripeWebhook@7-25",
    "src/stripe/handler.ts#function:processEvent@27-38",
    "src/stripe/handler.ts#function:markInvoicePaid@40-45",
    "src/stripe/handler.ts#function:cancelSubscription@47-52",
    "src/stripe/types.ts#interface:StripeEvent@1-6",
    "src/stripe/types.ts#type:WebhookResult@8-8",
    "src/users/profile.ts#interface:UserProfile@3-7",
    "src/users/profile.ts#function:renderProfile@9-11",
    "src/util/retry.ts#interface:RetryOptions@1-5",
    "src/util/retry.ts#function:computeBackoff@7-11",
    "src/util/retry.ts#function:withRetry@13-26",
    "src/webhooks/signature.ts#interface:ParsedSignature@1-4",
    "src/webhooks/signature.ts#function:parseSignatureHeader@8-13",
    "src/webhooks/signature.ts#function:verifySignature@15-23",
    "src/webhooks/signature.ts#function:sign@25-31",
    "tests/handler.test.ts#function:expectStatus@3-7",
    "tests/handler.test.ts#function:checkRejectsInvalidSignature@9-12",
  ]);
});

test("chunk content is the exact source lines and IDs are stable and unique", async () => {
  const [first, second] = [await extractFixture(), await extractFixture()];
  expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  expect(new Set(first.map((c) => c.id)).size).toBe(first.length);
  for (const chunk of first) {
    const lines = (await readFile(join(FIXTURE, chunk.file), "utf8")).split("\n");
    expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(chunk.estimatedTokens).toBe(charsPerTokenEstimator.count(chunk.content));
  }
});

test("extracts exported arrow-function constants and ignores plain values", async () => {
  const source = "export const a = (x: number) => x;\nconst n = 3;\nexport default class {}\n";
  const chunks = await chunksOf("x.ts", source);
  expect(inventory(chunks)).toEqual(["x.ts#function:a@1-1", "x.ts#class:default@3-3"]);
});

const built = existsSync(join(import.meta.dir, "../dist/analyzers/ecmascript.js"));
test.skipIf(!built)(
  "works from the compiled dist/ under Node, including concurrent first use of both grammars",
  async () => {
    const script = `
    import { extractEcmascript } from "./dist/analyzers/ecmascript.js";
    const est = { id: "t", count: (s) => s.length };
    // Concurrent first use of both grammars in a fresh process.
    const results = await Promise.all(
      ["a.ts", "b.tsx"].map((file) => extractEcmascript(file, "export function f() {}\\n", est).then((r) => r.chunks)),
    );
    console.log(JSON.stringify(results.flat().map((c) => c.name)));
  `;
    const proc = Bun.spawn(["node", "--input-type=module", "-e", script], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe('["f","f"]\n');
    expect(await proc.exited).toBe(0);
  },
);

test("gives a getter and setter on one line distinct names and IDs", async () => {
  const chunks = await chunksOf("a.ts", "class C { get x() { return 1; } set x(v: number) {} }");
  const accessors = chunks.filter((chunk) => chunk.kind === "method");
  expect(accessors.map((chunk) => chunk.name)).toEqual(["C.get x", "C.set x"]);
  expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
});

const inv = async (path: string, source: string) => inventory(await chunksOf(path, source));
const lines = (...parts: string[]) => parts.join("\n") + "\n";

test("covers every extension and picks the language from the path", async () => {
  expect([...ECMASCRIPT_EXTENSIONS]).toEqual([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
  for (const [path, language] of [
    ["a.ts", "typescript"],
    ["a.d.ts", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["a.tsx", "typescript"],
    ["a.js", "javascript"],
    ["a.jsx", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
  ] as const) {
    const chunks = await chunksOf(path, "function f() {}\n");
    expect(chunks.map((c) => `${c.language}:${c.name}`)).toEqual([`${language}:f`]);
  }
});

test("TypeScript: functions, bindings, classes, methods, types and enums", async () => {
  const source = lines(
    "export async function load(): Promise<void> {}", // 1
    "function* gen() { yield 1; }", // 2
    "const arrow = (x: number) => x;", // 3
    "export let expr = function () {};", // 4
    "var old = async () => {}, other = () => 1;", // 5
    "export abstract class Base {", // 6
    "  static create() {}", // 7
    "  get size() { return 1; }", // 8
    "  set size(v: number) {}", // 9
    "  async #secret() {}", // 10
    "  handler = () => {};", // 11
    "  plain = 1;", // 12
    "  constructor() {}", // 13
    "}", // 14
    "const Made = class { run() {} };", // 15
    "export interface Opts { a: number }", // 16
    "type Id = string;", // 17
    "export const enum Color { Red }", // 18
    "enum Size { S }", // 19
    "namespace Ns { export function hidden() {} }", // 20
    "declare module 'm' { function hidden2(): void }", // 21
    "export const LIMIT = 3;", // 22
    "const internal = 4;", // 23
    "export { arrow, load as other };", // 24
    "export * from './x';", // 25
  );
  expect(await inv("a.ts", source)).toEqual([
    "a.ts#function:load@1-1",
    "a.ts#function:gen@2-2",
    "a.ts#function:arrow@3-3",
    "a.ts#function:expr@4-4",
    "a.ts#function:old@5-5",
    "a.ts#function:other@5-5",
    "a.ts#class:Base@6-14",
    "a.ts#method:Base.create@7-7",
    "a.ts#method:Base.get size@8-8",
    "a.ts#method:Base.set size@9-9",
    "a.ts#method:Base.#secret@10-10",
    "a.ts#method:Base.handler@11-11",
    "a.ts#class:Made@15-15",
    "a.ts#method:Made.run@15-15",
    "a.ts#interface:Opts@16-16",
    "a.ts#type:Id@17-17",
    "a.ts#type:Color@18-18",
    "a.ts#type:Size@19-19",
    "a.ts#config:LIMIT@22-22",
  ]);
});

test("JavaScript and JSX parse with the javascript grammar", async () => {
  const source = lines(
    "export function Button({ label }) {", // 1
    "  return <button>{label}</button>;", // 2
    "}", // 3
    "const Card = () => <div />;", // 4
    "const helper = () => 1;", // 5
    "class Store {", // 6
    "  #items = [];", // 7
    "  #add = (x) => this.#items.push(x);", // 8
    "  static of() {}", // 9
    "}", // 10
    "module.exports = { Button };", // 11
  );
  expect(await inv("a.jsx", source)).toEqual([
    "a.jsx#component:Button@1-3",
    "a.jsx#component:Card@4-4",
    "a.jsx#function:helper@5-5",
    "a.jsx#class:Store@6-10",
    "a.jsx#method:Store.#add@8-8",
    "a.jsx#method:Store.of@9-9",
  ]);
  expect(await inv("a.mjs", "export const f = () => 1;\nexport default async function () {}\n")).toEqual([
    "a.mjs#function:f@1-1",
    "a.mjs#function:default@2-2",
  ]);
  expect(await inv("a.cjs", "function f() {}\n")).toEqual(["a.cjs#function:f@1-1"]);
  expect(await inv("a.js", "class A { m() {} }\n")).toEqual(["a.js#class:A@1-1", "a.js#method:A.m@1-1"]);
});

test("TSX: components by JSX, by FC typing, and by default export", async () => {
  const source = lines(
    "import React from 'react';", // 1
    "export const A = () => <div />;", // 2
    "export const B: React.FC<{ n: number }> = ({ n }) => null;", // 3
    "const c = () => <div />;", // 4
    "const D = () => 1;", // 5
    "export function E() { return <></>; }", // 6
    "export default () => <section />;", // 7
    "function render() { return <b />; }", // 8
  );
  expect(await inv("a.tsx", source)).toEqual([
    "a.tsx#component:A@2-2",
    "a.tsx#component:B@3-3",
    "a.tsx#function:c@4-4",
    "a.tsx#function:D@5-5",
    "a.tsx#component:E@6-6",
    "a.tsx#component:default@7-7",
    "a.tsx#function:render@8-8",
  ]);
  expect(await inv("b.tsx", "export default function Page() { return <main />; }\n")).toEqual([
    "b.tsx#component:Page@1-1",
  ]);
});

test("export default forms", async () => {
  expect(await inv("a.ts", "export default function () {}\n")).toEqual(["a.ts#function:default@1-1"]);
  expect(await inv("a.ts", "export default function named() {}\n")).toEqual(["a.ts#function:named@1-1"]);
  expect(await inv("a.ts", "export default class {\n  m() {}\n}\n")).toEqual([
    "a.ts#class:default@1-3",
    "a.ts#method:default.m@2-2",
  ]);
  expect(await inv("a.ts", "export default class Named {}\n")).toEqual(["a.ts#class:Named@1-1"]);
  expect(await inv("a.ts", "export default { a: 1 };\n")).toEqual(["a.ts#config:default@1-1"]);
  expect(await inv("a.ts", "const x = 1;\nexport default x;\n")).toEqual([]);
});

test("decorators are part of class and method ranges", async () => {
  const source = lines(
    "@Injectable()", // 1
    "export class Svc {", // 2
    "  @Input()", // 3
    "  @Other()", // 4
    "  name = () => 1;", // 5
    "  @Log()", // 6
    "  run() {}", // 7
    "}", // 8
    "@Plain", // 9
    "class Bare {}", // 10
    "export @Late class Late {}", // 11
  );
  expect(await inv("a.ts", source)).toEqual([
    "a.ts#class:Svc@1-8",
    "a.ts#method:Svc.name@3-5",
    "a.ts#method:Svc.run@6-7",
    "a.ts#class:Bare@9-10",
    "a.ts#class:Late@11-11",
  ]);
});

test("overloads merge into the implementation that follows them", async () => {
  const source = lines(
    "export function f(a: string): string;", // 1
    "export function f(a: number): number;", // 2
    "export function f(a: any): any {", // 3
    "  return a;", // 4
    "}", // 5
    "const gap = 1;", // 6
    "function g(a: string): void;", // 7
    "const between = 2;", // 8
    "function g(a: any) {}", // 9
    "declare function h(a: string): void;", // 10
    "declare function h(a: number): void;", // 11
    "class C {", // 12
    "  m(a: string): void;", // 13
    "  m(a: number): void;", // 14
    "  m(a: any) {}", // 15
    "  abstract z(): void;", // 16
    "}", // 17
  );
  expect(await inv("a.ts", source)).toEqual([
    "a.ts#function:f@1-5",
    "a.ts#function:g@7-7",
    "a.ts#function:g@9-9",
    "a.ts#function:h@10-11",
    "a.ts#class:C@12-17",
    "a.ts#method:C.m@13-15",
    "a.ts#method:C.z@16-16",
  ]);
});

test("nested functions and nested classes are not separate chunks", async () => {
  const source = lines(
    "function outer() {", // 1
    "  const inner = () => 1;", // 2
    "  function deep() {}", // 3
    "  class Local { m() {} }", // 4
    "  return inner;", // 5
    "}", // 6
  );
  expect(await inv("a.ts", source)).toEqual(["a.ts#function:outer@1-6"]);
});

test("test blocks: top-level describe is a section, bare it/test are functions, nested its stay inside", async () => {
  const source = lines(
    "import { describe, it, test } from 'bun:test';", // 1
    "describe('math', () => {", // 2
    "  it('adds', () => {});", // 3
    "  describe('inner', () => { test('x', () => {}); });", // 4
    "});", // 5
    "it('standalone', () => {});", // 6
    "test.only(`templated`, () => {});", // 7
    'describe.skip("quoted", () => {});', // 8
    "it(name, () => {});", // 9
  );
  expect(await inv("a.test.ts", source)).toEqual([
    "a.test.ts#section:describe: math@2-5",
    "a.test.ts#function:test: standalone@6-6",
    "a.test.ts#function:test: templated@7-7",
    "a.test.ts#section:describe: quoted@8-8",
    "a.test.ts#function:test: name@9-9",
  ]);
});

test("Unicode names and strings, and CRLF files give the same ranges and IDs as LF", async () => {
  const source = lines(
    "export const grüße = () => 'héllo 日本語';", // 1
    "class Café {", // 2
    "  naïve() {}", // 3
    "}", // 4
    "describe('日本語 😀', () => {});", // 5
  );
  const lf = await chunksOf("u.ts", source);
  expect(lf.map((c) => c.name)).toEqual(["grüße", "Café", "Café.naïve", "describe: 日本語 😀"]);
  const crlf = await chunksOf("u.ts", source.replaceAll("\n", "\r\n"));
  expect(crlf.map((c) => c.id)).toEqual(lf.map((c) => c.id));
  expect(inventory(crlf)).toEqual(inventory(lf));
  expect(crlf[1]?.content).toBe("class Café {\r\n  naïve() {}\r\n}\r");
});

test("duplicate and same-line names get distinct IDs", async () => {
  const source = lines("function dup() {}", "function dup() {}", "const a = () => 1, b = () => 2;");
  const chunks = await chunksOf("d.ts", source);
  expect(inventory(chunks)).toEqual([
    "d.ts#function:dup@1-1",
    "d.ts#function:dup@2-2",
    "d.ts#function:a@3-3",
    "d.ts#function:b@3-3",
  ]);
  expect(new Set(chunks.map((c) => c.id)).size).toBe(4);
});

test("declaration files: ambient declarations are chunks", async () => {
  const source = lines(
    "export declare function f(a: string): void;", // 1
    "export declare const VERSION: string;", // 2
    "declare class K { m(): void; }", // 3
    "export interface I {}", // 4
  );
  expect(await inv("a.d.ts", source)).toEqual([
    "a.d.ts#function:f@1-1",
    "a.d.ts#config:VERSION@2-2",
    "a.d.ts#class:K@3-3",
    "a.d.ts#method:K.m@3-3",
    "a.d.ts#interface:I@4-4",
  ]);
});

test("syntax errors: parseable declarations are extracted and a warning is added", async () => {
  const source = lines(
    "function good() {}", // 1
    "const x = ;", // 2
    "function alsoGood() {}", // 3
    "class K { m() { 1 +; } n() {} }", // 4
    "function third() {}", // 5
  );
  const { chunks, warnings } = await extractEcmascript("e.ts", source, charsPerTokenEstimator);
  // A statement that contains an error (here the whole class K) is skipped.
  expect(inventory(chunks)).toEqual([
    "e.ts#function:good@1-1",
    "e.ts#function:alsoGood@3-3",
    "e.ts#function:third@5-5",
  ]);
  expect(warnings).toEqual(["e.ts: syntax errors; extracted 3 declarations from the parseable regions"]);
});

test("syntax errors with nothing extractable give a warning and no chunks; clean files give no warning", async () => {
  const bad = await extractEcmascript("e.js", "const = ;\n(((\n", charsPerTokenEstimator);
  expect(bad.chunks).toEqual([]);
  expect(bad.warnings).toEqual(["e.js: syntax errors; extracted 0 declarations from the parseable regions"]);
  expect((await extractEcmascript("ok.js", "function f() {}\n", charsPerTokenEstimator)).warnings).toEqual([]);
  expect((await extractEcmascript("empty.ts", "", charsPerTokenEstimator)).chunks).toEqual([]);
});

test("static and instance overloads, wrapped default exports and chained test modifiers", async () => {
  const names = async (path: string, source: string) =>
    (await extractEcmascript(path, source, charsPerTokenEstimator)).chunks.map((c) => `${c.kind}:${c.name}`);
  expect(await names("a.ts", "declare class C { static m(a: string): void; m(a: number): void; }")).toEqual([
    "class:C",
    "method:C.static m",
    "method:C.m",
  ]);
  expect(await names("a.ts", "declare function Factory(): void;\ninterface Factory {}")).toEqual([
    "function:Factory",
    "type:Factory",
  ]);
  expect(await names("a.tsx", "export default function page() { return <main />; }")).toEqual(["component:page"]);
  expect(await names("a.tsx", "export default (() => <div />);")).toEqual(["component:default"]);
  expect(await names("a.ts", "export default (class { m() {} });")).toEqual(["class:default", "method:default.m"]);
  expect(await names("a.test.ts", 'test.concurrent.only("x", () => {});')).toEqual(["function:test: x"]);
});
