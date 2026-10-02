import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { clipText, type ObserveResult, ulid, type WindowInfo } from "@localdot/protocol";
import type { XHelper } from "../x/helper.ts";
import type { CuaDriver } from "./driver.ts";
import { type HelperWindow, listWindows } from "./hit-test.ts";

const run = promisify(execFile);
const SHM = "/dev/shm";

export interface ObserveDeps {
  driver: Pick<CuaDriver, "desktopShot">;
  x: XHelper;
  encode?: (png: Buffer) => Promise<Buffer>;
}

// cwebp (Ubuntu's webp package) through tmpfs: the driver's PNG in, WebP q80 out.
export async function encodeWebp(png: Buffer, tmp = SHM): Promise<Buffer> {
  const id = ulid();
  const input = join(tmp, `localdot-${id}.png`);
  const output = join(tmp, `localdot-${id}.webp`);
  try {
    await writeFile(input, png, { mode: 0o600, flag: "wx" });
    await run("cwebp", ["-quiet", "-q", "80", input, "-o", output], { timeout: 2000 });
    return await readFile(output);
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}

export function windowInfo(w: HelperWindow): WindowInfo {
  return {
    id: w.id,
    pid: w.pid,
    cls: clipText(w.cls, 128),
    title: clipText(w.title, 256),
    rect: { x: w.x, y: w.y, w: w.w, h: w.h },
    frame: { x: w.frame[0], y: w.frame[1], w: w.frame[2], h: w.frame[3] },
    active: w.active,
  };
}

export async function observe(deps: ObserveDeps): Promise<ObserveResult> {
  const [png, pointer, windows] = await Promise.all([
    deps.driver.desktopShot(1280),
    deps.x.call<{ x: number; y: number }>("pointer"),
    listWindows(deps.x),
  ]);
  const webp = await (deps.encode ?? encodeWebp)(png);
  return {
    frameId: ulid(),
    width: 1280,
    height: 800,
    image: webp.toString("base64"),
    pointer: { x: pointer.x, y: pointer.y },
    windows: windows.map(windowInfo),
  };
}
