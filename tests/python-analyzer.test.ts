import { expect, test } from "bun:test";
import { analyzeFile } from "../src/analyzers/index.ts";
import { extractPythonChunks, pythonAnalyzer } from "../src/analyzers/python.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import type { CodeChunk } from "../src/types.ts";

const WORKER = `#!/usr/bin/env python3
"""Background job worker."""
import os
from typing import Optional

MAX_RETRIES = 3
DEFAULT_QUEUE: str = "jobs"
_PRIVATE_LIMIT = 10
counter: int = 0
lowercase_value = 5
a, B = 1, 2


@dataclass
class Job:
    """A unit of work."""

    class Meta:
        table = "jobs"

        def label(self):
            return "meta"

    def __init__(self, name):
        self.name = name

    @staticmethod
    def make(name):
        return Job(name)

    @classmethod
    def from_dict(cls, data):
        return cls(data["name"])

    @property
    def title(self):
        return self._title

    @title.setter
    def title(self, value):
        self._title = value

    @title.deleter
    def title(self):
        del self._title

    async def run(self):
        def inner():
            return 1

        class Hidden:
            pass

        return inner()


async def fetch_jobs(queue):
    """Fetch jobs."""
    return []


@retry(times=3)
@log
def process(job):
    return job


def helper():
    return "ü"


def helper():
    return "redefined"


def naïve_größe(wert="日本語"):
    return wert


if __name__ == "__main__":
    main()
`;

const inventory = (chunks: CodeChunk[]) => chunks.map((c) => `${c.kind}:${c.name}@${c.startLine}-${c.endLine}`);

const analyze = (path: string, source: string) => extractPythonChunks(path, source, heuristicEstimator);

test("golden inventory for a Python worker module", async () => {
  const { chunks, warnings } = await analyze("worker/jobs.py", WORKER);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "config:MAX_RETRIES@6-6",
    "config:DEFAULT_QUEUE@7-7",
    "config:_PRIVATE_LIMIT@8-8",
    "config:counter@9-9",
    "class:Job@14-16",
    "class:Job.Meta@18-22",
    "method:Job.__init__@24-25",
    "method:Job.make@27-29",
    "method:Job.from_dict@31-33",
    "method:Job.title@35-37",
    "method:Job.set title@39-41",
    "method:Job.delete title@43-45",
    "method:Job.run@47-54",
    "function:fetch_jobs@57-59",
    "function:process@62-65",
    "function:helper@68-69",
    "function:helper@72-73",
    "function:naïve_größe@76-77",
    "section:__main__@80-81",
  ]);
});

test("ranges, content, references and IDs", async () => {
  const { chunks } = await analyze("worker/jobs.py", WORKER);
  const lines = WORKER.split("\n");
  for (const chunk of chunks) {
    expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    // The file's two top-level imports are file-level context on every chunk (docs/chunk-model.md, "References").
    expect(chunk.references.map((r) => r.specifier)).toEqual(["os", "typing"]);
    expect(chunk.language).toBe("python");
    expect(chunk.file).toBe("worker/jobs.py");
  }
  expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  const again = await analyze("worker/jobs.py", WORKER);
  expect(again.chunks.map((c) => c.id)).toEqual(chunks.map((c) => c.id));
});

test("decorators and docstrings are inside the chunk range; nested functions are not chunks", async () => {
  const { chunks } = await analyze("worker/jobs.py", WORKER);
  const byName = (name: string) => chunks.filter((c) => c.name === name);
  expect(byName("process")[0]?.content.startsWith("@retry(times=3)\n@log\ndef process")).toBe(true);
  expect(byName("Job")[0]?.content.startsWith("@dataclass\nclass Job:")).toBe(true);
  expect(byName("Job")[0]?.content).toContain('"""A unit of work."""');
  expect(byName("fetch_jobs")[0]?.content).toContain('"""Fetch jobs."""');
  expect(chunks.some((c) => c.name?.includes("inner") || c.name?.includes("Hidden"))).toBe(false);
});

test("same-named redefinitions get distinct IDs", async () => {
  const { chunks } = await analyze("worker/jobs.py", WORKER);
  const [first, second] = chunks.filter((c) => c.name === "helper");
  expect(first && second && first.id !== second.id).toBe(true);
});

