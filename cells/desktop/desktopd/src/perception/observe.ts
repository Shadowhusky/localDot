import { spawn } from "node:child_process";
import { clipText, type ObserveResult, ulid, type WindowInfo } from "@localdot/protocol";
import type { XHelper } from "../x/helper.ts";
import { MODEL_SCREEN, modelPixels, type Screenshots } from "./capture.ts";
import type { CuaDriver } from "./driver.ts";
import { type HelperWindow, listWindows } from "./hit-test.ts";

export interface ObserveDeps {
  driver: Pick<CuaDriver, "desktopShot">;
  x: XHelper;
  screenshots?: Screenshots;
  encode?: (image: Buffer) => Promise<Buffer>;
}

export function ppm(rgb: Buffer, width: number, height: number): Buffer {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"), rgb]);
}

// cwebp (Ubuntu's webp package), lossless, so the model's frames keep small text exact: a PNG or
// a binary PPM on stdin, the WebP on stdout.
export function encodeWebp(image: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cwebp",
      ["-quiet", "-lossless", "-z", "0", "-metadata", "none", "-o", "-", "--", "-"],
      { stdio: ["pipe", "pipe", "ignore"], timeout: 2000 },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(chunks);
      if (
        code === 0 &&
        out.toString("latin1", 0, 4) === "RIFF" &&
        out.toString("latin1", 8, 12) === "WEBP"
      )
        resolve(out);
      else reject(new Error(`cwebp failed (${code})`));
    });
    // cwebp can exit before reading everything; its exit status is the error that counts.
    child.stdin.on("error", () => {});
    child.stdin.end(image);
  });
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

// The X helper's capture of the root; the driver's screenshot only when that fails.
async function screenImage(deps: ObserveDeps): Promise<Buffer> {
  const encode = deps.encode ?? encodeWebp;
  if (deps.screenshots) {
    try {
      const capture = await deps.screenshots.capture(deps.x);
      const rgb = modelPixels(capture);
      return await encode(ppm(rgb, MODEL_SCREEN.width, MODEL_SCREEN.height));
    } catch (err) {
      console.error(
        `desktopd: root capture failed, using the driver: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return encode(await deps.driver.desktopShot(MODEL_SCREEN.width));
}

export async function observe(deps: ObserveDeps): Promise<ObserveResult> {
  const [image, pointer, windows] = await Promise.all([
    screenImage(deps),
    deps.x.call<{ x: number; y: number }>("pointer"),
    listWindows(deps.x),
  ]);
  return {
    frameId: ulid(),
    width: MODEL_SCREEN.width,
    height: MODEL_SCREEN.height,
    image: image.toString("base64"),
    pointer: { x: pointer.x, y: pointer.y },
    windows: windows.map(windowInfo),
  };
}
