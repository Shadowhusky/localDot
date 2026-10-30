import { describe, expect, it, vi } from "vitest";
import { screenWindows } from "./windows.ts";
import type { XHelper } from "./x/helper.ts";

const window = (id: number, pid: number, active = false) => ({
  id,
  pid,
  cls: "app",
  title: "",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  frame: [0, 0, 10, 10],
  active,
  overrideRedirect: false,
  transientFor: null,
});

describe("screen windows", () => {
  it("names each window's program session and start, and raises a window asked for first", async () => {
    const calls: string[] = [];
    const x = {
      call: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}${args?.window ? ` ${args.window}` : ""}`);
        return cmd === "windows"
          ? { windows: [window(2, 42, true), window(3, 0)], generation: 1 }
          : {};
      }),
    } as unknown as XHelper;
    const read = vi.fn(async (path: string) => {
      if (path === "/proc/uptime") return "1234.56 999.00\n";
      if (path === "/proc/42/stat")
        return "42 (my (odd) app) S 1 42 40 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 98765 0 0";
      throw new Error("gone");
    });
    const result = await screenWindows({ x, read }, { activate: 2 });
    expect(calls).toEqual(["activate 2", "windows"]);
    expect(result).toEqual({
      ticks: 123456,
      windows: [
        {
          id: 2,
          pid: 42,
          sid: 40,
          started: 98765,
          frame: { x: 0, y: 0, w: 10, h: 10 },
          active: true,
          transientFor: null,
        },
        { id: 3, pid: 0, frame: { x: 0, y: 0, w: 10, h: 10 }, active: false, transientFor: null },
      ],
    });
  });
});
