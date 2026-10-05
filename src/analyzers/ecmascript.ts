import type { Node } from "web-tree-sitter";
import { makeChunkId } from "../chunk-id.ts";
import type { AnalysisResult, Analyzer, ChunkKind, CodeChunk, Language, TokenEstimator } from "../types.ts";
import { type Grammar, parserFor } from "./parser.ts";

/** Every extension the analyzer understands (`.d.ts` is covered by `.ts`). */
export const ECMASCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** The TypeScript subset `scope.ts` scans until the repository scanner (#18/#20) takes over file discovery. */
export const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx"] as const;

/** The grammar and chunk language for a file, decided by its path. Unknown extensions use the TypeScript grammar. */
export function grammarForPath(path: string): { grammar: Grammar; language: Language } {
  const lower = path.toLowerCase();
  const ends = (...extensions: string[]) => extensions.some((extension) => lower.endsWith(extension));
  if (ends(".tsx")) return { grammar: "tsx", language: "typescript" };
  if (ends(".js", ".jsx", ".mjs", ".cjs")) return { grammar: "javascript", language: "javascript" };
  return { grammar: "typescript", language: "typescript" };
}

const CLASS_TYPES = new Set(["class_declaration", "abstract_class_declaration", "class"]);
const FUNCTION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "function_expression",
  "function",
  "generator_function",
  "arrow_function",
]);
/** Declarations that are one chunk each, with the kind it gets. Enums are `type` chunks. */
const SIMPLE_KINDS: Record<string, ChunkKind> = {
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "type",
};
const METHOD_SIGNATURES = new Set(["method_signature", "abstract_method_signature"]);
const FIELD_TYPES = new Set(["public_field_definition", "field_definition"]);
/** Transparent wrappers around a value: `(() => 1)`, `fn as T`, `fn satisfies T`. */
const VALUE_WRAPPERS = new Set(["parenthesized_expression", "as_expression", "satisfies_expression"]);
const JSX_TYPES = ["jsx_element", "jsx_self_closing_element", "jsx_fragment"];
const COMPONENT_TYPE = /\b(?:FC|FunctionComponent|VFC|VoidFunctionComponent)\b/;
const TEST_MODIFIERS = new Set(["only", "skip", "todo", "concurrent", "failing"]);

/** One declaration. `start`/`end` are the nodes whose rows bound the chunk (wrappers and decorators included). */
interface Found {
  start: Node;
  end: Node;
  kind: ChunkKind;
  name: string;
  /** A body-less overload or abstract signature; merged into the implementation that follows it. */
  signature?: boolean;
  /** Marks a static class member so it can be told apart from an instance member of the same name. */
  isStatic?: boolean;
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && child.type !== "comment");
}

function unwrapValue(node: Node | null): Node | null {
  let current = node;
  while (current && VALUE_WRAPPERS.has(current.type)) current = namedChildren(current)[0] ?? null;
  return current;
}

function hasJsx(node: Node): boolean {
  return node.descendantsOfType(JSX_TYPES).length > 0;
}

/** A function or arrow is a component when it is named like one (or default-exported) and renders JSX or is `FC`-typed. */
function functionKind(node: Node, name: string, typeAnnotation?: Node | null, isDefaultExport = false): ChunkKind {
  if (node.type === "function_signature") return "function";
  const componentName = isDefaultExport || name === "default" || /^[A-Z]/.test(name);
  const typed = typeAnnotation !== undefined && typeAnnotation !== null && COMPONENT_TYPE.test(typeAnnotation.text);
  return componentName && (typed || hasJsx(node)) ? "component" : "function";
}

/** `get `/`set ` for accessors so a getter and setter sharing a name and line get distinct chunk identities. */
function accessorPrefix(member: Node): string {
  const accessor = member.children.find((child) => child?.type === "get" || child?.type === "set");
  return accessor ? `${accessor.type} ` : "";
}

