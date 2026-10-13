import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DesktopCapabilities, WORK_PROGRAMS } from "@localdot/protocol";

// Inspect executable metadata only. No process launch, shell startup, credentials, or network.
// PATH comes from the desktop service, never tool arguments. Profile-only additions are untested.
export async function desktopCapabilities(
  path: string | undefined,
  signal: AbortSignal,
): Promise<DesktopCapabilities> {
  signal.throwIfAborted();
  const all = [...new Set((path ?? "").split(":"))];
  const paths = all.filter((part) => isAbsolute(part) && part.length <= 1024).slice(0, 32);
  const incomplete = !path || paths.length !== all.length;
  const entries = await Promise.all(
    WORK_PROGRAMS.map(async (program) => {
      let uncertain = incomplete;
      for (const directory of paths) {
        signal.throwIfAborted();
        const file = join(directory, program);
        try {
          const info = await stat(file);
          if (!info.isFile() || (info.mode & 0o111) === 0) continue;
          await access(file, constants.X_OK);
          return [program, "available"];
        } catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
            uncertain = true;
        }
      }
      return [program, uncertain ? "unknown" : "not_on_path"];
    }),
  );
  signal.throwIfAborted();
  return DesktopCapabilities.parse({
    version: 1,
    search: "service_path",
    programs: Object.fromEntries(entries),
  });
}
