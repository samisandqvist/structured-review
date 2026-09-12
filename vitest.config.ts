import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    projects: [
      "packages/*/vitest.config.ts",
      { test: { name: "harness", include: ["tests/harness/**/*.test.mjs", "tests/security/**/*.test.mjs"] } },
    ],
    coverage: {
      provider: "v8",
      all: true,
      include: ["packages/*/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}", "scripts/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
      exclude: ["**/*.d.ts", "**/*.d.mts", "**/*.d.cts", "packages/web/src/test/setup.ts"],
      reporter: ["text-summary", "json", "json-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
