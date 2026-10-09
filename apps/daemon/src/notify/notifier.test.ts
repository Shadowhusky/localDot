import {
  type AttentionChangeEvent,
  type AttentionItem,
  DEFAULT_NOTIFY_SETTINGS,
} from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier, SETTLE_MS } from "./notifier.ts";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const item = (key: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  key: `${SESSION}:${key}`,
  sessionId: SESSION,
  level: "needs_you",
  reason: "approval",
  task: "Pay the electricity bill",
  at: 1,
  ...extra,
});

function fixture(
  presence = { localVisible: false, localHiddenCanNotify: false },
  confirms = true,
  expires?: number,
) {
  const listeners = new Set<(item: AttentionItem) => void>();
  let current: AttentionItem | undefined;
  const published: AttentionChangeEvent[] = [];
  const banners: [string, string][] = [];
  const pushes: unknown[] = [];
  const options: unknown[] = [];
  const notifier = new Notifier({
    ledger: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      current: () => current,
      approvalExpiresAt: () => expires,
      isRoutine: () => false,
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
      sendAll: async (payload, opts) => {
        pushes.push(payload);
        options.push(opts);
        return [{ id: "0123456789abcdef", label: "iPhone", result: "sent" }];
      },
    },
    presence: { snapshot: () => presence, waitForShown: async () => confirms },
    publish: (event) => published.push(event),
    now: () => new Date("2026-10-08T11:00:00Z"),
    timeZone: () => "Europe/London",
  });
  const emit = (next: AttentionItem | undefined, change = next) => {
    current = next;
    if (change) for (const listener of listeners) listener(change);
  };
  return { notifier, emit, published, banners, pushes, options };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Notifier", () => {
  it("publishes each change at once and notifies once it has settled", async () => {
    const f = fixture();
    f.notifier.start();
    f.emit(item("approval:a:1:1"));
    expect(f.published.map((e) => e.page)).toEqual([false]);
    expect(f.banners).toEqual([]);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.banners).toEqual([["dot needs you", "Pay the electricity bill"]]);
    expect(f.pushes).toEqual([{ kind: "needs_you", sessionId: SESSION }]);
  });

  it("pings only for the revision still waiting, and not at all for one answered in time", async () => {
    const f = fixture();
    f.notifier.start();
    f.emit(item("approval:a:1:1"));
    await vi.advanceTimersByTimeAsync(500);
    f.emit(item("approval:a:1:2"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.pushes).toHaveLength(1);
    f.emit(item("approval:b:1:1"));
    f.emit(undefined, item("working:9", { level: "working", reason: "working" }));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.pushes).toHaveLength(1);
  });

  it("never delivers the same key twice", async () => {
    const f = fixture();
    f.notifier.start();
    f.emit(item("done:4", { level: "done", reason: "done" }));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    f.emit(item("done:4", { level: "done", reason: "done" }));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.banners).toEqual([["Task done", "Pay the electricity bill"]]);
  });

  it("lets a hidden tab on this Mac show it instead of a banner", async () => {
    const f = fixture({ localVisible: false, localHiddenCanNotify: true });
    f.notifier.start();
    f.emit(item("approval:a:1:1"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.banners).toEqual([]);
    expect(f.published.map((e) => e.page)).toEqual([false, true]);
    expect(f.pushes).toHaveLength(1);
  });

  it("falls back to the banner when the hidden tab never confirms", async () => {
    const f = fixture({ localVisible: false, localHiddenCanNotify: true }, false);
    f.notifier.start();
    f.emit(item("approval:a:1:1"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.published.map((e) => e.page)).toEqual([false, true]);
    expect(f.banners).toEqual([["dot needs you", "Pay the electricity bill"]]);
  });

  it("lets an approval's push live as long as its card", async () => {
    const f = fixture(undefined, true, Date.parse("2026-10-08T11:00:00Z") + 3_600_000);
    f.notifier.start();
    f.emit(item("approval:a:1:1"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.options).toEqual([{ ttl: 3600, urgency: "high" }]);
  });

  it("stops its timers when stopped", async () => {
    const f = fixture();
    const stop = f.notifier.start();
    f.emit(item("approval:a:1:1"));
    stop();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.pushes).toEqual([]);
  });

  it("sends a test to the Mac and every phone, ignoring switches", async () => {
    const f = fixture({ localVisible: true, localHiddenCanNotify: false });
    await expect(f.notifier.test()).resolves.toEqual({
      mac: "shown",
      phones: [{ id: "0123456789abcdef", label: "iPhone", result: "sent" }],
    });
    expect(f.banners).toEqual([["Notifications are on", "This is a test from localDot."]]);
    expect(f.pushes).toEqual([{ kind: "test", sessionId: null }]);
  });
});
