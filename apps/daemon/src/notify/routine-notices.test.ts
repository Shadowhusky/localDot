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
  runId: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH2",
  outcome: "done",
  sessionId: SESSION,
  notify: true,
  title: "Morning bills: Done",
  ...extra,
});

function fixture(routineSessions: string[] = []) {
  const listeners = new Set<(item: AttentionItem) => void>();
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
    now: () => new Date("2026-10-08T11:00:00Z"),
    timeZone: () => "Europe/London",
  });
  const emit = (item: AttentionItem) => {
    current = item;
    for (const listener of listeners) listener(item);
  };
  return { notifier, emit, banners, pushes, published };
}

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
    f.emit({
      key: `${SESSION}:done:9`,
      sessionId: SESSION,
      level: "done",
      reason: "done",
      task: "Morning bills",
      at: 1,
    });
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

describe("routine sessions in the ledger", () => {
  it("knows a session a routine started, until it is cleared", () => {
    const ledger = new AttentionLedger(() => 1);
    const start = (sessionId: string, origin?: unknown) =>
      ledger.observe(sessionId, {
        v: 1,
        id: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH9",
        seq: 0,
        at: "2026-10-08T11:00:00.000Z",
        type: "session.start",
        data: {
          screen: { w: 1280, h: 800, scale: 2 },
          os: "linux",
          title: "Morning bills",
          ...(origin ? { origin } : {}),
        },
      } as unknown as LocalDotEvent);
    start(SESSION, { kind: "routine", runId: "01J9ZQ4V5W6X7Y8Z9ABCDEFGH2" });
    start("01J9ZQ4V5W6X7Y8Z9ABCDEFGHK");
    expect(ledger.isRoutine(SESSION)).toBe(true);
    expect(ledger.isRoutine("01J9ZQ4V5W6X7Y8Z9ABCDEFGHK")).toBe(false);
  });
});
