import { defineConfig } from "vitest/config";

// Real desktop tasks on fresh, label-scoped desktops: LOCALDOT_DOCKER_TESTS=1 pnpm test:eval.
// Model mode also needs LOCALDOT_EVAL_MODEL and LOCALDOT_EVAL_SPEND_CAP_USD.
export default defineConfig({
  test: {
    include: ["apps/daemon/src/agent/evals/**/*.eval.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
