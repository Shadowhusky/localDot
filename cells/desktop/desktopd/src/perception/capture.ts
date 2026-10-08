import { existsSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { XHelper } from "../x/helper.ts";

export const MODEL_SCREEN = { width: 1280, height: 800 } as const;

// The root at device resolution, as the helper wrote it: BGRX rows `stride` bytes apart.
export interface RootCapture {
  pixels: Buffer;
  width: number;
  height: number;
  stride: number;
  mono: number;
}

function factorOf(c: RootCapture): 1 | 2 {
  const f = c.width / MODEL_SCREEN.width;
  if ((f !== 1 && f !== 2) || c.height !== MODEL_SCREEN.height * f)
    throw new RangeError(`capture: a ${c.width}x${c.height} screen is not a model screen`);
  return f;
}

// One channel of two horizontally adjacent BGRX pixels in two rows.
const mean4 = (p: Buffer, a: number, b: number): number =>
  ((p[a] as number) + (p[a + 4] as number) + (p[b] as number) + (p[b + 4] as number) + 2) >> 2;

// The model's 1280×800 RGB frame: at 2× each pixel is its 2×2 block's mean, which is what the
// screen would show at 1×.
export function modelPixels(c: RootCapture): Buffer {
  const f = factorOf(c);
  const p = c.pixels;
  const out = Buffer.allocUnsafe(MODEL_SCREEN.width * MODEL_SCREEN.height * 3);
  let o = 0;
  for (let y = 0; y < MODEL_SCREEN.height; y++) {
    let a = f * y * c.stride;
    if (f === 1) {
      for (let x = 0; x < MODEL_SCREEN.width; x++, a += 4) {
        out[o++] = p[a + 2] as number;
        out[o++] = p[a + 1] as number;
        out[o++] = p[a] as number;
      }
      continue;
    }
    let b = a + c.stride;
    for (let x = 0; x < MODEL_SCREEN.width; x++, a += 8, b += 8) {
      out[o++] = mean4(p, a + 2, b + 2);
      out[o++] = mean4(p, a + 1, b + 1);
      out[o++] = mean4(p, a, b);
    }
  }
  return out;
}

// The tmpfs file the helper rewrites with each capture (16 MB at 2×). One fixed path per user, so
// a restarted desktopd reuses it instead of leaving another behind.
export function captureFile(
  uid: number,
  base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir(),
): string {
  const dir = join(base, `localdot-desktopd-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const ours = st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0;
  return join(ours ? dir : mkdtempSync(join(base, "localdot-desktopd-")), "root.raw");
}

// Root captures through the X helper.
export class Screenshots {
  #turn: Promise<unknown> = Promise.resolve();

  // `file` is a tmpfs path only this desktopd uses; the helper rewrites it in place.
  constructor(private readonly file: string) {}

  // Every capture rewrites the one file, so captures take turns.
  capture(x: XHelper): Promise<RootCapture> {
    const run = this.#turn.then(async () => {
      const { width, height, stride, mono } = await x.call<{
        width: number;
        height: number;
        stride: number;
        mono: number;
      }>("capture", { path: this.file });
      const pixels = await readFile(this.file);
      if (pixels.length < stride * height) throw new Error("capture: the frame file is short");
      return { pixels, width, height, stride, mono };
    });
    this.#turn = run.catch(() => {});
    return run;
  }
}
