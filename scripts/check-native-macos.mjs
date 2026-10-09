import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Native acceptance requires an Apple Silicon Mac");
}
if (Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error("Native acceptance requires Node 24 or newer");
}

// The native fixtures use synthetic data. A caller's opt-in variables must not turn this
// routine CI command into a live login-Keychain, signed-identity or cleanup test.
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("KEYD_") || name === "LOCALDOT_NATIVE_SUPERVISOR_TEST_BIN") {
    delete env[name];
  }
}

function run(command, args, cwd = root, capture = false) {
  console.log(`Native check: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed (${result.error?.message ?? result.signal ?? result.status})`,
    );
  }
  return result.stdout;
}

const keyd = join(root, "keyd");
const go = JSON.parse(run("go", ["env", "-json", "GOOS", "GOARCH", "CGO_ENABLED"], keyd, true));
if (go.GOOS !== "darwin" || go.GOARCH !== "arm64" || go.CGO_ENABLED !== "1") {
  throw new Error("Native acceptance requires darwin/arm64 with CGO_ENABLED=1");
}

const temp = realpathSync(mkdtempSync(join(tmpdir(), "localdot-native-check-")));
try {
  run("go", ["vet", "./..."], keyd);
  run("go", ["test", "-race", "-count=1", "-timeout=120s", "./..."], keyd);
  const binary = join(temp, "keyd-native");
  run("go", ["build", "-trimpath", "-o", binary, "./cmd/keyd-native"], keyd);
  env.LOCALDOT_NATIVE_SUPERVISOR_TEST_BIN = binary;
  const report = join(temp, "vitest.json");
  run(process.execPath, [
    join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.native.config.ts",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${report}`,
  ]);
  const result = JSON.parse(readFileSync(report, "utf8"));
  if (
    result.success !== true ||
    !(result.numTotalTests > 0) ||
    result.numPassedTests !== result.numTotalTests ||
    result.numPendingTests !== 0 ||
    result.numTodoTests !== 0
  ) {
    throw new Error("Native acceptance must pass every selected test without skips");
  }
  console.log(
    `Native macOS acceptance passed: ${result.numPassedTests} Node tests and Go race suite`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
