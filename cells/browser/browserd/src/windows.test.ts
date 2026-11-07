import { describe, expect, it, vi } from "vitest";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import { BrowserTargetError } from "./targets.ts";
import {
  BROWSER_FREEZE_AFTER_USE_MS,
  BROWSER_KEPT_FREE_WINDOWS,
  BrowserWindows,
} from "./windows.ts";

const browserCellId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const parentCellId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";
const instance = "87ae386e-79f1-4f3e-b604-869812515446";
const taskA = "01J9ZQ3V8Y7X6W5T4S3R2Q1PAA";
const taskB = "01J9ZQ3V8Y7X6W5T4S3R2Q1PBB";
const taskC = "01J9ZQ3V8Y7X6W5T4S3R2Q1PCC";

function permit(sessionId: string): BrowserActionPermit {
  return {
    browserCellId,
    parentCellId,
    instance,
    revision: 1,
    requestId: sessionId,
    owner: { sessionId, generation: 1 },
  };
}

// Chromium and the display as far as the registry sees them: tabs in windows, and an X window for
// each, the newest active. A minimized window comes back as the window manager activates it, unless
// it is `stuck`.
function fixture(start: { id: string; windowId: number; opener?: string }[] = []) {
  const pages = start.map((page) => ({ ready: true, ...page }));
  const xids = new Map<number, number>();
  const states = new Map<number, string>();
  const lifecycle = new Map<string, "frozen" | "active">();
  let stuck = false;
  let active: number | undefined;
  const place = (windowId: number) => {
    if (!xids.has(windowId)) xids.set(windowId, 1000 + windowId);
    active = xids.get(windowId);
  };
  for (const page of pages) place(page.windowId);
  let next = 100;
  const commands: { name: string; args: unknown }[] = [];
  const native = {
    command: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
      commands.push({ name, args });
      if (name === "windows")
        return {
          windows: [...xids.values()].map((id) => ({
            id,
            active: id === active,
            frame: [0, 0, 2560, 1600],
          })),
        };
      if (name === "activate") {
        active = args.window as number;
        for (const [windowId, xid] of xids)
          if (xid === active && states.get(windowId) === "minimized" && !stuck)
            states.set(windowId, "maximized");
        return { active, changed: true, waitedMs: 1 };
      }
      if (name === "pointer") return { x: 5, y: 6 };
      if (name === "surface") return { window: args.window, page: {} };
      return {};
    }),
  };
  const targets = {
    pages: () => pages.map((page) => ({ ...page })),
    openWindow: vi.fn(async () => {
      next += 1;
      const tab = `tab-${next}`;
      pages.push({ id: tab, windowId: next, ready: true });
      place(next);
      return tab;
    }),
    settleNewWindow: vi.fn(async () => {}),
    activate: vi.fn(async (tabId: string) => {
      const page = pages.find((candidate) => candidate.id === tabId);
      if (page) active = xids.get(page.windowId);
    }),
    closeTab: vi.fn(async (tabId: string) => {
      const at = pages.findIndex((page) => page.id === tabId);
      const [gone] = pages.splice(at, 1);
      if (gone && !pages.some((page) => page.windowId === gone.windowId))
        xids.delete(gone.windowId);
    }),
    closed: false,
    lifecycle: vi.fn(async (tabId: string, state: "frozen" | "active") => {
      if (!pages.some((page) => page.id === tabId)) throw new BrowserTargetError("stale");
      lifecycle.set(tabId, state);
    }),
    window: vi.fn(async (tabId: string) => {
      const windowId = pages.find((page) => page.id === tabId)?.windowId ?? 0;
      return { windowState: states.get(windowId) ?? "maximized" };
    }),
    windowState: vi.fn(async (tabId: string, state: string) => {
      const windowId = pages.find((page) => page.id === tabId)?.windowId ?? 0;
      states.set(windowId, state);
    }),
  };
  const secrets = {
    secretPages: vi.fn(async (): Promise<readonly string[]> => []),
    reload: vi.fn(async () => {}),
  };
  const finished = vi.fn();
  const control = {
    admit: vi.fn(() => ({
      signal: new AbortController().signal,
      check: () => {},
      finish: finished,
    })),
  };
  let now = 0;
  const windows = new BrowserWindows({
    control,
    targets: targets as never,
    native: native as never,
    secrets: secrets as never,
    now: () => now,
  });
  const signal = new AbortController().signal;
  const enter = (sessionId: string, place: { continues?: string; fresh?: true } = {}) =>
    windows.enter({ permit: permit(sessionId), ...place }, signal);
  const frozen = () =>
    [...lifecycle].filter(([, state]) => state === "frozen").map(([tabId]) => tabId);
  return {
    windows,
    native,
    targets,
    secrets,
    pages,
    control,
    commands,
    enter,
    signal,
    xids,
    states,
    frozen,
    stick: (value: boolean) => {
      stuck = value;
    },
    active: () => active,
    later: (ms = BROWSER_FREEZE_AFTER_USE_MS) => {
      now += ms;
    },
  };
}

