import type { Node } from "web-tree-sitter";
import { assembleChunks } from "./assemble.ts";
import type { AnalysisResult, Analyzer, ChunkKind, Language, TokenEstimator } from "../types.ts";
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

/** A JSON or YAML key as written, without its quotes. Inner whitespace is kept exactly unless the name spans lines. */
function keyName(key: Node): string {
  const text = key.text.trim();
  const singleLine = (value: string) => (/[\r\n]/.test(value) ? value.replace(/\s+/g, " ").trim() : value);
  if (text.startsWith('"')) {
    try {
      const parsed: string = JSON.parse(text);
      return parsed === "" ? text : singleLine(parsed);
    } catch {
      return singleLine(text);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) {
    return singleLine(text.slice(1, -1).replaceAll("''", "'"));
  }
  // A plain scalar that wraps lines folds them into single spaces.
  return singleLine(text);
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
const YAML_NON_BODY = ["comment", "yaml_directive", "tag_directive", "reserved_directive"];
const YAML_PAIRS = ["block_mapping_pair", "flow_pair"];

const findYaml: Finder = (root) => {
  const documents = entries(root, ["document"]).map((document) =>
    namedChildren(document).find((child) => !YAML_NON_BODY.includes(child.type)),
  );
  const found = keyedEntries(entries(root, YAML_PAIRS));
  // Empty documents give no chunks and do not count toward the `doc[N]` prefix; N stays the position in the file.
  const filled = documents.filter(Boolean).length;
  documents.forEach((body, index) => {
    if (!body) return;
    const label = filled > 1 ? `doc[${index}]` : undefined;
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
    const found = find(tree.rootNode).map(({ node, last = node, kind, name }) => {
      const { startPosition: start } = node;
      const { endPosition: end } = last;
      // A node that ends at column 0 (a block scalar keeps its trailing newline) stops on the line before.
      const endLine = end.column === 0 && end.row > start.row ? end.row : end.row + 1;
      return { startLine: start.row + 1, endLine, kind, name };
    });
    // Entries sharing a line range (minified JSON, flow YAML) would each repeat the whole line, so they collapse into
    // one `file` chunk for that range.
    const perRange = new Map<string, (typeof found)[number][]>();
    for (const entry of found) {
      const key = `${entry.startLine}-${entry.endLine}`;
      perRange.set(key, [...(perRange.get(key) ?? []), entry]);
    }
    const unique = [...perRange.values()].map((group) =>
      group.length > 1 ? { ...group[0]!, kind: "file" as const, name: undefined } : group[0]!,
    );
    const { chunks, warnings } = assembleChunks(
      file,
      source,
      language,
      unique,
      tree.rootNode.hasError,
      estimator,
      "entries",
    );
    if (grammar === "json" && tree.rootNode.descendantsOfType("comment").length > 0) {
      warnings.push(`${file}: contains comments (JSONC); parsed leniently`);
    }
    return { chunks, warnings };
  } finally {
    tree.delete();
  }
}

export const configAnalyzer: Analyzer = {
  languages: ["json", "yaml", "toml"],
  analyze: (file, estimator) => extractConfigChunks(file.path, file.source, estimator),
};
