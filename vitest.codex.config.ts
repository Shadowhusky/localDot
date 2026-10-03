import { defineConfig } from "vitest/config";

// Opt-in pinned-binary and Seatbelt probes use owned local fixtures, not live model services.
export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.codex.test.ts", "harness/*/src/**/*.codex.test.ts"],
    fileParallelism: false,
  },
});
