import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserIdlePages,
  IDLE_PAGES_GRACE_MS,
  IDLE_PAGES_SWEEP_MS,
  type IdleRequest,
  type IdleTask,
} from "./idle-pages.ts";

const taskA = "01J9ZQ3V8Y7X6W5T4S3R2Q1PAA";
const taskB = "01J9ZQ3V8Y7X6W5T4S3R2Q1PBB";
const FROZEN = { frozen: true, keep: [] };
const THAWED = { frozen: false };

// One computer whose web browser runs; what it is sent, as browserd confirms it.
function fixture() {
  let viewers = 0;
  let tasks: IdleTask[] = [];
  let instance = "instance-1";
  let refusing = false;
  const sent: IdleRequest[] = [];
  const send = vi.fn(async (_parent: string, _instance: string, request: IdleRequest) => {
    if (refusing) throw new Error("browserd refused");
    sent.push(request);
  });
  const pages = new BrowserIdlePages({
    browsers: () => [{ parentCellId: "computer", instance }],
    viewers: () => viewers,
    tasks: () => tasks,
    send,
  });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return {
    pages,
    sent,
    send,
    settle,
    last: () => sent.at(-1),
    watch: async (count: number) => {
      viewers = count;
      pages.changed("computer");
      await settle();
    },
    tasks: async (next: IdleTask[]) => {
      tasks = next;
      pages.changed("computer");
      await settle();
    },
    refuse: (value: boolean) => {
      refusing = value;
    },
    restart: async () => {
      instance = "instance-2";
      pages.changed("computer");
      await settle();
    },
    wait: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}

const task = (id: string, busy: boolean, controlled = false): IdleTask => ({
  id,
  busy,
  controlled,
});

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("freezing the pages nobody uses", () => {
  it("freezes a browser nobody uses a minute after it is first seen, and not before", async () => {
    const f = fixture();
    await f.settle();
    expect(f.sent).toEqual([THAWED]);
    await f.wait(IDLE_PAGES_GRACE_MS - 1000);
    expect(f.sent).toEqual([THAWED]);
    await f.wait(1001);
    expect(f.last()).toEqual(FROZEN);
    f.pages.dispose();
  });

  it("thaws at once when someone watches, and freezes a full minute after they leave", async () => {
    const f = fixture();
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    expect(f.last()).toEqual(FROZEN);
    await f.watch(1);
    expect(f.last()).toEqual(THAWED);
    // Watching for several minutes and then leaving starts the minute over from when they left.
    await f.wait(5 * IDLE_PAGES_GRACE_MS);
    await f.watch(0);
    await f.wait(IDLE_PAGES_GRACE_MS - 1000);
    expect(f.last()).toEqual(THAWED);
    await f.wait(1001);
    expect(f.last()).toEqual(FROZEN);
    f.pages.dispose();
  });

  it("doesn't flap as viewers come and go within the minute", async () => {
    const f = fixture();
    await f.watch(1);
    for (let glance = 0; glance < 5; glance++) {
      await f.watch(0);
      await f.wait(20_000);
      await f.watch(1);
      await f.wait(1000);
    }
    await f.watch(0);
    await f.wait(IDLE_PAGES_GRACE_MS - 1000);
    expect(f.sent).toEqual([THAWED]);
    await f.wait(1001);
    expect(f.sent).toEqual([THAWED, FROZEN]);
    f.pages.dispose();
  });

  it("keeps a working task's windows awake, and for a minute after its work", async () => {
    const f = fixture();
    await f.tasks([task(taskA, true), task(taskB, false)]);
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    expect(f.last()).toEqual({ frozen: true, keep: [taskA] });
    await f.tasks([task(taskA, false), task(taskB, false)]);
    await f.wait(IDLE_PAGES_GRACE_MS - 1000);
    expect(f.last()).toEqual({ frozen: true, keep: [taskA] });
    await f.wait(1001);
    expect(f.last()).toEqual(FROZEN);
    // Back at work: its windows wake at once.
    await f.tasks([task(taskA, false), task(taskB, true)]);
    expect(f.last()).toEqual({ frozen: true, keep: [taskB] });
    f.pages.dispose();
  });

  it("keeps a finished task's window awake for a minute after it ends", async () => {
    const f = fixture();
    await f.tasks([task(taskA, true)]);
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    await f.tasks([]);
    expect(f.last()).toEqual({ frozen: true, keep: [taskA] });
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    expect(f.last()).toEqual(FROZEN);
    f.pages.dispose();
  });

  it("freezes a sign-in left waiting for the user, and thaws it when they take control", async () => {
    const f = fixture();
    // dot handed the computer over for a QR code; nobody is looking.
    await f.tasks([task(taskA, false)]);
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    expect(f.last()).toEqual(FROZEN);
    await f.tasks([task(taskA, false, true)]);
    expect(f.last()).toEqual(THAWED);
    await f.wait(5 * IDLE_PAGES_GRACE_MS);
    expect(f.last()).toEqual(THAWED);
    f.pages.dispose();
  });

  it("asserts a freeze again on each sweep, and a thaw only once", async () => {
    const f = fixture();
    await f.watch(1);
    await f.wait(3 * IDLE_PAGES_SWEEP_MS);
    expect(f.sent).toEqual([THAWED]);
    await f.watch(0);
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    const frozen = f.sent.length;
    await f.wait(2 * IDLE_PAGES_SWEEP_MS);
    expect(f.sent.length).toBe(frozen + 2);
    expect(f.last()).toEqual(FROZEN);
    f.pages.dispose();
  });

  it("sends again after browserd refuses", async () => {
    const f = fixture();
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    f.refuse(true);
    await f.watch(1);
    expect(f.last()).toEqual(FROZEN);
    f.refuse(false);
    await f.wait(1001);
    expect(f.last()).toEqual(THAWED);
    f.pages.dispose();
  });

  it("asks a browserd that keeps refusing less and less often", async () => {
    const f = fixture();
    f.refuse(true);
    await f.watch(1);
    const asked = f.send.mock.calls.length;
    await f.wait(IDLE_PAGES_GRACE_MS);
    // A second, two, four, eight, then once or twice a sweep: not sixty times a minute.
    expect(f.send.mock.calls.length - asked).toBeLessThanOrEqual(14);
    f.pages.dispose();
  });

  it("starts over for a browser started anew", async () => {
    const f = fixture();
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    expect(f.last()).toEqual(FROZEN);
    await f.restart();
    expect(f.last()).toEqual(THAWED);
    expect(f.send).toHaveBeenLastCalledWith("computer", "instance-2", THAWED);
    await f.wait(IDLE_PAGES_GRACE_MS + 1);
    expect(f.last()).toEqual(FROZEN);
    f.pages.dispose();
  });

  it("reads the computer again on the next sweep when a read fails", async () => {
    let failing = true;
    const sent: IdleRequest[] = [];
    const pages = new BrowserIdlePages({
      browsers: () => [{ parentCellId: "computer", instance: "instance-1" }],
      viewers: () => 0,
      tasks: () => {
        if (failing) throw new Error("the runner is changing");
        return [];
      },
      send: async (_parent, _instance, request) => {
        sent.push(request);
      },
    });
    await vi.advanceTimersByTimeAsync(IDLE_PAGES_SWEEP_MS);
    expect(sent).toEqual([]);
    failing = false;
    await vi.advanceTimersByTimeAsync(IDLE_PAGES_SWEEP_MS);
    expect(sent).toEqual([THAWED]);
    pages.dispose();
  });

  it("reads a task's status outside the change it reports", async () => {
    let depth = 0;
    let deepest = 0;
    let reported = false;
    const pages = new BrowserIdlePages({
      browsers: () => [{ parentCellId: "computer", instance: "instance-1" }],
      viewers: () => 0,
      // Reading a status can report that it changed, as the runner does.
      tasks: () => {
        depth++;
        deepest = Math.max(deepest, depth);
        if (!reported) pages.changed("computer");
        reported = true;
        depth--;
        return [];
      },
      send: async () => {},
    });
    await vi.advanceTimersByTimeAsync(IDLE_PAGES_SWEEP_MS);
    expect(reported).toBe(true);
    expect(deepest).toBe(1);
    pages.dispose();
  });
});
