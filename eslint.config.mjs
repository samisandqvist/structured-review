import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/dist/**",
      "plugin/**",
      "plugins/**",
      ".tools/**",
      ".superpowers/**",
      ".code-review-graph/**",
      ".venv-crg/**",
      "coverage/**",
      "reports/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.vitest } },
    plugins: { sonarjs },
    rules: {
      complexity: ["error", 15],
      "sonarjs/cognitive-complexity": ["error", 15],
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ["packages/*/src/**/*.{ts,tsx}"] })),
  {
    files: ["packages/*/src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/*/src/**"],
  })),
);
