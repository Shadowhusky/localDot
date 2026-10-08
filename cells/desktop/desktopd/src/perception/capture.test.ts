import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startXHelper, type XHelper } from "../x/helper.ts";
import { captureFile, modelPixels, type RootCapture, Screenshots } from "./capture.ts";

const FAKE = fileURLToPath(new URL("../x/testing/fake-xhelper.mjs", import.meta.url));
const helpers: XHelper[] = [];
afterEach(async () => {
  for (const h of helpers.splice(0)) await h.close();
});

async function fake(root = "2560x1600"): Promise<XHelper> {
  const h = await startXHelper({ command: process.execPath, args: [FAKE, "", `--root=${root}`] });
  helpers.push(h);
  return h;
}

// The fake helper's pattern for capture n, as [R, G, B].
const pattern = (x: number, y: number, n: number) => [(x + y + n) % 256, y % 241, x % 251];

const rgbAt = (rgb: Buffer, width: number, x: number, y: number) => [
  ...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3),
];

describe("Screenshots", () => {
  it("reads the helper's device-resolution root and averages each 2×2 block for the model", async () => {
    const shots = new Screenshots(join(mkdtempSync(join(tmpdir(), "localdot-capture-")), "r.raw"));
    const capture = await shots.capture(await fake());
    expect(capture).toMatchObject({ width: 2560, height: 1600, stride: 10240 });
    const rgb = modelPixels(capture);
    expect(rgb.length).toBe(1280 * 800 * 3);
    for (const [x, y] of [
      [0, 0],
      [125, 120],
      [640, 400],
      [1279, 799],
    ] as const) {
      const block = [
        pattern(2 * x, 2 * y, 1),
        pattern(2 * x + 1, 2 * y, 1),
        pattern(2 * x, 2 * y + 1, 1),
        pattern(2 * x + 1, 2 * y + 1, 1),
      ];
      const mean = [0, 1, 2].map(
        (ch) => (block.reduce((sum, p) => sum + (p[ch] as number), 0) + 2) >> 2,
      );
      expect(rgbAt(rgb, 1280, x, y)).toEqual(mean);
    }
  });

  it("converts a 1× root without scaling", async () => {
    const shots = new Screenshots(join(mkdtempSync(join(tmpdir(), "localdot-capture-")), "r.raw"));
    const rgb = modelPixels(await shots.capture(await fake("1280x800")));
    expect(rgbAt(rgb, 1280, 300, 200)).toEqual(pattern(300, 200, 1));
  });

  it("refuses a root that is not the model screen at 1× or 2×", () => {
    const odd: RootCapture = {
      pixels: Buffer.alloc(1920 * 1080 * 4),
      width: 1920,
      height: 1080,
      stride: 1920 * 4,
      mono: 1,
    };
    expect(() => modelPixels(odd)).toThrow(RangeError);
  });

  it("takes captures one at a time, so each reads its own frame from the shared file", async () => {
    const shots = new Screenshots(join(mkdtempSync(join(tmpdir(), "localdot-capture-")), "r.raw"));
    let n = 0;
    // The first capture answers late: a second one that overtook it would overwrite its frame.
    const x = {
      call: async (_cmd: string, args: { path: string }) => {
        n += 1;
        writeFileSync(args.path, Buffer.alloc(1280 * 800 * 4, n));
        if (n === 1) await new Promise((r) => setTimeout(r, 30));
        return { width: 1280, height: 800, stride: 5120, mono: n };
      },
    } as unknown as XHelper;
    const [a, b] = await Promise.all([shots.capture(x), shots.capture(x)]);
    expect([a.pixels[0], b.pixels[0]]).toEqual([1, 2]);
  });
});

describe("captureFile", () => {
  it("keeps one private folder per user and reuses it", () => {
    const base = mkdtempSync(join(tmpdir(), "localdot-shm-"));
    const uid = userInfo().uid;
    const first = captureFile(uid, base);
    expect(first).toBe(join(base, `localdot-desktopd-${uid}`, "root.raw"));
    expect(statSync(join(base, `localdot-desktopd-${uid}`)).mode & 0o777).toBe(0o700);
    expect(captureFile(uid, base)).toBe(first);
  });

  it("uses a fresh private folder when the usual one is open to others", () => {
    const base = mkdtempSync(join(tmpdir(), "localdot-shm-"));
    const uid = userInfo().uid;
    mkdirSync(join(base, `localdot-desktopd-${uid}`));
    chmodSync(join(base, `localdot-desktopd-${uid}`), 0o777);
    const file = captureFile(uid, base);
    expect(file.startsWith(join(base, `localdot-desktopd-${uid}`, ""))).toBe(false);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
  });
});
