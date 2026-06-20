import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "skill", include: ["test/**/*.test.ts"], globals: true },
});
