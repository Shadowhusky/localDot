import { defineConfig } from "vitest/config";

// No `esbuild` block: Vite 8 (under Vitest 5) deprecates it in favour of oxc, and its default JSX
// runtime is already automatic.
export default defineConfig({
  // apps/web resolves its @/ alias from its tsconfig.
  resolve: { tsconfigPaths: true },
  test: {
    // GitHub's macOS runners are several times slower than a development Mac, so a whole-app test
    // that takes 2 s here can pass 5 s there; CI gets room, local runs keep the tight limits.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
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
      "scripts/distribution/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/*.docker.test.ts",
      "**/*.keyd.test.ts",
      "**/*.codex.test.ts",
      "**/*.eval.test.ts",
      // The website's tests run under its own config: pnpm --dir apps/site test.
      "apps/site/**",
    ],
  },
});
