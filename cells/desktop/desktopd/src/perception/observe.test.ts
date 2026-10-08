import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Screenshots } from "./capture.ts";
import { observe } from "./observe.ts";

// A helper whose 2× root is one grey level, with the pointer and no windows.
function rootHelper(grey: number, fail = false) {
  const calls: string[] = [];
  return {
    calls,
    x: {
      call: async (cmd: string, args: { path?: string } = {}) => {
        calls.push(cmd);
        if (cmd === "pointer") return { x: 10, y: 20 };
        if (cmd === "windows") return { windows: [] };
        if (cmd !== "capture" || !args.path) throw new Error(`unexpected ${cmd}`);
        if (fail) throw new Error("xhelper capture: BadMatch");
        writeFileSync(args.path, Buffer.alloc(2560 * 1600 * 4, grey));
        return { width: 2560, height: 1600, stride: 10240, mono: 5 };
      },
    } as never,
  };
}

describe("observe", () => {
  it("encodes the driver's PNG to WebP, and reports the pointer and the windows", async () => {
    const png = Buffer.from("png-bytes");
    const calls: string[] = [];
    const result = await observe({
      driver: { desktopShot: async () => png } as never,
      x: {
        call: async (cmd: string) =>
          cmd === "pointer"
            ? { x: 640, y: 400 }
            : {
                windows: [
                  {
                    id: 5,
                    pid: 50,
                    cls: "Thunar",
                    title: "Home",
                    x: 1,
                    y: 78,
                    w: 100,
                    h: 50,
                    frame: [0, 54, 102, 75],
                    active: true,
                  },
                ],
              },
      } as never,
      encode: async (input) => {
        calls.push(input.toString());
        return Buffer.from("RIFF....WEBP");
      },
    });
    expect(calls).toEqual(["png-bytes"]);
    expect(result).toMatchObject({ width: 1280, height: 800, pointer: { x: 640, y: 400 } });
    expect(Buffer.from(result.image, "base64").toString()).toBe("RIFF....WEBP");
    expect(result.windows[0]).toEqual({
      id: 5,
      pid: 50,
      cls: "Thunar",
      title: "Home",
      rect: { x: 1, y: 78, w: 100, h: 50 },
      frame: { x: 0, y: 54, w: 102, h: 75 },
      active: true,
    });
    expect(result.frameId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("observe from the root capture", () => {
  const shots = () => new Screenshots(join(mkdtempSync(join(tmpdir(), "localdot-obs-")), "r.raw"));

  it("encodes the helper's capture at model size, not the driver's screenshot, and keeps it", async () => {
    const { x } = rootHelper(77);
    const screenshots = shots();
    const inputs: Buffer[] = [];
    const result = await observe({
      driver: {
        desktopShot: async () => {
          throw new Error("the driver must not be asked");
        },
      },
      x,
      screenshots,
      encode: async (image) => {
        inputs.push(image);
        return Buffer.from("RIFF....WEBP");
      },
    });
    const header = Buffer.from("P6\n1280 800\n255\n");
    expect(inputs[0]?.subarray(0, header.length)).toEqual(header);
    expect(inputs[0]?.length).toBe(header.length + 1280 * 800 * 3);
    expect(inputs[0]?.[header.length + 1000]).toBe(77);
    expect(result).toMatchObject({ width: 1280, height: 800, pointer: { x: 10, y: 20 } });
    expect(screenshots.zoom(result.frameId, { x: 0, y: 0, w: 8, h: 8 })).toBeInstanceOf(Buffer);
  });

  it("falls back to the driver's screenshot when the capture fails", async () => {
    const { x } = rootHelper(0, true);
    const screenshots = shots();
    const inputs: string[] = [];
    const result = await observe({
      driver: { desktopShot: async () => Buffer.from("png-bytes") },
      x,
      screenshots,
      encode: async (image) => {
        inputs.push(image.toString());
        return Buffer.from("RIFF....WEBP");
      },
    });
    expect(inputs).toEqual(["png-bytes"]);
    expect(screenshots.zoom(result.frameId, { x: 0, y: 0, w: 8, h: 8 })).toBeUndefined();
  });
});
