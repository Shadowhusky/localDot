import { describe, expect, it } from "vitest";
import { observe } from "./observe.ts";

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
