import { type ChildProcess, spawn } from "node:child_process";
import type { LaunchApp, LaunchRequest } from "@localdot/protocol";

export const LAUNCHERS: Record<LaunchApp, string[]> = {
  chromium: ["/usr/local/bin/localdot-chromium"],
  calc: ["libreoffice", "--calc", "--norestore"],
  writer: ["libreoffice", "--writer", "--norestore"],
  impress: ["libreoffice", "--impress", "--norestore"],
  terminal: ["xfce4-terminal"],
  thunar: ["thunar"],
  mousepad: ["mousepad"],
  codium: ["codium"],
  gimp: ["gimp"],
};

// Launch arguments are the few flags the puppet needs and files the desktop already holds (never
// a flag that re-points Chromium's DevTools, proxy or profile, nor a `..` that leaves those
// folders); the agent's own commands come through the shell tool (M4), never through launch.
const ARGUMENT =
  /^(--kiosk|--new-window|--incognito|about:blank|file:\/\/\/(opt\/localdot|config)\/[^\s]*|\/(opt\/localdot|config)\/[^\s]*)$/;
const PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;

type SpawnLike = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => Pick<ChildProcess, "pid" | "unref" | "once">;

export function launchApp(
  req: LaunchRequest,
  env: NodeJS.ProcessEnv = process.env,
  spawnImpl: SpawnLike = spawn as unknown as SpawnLike,
): { pid: number } {
  for (const a of req.args) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(a);
    } catch {
      throw new RangeError("invalid launch argument encoding");
    }
    if (
      !ARGUMENT.test(a) ||
      PARENT_SEGMENT.test(decoded) ||
      [...decoded].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === "\\")
    )
      throw new RangeError(`launch argument not allowed: ${JSON.stringify(a)}`);
  }
  const [cmd, ...base] = LAUNCHERS[req.app];
  const child = spawnImpl(cmd as string, [...base, ...req.args], {
    detached: true,
    stdio: "ignore",
    env,
  });
  // A failed spawn emits an asynchronous error as well as leaving pid unset.
  child.once("error", () => {});
  child.unref();
  if (!child.pid) throw new Error(`could not launch ${req.app}`);
  return { pid: child.pid };
}
