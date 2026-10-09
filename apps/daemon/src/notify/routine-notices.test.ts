import {
  type AttentionChangeEvent,
  type AttentionItem,
  DEFAULT_NOTIFY_SETTINGS,
  type LocalDotEvent,
} from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionLedger } from "./attention.ts";
import { Notifier, type RoutineRunNotice, SETTLE_MS } from "./notifier.ts";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const run = (extra: Partial<RoutineRunNotice>): RoutineRunNotice => ({
  type: "routine.run",
  routineId: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH1",
  runId: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH2",
  outcome: "done",
  sessionId: SESSION,
  notify: true,
  title: "Morning bills: Done",
  ...extra,
});

function fixture(routineSessions: string[] = [], wired = true) {
  const listeners = new Set<(item: AttentionItem) => void>();
  const runs = new Set<(run: RoutineRunNotice) => void>();
  let current: AttentionItem | undefined;
  const banners: [string, string][] = [];
  const pushes: unknown[] = [];
  const published: AttentionChangeEvent[] = [];
  const notifier = new Notifier({
    ledger: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      current: () => current,
      approvalExpiresAt: () => undefined,
      isRoutine: (id) => routineSessions.includes(id),
    },
    store: { settings: () => DEFAULT_NOTIFY_SETTINGS },
    mac: {
      available: true,
      show: async (title, body) => {
        banners.push([title, body]);
        return "shown";
      },
    },
    push: {
      sendAll: async (payload) => {
        pushes.push(payload);
        return [];
      },
    },
    presence: {
      snapshot: () => ({ localVisible: false, localHiddenCanNotify: false }),
      waitForShown: async () => false,
    },
    publish: (event) => published.push(event),
    ...(wired
      ? {
          routineRuns: (listener: (run: RoutineRunNotice) => void) => {
            runs.add(listener);
            return () => runs.delete(listener);
          },
        }
      : {}),
    now: () => new Date("2026-10-08T11:00:00Z"),
    timeZone: () => "Europe/London",
  });
  const emit = (item: AttentionItem) => {
    current = item;
    for (const listener of listeners) listener(item);
  };
  const report = (next: RoutineRunNotice) => {
    for (const listener of runs) listener(next);
  };
  return { notifier, emit, report, banners, pushes, published };
}

const done = (at: number): AttentionItem => ({
  key: `${SESSION}:done:${at}`,
  sessionId: SESSION,
  level: "done",
  reason: "done",
  task: "Morning bills",
  at,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("routine notices", () => {
  it("delivers a routine result as Routine results with its own title", async () => {
    const f = fixture();
    await f.notifier.notifyRoutine(run({}));
    expect(f.banners).toEqual([["Morning bills: Done", "Open localDot to see the result."]]);
    expect(f.pushes).toEqual([{ kind: "routine", sessionId: SESSION }]);
  });

  it("leaves Needs you to the routine's session, but raises the keep-running question", async () => {
    const f = fixture();
    await f.notifier.notifyRoutine(
      run({ outcome: "needs_you", title: "Morning bills: Needs you" }),
    );
    expect(f.banners).toEqual([]);
    await f.notifier.notifyRoutine(
      run({ outcome: "needs_you", sessionId: null, title: "Keep running Morning bills?" }),
    );
    expect(f.banners).toEqual([["dot needs you", "Keep running Morning bills?"]]);
  });

  it("stays quiet when the routine says not to, and while it is still running", async () => {
    const f = fixture();
    await f.notifier.notifyRoutine(run({ notify: false }));
    await f.notifier.notifyRoutine(
      run({ outcome: "running", runId: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH3" }),
    );
    expect(f.banners).toEqual([]);
  });

  it("tells each run's outcome once", async () => {
    const f = fixture();
    await f.notifier.notifyRoutine(run({}));
    await f.notifier.notifyRoutine(run({}));
    expect(f.banners).toHaveLength(1);
  });

  it("does not also announce a routine session's own Done, but still asks for it", async () => {
    const f = fixture([SESSION]);
    f.notifier.start();
    f.emit(done(1));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.banners).toEqual([]);
    expect(f.published).toHaveLength(1);
    f.emit({
      key: `${SESSION}:approval:a:1:1`,
      sessionId: SESSION,
      level: "needs_you",
      reason: "approval",
      task: "Morning bills",
      at: 2,
    });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.banners).toEqual([["dot needs you", "Morning bills"]]);
  });
});

describe("routine results heard from the app events", () => {
  it("tells a routine.run it hears once started, and nothing after it stops", async () => {
    const f = fixture([SESSION]);
    const stop = f.notifier.start();
    f.report(run({}));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.banners).toEqual([["Morning bills: Done", "Open localDot to see the result."]]);
    stop();
    f.report(run({ runId: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH3" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.banners).toHaveLength(1);
  });

  it("announces a routine session's Done itself while nothing tells routine results", async () => {
    const f = fixture([SESSION], false);
    f.notifier.start();
    f.emit(done(1));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.banners).toEqual([["Task done", "Morning bills"]]);
  });
});

describe("routine sessions in the ledger", () => {
  it("knows a session a routine started, after its Done is seen, until the session ends", () => {
    const ledger = new AttentionLedger(() => 1);
    let seq = 0;
    const observe = (sessionId: string, type: string, data: Record<string, unknown>) =>
      ledger.observe(sessionId, {
        v: 1,
        id: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH9",
        seq: seq++,
        at: "2026-10-08T11:00:00.000Z",
        type,
        data,
      } as unknown as LocalDotEvent);
    const start = (sessionId: string, origin?: unknown) =>
      observe(sessionId, "session.start", {
        screen: { w: 1280, h: 800, scale: 2 },
        os: "linux",
        title: "Morning bills",
        ...(origin ? { origin } : {}),
      });
    start(SESSION, { kind: "routine", runId: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH2" });
    start("01J9ZQ4V5W6X7Y8Z9ABCDEFGHK");
    expect(ledger.isRoutine(SESSION)).toBe(true);
    expect(ledger.isRoutine("01J9ZQ4V5W6X7Y8Z9ABCDEFGHK")).toBe(false);
    observe(SESSION, "agent.state", { state: "done" });
    expect(ledger.seen(SESSION)).toBe(true);
    expect(ledger.isRoutine(SESSION)).toBe(true);
    observe(SESSION, "session.end", { reason: "done" });
    expect(ledger.isRoutine(SESSION)).toBe(false);
  });
});
