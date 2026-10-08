import { defineConfig } from "vitest/config";

// No `esbuild` block: Vite 8 (under Vitest 5) deprecates it in favour of oxc, and its default JSX
// runtime is already automatic.
export default defineConfig({
  // apps/web resolves its @/ alias from its tsconfig.
  resolve: { tsconfigPaths: true },
  test: {
    css: { include: [/theme\.css/, /tokens\.css/] },
    include: [
      "packages/*/src/**/*.test.ts",
      "harness/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "cells/*/desktopd/src/**/*.test.ts",
      "cells/browser/browserd/src/**/*.test.ts",
      "cells/brain/src/**/*.test.ts",
      "apps/*/scripts/**/*.test.mjs",
      "cells/*/scripts/**/*.test.mjs",
      "scripts/**/*.test.mjs",
    ],
    exclude: [
      "**/node_modules/**",
      "**/*.docker.test.ts",
      "**/*.keyd.test.ts",
      "**/*.codex.test.ts",
    ],
  },
});