test("declarations inside control flow keep the enclosing scope", async () => {
  const source = [
    "import sys",
    "if sys.platform == 'win32':",
    "    def f():",
    "        pass",
    "else:",
    "    def g():",
    "        pass",
    "try:",
    "    import json",
    "except ImportError:",
    "    class Fallback:",
    "        a = 1",
    "        b = 2",
    "        c = 3",
    "        if True:",
    "            def m(self):",
    "                pass",
    "",
  ].join("\n");
  const { chunks } = await extractPythonChunks("a.py", source, heuristicEstimator);
  expect(chunks.map((c) => `${c.kind}:${c.name}`)).toEqual([
    "function:f",
    "function:g",
    "class:Fallback",
    "method:Fallback.m",
  ]);
});

test("valid declarations survive malformed siblings inside a block", async () => {
  const { chunks } = await extractPythonChunks(
    "a.py",
    "if True:\n    def good():\n        pass\n    def broken(: pass\n",
    heuristicEstimator,
  );
  expect(chunks.map((c) => c.name)).toContain("good");
});

test("main guard detection reads operands, not whitespace", async () => {
  const names = async (source: string) =>
    (await extractPythonChunks("a.py", source, heuristicEstimator)).chunks.map((c) => c.name);
  expect(await names('if (__name__ == "__main__"):\n    run()\n')).toEqual(["__main__"]);
  expect(await names("if '__main__' == __name__:\n    run()\n")).toEqual(["__main__"]);
  expect(await names('if (__name__ ==  # entry point\n    "__main__"):\n    run()\n')).toEqual(["__main__"]);
  expect(await names('if __name__ == "__ main__":\n    run()\n')).toEqual([]);
});

test("chained assignments are not single-target constants", async () => {
  const { chunks } = await extractPythonChunks("a.py", "A = B = 1\nC = 2\n", heuristicEstimator);
  expect(chunks.map((c) => c.name)).toEqual(["C"]);
});

test("identical same-line declarations yield one chunk", async () => {
  const { chunks } = await extractPythonChunks("a.py", "A = 1; A = 2\n", heuristicEstimator);
  expect(chunks.map((c) => c.name)).toEqual(["A"]);
});

test("CRLF source gives the same inventory and IDs as LF", async () => {
  const lf = await analyze("worker/jobs.py", WORKER);
  const crlf = await analyze("worker/jobs.py", WORKER.replaceAll("\n", "\r\n"));
  expect(inventory(crlf.chunks)).toEqual(inventory(lf.chunks));
  expect(crlf.chunks.map((c) => c.id)).toEqual(lf.chunks.map((c) => c.id));
  const helper = crlf.chunks.find((c) => c.name === "helper");
  expect(helper?.content).toBe('def helper():\r\n    return "ü"\r');
});

test("syntax errors keep the declarations that parsed and add a warning", async () => {
  const source = `def good():
    return 1


def broken(:
    pass


class Fine:
    def ok(self):
        return 2


LIMIT = 4
`;
  const { chunks, warnings } = await analyze("bad.py", source);
  expect(inventory(chunks)).toEqual(["function:good@1-2", "class:Fine@9-11", "config:LIMIT@14-14"]);
  expect(warnings).toEqual(["bad.py: syntax errors; extracted 3 declarations from the parseable regions"]);
});

test("a non-empty file with nothing extractable returns only the warning", async () => {
  const { chunks, warnings } = await analyze("junk.py", "def (:\n  )))\n");
  expect(chunks).toEqual([]);
  expect(warnings).toEqual(["junk.py: syntax errors; extracted 0 declarations from the parseable regions"]);
});

test("empty and declaration-free files produce no chunks and no warnings", async () => {
  expect(await analyze("empty.py", "")).toEqual({ chunks: [], warnings: [] });
  expect(await analyze("plain.py", "import os\nprint(os.name)\n")).toEqual({ chunks: [], warnings: [] });
});

test("stub signatures behave like functions", async () => {
  const stub = `from typing import overload

def load(path: str) -> bytes: ...

class Reader:
    def read(self, n: int = ...) -> bytes: ...
    @overload
    def seek(self, pos: int) -> None: ...
    @overload
    def seek(self, pos: int, whence: int) -> None: ...
`;
  const { chunks, warnings } = await analyze("reader.pyi", stub);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "function:load@3-3",
    "class:Reader@5-5",
    "method:Reader.read@6-6",
    "method:Reader.seek@7-8",
    "method:Reader.seek@9-10",
  ]);
});

test("the analyzer is registered for python", async () => {
  expect(pythonAnalyzer.languages).toEqual(["python"]);
  const result = await analyzeFile({ path: "a.py", source: "X = 1\n" }, "python", heuristicEstimator);
  expect(inventory(result.chunks)).toEqual(["config:X@1-1"]);
});
