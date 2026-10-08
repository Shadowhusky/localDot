import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

declare const __LOCALDOT_PACKAGED__: boolean | undefined;

/** The installer authenticates the entire release before service startup. Its helper is a
 * fixed sibling of app/dist/daemon.mjs; never search PATH or accept an environment override.
 * Development fixtures keep their existing process backend until a helper is packaged.
 * A packaged app MUST refuse a missing/changed layout rather than fall back to an unowned task.
 */
export function resolveNativeSupervisor(moduleUrl: string, packaged: boolean): string | undefined {
  if (!packaged) return undefined;
  try {
    const path = fileURLToPath(new URL("../../keyd/bin/keyd", moduleUrl));
    const st = lstatSync(path);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.size < 1 ||
      (st.uid !== 0 && st.uid !== process.getuid?.()) ||
      (st.mode & 0o022) !== 0 ||
      realpathSync(path) !== path
    )
      throw new Error();
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    throw new Error("The installed native supervisor could not be verified.");
  }
}

export function nativeSupervisor(): string | undefined {
  return resolveNativeSupervisor(
    import.meta.url,
    typeof __LOCALDOT_PACKAGED__ === "boolean" && __LOCALDOT_PACKAGED__,
  );
}
