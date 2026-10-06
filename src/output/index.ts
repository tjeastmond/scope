import type { ScopeResult } from "../types.ts";
import { renderJson } from "./json.ts";
import { renderMarkdown } from "./markdown.ts";
import { renderResult } from "./text.ts";

export const FORMATS = ["text", "markdown", "json"] as const;
export type OutputFormat = (typeof FORMATS)[number];

const RENDERERS: Record<OutputFormat, (result: ScopeResult) => string> = {
  text: renderResult,
  markdown: renderMarkdown,
  json: renderJson,
};

/** Single entry point for turning a result into an artifact in the requested format. */
export const renderFormat = (format: OutputFormat, result: ScopeResult): string => RENDERERS[format](result);
