import { spawnSync } from "node:child_process";
import {
  docker,
  dockerExecAs,
  publishedPort,
  removeAll,
  sleepSync,
  waitFor,
} from "./docker-cli.ts";

export const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
export const TEST_DESKTOPD_TOKEN = "d".repeat(43);
export const TEST_STREAM_PASSWORD = "p".repeat(43);

export interface DesktopContainer {
  name: string;
  scale: 1 | 2;
  stream: number;
  desktopd: number;
  token: string;
  baseUrl: string;
}

// A standalone desktop (default bridge, no gate) with desktopd and Selkies published on 127.0.0.1.
export function startDesktopContainer(
  name: string,
  scale: 1 | 2,
  extra: string[] = [],
): DesktopContainer {
  removeAll({ containers: [name] });
  const [w, h] = scale === 2 ? ["2560", "1600"] : ["1280", "800"];
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--shm-size=1g",
    "--cap-drop",
    "NET_RAW",
    "-p",
    "127.0.0.1:0:3000",
    "-p",
    "127.0.0.1:0:7700",
    "-e",
    `PASSWORD=${TEST_STREAM_PASSWORD}`,
    "-e",
    `LOCALDOT_DESKTOPD_TOKEN=${TEST_DESKTOPD_TOKEN}`,
    "-e",
    `LOCALDOT_SCALE=${scale}`,
    "-e",
    `SELKIES_MANUAL_WIDTH=${w}`,
    "-e",
    `SELKIES_MANUAL_HEIGHT=${h}`,
    ...extra,
    DESKTOP_IMAGE,
  );
  waitFor(
    "xfce4-panel",
    () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0,
    180_000,
  );
  sleepSync(5000);
  const desktopd = publishedPort(name, "7700");
  // desktopd answers 200 with ok:false while the session is still coming up (Part 2): wait for ok.
  const health = `curl -sf -H 'Authorization: Bearer ${TEST_DESKTOPD_TOKEN}' http://127.0.0.1:7700/healthz | grep -q '"ok":true'`;
  waitFor("desktopd", () => dockerExecAs(name, "abc", "sh", "-c", health).status === 0, 60_000);
  return {
    name,
    scale,
    stream: publishedPort(name, "3000"),
    desktopd,
    token: TEST_DESKTOPD_TOKEN,
    baseUrl: `http://127.0.0.1:${desktopd}`,
  };
}

export function execAsDesktopUser(name: string, ...cmd: string[]): { status: number; out: string } {
  return dockerExecAs(
    name,
    "abc",
    "env",
    "DISPLAY=:1",
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus",
    ...cmd,
  );
}

export function launchInDesktop(name: string, ...cmd: string[]): void {
  docker(
    "exec",
    "-d",
    "-u",
    "abc",
    "-e",
    "DISPLAY=:1",
    "-e",
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus",
    name,
    ...cmd,
  );
}

// xdotool search exits 1 when no window matches, which a poll expects; any other status is a
// failed probe. A window that closes between the two calls is skipped.
export function windowGeometry(
  name: string,
  className: string,
): { id: number; x: number; y: number; w: number; h: number } | undefined {
  const search = execAsDesktopUser(
    name,
    "xdotool",
    "search",
    "--onlyvisible",
    "--classname",
    className,
  );
  if (search.status === 1) return undefined;
  if (search.status !== 0)
    throw new Error(`xdotool search ${className} exited ${search.status}: ${search.out}`);
  for (const id of search.out.trim().split("\n").filter(Boolean)) {
    // xdotool adds the frame origin twice on this XFWM build for restored windows.
    const geometry = execAsDesktopUser(name, "xwininfo", "-id", id);
    if (geometry.status !== 0) continue;
    const out = geometry.out;
    const pick = (key: string) => Number(new RegExp(`${key}:\\s+(-?\\d+)`).exec(out)?.[1]);
    const g = {
      id: Number(id),
      x: pick("Absolute upper-left X"),
      y: pick("Absolute upper-left Y"),
      w: pick("Width"),
      h: pick("Height"),
    };
    if (g.w > 100 && g.h > 100) return g;
  }
  return undefined;
}

export function copyIntoDesktop(name: string, path: string, bytes: Buffer): void {
  const r = spawnSync("docker", ["exec", "-i", name, "tee", path], {
    input: bytes,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`copy into ${name}:${path} failed: ${String(r.stderr)}`);
}
