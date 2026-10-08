import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./apps/cli/scripts/build-options.mjs";

// These suites normally skip on other platforms. This entry point must never report that as
// native acceptance. The wrapper builds the candidate helper before starting this process.
const helper = process.env.LOCALDOT_NATIVE_SUPERVISOR_TEST_BIN;
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Native acceptance requires an Apple Silicon Mac");
}
if (!helper || !isAbsolute(helper) || !statSync(helper).isFile()) {
  throw new Error("Native acceptance requires a built helper; run pnpm test:native-macos");
}
accessSync(helper, constants.X_OK);
process.env.LOCALDOT_NATIVE_SUPERVISOR_TEST_BIN = realpathSync(helper);

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: {
    fileParallelism: false,
    include: [
      "harness/codex/src/native-recovery-live.test.ts",
      "harness/codex/src/supervised-process.test.ts",
      "harness/codex/src/launch.test.ts",
      "harness/codex/src/retirement-record.test.ts",
      "apps/cli/src/install/native-recovery.test.ts",
      "apps/cli/src/install/service-retirement.test.ts",
      "apps/cli/src/install/install-lock-transport.test.ts",
    ],
  },
});
