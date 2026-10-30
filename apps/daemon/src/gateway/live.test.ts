import { describe, expect, it, vi } from "vitest";
import { LiveSessions } from "./live.ts";

describe("live session settlement", () => {
  it("registers before callbacks run and handles reentrant Stop", async () => {
    const live = new LiveSessions();
    live.start("cell", "session", async (signal) => {
      expect(live.get("cell")).toBe("session");
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve()),
      );
      expect(live.stop("session")).toBe(true);
      await aborted;
    });
    await live.settled("session");
    expect(live.get("cell")).toBeUndefined();
    await live.settled("already-finished");
  });

  it("settles synchronous throws without exposing exception contents", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const live = new LiveSessions();
      live.start("cell", "session", () => {
        throw new Error("private-input");
      });
      await live.settled("session");
      expect(live.get("cell")).toBeUndefined();
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-input");
    } finally {
      log.mockRestore();
    }
  });

  it("rejects an ambiguous session id shared by two computers", async () => {
    const live = new LiveSessions();
    live.start(
      "first",
      "session",
      (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve)),
    );
    expect(() => live.start("second", "session", async () => {})).toThrow("already live");
    live.stop("session");
    await live.settled("session");
  });
});

it("keeps idle admission until the actual operation settles, then allows exactly one new owner", async () => {
  const live = new LiveSessions();
  const first = live.admitIdleOperation("cell");
  expect(first).toBeDefined();
  expect(live.idleOperationPending("cell")).toBe(true);
  expect(live.admitIdleOperation("cell")).toBeUndefined();
  expect(() => live.start("cell", "task", async () => {})).toThrow("still settling");
  first?.release();
  const next = live.admitIdleOperation("cell");
  first?.release(); // A stale release cannot release the replacement's lease.
  expect(live.idleOperationPending("cell")).toBe(true);
  next?.release();
  live.start(
    "cell",
    "task",
    (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve)),
  );
  expect(live.admitIdleOperation("cell")).toBeUndefined();
  live.stop("task");
  expect(live.admitIdleOperation("cell")).toBeUndefined();
  await live.settled("task");
  const idle = live.admitIdleOperation("cell");
  expect(idle).toBeDefined();
  idle?.release();
});

it("registers synchronously and drains both lifecycle hooks before releasing Stop ownership", async () => {
  const live = new LiveSessions();
  const calls: string[] = [];
  let finishBefore: () => void = () => {};
  let finishAfter: () => void = () => {};
  const before = new Promise<void>((r) => {
    finishBefore = r;
  });
  const after = new Promise<void>((r) => {
    finishAfter = r;
  });
  live.addHooks({
    beforeRun: async () => {
      calls.push("before");
      await before;
    },
    afterRun: async () => {
      calls.push("after");
      await after;
    },
  });
  live.start("cell", "session", async () => {
    calls.push("run");
  });
  expect(live.get("cell")).toBe("session");
  expect(calls).toEqual(["before"]);
  finishBefore();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toContain("run");
  expect(live.admitIdleOperation("cell")).toBeUndefined();
  finishAfter();
  await live.settled("session");
  expect(calls).toEqual(["before", "run", "after"]);
  expect(live.get("cell")).toBeUndefined();
});
it("does not start a run after Stop while beforeRun is still awaiting", async () => {
  const live = new LiveSessions();
  let release: () => void = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let runs = 0;
  let finalized = 0;
  live.addHooks({
    beforeRun: () => wait,
    afterRun: async () => {
      finalized++;
    },
  });
  live.start("cell", "session", async () => {
    runs++;
  });
  expect(live.stop("session")).toBe(true);
  release();
  await live.settled("session");
  expect(runs).toBe(0);
  expect(finalized).toBe(1);
  expect(live.get("cell")).toBeUndefined();
});
it("uses the hook snapshot for a live run and safely unregisters it for the next", async () => {
  const live = new LiveSessions();
  let finalized = 0;
  const remove = live.addHooks({
    afterRun: async () => {
      finalized++;
    },
  });
  live.start("cell", "one", async () => {});
  remove();
  await live.settled("one");
  expect(finalized).toBe(1);
  live.start("cell", "two", async () => {});
  await live.settled("two");
  expect(finalized).toBe(1);
});

