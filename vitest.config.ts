import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tools/*/src/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
  },
});
