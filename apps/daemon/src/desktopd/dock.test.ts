import { ulid } from "@localdot/protocol";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { NO_STREAM } from "../cells/types.ts";
import { DesktopdError } from "./client.ts";
import { dockCovered, dockRoutes } from "./dock.ts";

const SCREEN = { w: 2560, h: 1600 };
const frame = (x: number, y: number, w: number, h: number) => ({ frame: { x, y, w, h } });
// The real desktop's furniture at 2x, as its window stack lists it (top first, desktop last).
const PLANK = frame(0, 1416, 2560, 184);
const PANEL = frame(0, 0, 2560, 48);
const DESKTOP = frame(0, 0, 2560, 1600);

describe("whether a window covers the dock", () => {
  it("is not the desktop's own furniture: its dock, its menu bar and the desktop itself", () => {
    expect(dockCovered([PLANK, PANEL, DESKTOP], SCREEN)).toBe(false);
  });

  it("is an application window over the dock, maximised or not", () => {
    expect(dockCovered([PLANK, PANEL, frame(0, 48, 2560, 1552), DESKTOP], SCREEN)).toBe(true);
    expect(dockCovered([PLANK, PANEL, frame(300, 200, 1404, 1358), DESKTOP], SCREEN)).toBe(true);
    // The web browser's item the stage draws beside Plank's apps is the dock's too.
    expect(dockCovered([frame(1820, 1500, 200, 80), DESKTOP], SCREEN)).toBe(true);
  });

  it("is not a window that stays clear of it", () => {
    expect(dockCovered([PLANK, PANEL, frame(300, 200, 1404, 958), DESKTOP], SCREEN)).toBe(false);
    // Beside the dock, down to the screen's foot.
    expect(dockCovered([frame(0, 900, 700, 700), DESKTOP], SCREEN)).toBe(false);
    expect(dockCovered([frame(1960, 900, 600, 700), DESKTOP], SCREEN)).toBe(false);
  });

  it("is a window filling the screen above the desktop", () => {
    expect(dockCovered([frame(0, 0, 2560, 1600), PLANK, PANEL, DESKTOP], SCREEN)).toBe(true);
  });

  it("measures the dock at the screen's own scale", () => {
    expect(dockCovered([frame(150, 100, 702, 679)], { w: 1280, h: 800 })).toBe(true);
    expect(dockCovered([frame(150, 100, 702, 479)], { w: 1280, h: 800 })).toBe(false);
  });
});

describe("GET /api/cells/:id/dock", () => {
  const id = ulid();
  const cell = (over: Partial<CellSummary> = {}): CellSummary => ({
    id,
    state: "ready",
    scale: 2,
    createdAt: "2026-11-07T10:00:00.000Z",
    stream: { ...NO_STREAM },
    ...over,
  });
  function setup(windows: () => Promise<{ ticks: number; windows: { frame: never }[] }>) {
    let summary: CellSummary | undefined = cell();
    let clock = 0;
    const read = vi.fn(windows);
    const app = new Hono();
    dockRoutes(app, {
      cells: { get: () => summary },
      registry: { for: () => ({ client: { windows: read } as never }) },
      now: () => clock,
    });
    return {
      read,
      ask: (path = `/api/cells/${id}/dock`) => app.request(path),
      set: (next: CellSummary | undefined) => {
        summary = next;
      },
      wait: (ms: number) => {
        clock += ms;
      },
    };
  }
  const covered = () =>
    Promise.resolve({ ticks: 1, windows: [frame(0, 48, 2560, 1552), DESKTOP] as never[] });

  it("answers yes or no and nothing of the windows", async () => {
    const { ask, read } = setup(covered);
    const reply = await ask();
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ covered: true, browser: true });
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenCalledWith({}, expect.any(AbortSignal));
  });

  it("says whether the web browser runs, and takes it as running when that can't be told", async () => {
    for (const [running, said] of [
      [() => false, false],
      [() => true, true],
      [() => Promise.reject(new Error("unknown")), true],
    ] as const) {
      const app = new Hono();
      dockRoutes(app, {
        cells: { get: () => cell() },
        registry: { for: () => ({ client: { windows: covered } as never }) },
        browserRunning: running,
      });
      const reply = await app.request(`/api/cells/${id}/dock`);
      expect(await reply.json()).toEqual({ covered: true, browser: said });
    }
  });

  it("reads the windows once for every viewer asking within a moment", async () => {
    const { ask, read, wait } = setup(covered);
    await Promise.all([ask(), ask(), ask()]);
    wait(500);
    await ask();
    expect(read).toHaveBeenCalledTimes(1);
    wait(800);
    await ask();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("says so when the computer can't be read, and reads again at the next ask", async () => {
    const { ask, read } = setup(() => Promise.reject(new DesktopdError(0, "down", "/windows")));
    expect((await ask()).status).toBe(502);
    expect((await ask()).status).toBe(502);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refuses a bad id and a computer that isn't ready", async () => {
    const { ask, set, read } = setup(covered);
    expect((await ask("/api/cells/nope/dock")).status).toBe(400);
    set(cell({ paused: true }));
    expect((await ask()).status).toBe(409);
    set(cell({ state: "stopped" }));
    expect((await ask()).status).toBe(409);
    set(undefined);
    expect((await ask()).status).toBe(409);
    expect(read).not.toHaveBeenCalled();
  });
});