it("retains preparation ownership and never records a failed preparation", async () => {
  const live = new LiveSessions();
  const calls: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  live.addHooks({
    beforeRun: async () => {
      calls.push("record");
    },
  });
  live.start(
    "cell",
    "task",
    async (signal) => {
      expect(signal.aborted).toBe(true);
      calls.push("finalize");
    },
    async () => {
      await pending;
      throw new Error("preparation failed");
    },
  );
  expect(live.get("cell")).toBe("task");
  expect(live.admitIdleOperation("cell")).toBeUndefined();
  expect(calls).toEqual([]);
  finish();
  await live.settled("task");
  expect(calls).toEqual(["finalize"]);
  expect(live.get("cell")).toBeUndefined();
});

it("a prepared task finalizes after Stop even when the recording hook was still starting", async () => {
  const live = new LiveSessions();
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  live.addHooks({
    beforeRun: async () => {
      entered();
      await pending;
    },
    afterRun: async () => {
      calls.push("recording closed");
    },
  });
  live.start(
    "cell",
    "task",
    async (signal) => {
      expect(signal.aborted).toBe(true);
      calls.push("finalize");
    },
    async () => {},
  );
  await ready;
  live.stop("task");
  finish();
  await live.settled("task");
  expect(calls).toEqual(["finalize", "recording closed"]);
});

describe("tasks sharing a computer", () => {
  const forever = (signal: AbortSignal) =>
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));

  it("runs several tasks at once and puts the computer's doings down to the one acting", async () => {
    const live = new LiveSessions();
    live.start("cell", "a", forever);
    live.start("cell", "b", forever);
    expect(live.sessionsOn("cell")).toEqual(["a", "b"]);
    expect(live.busy("cell")).toBe(true);
    expect(live.get("cell")).toBe("b");
    const turn = await live.lease("cell").acquire("a");
    expect(live.get("cell")).toBe("a");
    turn.release();
    expect(live.get("cell")).toBe("a");
    live.stop("a");
    await live.settled("a");
    expect(live.sessionsOn("cell")).toEqual(["b"]);
    expect(live.get("cell")).toBe("b");
    expect(live.admitIdleOperation("cell")).toBeUndefined();
    live.stop("b");
    await live.settled("b");
    expect(live.busy("cell")).toBe(false);
  });

  it("ends a stopped task's waits for the computer and leaves the others' alone", async () => {
    const live = new LiveSessions();
    live.start("cell", "a", forever);
    live.start("cell", "b", forever);
    live.start("cell", "c", forever);
    const held = await live.lease("cell").acquire("a");
    const b = live.lease("cell").acquire("b");
    const c = live.lease("cell").acquire("c");
    live.stop("b");
    await live.settled("b");
    await expect(b).rejects.toBeDefined();
    held.release();
    expect((await c).sessionId).toBe("c");
    for (const id of ["a", "c"]) {
      live.stop(id);
      await live.settled(id);
    }
    expect(live.lease("cell").holder).toBeUndefined();
  });

  it("gives the web browser to one task at a time until it lets go or ends", async () => {
    const live = new LiveSessions();
    live.start("cell", "a", forever);
    live.start("cell", "b", forever);
    expect(live.claimBrowser("cell", "a")).toBe(true);
    expect(live.claimBrowser("cell", "a")).toBe(true);
    expect(live.claimBrowser("cell", "b")).toBe(false);
    expect(live.browserHolder("cell")).toBe("a");
    live.releaseBrowser("cell", "b");
    expect(live.browserHolder("cell")).toBe("a");
    live.stop("a");
    await live.settled("a");
    expect(live.browserHolder("cell")).toBeUndefined();
    expect(live.claimBrowser("cell", "b")).toBe(true);
    live.stop("b");
    await live.settled("b");
  });
});