/** Class members as `Class.member` method chunks. Overload signatures are merged by the caller. */
function classMembers(classNode: Node, className: string): (Found | undefined)[] {
  const body = classNode.childForFieldName("body");
  const entries: (Found | undefined)[] = [];
  // Method decorators are siblings of the method inside the class body, so they are folded into its range here.
  let decorator: Node | undefined;
  for (const member of body ? namedChildren(body) : []) {
    if (member.type === "decorator") {
      decorator ??= member;
      continue;
    }
    const start = decorator ?? member;
    decorator = undefined;
    const isMethod = member.type === "method_definition" || METHOD_SIGNATURES.has(member.type);
    const name = (member.childForFieldName("name") ?? member.childForFieldName("property"))?.text;
    const value = FIELD_TYPES.has(member.type) ? unwrapValue(member.childForFieldName("value")) : null;
    const memberIsFunction = value !== null && FUNCTION_TYPES.has(value.type);
    if (member.hasError || !name || name === "constructor" || !(isMethod || memberIsFunction)) {
      entries.push(undefined);
      continue;
    }
    entries.push({
      start,
      end: member,
      kind: "method",
      name: `${className}.${accessorPrefix(member)}${name}`,
      signature: METHOD_SIGNATURES.has(member.type),
      isStatic: member.children.some((child) => child?.type === "static"),
    });
  }
  // A static and an instance member can share a name; keep their chunk identities distinct.
  const instanceNames = new Set(entries.flatMap((entry) => (entry && !entry.isStatic ? [entry.name] : [])));
  return entries.map((entry) =>
    entry?.isStatic && instanceNames.has(entry.name)
      ? { ...entry, name: `${className}.static ${entry.name.slice(className.length + 1)}` }
      : entry,
  );
}

/** `class` chunk plus its members. */
function classEntries(classNode: Node, name: string, range: Node): (Found | undefined)[] {
  return [{ start: range, end: range, kind: "class", name }, ...classMembers(classNode, name)];
}

/** `const f = () => ...`, `const C = class {}` and exported constants, one per identifier declarator. */
function variableEntries(declaration: Node, range: Node, exported: boolean): (Found | undefined)[] {
  const found: (Found | undefined)[] = [];
  for (const declarator of namedChildren(declaration)) {
    const id = declarator.childForFieldName("name");
    if (declarator.type !== "variable_declarator" || id?.type !== "identifier") continue;
    const value = unwrapValue(declarator.childForFieldName("value"));
    const spec = { start: range, end: range, name: id.text };
    if (value && FUNCTION_TYPES.has(value.type))
      found.push({ ...spec, kind: functionKind(value, id.text, declarator.childForFieldName("type")) });
    else if (value && CLASS_TYPES.has(value.type)) found.push(...classEntries(value, id.text, range));
    else if (exported) found.push({ ...spec, kind: "config" });
  }
  return found;
}

/** The called name of `describe(...)`, `it.only(...)` and similar; `describe`, `it` or `test`. */
function testCall(statement: Node): { callee: string; title: string } | undefined {
  const call = statement.type === "expression_statement" ? namedChildren(statement)[0] : undefined;
  if (call?.type !== "call_expression") return undefined;
  const fn = call.childForFieldName("function");
  let callee = fn;
  while (callee?.type === "member_expression" && TEST_MODIFIERS.has(callee.childForFieldName("property")?.text ?? "")) {
    callee = callee.childForFieldName("object");
  }
  if (callee?.type !== "identifier" || !["describe", "it", "test"].includes(callee.text)) return undefined;
  const first = call.childForFieldName("arguments")?.namedChildren.find((child) => child?.type !== "comment");
  if (!first) return undefined;
  const quoted = first.type === "string" || (first.type === "template_string" && !first.text.includes("${"));
  return { callee: callee.text, title: quoted ? first.text.slice(1, -1) : first.text };
}

