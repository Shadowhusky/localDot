import { defineConfig } from "vitest/config";

// Suites that run the real keyd built from keyd/: opt in with LOCALDOT_KEYD_TESTS=1 pnpm test:keyd.
export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.keyd.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // keyd is built once per run, and the build is removed afterwards.
    globalSetup: ["apps/daemon/src/keyd/testing/keyd-build.ts"],
  },
});
