import { defineConfig } from "vitest/config";

// Docker-backed suites: opt in with LOCALDOT_DOCKER_TESTS=1 pnpm test:docker.
export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.docker.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    // keyd is built once per run, and the build is removed afterwards.
    globalSetup: ["apps/daemon/src/keyd/testing/keyd-build.ts"],
  },
});
