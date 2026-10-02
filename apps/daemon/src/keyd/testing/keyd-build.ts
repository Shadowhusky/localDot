import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Vitest's global setup for the suites that run the real keyd: built once per run into a
// temporary folder that the teardown removes; the suites find it through LOCALDOT_KEYD_BIN.
let dir: string | undefined;

export function setup(): void {
  const wanted =
    process.env.LOCALDOT_KEYD_TESTS === "1" || process.env.LOCALDOT_DOCKER_TESTS === "1";
  if (!wanted || process.env.LOCALDOT_KEYD_BIN) return;
  dir = mkdtempSync(join(tmpdir(), "localdot-keyd-bin-"));
  const bin = join(dir, "keyd");
  try {
    execFileSync(process.env.GO ?? "go", ["build", "-o", bin, "./cmd/keyd"], {
      cwd: fileURLToPath(new URL("../../../../../keyd/", import.meta.url)),
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (error) {
    teardown();
    throw error;
  }
  process.env.LOCALDOT_KEYD_BIN = bin;
}

export function teardown(): void {
  if (!dir) return;
  if (process.env.LOCALDOT_KEYD_BIN === join(dir, "keyd")) delete process.env.LOCALDOT_KEYD_BIN;
  rmSync(dir, { recursive: true, force: true });
  dir = undefined;
}
