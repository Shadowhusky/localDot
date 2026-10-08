import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Build this checkout's helper without downloading modules, signing, or executing a service.
 * Tests must have the repository's Go dependencies cached. No developer-specific artifact path.
 */
export async function buildTestKeyd() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "localdot-keyd-fixture-")));
  const path = join(directory, "keyd");
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await promisify(execFile)("go", ["build", "-o", path, "./cmd/keyd"], {
      cwd: fileURLToPath(new URL("../../../../../keyd", import.meta.url)),
      env: {
        ...process.env,
        GOPROXY: "off",
        GOSUMDB: "off",
        GOTOOLCHAIN: "local",
        GOCACHE: process.env.GOCACHE ?? join(directory, "go-cache"),
      },
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    return { path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
