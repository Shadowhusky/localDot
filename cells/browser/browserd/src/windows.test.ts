import { describe, expect, it, vi } from "vitest";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import { BROWSER_KEPT_FREE_WINDOWS, BrowserWindows } from "./windows.ts";

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
// each, the newest active.
function fixture(start: { id: string; windowId: number; opener?: string }[] = []) {
  const pages = start.map((page) => ({ ready: true, ...page }));
  const xids = new Map<number, number>();
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
  const windows = new BrowserWindows({
    control,
    targets: targets as never,
    native: native as never,
    secrets: secrets as never,
  });
  const signal = new AbortController().signal;
  const enter = (sessionId: string, place: { continues?: string; fresh?: true } = {}) =>
    windows.enter({ permit: permit(sessionId), ...place }, signal);
  return { windows, native, targets, secrets, pages, control, commands, enter, signal, xids };
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
