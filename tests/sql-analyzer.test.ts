import { expect, test } from "bun:test";
import { analyzeFile } from "../src/analyzers/index.ts";
import { extractSqlChunks, sqlAnalyzer } from "../src/analyzers/sql.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import type { CodeChunk } from "../src/types.ts";

const MIGRATION = `-- Migration 0042: accounts
-- Adds the accounts schema.

SET search_path TO app, public;

/* Core table;
   with a semicolon in this comment */
CREATE TABLE IF NOT EXISTS app.accounts (
  id bigserial PRIMARY KEY,
  email text NOT NULL DEFAULT 'a;b',
  "weird;name" text, -- trailing; comment
  note text DEFAULT 'it''s; fine'
);

CREATE UNIQUE INDEX CONCURRENTLY idx_accounts_email ON app.accounts (email);

CREATE TEMP TABLE scratch (x int);

CREATE OR REPLACE VIEW "app"."active_accounts" AS
  SELECT * FROM app.accounts WHERE email <> ';';

CREATE MATERIALIZED VIEW daily_totals AS SELECT 1;

CREATE TYPE mood AS ENUM ('sad', 'ok');

CREATE OR REPLACE FUNCTION app.touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now(); -- not a statement end;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION tagged() RETURNS text AS $body$
  SELECT $$nested; $$ || 'x';
$body$ LANGUAGE sql;

CREATE TRIGGER accounts_touch BEFORE UPDATE ON app.accounts
  FOR EACH ROW EXECUTE FUNCTION app.touch();

ALTER TABLE ONLY app.accounts ADD COLUMN age int;
DROP TABLE IF EXISTS \`old\`.\`legacy\`;
COMMIT
`;

const QUERIES = `-- all users
SELECT id, name FROM users WHERE name = 'a;b' ORDER BY id;

-- detached comment

INSERT INTO audit.log (msg) VALUES ('x;y'), ('it''s');
UPDATE ONLY users SET name = 'n' WHERE id = 1;
DELETE FROM sessions
 WHERE expires < now();

WITH recent AS (
  SELECT * FROM orders WHERE created > now() - interval '1 day'
), totals(n) AS MATERIALIZED (SELECT count(*) FROM recent)
SELECT n FROM totals;

SELECT extract(year FROM created) AS y, 1;
(SELECT 1) UNION (SELECT 2);
MERGE INTO stock s USING deliveries d ON s.id = d.id WHEN MATCHED THEN UPDATE SET qty = s.qty + d.qty;
SELECT 1`;

const inventory = (chunks: CodeChunk[]) => chunks.map((c) => `${c.kind}:${c.name}@${c.startLine}-${c.endLine}`);

const analyze = (path: string, source: string) => extractSqlChunks(path, source, charsPerTokenEstimator);

test("golden inventory for a migration file", async () => {
  const { chunks, warnings } = await analyze("db/0042.sql", MIGRATION);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "config:set search_path@4-4",
    "table:app.accounts@6-13",
    "config:create index idx_accounts_email@15-15",
    "table:scratch@17-17",
    'table:"app"."active_accounts"@19-20',
    "table:daily_totals@22-22",
    "type:mood@24-24",
    "function:app.touch@26-31",
    "function:tagged@33-35",
    "function:accounts_touch@37-38",
    "config:alter table app.accounts@40-40",
    "config:drop table `old`.`legacy`@41-41",
    "config:commit@42-42",
  ]);
});

test("golden inventory for a query file", async () => {
  const { chunks, warnings } = await analyze("queries/report.sql", QUERIES);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "query:select from users@1-2",
    "query:insert into audit.log@6-6",
    "query:update users@7-7",
    "query:delete from sessions@8-9",
    "query:with recent, totals@11-14",
    "query:select@16-16",
    "query:query@17-17",
    "query:merge into stock@18-18",
    "query:select@19-19",
  ]);
});

test("ranges, content, references and IDs", async () => {
  for (const [path, source] of [
    ["db/0042.sql", MIGRATION],
    ["queries/report.sql", QUERIES],
  ] as const) {
    const { chunks } = await analyze(path, source);
    const lines = source.split("\n");
    for (const chunk of chunks) {
      expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
      expect(chunk.references).toEqual([]);
      expect(chunk.language).toBe("sql");
      expect(chunk.file).toBe(path);
    }
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  }
});

