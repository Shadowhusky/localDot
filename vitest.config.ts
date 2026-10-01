import { defineConfig } from "vitest/config";

// No `esbuild` block: Vite 8 (under Vitest 5) deprecates it in favour of oxc, and its default JSX
// runtime is already automatic.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "cells/*/desktopd/src/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", "**/*.docker.test.ts"],
  },
});
