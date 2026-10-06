import type { Node } from "web-tree-sitter";
import { collapse, type RawReference } from "./assemble.ts";

/** The text of a string literal without quotes, or of a template without substitutions; otherwise undefined. */
function literalText(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const plain = node.type === "string" || (node.type === "template_string" && !node.text.includes("${"));
  return plain ? node.text.slice(1, -1) : undefined;
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && child.type !== "comment");
}

/** The imported/exported name of an `import_specifier` or `export_specifier` (the left side of `a as b`). */
function specifierName(specifier: Node): string {
  return (specifier.childForFieldName("name") ?? namedChildren(specifier)[0])?.text ?? specifier.text;
}

/** The local binding of an `import_specifier` (`b` in `a as b`) when it differs from the imported name. */
function localAlias(specifier: Node): { local?: string } {
  const alias = specifier.childForFieldName("alias")?.text;
  return alias === undefined || alias === specifierName(specifier) ? {} : { local: alias };
}

/** `import ... from "x"` and `import "x"` (side effect), plus `import x = require("x")`. */
function importReferences(statement: Node, line: number): RawReference[] {
  const base = { kind: "import" as const, line };
  const clause = namedChildren(statement).find((child) => child.type === "import_clause");
  const requireClause = namedChildren(statement).find((child) => child.type === "import_require_clause");
  const specifier = literalText(
    statement.childForFieldName("source") ?? (requireClause ? namedChildren(requireClause).at(-1) : undefined),
  );
  if (specifier === undefined) return [];
  if (!clause)
    return [
      { ...base, name: requireClause ? (namedChildren(requireClause)[0]?.text ?? specifier) : specifier, specifier },
    ];
  const refs: RawReference[] = [];
  for (const part of namedChildren(clause)) {
    if (part.type === "identifier") refs.push({ ...base, name: "default", specifier, local: part.text });
    else if (part.type === "namespace_import") {
      refs.push({ ...base, name: namedChildren(part)[0]?.text ?? "*", specifier, namespace: true });
    } else if (part.type === "named_imports") {
      for (const item of namedChildren(part)) {
        refs.push({ ...base, name: specifierName(item), specifier, ...localAlias(item) });
      }
    }
  }
  // `import {} from "x"` still loads the module.
  return refs.length > 0 ? refs : [{ ...base, name: specifier, specifier }];
}

/** `export ... from "x"`; plain `export { a }` and declarations reference nothing. */
function exportFromReferences(statement: Node, line: number): RawReference[] {
  const specifier = literalText(statement.childForFieldName("source"));
  if (specifier === undefined) return [];
  const base = { kind: "import" as const, line, specifier };
  const refs: RawReference[] = [];
  for (const part of namedChildren(statement)) {
    if (part.type === "namespace_export") refs.push({ ...base, name: namedChildren(part)[0]?.text ?? "*" });
    else if (part.type === "export_clause") {
      for (const item of namedChildren(part)) refs.push({ ...base, name: specifierName(item) });
    }
  }
  return refs.length > 0 ? refs : [{ ...base, name: "*" }];
}

/** `require(x)` and `import(x)`: a literal argument is a plain reference; anything else is `unresolved`. */
function callReference(call: Node): RawReference[] {
  const fn = call.childForFieldName("function");
  if (!fn || !(fn.type === "import" || (fn.type === "identifier" && fn.text === "require"))) return [];
  const argument = call
    .childForFieldName("arguments")
    ?.namedChildren.find((child) => child && child.type !== "comment");
  if (!argument) return [];
  const line = call.startPosition.row + 1;
  const specifier = literalText(argument);
  return specifier === undefined
    ? [{ kind: "import", line, name: collapse(argument.text), evidence: "unresolved" }]
    : [{ kind: "import", line, name: specifier, specifier }];
}

/** Every import, re-export, `require` and dynamic `import()` in the tree, in source order. Nothing is resolved. */
export function extractEcmascriptReferences(root: Node): RawReference[] {
  const refs: RawReference[] = [];
  for (const node of root.descendantsOfType(["import_statement", "export_statement", "call_expression"])) {
    if (!node || node.hasError) continue;
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") refs.push(...importReferences(node, line));
    else if (node.type === "export_statement") refs.push(...exportFromReferences(node, line));
    else refs.push(...callReference(node));
  }
  return refs;
}
