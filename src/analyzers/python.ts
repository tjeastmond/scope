import type { Node } from "web-tree-sitter";
import { makeChunkId } from "../chunk-id.ts";
import type { AnalysisResult, Analyzer, ChunkKind, CodeChunk, TokenEstimator } from "../types.ts";
import { parserFor } from "./parser.ts";

export const PYTHON_EXTENSIONS = [".py", ".pyi"] as const;

interface Found {
  node: Node;
  kind: ChunkKind;
  name: string;
}

const CONSTANT_NAME = /^_*[A-Z][A-Z0-9_]*$/;
const ACCESSOR_DECORATOR = /^@\s*([\p{L}\p{N}_]+)\s*\.\s*(setter|getter|deleter)\s*$/u;
const ACCESSOR_PREFIX = { setter: "set", getter: "get", deleter: "delete" } as const;

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

/** True when the node, or anything under it, is a syntax error or a recovered (missing) token. */
function isBroken(node: Node): boolean {
  return node.hasError || node.isMissing || node.type === "ERROR";
}

/**
 * Methods defined with `@x.setter`, `@x.getter` or `@x.deleter` share the property's name, so they become
 * `Class.set x`, `Class.get x` and `Class.delete x` (the plain `@property` getter stays `Class.x`).
 */
function accessorName(decorated: Node | undefined): string | undefined {
  if (!decorated) return undefined;
  for (const decorator of namedChildren(decorated).filter((child) => child.type === "decorator")) {
    const match = ACCESSOR_DECORATOR.exec(decorator.text.trim());
    if (match) return `${ACCESSOR_PREFIX[match[2] as keyof typeof ACCESSOR_PREFIX]} ${match[1]}`;
  }
  return undefined;
}

function isMainGuard(node: Node): boolean {
  if (node.type !== "if_statement") return false;
  const condition = node.childForFieldName("condition");
  if (!condition || condition.type !== "comparison_operator" || node.childForFieldName("alternative")) return false;
  const text = condition.text.replace(/\s+/g, "").replaceAll("'", '"');
  return text === `__name__=="__main__"` || text === `"__main__"==__name__`;
}

/** `NAME = ...` and `name: T = ...` statements: UPPER_CASE targets or any annotated target. */
function constantName(statement: Node): string | undefined {
  if (statement.type !== "expression_statement") return undefined;
  const assignment = namedChildren(statement).find((child) => child.type === "assignment");
  const left = assignment?.childForFieldName("left");
  if (!assignment || left?.type !== "identifier") return undefined;
  const annotated = assignment.childForFieldName("type") !== null;
  return annotated || CONSTANT_NAME.test(left.text) ? left.text : undefined;
}

/**
 * Collects the definitions in one scope. At module level that is functions, classes, constants and the `__main__`
 * guard; in a class body it is methods and nested classes. Function bodies are never entered, so nested functions
 * stay part of their parent chunk.
 */
function collect(scope: Node[], owner: string | undefined, found: Found[]): void {
  for (const statement of scope) {
    const decorated = statement.type === "decorated_definition" ? statement : undefined;
    const definition = decorated ? decorated.childForFieldName("definition") : statement;
    if (!definition) continue;
    const name = definition.childForFieldName("name")?.text;
    let entry: Found | undefined;
    if (definition.type === "function_definition" && name) {
      entry =
        owner === undefined
          ? { node: statement, kind: "function", name }
          : { node: statement, kind: "method", name: `${owner}.${accessorName(decorated) ?? name}` };
    } else if (definition.type === "class_definition" && name) {
      entry = { node: statement, kind: "class", name: owner === undefined ? name : `${owner}.${name}` };
    } else if (owner === undefined && isMainGuard(definition)) {
      entry = { node: statement, kind: "section", name: "__main__" };
    } else if (owner === undefined) {
      const constant = constantName(definition);
      if (constant) entry = { node: statement, kind: "config", name: constant };
    }
    if (!entry || isBroken(statement)) continue;
    found.push(entry);
    if (entry.kind === "class") {
      collect(namedChildren(definition.childForFieldName("body") ?? definition), entry.name, found);
    }
  }
}

/**
 * Extracts declaration-level chunks from one Python source file. `content` is the exact source lines the
 * declaration spans (decorators and docstrings included), and line numbers are 1-based and inclusive. Declarations
 * that contain syntax errors are skipped and reported in `warnings`.
 */
export async function extractPythonChunks(
  file: string,
  source: string,
  estimator: TokenEstimator,
): Promise<AnalysisResult> {
  const parser = await parserFor("python");
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Tree-sitter could not parse ${file}`);
  try {
    const found: Found[] = [];
    collect(namedChildren(tree.rootNode), undefined, found);
    const lines = source.split("\n");
    const chunks = found.map(({ node, kind, name }): CodeChunk => {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const content = lines.slice(startLine - 1, endLine).join("\n");
      return {
        id: makeChunkId({ file, startLine, endLine, kind, name }),
        file,
        language: "python",
        kind,
        name,
        startLine,
        endLine,
        content,
        references: [],
        estimatedTokens: estimator.count(content),
      };
    });
    const warnings =
      tree.rootNode.hasError && source.trim() !== ""
        ? [`${file}: syntax errors; extracted ${chunks.length} declarations from the parseable regions`]
        : [];
    return { chunks, warnings };
  } finally {
    tree.delete();
  }
}

export const pythonAnalyzer: Analyzer = {
  languages: ["python"],
  analyze: (file, estimator) => extractPythonChunks(file.path, file.source, estimator),
};
