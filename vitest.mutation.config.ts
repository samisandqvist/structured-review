import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    include: [
      "packages/server/test/coverage.test.ts",
      "packages/server/test/globs.test.ts",
      "packages/server/test/properties.test.ts",
    ],
  },
});
