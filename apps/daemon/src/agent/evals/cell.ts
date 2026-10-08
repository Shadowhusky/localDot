import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DESKTOP_LIMITS } from "../../cells/spec.ts";

const DESKTOP_USER = "abc";
const DESKTOP_HOME = "/config";
const SESSION_ENV = [
  "DISPLAY=:1",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus",
  `HOME=${DESKTOP_HOME}`,
];

export interface EvalCellOptions {
  image: string;
  // Every container the suite creates carries this label; cleanup filters on it and nothing else.
  label: string;
  namePrefix: string;
  scale: 1 | 2;
  desktopdPort: number;
}

export interface EvalCell {
  id: string;
  name: string;
  scale: 1 | 2;
  baseUrl: string;
  token: string;
  home: string;
  exec(args: string[], input?: Buffer | string): { status: number; out: string };
  launch(args: string[]): void;
  write(path: string, content: Buffer | string): void;
  read(path: string): Buffer | undefined;
}

export function evalCellOptions(env: NodeJS.ProcessEnv = process.env): EvalCellOptions {
  const namePrefix = env.LOCALDOT_EVAL_NAME_PREFIX || "ldtest-eval-";
  const label = env.LOCALDOT_EVAL_LABEL || "dev.localdot.test=eval";
  // The live computer's containers are localdot-*; the suite never creates or removes one.
  if (!/^[a-z0-9][a-z0-9-]*-$/.test(namePrefix) || namePrefix.startsWith("localdot"))
    throw new Error("LOCALDOT_EVAL_NAME_PREFIX must be a lower-case prefix outside localdot-*");
  if (!/^[a-z0-9.-]+=[a-z0-9.-]+$/.test(label))
    throw new Error("LOCALDOT_EVAL_LABEL must be key=value");
  const port = Number(env.LOCALDOT_EVAL_DESKTOPD_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("LOCALDOT_EVAL_DESKTOPD_PORT must be a port number");
  return {
    image: env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev",
    label,
    namePrefix,
    scale: env.LOCALDOT_EVAL_SCALE === "1" ? 1 : 2,
    desktopdPort: port,
  };
}

function docker(args: string[], input?: Buffer | string): { status: number; out: string } {
  const r = spawnSync("docker", args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return {
    status: r.status ?? -1,
    out: `${r.stdout?.toString("utf8") ?? ""}${r.stderr?.toString("utf8") ?? ""}`,
  };
}

export function labelledContainers(label: string): string[] {
  return execFileSync("docker", ["ps", "-aq", "--filter", `label=${label}`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

// -v removes the anonymous /config volume with its container.
export function removeLabelled(label: string, id?: string): void {
  for (const found of labelledContainers(label))
    if (!id || id.startsWith(found) || found.startsWith(id)) docker(["rm", "-fv", found]);
}

async function healthy(baseUrl: string, token: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok && ((await res.json()) as { ok?: boolean }).ok === true) return;
    } catch {
      /* desktopd is still starting */
    }
    await sleep(1000);
  }
  throw new Error("the desktop did not become ready");
}

// A standalone desktop on the default bridge, shaped like a production cell (user, scale, limits,
// the browser-profile tmpfs) but with no gate, keyd or home volume of the live computer.
export async function startEvalCell(word: string, o: EvalCellOptions): Promise<EvalCell> {
  if (!/^[a-z0-9-]{1,32}$/.test(word)) throw new Error("invalid cell name");
  const name = `${o.namePrefix}${word}`;
  const token = randomBytes(32).toString("base64url");
  const [w, h] = o.scale === 2 ? [2560, 1600] : [1280, 800];
  const run = docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    o.label,
    "--shm-size",
    String(DESKTOP_LIMITS.shmBytes),
    "--memory",
    String(DESKTOP_LIMITS.memoryBytes),
    "--memory-swap",
    String(DESKTOP_LIMITS.memoryBytes),
    "--cpus",
    String(DESKTOP_LIMITS.nanoCpus / 1e9),
    "--pids-limit",
    String(DESKTOP_LIMITS.pids),
    "--cap-drop",
    "NET_RAW",
    "--tmpfs",
    "/run/localdot-desktop-browser:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=0700",
    "--mount",
    `type=volume,dst=${DESKTOP_HOME},volume-label=${o.label}`,
    "-p",
    `127.0.0.1:${o.desktopdPort || ""}:7700`,
    "-e",
    "PUID=1000",
    "-e",
    "PGID=1000",
    "-e",
    "TZ=Etc/UTC",
    "-e",
    `PASSWORD=${randomBytes(32).toString("base64url")}`,
    "-e",
    `LOCALDOT_DESKTOPD_TOKEN=${token}`,
    "-e",
    `LOCALDOT_SCALE=${o.scale}`,
    "-e",
    `SELKIES_MANUAL_WIDTH=${w}`,
    "-e",
    `SELKIES_MANUAL_HEIGHT=${h}`,
    o.image,
  ]);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.out.trim()}`);
  const id = run.out.trim().split("\n").at(-1) ?? "";
  try {
    const port = Number(docker(["port", id, "7700"]).out.split("\n")[0]?.split(":").at(-1));
    if (!Number.isInteger(port) || port <= 0) throw new Error("desktopd is not published");
    const baseUrl = `http://127.0.0.1:${port}`;
    await healthy(baseUrl, token, Date.now() + 180_000);
    const exec = (args: string[], input?: Buffer | string) =>
      docker(
        [
          "exec",
          ...(input === undefined ? [] : ["-i"]),
          "-u",
          DESKTOP_USER,
          ...SESSION_ENV.flatMap((e) => ["-e", e]),
          id,
          ...args,
        ],
        input,
      );
    return {
      id,
      name,
      scale: o.scale,
      baseUrl,
      token,
      home: DESKTOP_HOME,
      exec,
      launch: (args) => {
        const r = docker([
          "exec",
          "-d",
          "-u",
          DESKTOP_USER,
          ...SESSION_ENV.flatMap((e) => ["-e", e]),
          id,
          ...args,
        ]);
        if (r.status !== 0) throw new Error(`launch ${args[0]} failed: ${r.out.trim()}`);
      },
      write: (path, content) => {
        const r = exec(
          ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
          content,
        );
        if (r.status !== 0) throw new Error(`write ${path} failed: ${r.out.trim()}`);
      },
      read: (path) => {
        const r = spawnSync("docker", ["exec", "-u", DESKTOP_USER, id, "cat", path], {
          maxBuffer: 64 * 1024 * 1024,
        });
        return r.status === 0 ? r.stdout : undefined;
      },
    };
  } catch (error) {
    removeLabelled(o.label, id);
    throw error;
  }
}

export interface WindowGeometry {
  id: number;
  cls: string;
  title: string;
  rect: { x: number; y: number; w: number; h: number };
}

// The desktop's own window list (device pixels), as desktopd's observe reports it.
export async function desktopWindows(cell: EvalCell): Promise<WindowGeometry[]> {
  const res = await fetch(`${cell.baseUrl}/observe`, {
    method: "POST",
    headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`observe failed: ${res.status}`);
  return ((await res.json()) as { windows: WindowGeometry[] }).windows;
}

export async function waitForWindow(
  cell: EvalCell,
  match: (w: WindowGeometry) => boolean,
  timeoutMs: number,
): Promise<WindowGeometry> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = (await desktopWindows(cell)).find(match);
      if (found) return found;
    } catch {
      /* observe can time out while a large app starts */
    }
    await sleep(1000);
  }
  throw new Error("the expected window did not appear");
}
