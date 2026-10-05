import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

/**
 * Grammars shipped as WASM by `tree-sitter-wasms`, except yaml, whose copy there does not load in web-tree-sitter 0.25
 * and comes from `@tree-sitter-grammars/tree-sitter-yaml` instead. `jsx` files use the javascript grammar.
 * sql, scss and markdown have no WASM grammar available; see docs/grammars.md.
 */
export const GRAMMARS = ["typescript", "tsx", "javascript", "python", "html", "css", "json", "yaml", "toml"] as const;

export type Grammar = (typeof GRAMMARS)[number];

const require = createRequire(import.meta.url);
let initialized: Promise<void> | undefined;
const parsers = new Map<Grammar, Promise<Parser>>();

function wasmSpecifier(grammar: Grammar): string {
  return grammar === "yaml"
    ? "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm"
    : `tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`;
}

/** A parser for `grammar`, initialized once per process and cached. */
export function parserFor(grammar: Grammar): Promise<Parser> {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = (async () => {
      if (!(GRAMMARS as readonly string[]).includes(grammar)) throw new Error(`Unsupported grammar: ${grammar}`);
      let path: string;
      try {
        path = require.resolve(wasmSpecifier(grammar));
      } catch (error) {
        throw new Error(`Grammar "${grammar}" is unavailable: its WASM file is missing`, {
          cause: error,
        });
      }
      await (initialized ??= Parser.init());
      const instance = new Parser();
      instance.setLanguage(await Language.load(path));
      return instance;
    })();
    // Do not cache failures.
    parser.catch(() => parsers.delete(grammar));
    parsers.set(grammar, parser);
  }
  return parser;
}
