import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

declare const __LOCALDOT_PACKAGED__: boolean | undefined;
export const ProcessIdentity = z.strictObject({
  pid: z.number().int().min(2).max(2147483647),
  start: z.string().regex(/^[0-9:]{1,64}$/),
});
export type ProcessIdentity = z.infer<typeof ProcessIdentity>;
export type ProcessState = "alive" | "exited" | "unknown";
export interface NativeProcessProbe {
  identity(pid: number): ProcessIdentity | undefined;
  status(identity: ProcessIdentity): ProcessState;
}
function ask(args: string[]): unknown {
  const packaged = typeof __LOCALDOT_PACKAGED__ === "boolean" && __LOCALDOT_PACKAGED__;
  const paths = packaged ? ["../keyd", "../../keyd/bin/keyd"] : ["../../../../../keyd/bin/keyd"];
  for (const relative of paths) {
    try {
      const path = fileURLToPath(new URL(relative, import.meta.url)),
        st = lstatSync(path);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.nlink !== 1 ||
        st.mode & 0o022 ||
        (st.uid !== 0 && st.uid !== process.getuid?.()) ||
        realpathSync(path) !== path
      )
        continue;
      return JSON.parse(
        execFileSync(path, ["native-process", ...args], {
          encoding: "utf8",
          env: {},
          timeout: 2000,
          maxBuffer: 256,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      /* Missing, old or unreadable helpers cannot prove retirement. */
    }
  }
}
export const nativeProcessProbe: NativeProcessProbe = {
  identity(pid) {
    if (!Number.isSafeInteger(pid) || pid < 2) return;
    const r = z
      .strictObject({ state: z.literal("owned"), start: ProcessIdentity.shape.start })
      .safeParse(ask(["identity", String(pid)]));
    return r.success ? { pid, start: r.data.start } : undefined;
  },
  status(identity) {
    const checked = ProcessIdentity.safeParse(identity);
    if (!checked.success) return "unknown";
    const r = z
      .strictObject({ state: z.enum(["alive", "exited", "unknown"]) })
      .safeParse(ask(["status", String(checked.data.pid), checked.data.start]));
    return r.success ? r.data.state : "unknown";
  },
};
