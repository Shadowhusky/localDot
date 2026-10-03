import { defineConfig } from "vitest/config";

// Real account acceptance is deliberately separate from every offline and host command.
export default defineConfig({
  test: {
    include: ["apps/daemon/src/agent/codex/signin.codex.test.ts"],
    fileParallelism: false,
  },
});
