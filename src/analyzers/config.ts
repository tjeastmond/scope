import type { Node } from "web-tree-sitter";
import { makeChunkId } from "../chunk-id.ts";
import type { AnalysisResult, Analyzer, ChunkKind, CodeChunk, Language, TokenEstimator } from "../types.ts";
import { type Grammar, parserFor } from "./parser.ts";

interface Found {
  node: Node;
  /** The node whose end closes the chunk, when `node` also swallows trailing blank lines and comments. */
  last?: Node;
  kind: ChunkKind;
  name?: string;
}

type Finder = (root: Node) => Found[];

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

/** The children of `parent` of the given types, looking inside error nodes so that what parsed is kept. */
function entries(parent: Node, types: readonly string[]): Node[] {
  return namedChildren(parent).flatMap((child) =>
    types.includes(child.type) ? [child] : child.type === "ERROR" ? entries(child, types) : [],
  );
}

/** A JSON or YAML key as written, without its quotes. */
function keyName(key: Node): string {
  const text = key.text.replace(/\s+/g, " ").trim();
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) || text;
    } catch {
      return text;
    }
  }
  return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text;
}

function keyedEntries(pairs: Node[], prefix = ""): Found[] {
  return pairs.flatMap((pair) => {
    const key = pair.childForFieldName("key");
    return key ? [{ node: pair, kind: "config" as const, name: prefix + keyName(key) }] : [];
  });
}

const findJson: Finder = (root) => {
  const top = namedChildren(root).find((child) => child.type !== "comment");
  if (!top) return [];
  if (top.type === "object" || top.type === "ERROR") return keyedEntries(entries(top, ["pair"]));
  return [{ node: top, kind: "file" }];
};

const YAML_MAPPINGS = ["block_mapping", "flow_mapping"];
const YAML_PAIRS = ["block_mapping_pair", "flow_pair"];

const findYaml: Finder = (root) => {
  const documents = entries(root, ["document"]);
  const found = keyedEntries(entries(root, YAML_PAIRS));
  documents.forEach((document, index) => {
    const body = namedChildren(document).find((child) => child.type !== "comment");
    if (!body) return;
    const label = documents.length > 1 ? `doc[${index}]` : undefined;
    const mapping = namedChildren(body).find((child) => YAML_MAPPINGS.includes(child.type));
    if (mapping) found.push(...keyedEntries(entries(mapping, YAML_PAIRS), label && `${label}.`));
    else found.push({ node: body, kind: "file", name: label });
  });
  return found;
};

/** `a.b` for a dotted key, the key as written (quotes kept) otherwise: `"a.b"` and `a.b` stay distinct. */
function tomlKey(node: Node): string {
  return node.type === "dotted_key" ? namedChildren(node).map(tomlKey).join(".") : node.text;
}

const findToml: Finder = (root) => {
  const arrayCounts = new Map<string, number>();
  return entries(root, ["pair", "table", "table_array_element"]).flatMap((node): Found[] => {
    const key = namedChildren(node)[0];
    if (!key) return [];
    let name = tomlKey(key);
    if (node.type === "table_array_element") {
      const index = arrayCounts.get(name) ?? 0;
      arrayCounts.set(name, index + 1);
      name = `${name}[${index}]`;
    }
    // A table runs up to the next header, so its trailing blank lines and comments are not part of it.
    const last = namedChildren(node).findLast((child) => child.type !== "comment");
    return [{ node, last, kind: "config", name }];
  });
};

const FORMATS: Record<string, { grammar: Grammar; language: Language; find: Finder }> = {
  ".json": { grammar: "json", language: "json", find: findJson },
  ".yaml": { grammar: "yaml", language: "yaml", find: findYaml },
  ".yml": { grammar: "yaml", language: "yaml", find: findYaml },
  ".toml": { grammar: "toml", language: "toml", find: findToml },
};

function formatFor(path: string) {
  const dot = path.lastIndexOf(".");
  return FORMATS[dot < 0 ? "" : path.slice(dot).toLowerCase()] ?? FORMATS[".json"]!;
}

/**
 * Extracts one `config` chunk per top-level entry of a JSON, YAML or TOML file (see docs/chunk-model.md). `content` is
 * the exact source lines the entry spans and line numbers are 1-based and inclusive. Entries survive syntax errors
 * elsewhere in the file; any error adds a warning.
 */
export async function extractConfigChunks(
  file: string,
  source: string,
  estimator: TokenEstimator,
): Promise<AnalysisResult> {
  const { grammar, language, find } = formatFor(file);
  const parser = await parserFor(grammar);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Tree-sitter could not parse ${file}`);
  try {
    const lines = source.split("\n");
    const chunks = find(tree.rootNode).map(({ node, last = node, kind, name }): CodeChunk => {
      const { startPosition: start } = node;
      const { endPosition: end } = last;
      const startLine = start.row + 1;
      // A node that ends at column 0 (a block scalar keeps its trailing newline) stops on the line before.
      const endLine = end.column === 0 && end.row > start.row ? end.row : end.row + 1;
      const content = lines.slice(startLine - 1, endLine).join("\n");
      return {
        id: makeChunkId({ file, startLine, endLine, kind, name }),
        file,
        language,
        kind,
        ...(name === undefined ? {} : { name }),
        startLine,
        endLine,
        content,
        references: [],
        estimatedTokens: estimator.count(content),
      };
    });
    // `{"a": 1, "a": 2}` on one line yields two identical entries; keep one so chunk ids stay unique.
    const unique = [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
    const warnings: string[] = [];
    if (tree.rootNode.hasError) {
      warnings.push(`${file}: syntax errors; extracted ${unique.length} entries from the parseable regions`);
    }
    if (grammar === "json" && tree.rootNode.descendantsOfType("comment").length > 0) {
      warnings.push(`${file}: contains comments (JSONC); parsed leniently`);
    }
    return { chunks: unique, warnings };
  } finally {
    tree.delete();
  }
}

export const configAnalyzer: Analyzer = {
  languages: ["json", "yaml", "toml"],
  analyze: (file, estimator) => extractConfigChunks(file.path, file.source, estimator),
};