/** The declarations of one top-level statement. Statements that declare nothing give an empty array. */
function statementEntries(statement: Node): (Found | undefined)[] {
  const exported = statement.type === "export_statement";
  let inner: Node | null = exported
    ? (statement.childForFieldName("declaration") ?? statement.childForFieldName("value"))
    : statement;
  if (inner?.type === "ambient_declaration") inner = namedChildren(inner)[0] ?? null;
  const isDefault = exported && statement.childForFieldName("value") !== null;
  const isDefaultExport = exported && statement.children.some((child) => child?.type === "default");
  if (isDefault) inner = unwrapValue(inner);
  if (!inner) return [];
  const spec = { start: statement, end: statement };
  const name = inner.childForFieldName("name")?.text ?? (isDefault ? "default" : undefined);

  if (CLASS_TYPES.has(inner.type)) return name ? classEntries(inner, name, statement) : [];
  if (FUNCTION_TYPES.has(inner.type))
    return name
      ? [
          {
            ...spec,
            kind: functionKind(inner, name, undefined, isDefaultExport),
            name,
            signature: inner.type === "function_signature",
          },
        ]
      : [];
  const kind = SIMPLE_KINDS[inner.type];
  if (kind) return name ? [{ ...spec, kind, name }] : [];
  if (inner.type === "lexical_declaration" || inner.type === "variable_declaration")
    return variableEntries(inner, statement, exported);
  if (isDefault && inner.type !== "identifier") return [{ ...spec, kind: "config", name: "default" }];
  const test = exported ? undefined : testCall(statement);
  if (test)
    return [
      test.callee === "describe"
        ? { ...spec, kind: "section", name: `describe: ${test.title}` }
        : { ...spec, kind: "function", name: `test: ${test.title}` },
    ];
  return [];
}

/**
 * Merges runs of same-name signatures into the implementation that directly follows them (or into one chunk when no
 * implementation follows). `undefined` entries break adjacency.
 */
function mergeOverloads(entries: (Found | undefined)[]): Found[] {
  const found: Found[] = [];
  let run: Found | undefined;
  const flush = () => {
    if (run) found.push({ ...run, signature: undefined });
    run = undefined;
  };
  for (const entry of entries) {
    if (!entry) flush();
    else if (entry.signature) {
      if (run?.name === entry.name && run.kind === entry.kind) run = { ...run, end: entry.end };
      else {
        flush();
        run = entry;
      }
    } else if (run?.name === entry.name && run.kind === entry.kind) {
      found.push({ ...entry, start: run.start });
      run = undefined;
    } else {
      flush();
      found.push(entry);
    }
  }
  flush();
  return found;
}

/**
 * Extracts declaration-level chunks from one JavaScript or TypeScript source file. `content` is the exact source lines
 * the declaration spans, and line numbers are 1-based and inclusive. The grammar and chunk language come from the path.
 */
export async function extractEcmascript(
  path: string,
  source: string,
  estimator: TokenEstimator,
): Promise<AnalysisResult> {
  const { grammar, language } = grammarForPath(path);
  const parser = await parserFor(grammar);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Tree-sitter could not parse ${path}`);
  try {
    const entries = namedChildren(tree.rootNode).flatMap((statement) => {
      const found = statement.hasError ? [] : statementEntries(statement);
      return found.length > 0 ? found : [undefined];
    });
    const found = mergeOverloads(entries);
    const lines = source.split("\n");
    const all = found.map(({ start, end, kind, name }): CodeChunk => {
      const startLine = start.startPosition.row + 1;
      const endLine = end.endPosition.row + 1;
      const content = lines.slice(startLine - 1, endLine).join("\n");
      return {
        id: makeChunkId({ file: path, startLine, endLine, kind, name }),
        file: path,
        language,
        kind,
        name,
        startLine,
        endLine,
        content,
        references: [],
        estimatedTokens: estimator.count(content),
      };
    });
    // Same-name declarations on one line (`it("a", f); it("a", f);`) share a range, hence an id; keep the first.
    const chunks = [...new Map(all.map((chunk) => [chunk.id, chunk])).values()];
    const warnings = tree.rootNode.hasError
      ? [`${path}: syntax errors; extracted ${chunks.length} declarations from the parseable regions`]
      : [];
    return { chunks, warnings };
  } finally {
    tree.delete();
  }
}

export const ecmascriptAnalyzer: Analyzer = {
  languages: ["typescript", "javascript"],
  analyze: (file, estimator) => extractEcmascript(file.path, file.source, estimator),
};
