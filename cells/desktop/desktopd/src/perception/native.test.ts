import { describe, expect, it } from "vitest";
import { type XHelper, XHelperError, XHelperTimeoutError } from "../x/helper.ts";
import type { HelperWindow } from "./hit-test.ts";
import { AtspiAccessibility } from "./native.ts";

const dialog: HelperWindow = {
  id: 21,
  pid: 2193,
  cls: "Gimp",
  title: "Change Foreground Color",
  x: 2,
  y: 222,
  w: 1188,
  h: 734,
  frame: [0, 166, 1192, 792],
  active: true,
  overrideRedirect: false,
  transientFor: 11,
};
const q = { kit: "gtk" as const, g: 2, c: 2 };
const entry = {
  role: "text",
  name: "",
  frame: { x: 380, y: 355, w: 161, h: 28 },
  space: "gtk",
  secret: false,
  editable: true,
};

interface Call {
  cmd: string;
  args: Record<string, unknown>;
  timeoutMs: number | undefined;
}

// Helpers the accessibility client starts: each answers by script and records its calls.
function helpers(...scripts: ((cmd: string, args: Record<string, unknown>) => unknown)[]) {
  const calls: Call[][] = [];
  const closed: number[] = [];
  let started = 0;
  const start = async (): Promise<XHelper> => {
    const n = started++;
    const script = scripts[n];
    if (!script) throw new XHelperError("native failed to start");
    calls[n] = [];
    let alive = true;
    return {
      get alive() {
        return alive;
      },
      async call(cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number) {
        calls[n]?.push({ cmd, args, timeoutMs });
        return (await script(cmd, args)) as never;
      },
      onEvent: () => () => {},
      async close() {
        alive = false;
        closed.push(n);
      },
    };
  };
  return { start, calls, closed, started: () => started };
}

describe("AtspiAccessibility", () => {
  it("sends the window, the point and an absolute deadline on the helper's clock", async () => {
    const h = helpers(() => ({ element: entry }));
    const native = new AtspiAccessibility(h.start, () => 1_000);
    const answer = await native.at(dialog, { x: 896, y: 736 }, q, 300);
    expect(answer).toMatchObject({ element: { role: "text", editable: true } });
    expect(h.calls[0]?.[0]).toEqual({
      cmd: "at",
      args: {
        window: {
          pid: 2193,
          title: "Change Foreground Color",
          rect: [2, 222, 1188, 734],
          frame: [0, 166, 1192, 792],
          overrideRedirect: false,
        },
        point: { x: 896, y: 736 },
        kit: "gtk",
        g: 2,
        c: 2,
        deadline: 1_300,
      },
      timeoutMs: 500,
    });
  });

  it("answers unknown, and replaces the helper, when it misses its own deadline", async () => {
    const h = helpers(
      () => {
        throw new XHelperTimeoutError("native at: timed out after 500 ms");
      },
      () => ({ element: null }),
    );
    const native = new AtspiAccessibility(h.start, () => 0);
    expect(await native.at(dialog, { x: 1, y: 1 }, q, 300)).toEqual({ unknown: true });
    expect(h.closed).toEqual([0]);
    expect(await native.focused(dialog, q, 300)).toEqual({ element: null });
    expect(h.started()).toBe(2);
  });

  it("answers unknown and keeps the helper when a query fails", async () => {
    const h = helpers((cmd) => {
      if (cmd === "at") throw new XHelperError("native at: Error: atspi_error");
      return { element: entry };
    });
    const native = new AtspiAccessibility(h.start, () => 0);
    expect(await native.at(dialog, { x: 1, y: 1 }, q, 300)).toEqual({ unknown: true });
    expect(await native.focused(dialog, q, 300)).toMatchObject({ element: { role: "text" } });
    expect(h.started()).toBe(1);
  });

  it("answers unknown while no helper can start, and tries again on the next query", async () => {
    const h = helpers();
    const native = new AtspiAccessibility(h.start, () => 0);
    expect(await native.focused(dialog, q, 300)).toEqual({ unknown: true });
    expect(await native.focused(dialog, q, 300)).toEqual({ unknown: true });
    expect(h.started()).toBe(2);
  });

  it("keeps a window's tree until the screen changes, unless the walk was cut short", async () => {
    let truncated = true;
    const h = helpers(() => ({ elements: [entry], truncated }));
    const native = new AtspiAccessibility(h.start, () => 0);
    await native.tree(dialog, q, 1500, 7);
    await native.tree(dialog, q, 1500, 7);
    expect(h.calls[0]?.length).toBe(2);
    truncated = false;
    await native.tree(dialog, q, 1500, 7);
    expect(await native.tree(dialog, q, 1500, 7)).toEqual({ elements: [entry] });
    expect(h.calls[0]?.length).toBe(3);
    await native.tree(dialog, q, 1500, 8);
    await native.tree({ ...dialog, x: 40 }, q, 1500, 8);
    expect(h.calls[0]?.length).toBe(5);
  });
});