describe("a window per task", () => {
  it("gives a lone task the window that is there and moves nothing", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    const reply = await f.enter(taskA, { fresh: true });
    expect(reply).toEqual({ tabs: [{ id: "first", ready: true }], opened: false });
    expect(f.native.command).not.toHaveBeenCalled();
    expect(f.windows.owns(taskA, "first")).toBe(true);
    await f.enter(taskA);
    expect(f.native.command).not.toHaveBeenCalled();
    expect(f.targets.openWindow).not.toHaveBeenCalled();
  });

  it("opens a second task its own window, and neither can claim the other's tab", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA, { fresh: true });
    const second = await f.enter(taskB, { fresh: true });
    expect(second.opened).toBe(true);
    const tab = second.tabs[0]?.id ?? "";
    expect(f.windows.owns(taskB, tab)).toBe(true);
    expect(f.windows.owns(taskA, tab)).toBe(false);
    expect(f.windows.owns(taskB, "first")).toBe(false);
    expect(f.windows.tabs(permit(taskA))).toEqual([{ id: "first", ready: true }]);
    expect(f.windows.tabs(permit(taskB))).toEqual([{ id: tab, ready: true }]);
    expect(f.windows.othersAtWork(tab)).toBe(true);
    expect(f.windows.othersAtWork("first")).toBe(true);
  });

  it("binds a window to the X window it was opened as, and no other", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    expect(f.windows.bound(1, 1001)).toBe(true);
    await f.enter(taskB);
    const second = f.pages.at(-1)?.windowId ?? 0;
    const xid = f.xids.get(second) ?? 0;
    expect(f.windows.bound(second, xid)).toBe(true);
    // The other task's window in front, on the same address or not, is refused.
    expect(f.windows.bound(1, xid)).toBe(false);
    expect(f.windows.bound(second, 1001)).toBe(false);
  });

  it("brings the task's window forward on its turn, clearing what the last task copied", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.commands.length = 0;
    await f.enter(taskA);
    const names = f.commands.map(({ name }) => name);
    expect(names).toContain("clearSelections");
    expect(names.indexOf("clearSelections")).toBeLessThan(names.indexOf("activate"));
    expect(f.commands.find(({ name }) => name === "activate")?.args).toEqual({ window: 1001 });
    f.commands.length = 0;
    // A task whose window is still the active one keeps its clipboard and moves nothing.
    await f.enter(taskA);
    expect(f.commands.map(({ name }) => name)).toEqual(["windows"]);
  });

  it("puts the pointer back where each task left it", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    await f.enter(taskA);
    await f.enter(taskB);
    expect(f.commands.filter(({ name }) => name === "move").at(-1)?.args).toEqual({ x: 5, y: 6 });
  });

  it("makes a popup its opener's, and a window nothing opened the task's on screen", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.pages.push({ id: "popup", windowId: 9, opener: "first", ready: true });
    expect(f.windows.ownerOf("popup")).toBe(taskA);
    f.pages.push({ id: "stray", windowId: 10, ready: true });
    expect(f.windows.ownerOf("stray")).toBe(taskB);
  });

  it("gives a task the window of the conversation it continues", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.windows.release(taskA, false);
    expect(f.windows.owns(taskA, "first")).toBe(false);
    const next = await f.enter(taskC, { continues: taskA });
    expect(next).toEqual({ tabs: [{ id: "first", ready: true }], opened: false });
  });

  it("gives a new conversation a finished task's window, and cleans it for another task", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.windows.release(taskA, false);
    f.secrets.secretPages.mockResolvedValueOnce(["first"]);
    const next = await f.enter(taskC, { fresh: true });
    expect(next.opened).toBe(false);
    expect(f.secrets.secretPages).toHaveBeenCalledWith(expect.any(AbortSignal), ["first"]);
    expect(f.secrets.reload).toHaveBeenCalledExactlyOnceWith("first", expect.any(AbortSignal));
  });

  it("never lands a task that was at work on someone else's page", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.windows.release(taskA, false);
    const next = await f.enter(taskC);
    expect(next.opened).toBe(true);
    expect(next.tabs.map((tab) => tab.id)).not.toContain("first");
  });

  it("holds a task's window while it is on the desktop", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.windows.release(taskA, true);
    expect(f.windows.owns(taskA, "first")).toBe(true);
    const next = await f.enter(taskC, { fresh: true });
    expect(next.opened).toBe(true);
    expect((await f.enter(taskA)).tabs).toEqual([{ id: "first", ready: true }]);
  });

  it("keeps a few finished tasks' windows, never closing the last one", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    const tasks = ["01J9ZQ3V8Y7X6W5T4S3R2Q1PA1", "01J9ZQ3V8Y7X6W5T4S3R2Q1PA2", taskA, taskB, taskC];
    for (const task of tasks) await f.enter(task);
    expect(f.pages).toHaveLength(tasks.length);
    for (const task of tasks) f.windows.release(task, false);
    await vi.waitFor(() =>
      expect(f.targets.closeTab).toHaveBeenCalledTimes(tasks.length - BROWSER_KEPT_FREE_WINDOWS),
    );
    expect(f.pages).toHaveLength(BROWSER_KEPT_FREE_WINDOWS);
  });

  it("opens a new window for a task whose window closed", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.pages.splice(0, 1);
    f.xids.delete(1);
    const again = await f.enter(taskA);
    expect(again.opened).toBe(true);
    expect(again.tabs).toHaveLength(1);
  });

  it("closes every window but the one on screen before a relaunch for sign-in", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    await f.enter(taskA);
    await f.windows.closeOthers();
    expect(f.pages.map((page) => page.id)).toEqual(["first"]);
    expect(f.windows.owns(taskA, "first")).toBe(true);
  });

  it("raises the window for the user without a permit", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    await f.enter(taskB);
    f.commands.length = 0;
    await f.windows.front(taskA, f.signal);
    expect(f.commands.find(({ name }) => name === "activate")?.args).toEqual({ window: 1001 });
    expect(f.control.admit).toHaveBeenCalledTimes(2);
  });

  it("always finishes the lease it took", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    expect(f.control.admit).toHaveBeenCalledTimes(1);
    f.targets.openWindow.mockRejectedValueOnce(new Error("no window"));
    await expect(f.enter(taskB)).rejects.toThrow();
    expect(f.control.admit).toHaveBeenCalledTimes(2);
    expect(f.control.admit.mock.results.length).toBe(2);
  });
});

