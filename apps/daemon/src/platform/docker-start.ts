import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** Only launch the local Desktop engine selected by this installation. Never switch engines,
 * change Docker settings, request privilege, or touch its disk. Called once per login/startup. */
export async function startDockerDesktop(
  socket: string,
  platform = process.platform,
  userHome = homedir(),
  execute = promisify(execFile),
): Promise<boolean> {
  if (
    platform !== "darwin" ||
    ![join(userHome, ".docker/run/docker.sock"), "/var/run/docker.sock"].includes(socket)
  )
    return false;
  try {
    await execute("/usr/bin/open", ["-g", "-a", "Docker"], { timeout: 10_000, maxBuffer: 4096 });
    return true;
  } catch {
    return false;
  }
}