test("attached leading comments join the chunk; detached ones do not", async () => {
  const { chunks } = await analyze("a.sql", MIGRATION);
  expect(chunks[0]!.content).toBe("SET search_path TO app, public;");
  expect(chunks[1]!.content.startsWith("/* Core table;\n   with a semicolon in this comment */\nCREATE TABLE")).toBe(
    true,
  );
  const queries = await analyze("q.sql", QUERIES);
  expect(queries.chunks[0]!.content.startsWith("-- all users\nSELECT")).toBe(true);
  expect(queries.chunks[1]!.content.startsWith("INSERT")).toBe(true);
});

test("CRLF files yield the same inventory and ids as LF, and keep their carriage returns", async () => {
  const lf = await analyze("db/0042.sql", MIGRATION);
  const crlf = await analyze("db/0042.sql", MIGRATION.replace(/\n/g, "\r\n"));
  expect(inventory(crlf.chunks)).toEqual(inventory(lf.chunks));
  expect(crlf.chunks.map((c) => c.id)).toEqual(lf.chunks.map((c) => c.id));
  expect(crlf.chunks[0]!.content).toBe("SET search_path TO app, public;\r");
  expect(crlf.chunks[1]!.content).toContain("\r\n");
});

test("a final statement without a semicolon ends at its last token, not at trailing comments or blank lines", async () => {
  const { chunks } = await analyze("a.sql", "SELECT 1;\nSELECT 2\n  FROM t\n\n-- bye\n\n");
  expect(inventory(chunks)).toEqual(["query:select@1-1", "query:select from t@2-3"]);
});

test("statements on one line are separate chunks sharing that line; identical ones collapse", async () => {
  const { chunks } = await analyze(
    "a.sql",
    "INSERT INTO a VALUES (1); INSERT INTO b VALUES (2); SELECT 1; SELECT 1;\n",
  );
  expect(inventory(chunks)).toEqual(["query:insert into a@1-1", "query:insert into b@1-1", "query:select@1-1"]);
  expect(chunks.every((c) => c.content === chunks[0]!.content)).toBe(true);
});

test("a statement after a same-line terminator does not claim comments belonging to the previous statement", async () => {
  const { chunks } = await analyze("a.sql", "SELECT 1; -- one\n-- two\nSELECT 2;\n");
  expect(chunks.map((c) => c.content)).toEqual(["SELECT 1; -- one", "-- two\nSELECT 2;"]);
});

test("BEGIN...END bodies of triggers and procedures do not split, and BEGIN; stays a statement", async () => {
  const source = `BEGIN;
CREATE TRIGGER t AFTER INSERT ON users
BEGIN
  UPDATE counters SET n = CASE WHEN n > 0 THEN n + 1 ELSE 1 END;
  INSERT INTO log VALUES (1);
END;
CREATE PROCEDURE p()
BEGIN
  IF x THEN SELECT 1; END IF;
  CASE x WHEN 1 THEN SELECT 2; END CASE;
END;
SELECT 3;
COMMIT;
`;
  const { chunks } = await analyze("a.sql", source);
  expect(inventory(chunks)).toEqual([
    "config:begin@1-1",
    "function:t@2-6",
    "function:p@7-11",
    "query:select@12-12",
    "config:commit@13-13",
  ]);
});

test("quoted identifiers, backticks and dollar-quote look-alikes", async () => {
  const source = 'SELECT "a;""b" FROM `t;``x`;\nSELECT $1, $2 FROM t WHERE a$b$ = 1;\nSELECT 1;\n';
  const { chunks, warnings } = await analyze("a.sql", source);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual(["query:select from `t;``x`@1-1", "query:select from t@2-2", "query:select@3-3"]);
});

test("unicode names and content", async () => {
  const { chunks } = await analyze("a.sql", "CREATE TABLE straße.größe (naïve text DEFAULT '日本;語');\n");
  expect(inventory(chunks)).toEqual(["table:straße.größe@1-1"]);
});

test("names fall back to the verb when no target is found", async () => {
  const source = "SELECT 1;\nVALUES (1);\nVACUUM;\nANALYZE;\nCREATE INDEX ON users (id);\n";
  const { chunks } = await analyze("a.sql", source);
  expect(inventory(chunks)).toEqual([
    "query:select@1-1",
    "query:values@2-2",
    "config:vacuum@3-3",
    "config:analyze@4-4",
    "config:create index on users@5-5",
  ]);
});