describe("freezing pages nobody uses", () => {
  // Task A and task B each have a window; A's is on screen.
  async function two() {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    const tabB = (await f.enter(taskB)).tabs[0]?.id ?? "";
    await f.enter(taskA);
    f.commands.length = 0;
    f.later();
    return { ...f, tabB };
  }

  it("freezes every window but the kept tasks', a finished task's included", async () => {
    const f = await two();
    f.pages.push({ id: "behind", windowId: 1, ready: true });
    expect(await f.windows.freeze([taskB], f.signal)).toBe(2);
    expect(f.frozen()).toEqual(["first", "behind"]);
    f.windows.release(taskB, false);
    expect(await f.windows.freeze([], f.signal)).toBe(3);
    expect(f.frozen()).toEqual(["first", "behind", f.tabB]);
    // Freezing touches neither the display nor any window's place on it.
    expect(f.commands).toEqual([]);
  });

  // The daemon's view of who is at work can lag a request the task already sent: a freeze worked
  // out just before a task's turn must not land on the window that turn brought forward.
  it("keeps awake a window its task has just entered, through a freeze sent before", async () => {
    const f = await two();
    await f.enter(taskA);
    expect(await f.windows.freeze([], f.signal)).toBe(1);
    expect(f.frozen()).toEqual([f.tabB]);
    f.later(BROWSER_FREEZE_AFTER_USE_MS - 1);
    await f.windows.freeze([], f.signal);
    expect(f.frozen()).toEqual([f.tabB]);
    f.later(1);
    await f.windows.freeze([], f.signal);
    expect(f.frozen()).toEqual([f.tabB, "first"]);
  });

  it("keeps awake a window whose page a task has just read or loaded", async () => {
    const f = await two();
    await f.windows.wakeTab(f.tabB, false, f.signal);
    await f.windows.wakeTab("first", true, f.signal);
    expect(await f.windows.freeze([], f.signal)).toBe(0);
    expect(f.frozen()).toEqual([]);
    await f.windows.wakeTask(taskB, f.signal);
    f.later();
    expect(await f.windows.freeze([], f.signal)).toBe(2);
  });

  it("wakes a window as its task is kept again, without bringing it forward", async () => {
    const f = await two();
    await f.windows.freeze([], f.signal);
    await f.windows.freeze([taskB], f.signal);
    expect(f.frozen()).toEqual(["first"]);
    expect(f.targets.lifecycle).toHaveBeenLastCalledWith(f.tabB, "active");
    expect(f.commands.map(({ name }) => name)).not.toContain("activate");
  });

  it("passes over a tab that closed as it froze", async () => {
    const f = await two();
    f.targets.lifecycle.mockRejectedValueOnce(new BrowserTargetError("stale"));
    expect(await f.windows.freeze([], f.signal)).toBe(1);
    f.targets.lifecycle.mockRejectedValueOnce(new BrowserTargetError("closed"));
    await expect(f.windows.freeze([], f.signal)).rejects.toThrow(BrowserTargetError);
  });

  it("shows a frozen window again as its task's turn brings it forward", async () => {
    const f = await two();
    await f.windows.freeze([], f.signal);
    await f.enter(taskB);
    expect(f.frozen()).toEqual(["first"]);
    const names = f.commands.map(({ name }) => name);
    // Minimized, then brought back by the window manager, in front: Chromium shows it again.
    expect(f.targets.windowState).toHaveBeenCalledWith(f.tabB, "minimized");
    expect(names.indexOf("activate")).toBeGreaterThan(-1);
    expect(f.states.get(f.pages.find((page) => page.id === f.tabB)?.windowId ?? 0)).toBe(
      "maximized",
    );
    expect(f.active()).toBe(f.xids.get(f.pages.at(-1)?.windowId ?? 0));
    // Once shown, the next turn moves nothing.
    f.commands.length = 0;
    f.targets.windowState.mockClear();
    await f.enter(taskB);
    expect(f.targets.windowState).not.toHaveBeenCalled();
    expect(f.commands.map(({ name }) => name)).toEqual(["windows"]);
  });

  it("shows a lone task's frozen window on its turn, where nothing moved before", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    f.later();
    await f.windows.freeze([], f.signal);
    await f.enter(taskA);
    expect(f.frozen()).toEqual([]);
    expect(f.targets.windowState).toHaveBeenCalledWith("first", "minimized");
    expect(f.commands.find(({ name }) => name === "activate")?.args).toEqual({ window: 1001 });
    f.commands.length = 0;
    await f.enter(taskA);
    expect(f.commands).toEqual([]);
  });

  it("brings a window back through Chromium when the window manager leaves it minimized", async () => {
    const f = fixture([{ id: "first", windowId: 1 }]);
    await f.enter(taskA);
    f.later();
    await f.windows.freeze([], f.signal);
    f.stick(true);
    await f.enter(taskA);
    expect(f.targets.windowState.mock.calls.map(([, state]) => state)).toEqual([
      "minimized",
      "normal",
      "maximized",
    ]);
    expect(f.states.get(1)).toBe("maximized");
  });

  it("thaws every page and shows only the window on screen", async () => {
    const f = await two();
    await f.windows.freeze([], f.signal);
    await f.windows.thaw(f.signal);
    expect(f.frozen()).toEqual([]);
    expect(f.targets.windowState.mock.calls).toEqual([["first", "minimized"]]);
    expect(f.active()).toBe(1001);
    // The window behind shows as its turn brings it forward.
    f.targets.windowState.mockClear();
    await f.enter(taskB);
    expect(f.targets.windowState).toHaveBeenCalledWith(f.tabB, "minimized");
  });

  it("wakes a tab's window before it is read or driven, showing it only on screen", async () => {
    const f = await two();
    await f.windows.freeze([], f.signal);
    await f.windows.wakeTab(f.tabB, true, f.signal);
    expect(f.frozen()).toEqual(["first"]);
    expect(f.targets.windowState).not.toHaveBeenCalled();
    await f.windows.wakeTab("first", false, f.signal);
    expect(f.frozen()).toEqual([]);
    expect(f.targets.windowState).not.toHaveBeenCalled();
    await f.windows.wakeTab("first", true, f.signal);
    expect(f.targets.windowState.mock.calls).toEqual([["first", "minimized"]]);
  });

  it("wakes a task's windows, and the window on screen for the user's input", async () => {
    const f = await two();
    await f.windows.freeze([], f.signal);
    await f.windows.wakeTask(taskB, f.signal);
    expect(f.frozen()).toEqual(["first"]);
    await f.windows.wakeScreen(f.signal);
    expect(f.frozen()).toEqual([]);
    expect(f.targets.windowState.mock.calls).toEqual([["first", "minimized"]]);
    // Each input after that costs nothing, until something freezes again.
    f.commands.length = 0;
    await f.windows.wakeScreen(f.signal);
    expect(f.commands).toEqual([]);
    f.later();
    await f.windows.freeze([taskA], f.signal);
    await f.windows.wakeScreen(f.signal);
    expect(f.commands.map(({ name }) => name)).toEqual(["windows"]);
  });

  it("asks Chromium nothing to wake a browser with nothing frozen", async () => {
    const f = await two();
    await f.windows.wakeTab("first", true, f.signal);
    await f.windows.wakeTask(taskA, f.signal);
    await f.windows.wakeScreen(f.signal);
    expect(f.targets.lifecycle).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });

  it("forgets frozen pages once the browser they were in is gone", async () => {
    const f = await two();
    await f.windows.freeze([], f.signal);
    f.targets.closed = true;
    f.targets.lifecycle.mockClear();
    await f.windows.wakeScreen(f.signal);
    expect(f.targets.lifecycle).not.toHaveBeenCalled();
  });
});
