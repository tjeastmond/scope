import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import { makeChunkId } from "../chunk-id.ts";
import type { Analyzer, ChunkKind, CodeChunk, TokenEstimator } from "../types.ts";

export const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx"] as const;

const require = createRequire(import.meta.url);
let initialized: Promise<void> | undefined;
const parsers = new Map<"typescript" | "tsx", Promise<Parser>>();

function parserFor(grammar: "typescript" | "tsx"): Promise<Parser> {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = (async () => {
      await (initialized ??= Parser.init());
      const instance = new Parser();
      instance.setLanguage(await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`)));
      return instance;
    })();
    parsers.set(grammar, parser);
  }
  return parser;
}

const DECLARATION_KINDS: Record<string, ChunkKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
};

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

interface Found {
  node: Node;
  kind: ChunkKind;
  name: string;
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function nameOf(node: Node): string | undefined {
  return node.childForFieldName("name")?.text;
}

/** `const f = () => ...` declarations, one per function-valued declarator. */
function functionConstants(declaration: Node, range: Node): Found[] {
  return namedChildren(declaration)
    .filter((declarator) => declarator.type === "variable_declarator")
    .flatMap((declarator) => {
      const value = declarator.childForFieldName("value");
      const name = nameOf(declarator);
      return value && name && FUNCTION_VALUES.has(value.type) ? [{ node: range, kind: "function" as const, name }] : [];
    });
}

/** `get `/`set ` for accessors so a getter and setter sharing a name and line get distinct chunk identities. */
function accessorPrefix(member: Node): string {
  const accessor = member.children.find((child) => child?.type === "get" || child?.type === "set");
  return accessor ? `${accessor.type} ` : "";
}

function collect(node: Node, found: Found[]): void {
  // Exported declarations are wrapped; use the wrapper's range so the chunk includes `export`.
  const declaration = node.type === "export_statement" ? (node.childForFieldName("declaration") ?? node) : node;
  const kind = DECLARATION_KINDS[declaration.type];
  const name = nameOf(declaration);
  if (kind && name) {
    found.push({ node, kind, name });
    if (kind === "class") {
      for (const member of namedChildren(declaration.childForFieldName("body") ?? declaration)) {
        const methodName = member.type === "method_definition" ? nameOf(member) : undefined;
        if (methodName && methodName !== "constructor")
          found.push({ node: member, kind: "method", name: `${name}.${accessorPrefix(member)}${methodName}` });
      }
    }
  } else if (declaration.type === "lexical_declaration") {
    found.push(...functionConstants(declaration, node));
  }
}

/**
 * Extracts declaration-level chunks from one TypeScript source file. `content` is the exact source lines the
 * declaration spans, and line numbers are 1-based and inclusive.
 */
export async function extractTypeScriptChunks(
  file: string,
  source: string,
  estimator: TokenEstimator,
): Promise<CodeChunk[]> {
  const parser = await parserFor(file.endsWith(".tsx") ? "tsx" : "typescript");
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Tree-sitter could not parse ${file}`);
  try {
    const found: Found[] = [];
    for (const child of namedChildren(tree.rootNode)) collect(child, found);
    const lines = source.split("\n");
    return found.map(({ node, kind, name }) => {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const content = lines.slice(startLine - 1, endLine).join("\n");
      return {
        id: makeChunkId({ file, startLine, endLine, kind, name }),
        file,
        language: "typescript",
        kind,
        name,
        startLine,
        endLine,
        content,
        references: [],
        estimatedTokens: estimator.count(content),
      };
    });
  } finally {
    tree.delete();
  }
}

export const typescriptAnalyzer: Analyzer = {
  languages: ["typescript"],
  async analyze(file, estimator) {
    return { chunks: await extractTypeScriptChunks(file.path, file.source, estimator), warnings: [] };
  },
};
