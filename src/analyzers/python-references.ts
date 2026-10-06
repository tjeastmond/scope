import type { Node } from "web-tree-sitter";
import { collapse, type RawReference } from "./assemble.ts";

/** The text of a plain string literal (no prefix, no interpolation, no implicit concatenation), else undefined. */
function literalText(node: Node | undefined): string | undefined {
  if (node?.type !== "string" || !/^["']/.test(node.text)) return undefined;
  const parts = node.namedChildren.filter((child): child is Node => child !== null);
  if (parts.some((part) => part.type === "interpolation")) return undefined;
  return parts.find((part) => part.type === "string_content")?.text ?? "";
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && child.type !== "comment");
}

/** A dotted name or an `a as b` pair: the module/symbol as written and its alias, if any. */
function nameAndAlias(node: Node): { name: string; alias?: string } {
  if (node.type !== "aliased_import") return { name: node.text };
  const alias = node.childForFieldName("alias")?.text;
  return { name: node.childForFieldName("name")?.text ?? node.text, ...(alias === undefined ? {} : { alias }) };
}

/** `import a.b`, `import a as b`: the name is the alias when there is one (like a JS namespace import). */
function importStatement(statement: Node, line: number): RawReference[] {
  return namedChildren(statement).map((item) => {
    const { name, alias } = nameAndAlias(item);
    return { kind: "import", line, name: alias ?? name, specifier: name };
  });
}

/** `from x import y`, `from . import y`, `from ..pkg import (a, b as c)`, `from x import *`. */
function importFromStatement(statement: Node, line: number): RawReference[] {
  const module = statement.childForFieldName("module_name");
  const specifier = module ? module.text.replace(/\s+/g, "") : "__future__";
  const names = namedChildren(statement).filter((child) => child.id !== module?.id);
  return names.map((item) => ({
    kind: "import" as const,
    line,
    name: item.type === "wildcard_import" ? "*" : nameAndAlias(item).name,
    specifier,
  }));
}

/** The module argument of a call: the first positional argument, else the value of `name=`. */
function moduleArgument(call: Node): Node | undefined {
  const args =
    call.childForFieldName("arguments")?.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment") ??
    [];
  const positional = args.find((arg) => arg.type !== "keyword_argument");
  if (positional) return positional;
  return (
    args
      .find((arg) => arg.type === "keyword_argument" && arg.childForFieldName("name")?.text === "name")
      ?.childForFieldName("value") ?? undefined
  );
}

/** `__import__(x)` and `importlib.import_module(x)`: a literal argument is a plain reference, else `unresolved`. */
function dynamicImport(call: Node): RawReference[] {
  const fn = call.childForFieldName("function");
  const isImport =
    (fn?.type === "identifier" && fn.text === "__import__") ||
    (fn?.type === "attribute" && fn.text.replace(/\s+/g, "") === "importlib.import_module");
  const argument = moduleArgument(call);
  if (!isImport || !argument) return [];
  const line = call.startPosition.row + 1;
  const specifier = literalText(argument);
  return specifier === undefined
    ? [{ kind: "import", line, name: collapse(argument.text), evidence: "unresolved" }]
    : [{ kind: "import", line, name: specifier, specifier }];
}

/** Every import, `from ... import` and dynamic import call in the tree, in source order. Nothing is resolved. */
export function extractPythonReferences(root: Node): RawReference[] {
  const refs: RawReference[] = [];
  const types = ["import_statement", "import_from_statement", "future_import_statement", "call"];
  for (const node of root.descendantsOfType(types)) {
    if (!node || node.hasError) continue;
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") refs.push(...importStatement(node, line));
    else if (node.type === "call") refs.push(...dynamicImport(node));
    else refs.push(...importFromStatement(node, line));
  }
  return refs;
}
