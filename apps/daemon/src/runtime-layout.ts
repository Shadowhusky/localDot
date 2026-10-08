import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __LOCALDOT_PACKAGED__: boolean | undefined;

/** Fixed build layout, never a working-directory or environment-based asset search. */
export function resolveRuntimeLayout(moduleUrl: string, packaged: boolean) {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const root = packaged ? join(moduleDir, "..") : join(moduleDir, "..", "..", "..");
  return Object.freeze({
    web: join(root, ...(packaged ? ["web"] : ["apps", "web"])),
    skills: join(root, "skills"),
    browserSeccomp: join(moduleDir, ...(packaged ? [] : ["cells"]), "browser-seccomp.json"),
  });
}

export const runtimeLayout = resolveRuntimeLayout(
  import.meta.url,
  typeof __LOCALDOT_PACKAGED__ === "boolean" && __LOCALDOT_PACKAGED__,
);
