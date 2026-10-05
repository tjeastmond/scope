import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".claude/", "dist/", "node_modules/", "fixtures/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Shipped runtime code must run on Node without Bun.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "Bun", message: "Shipped code must not depend on Bun." }],
      "no-restricted-imports": ["error", { patterns: ["bun:*"] }],
    },
  },
);