test("unterminated constructs run to the end of the file with a warning", async () => {
  for (const source of ["SELECT 'oops;\nSELECT 2;", "SELECT 1; /* never closed;\nSELECT 2;", "SELECT $$ open;\n"]) {
    const { chunks, warnings } = await analyze("bad.sql", source);
    expect(chunks.length).toBeGreaterThan(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith("bad.sql: unterminated");
  }
});

test("empty, whitespace-only, comment-only and bare-semicolon files yield nothing", async () => {
  for (const source of ["", "  \n\n", "-- just a note\n/* and\nanother */\n", ";;\n ; \n"]) {
    expect(await analyze("e.sql", source)).toEqual({ chunks: [], warnings: [] });
  }
});

test("the analyzer is registered for sql", async () => {
  expect(sqlAnalyzer.languages).toEqual(["sql"]);
  const result = await analyzeFile({ path: "a.sql", source: "SELECT 1;" }, "sql", charsPerTokenEstimator);
  expect(inventory(result.chunks)).toEqual(["query:select@1-1"]);
});

test("a stray END before any BEGIN does not unbalance a routine and swallow the file", async () => {
  const { chunks } = await analyze("a.sql", "CREATE FUNCTION f(end int) RETURNS int RETURN end;\nSELECT 1;\n");
  expect(inventory(chunks)).toEqual(["function:f@1-1", "query:select@2-2"]);
});

test("an unquoted column named end does not close a trigger body", async () => {
  const source =
    "CREATE TRIGGER t AFTER INSERT ON users BEGIN\n  UPDATE users SET end = 1;\n  INSERT INTO log (a, end) VALUES (1, 2);\n  SELECT users.end, x FROM users WHERE end = 3;\nEND;\nSELECT 1;\n";
  const { chunks } = await analyze("a.sql", source);
  expect(inventory(chunks)).toEqual(["function:t@1-5", "query:select@6-6"]);
});

test("end after a clause keyword or before = is a column, not a closer", async () => {
  const afterKeyword = "CREATE TRIGGER t AFTER INSERT ON u BEGIN\n  SELECT end FROM u;\n  SELECT 2;\nEND;\nSELECT 1;\n";
  expect(inventory((await analyze("a.sql", afterKeyword)).chunks)).toEqual(["function:t@1-4", "query:select@5-5"]);
  const beforeEquals =
    "CREATE TRIGGER t AFTER INSERT ON u BEGIN\n  IF end = 1 THEN a; END IF;\n  b;\nEND;\nSELECT 1;\n";
  expect(inventory((await analyze("a.sql", beforeEquals)).chunks)).toEqual(["function:t@1-4", "query:select@5-5"]);
});

test("end inside an expression never closes a routine body", async () => {
  const head = "CREATE TRIGGER t AFTER INSERT ON u BEGIN\n";
  const tail = "  b;\nEND;\nSELECT 1;\n";
  for (const body of ["  SELECT 1 + end FROM u;\n", "  SELECT CASE WHEN x THEN end ELSE 0 END FROM u;\n"]) {
    const { chunks } = await analyze("a.sql", head + body + tail);
    expect(inventory(chunks)).toEqual(["function:t@1-4", "query:select@5-5"]);
  }
});

test("an empty BEGIN END block and a trailing END CASE statement balance", async () => {
  const empty = "CREATE PROCEDURE p() BEGIN END;\nSELECT 1;\n";
  expect(inventory((await analyze("a.sql", empty)).chunks)).toEqual(["function:p@1-1", "query:select@2-2"]);
  const caseStatement = "CREATE PROCEDURE p() BEGIN\n  CASE x WHEN 1 THEN a; END CASE;\n  b;\nEND;\nSELECT 1;\n";
  expect(inventory((await analyze("a.sql", caseStatement)).chunks)).toEqual(["function:p@1-4", "query:select@5-5"]);
});

test("BEGIN TRANSACTION and BEGIN TRY do not open a counted block", async () => {
  const transaction = "CREATE PROCEDURE p() BEGIN\n  BEGIN TRANSACTION;\n  a;\n  COMMIT;\nEND;\nSELECT 1;\n";
  expect(inventory((await analyze("a.sql", transaction)).chunks)).toEqual(["function:p@1-5", "query:select@6-6"]);
  const tryCatch =
    "CREATE PROCEDURE p() BEGIN\n  BEGIN TRY\n  a;\n  END TRY\n  BEGIN CATCH\n  b;\n  END CATCH;\nEND;\nSELECT 1;\n";
  expect(inventory((await analyze("a.sql", tryCatch)).chunks)).toEqual(["function:p@1-8", "query:select@9-9"]);
});

test("begin used as an identifier does not open a block", async () => {
  const fragments = [
    "a + t.begin + 1",
    "f(1, begin + 1)",
    "(begin + 1)",
    "1 + begin = 1",
    "(1 + begin)",
    "1 + begin.x",
    "1 + begin, 2",
    "1 + begin FROM u",
    ...["SELECT", "SET", "WHERE", "AND", "OR", "BY", "ON"].map((word) => `${word} begin + 1`),
  ];
  for (const fragment of fragments) {
    const source = `CREATE TRIGGER t AFTER INSERT ON u BEGIN\n  ${fragment};\nEND;\nSELECT 1;\n`;
    expect(inventory((await analyze("a.sql", source)).chunks)).toEqual(["function:t@1-3", "query:select@4-4"]);
  }
});

test("routine keywords inside column definitions do not make a CREATE TABLE a routine", async () => {
  const { chunks } = await analyze("a.sql", "CREATE TABLE u (function int, begin int);\nSELECT 1;\n");
  expect(inventory(chunks)).toEqual(["table:u@1-1", "query:select@2-2"]);
});

test("the routine keyword search stops at a plain object keyword or an opening parenthesis", async () => {
  const lineRanges = async (source: string) =>
    (await analyze("a.sql", source)).chunks.map(({ startLine, endLine }) => `${startLine}-${endLine}`);
  expect(await lineRanges("CREATE VIEW v AS SELECT 1 AS function, 2 AS begin;\nSELECT 1;\n")).toEqual(["1-1", "2-2"]);
  expect(await lineRanges("CREATE COLLATION c (function int, x begin int);\nSELECT 1;\n")).toEqual(["1-1", "2-2"]);
});

test("a routine keyword far into the CREATE header still protects its BEGIN...END body", async () => {
  const source = "CREATE OR REPLACE DEFINER = x TEMP FUNCTION g()\nBEGIN\n  a;\n  b;\nEND;\nSELECT 1;\n";
  const { chunks } = await analyze("a.sql", source);
  expect(inventory(chunks)).toEqual(["function:g@1-5", "query:select@6-6"]);
});

test("comments above a line shared by two statements are claimed by the first only", async () => {
  const { chunks } = await analyze("a.sql", "-- header\nSELECT 1; SELECT 2 FROM t;\n");
  expect(inventory(chunks)).toEqual(["query:select@1-2", "query:select from t@2-2"]);
});

test("an unterminated final construct ends at the line holding its last character", async () => {
  const { chunks } = await analyze("a.sql", "SELECT 'oops\n");
  expect(inventory(chunks)).toEqual(["query:select@1-1"]);
  expect(chunks[0]!.content).toBe("SELECT 'oops");
});

test("query names skip ONLY, OR, column lists, RECURSIVE and NOT MATERIALIZED", async () => {
  const source = [
    "DELETE FROM ONLY t;",
    "UPDATE OR REPLACE users SET a = 1;",
    "WITH a(x) AS NOT MATERIALIZED (SELECT 1), b AS (SELECT 2) SELECT 1;",
    "WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r;",
  ].join("\n");
  const { chunks } = await analyze("a.sql", source);
  expect(chunks.map((c) => c.name)).toEqual(["delete from t", "update users", "with a, b", "with r"]);
});

test("non-CREATE statements only look for an object keyword right after the verb", async () => {
  const { chunks } = await analyze("a.sql", "GRANT ALL ON TABLE users TO bob;\nALTER TABLE x ADD y int;\n");
  expect(chunks.map((c) => c.name)).toEqual(["grant ALL", "alter table x"]);
});

test("a comment trailing a statement is not a leading comment of the next one", async () => {
  const { chunks } = await analyze("a.sql", "SELECT 1; -- note\nSELECT 2;\n");
  expect(chunks.map((c) => c.content)).toEqual(["SELECT 1; -- note", "SELECT 2;"]);
});
