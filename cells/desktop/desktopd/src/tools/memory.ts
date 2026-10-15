import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DesktopMemory } from "@localdot/protocol";

const ROOT = "/sys/fs/cgroup/";
const files = [
  "memory.current",
  "memory.max",
  "memory.stat",
  "memory.events",
  "memory.swap.current",
  "memory.swap.max",
]
  .map((name) => ROOT + name)
  .concat(["/proc/meminfo", "/proc/pressure/memory"]);
// Container-scoped cgroup v2 counters, not /proc/meminfo (which describes the whole VM).
// Optional VM evidence is kept separate: a healthy container can sit inside a stalled VM.
// No shell, environment, process arguments, page content, or credentials are inspected.
export async function desktopMemory(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<DesktopMemory | undefined> {
  return parseMemory(await Promise.all(files.map((name) => read(name).catch(() => undefined))));
}
// Shell startup must install its cancellation/exit handlers synchronously. These tiny kernel
// counter files are read without an async gap, so immediate Stop retains a confirmed result.
export function desktopMemoryNow(): DesktopMemory | undefined {
  return parseMemory(
    files.map((name) => {
      try {
        return readFileSync(name, "utf8");
      } catch {
        return undefined;
      }
    }),
  );
}
function parseMemory(values: (string | undefined)[]): DesktopMemory | undefined {
  const number = (v: string | undefined) => {
    if (!v || v.length > 64 || !/^\d+\s*$/u.test(v)) return undefined;
    const n = Number(v.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const counter = (s: string | undefined, key: string) => {
    if (!s || s.length > 65536) return undefined;
    return number(
      s
        .split("\n")
        .find((l) => l.startsWith(key + " "))
        ?.slice(key.length + 1),
    );
  };
  const currentBytes = number(values[0]),
    limitBytes = number(values[1]);
  const inactive = counter(values[2], "inactive_file"),
    oomKills = counter(values[3], "oom_kill");
  if (currentBytes === undefined || !limitBytes || inactive === undefined || oomKills === undefined)
    return undefined; // Unsupported or unreadable is unknown, never zero usage/zero OOMs.
  const workingSetBytes = Math.max(0, currentBytes - inactive);
  const ratio = workingSetBytes / limitBytes;
  const vm = machineMemory(values[6], values[7]);
  return DesktopMemory.parse({
    ...(vm ? { vm } : {}),
    currentBytes,
    workingSetBytes,
    limitBytes,
    oomKills,
    swapBytes: number(values[4]),
    swapLimitBytes: number(values[5]),
    pressure: ratio >= 0.9 ? "critical" : ratio >= 0.8 ? "high" : "normal",
  });
}

function machineMemory(info: string | undefined, psi: string | undefined): DesktopMemory["vm"] {
  if (!info || info.length > 65536) return undefined;
  const field = (name: string) => {
    const match = info.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m"));
    const bytes = match ? Number(match[1]) * 1024 : Number.NaN;
    return Number.isSafeInteger(bytes) ? bytes : undefined;
  };
  const totalBytes = field("MemTotal"),
    availableBytes = field("MemAvailable");
  if (!totalBytes || availableBytes === undefined || availableBytes > totalBytes) return undefined;
  const match = psi && psi.length < 4096 ? psi.match(/^full avg10=(\d+(?:\.\d+)?) /m) : undefined;
  const stall = match ? Number(match[1]) : undefined;
  const stallPercent10s = stall !== undefined && stall >= 0 && stall <= 100 ? stall : undefined;
  const fraction = availableBytes / totalBytes;
  return {
    totalBytes,
    availableBytes,
    ...(stallPercent10s !== undefined ? { stallPercent10s } : {}),
    pressure:
      fraction < 0.03 || (stallPercent10s ?? 0) >= 20
        ? "critical"
        : fraction < 0.1 || (stallPercent10s ?? 0) >= 5
          ? "high"
          : "normal",
  };
}
