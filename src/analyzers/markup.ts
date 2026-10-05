import type { Node } from "web-tree-sitter";
import type { Analyzer, TokenEstimator } from "../types.ts";
import { assembleChunks, collapse, type Region } from "./assemble.ts";
import { parserFor } from "./parser.ts";

export const HTML_EXTENSIONS = [".html", ".htm"] as const;

const LANDMARKS = new Set(["header", "main", "nav", "section", "form", "template", "article", "aside", "footer"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function startTagOf(element: Node): Node | undefined {
  return (
    element.namedChildren.find((child) => child?.type === "start_tag" || child?.type === "self_closing_tag") ??
    undefined
  );
}

function tagOf(element: Node): string {
  return (
    startTagOf(element)
      ?.namedChildren.find((child) => child?.type === "tag_name")
      ?.text.toLowerCase() ?? ""
  );
}

function attributeOf(element: Node, name: string): string | undefined {
  for (const attribute of startTagOf(element)?.namedChildren ?? []) {
    if (attribute?.type !== "attribute" || attribute.namedChildren[0]?.text.toLowerCase() !== name) continue;
    const value = attribute.namedChildren.find(
      (child) => child?.type === "attribute_value" || child?.type === "quoted_attribute_value",
    );
    const text = collapse(value?.text.replace(/^["']|["']$/g, "") ?? "");
    return text || undefined;
  }
  return undefined;
}

function firstHeading(element: Node): string | undefined {
  const heading = element.descendantsOfType("element").find((node) => node !== null && HEADINGS.has(tagOf(node)));
  const text = collapse(
    heading
      ?.descendantsOfType("text")
      .map((node) => node?.text ?? "")
      .join(" ") ?? "",
  );
  return text || undefined;
}

/** `tag#id`, else `tag "aria-label"`, else `tag.first-class`, else `tag "first heading"`, else the tag. */
function nameOf(element: Node, tag: string): string {
  const id = attributeOf(element, "id");
  if (id) return `${tag}#${id}`;
  const label = attributeOf(element, "aria-label");
  if (label) return `${tag} "${label}"`;
  const firstClass = attributeOf(element, "class")?.split(" ")[0];
  if (firstClass) return `${tag}.${firstClass}`;
  const heading = firstHeading(element);
  return heading ? `${tag} "${heading}"` : tag;
}

/**
 * Collects landmark elements and inline `<script>`/`<style>` blocks. Elements that are not landmarks (`html`, `body`,
 * `div`, ...) are looked through; what is inside a landmark stays part of it. Error nodes are looked through too, so
 * a document with an unclosed `<html>` or `<body>` still yields its landmarks.
 */
function collect(parent: Node, regions: Region[]): void {
  for (const node of parent.namedChildren) {
    if (!node) continue;
    const range = { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
    if (node.type === "script_element" || node.type === "style_element") {
      const hasBody = node.namedChildren.some((child) => child?.type === "raw_text" && child.text.trim() !== "");
      const tag = node.type === "script_element" ? "script" : "style";
      if (hasBody) regions.push({ ...range, kind: tag === "style" ? "style" : "section", name: nameOf(node, tag) });
    } else if (node.type === "element") {
      const tag = tagOf(node);
      if (LANDMARKS.has(tag)) {
        regions.push({ ...range, kind: tag === "template" ? "template" : "section", name: nameOf(node, tag) });
      } else {
        collect(node, regions);
      }
    } else if (node.type === "ERROR") {
      collect(node, regions);
    }
  }
}

/**
 * Extracts structural chunks from an HTML file: top-level landmark elements (`template` kind for `<template>`, else
 * `section`) and non-empty inline `<script>` (`section`) and `<style>` (`style`) blocks, each spanning the lines from its
 * opening to its closing tag. An unclosed landmark start tag is not a chunk; the file gets a warning.
 */
export async function extractHtmlChunks(file: string, source: string, estimator: TokenEstimator) {
  const parser = await parserFor("html");
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Tree-sitter could not parse ${file}`);
  try {
    const regions: Region[] = [];
    collect(tree.rootNode, regions);
    return assembleChunks(file, source, "html", regions, tree.rootNode.hasError, estimator);
  } finally {
    tree.delete();
  }
}

export const markupAnalyzer: Analyzer = {
  languages: ["html"],
  analyze: (file, estimator) => extractHtmlChunks(file.path, file.source, estimator),
};
