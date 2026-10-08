import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedCdp, MAX_CDP_PENDING } from "./cdp.ts";
import type { CdpCapabilities } from "./cdp-guard.ts";
import { type CdpTransport, pipeTransport } from "./pipe.ts";

function capabilities(overrides: Partial<CdpCapabilities> = {}): CdpCapabilities {
  return {
    downloadDir: "/private/downloads",
    uploadDir: "/private/uploads",
    ownsTarget: (id) => id === "target",
    ownsSession: (id) => id === "owned",
    ownsWindow: () => false,
    ownsNode: () => false,
    ownsDownload: () => false,
    allowsUpload: () => false,
    ...overrides,
  };
}
function fixture(caps = capabilities(), options: { unsubscribeThrows?: boolean } = {}) {
  let receive = (_message: string) => {};
  let disconnected = () => {};
  const writes: Record<string, unknown>[] = [];
  const closed = vi.fn();
  const fatal = vi.fn();
  const removals: string[] = [];
  const transport: CdpTransport = {
    write(message) {
      writes.push(JSON.parse(message) as Record<string, unknown>);
    },
    close: closed,
    onMessage(listener) {
      receive = listener;
      return () => {
        removals.push("message");
        if (options.unsubscribeThrows) throw new Error("private-unsubscribe-details");
      };
    },
    onClose(listener) {
      disconnected = listener;
      return () => {
        removals.push("close");
      };
    },
  };
  const broker = new GuardedCdp(transport, caps, fatal);
  return {
    broker,
    writes,
    fatal,
    closed,
    removals,
    receive: (v: unknown) => receive(JSON.stringify(v)),
    disconnect: () => disconnected(),
  };
}
async function tick() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());

describe("independent private CDP lifecycle review", () => {
  it("normal owned request acknowledges once and cleans its timer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const reply = f.broker.send("Page.enable", {}, { sessionId: "owned" });
    expect(f.writes).toHaveLength(1);
    f.receive({ id: 1, sessionId: "owned", result: {} });
    await expect(reply).resolves.toEqual({});
    expect(vi.getTimerCount()).toBe(0);
    f.broker.close();
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(f.removals).toEqual(["message", "close"]);
    expect(f.closed).toHaveBeenCalledTimes(1);
  });

  it("close during synchronous ownership validation settles the unwritten request", async () => {
    vi.useFakeTimers();
    let f!: ReturnType<typeof fixture>;
    f = fixture(
      capabilities({
        ownsSession: () => {
          f.broker.close();
          return true;
        },
      }),
    );
    const outcomes: string[] = [];
    void f.broker.send("Page.enable", {}, { sessionId: "owned" }).then(
      () => {
        outcomes.push("resolved");
      },
      (error: Error) => {
        outcomes.push(error.message);
      },
    );
    await tick();
    expect(f.writes).toHaveLength(0);
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["Browser request refused: closed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reentrant admission during ownership validation cannot exceed the pending cap", async () => {
    const nested: Promise<unknown>[] = [];
    let f!: ReturnType<typeof fixture>;
    f = fixture(
      capabilities({
        ownsSession: () => {
          for (let i = 0; i < MAX_CDP_PENDING; i++)
            nested.push(f.broker.send("Browser.getVersion"));
          return true;
        },
      }),
    );
    const outer = f.broker.send("Page.enable", {}, { sessionId: "owned" });
    const outcome = outer.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    try {
      expect(f.writes).toHaveLength(MAX_CDP_PENDING);
      await expect(outcome).resolves.toBe("Browser request refused: busy");
    } finally {
      const draining = Promise.allSettled(nested);
      f.broker.close();
      await draining;
      await outcome;
    }
  });

  it("a signal cancelled during ownership validation still counts as pre-write cancellation", async () => {
    const cancelled = new AbortController();
    const f = fixture(
      capabilities({
        ownsSession: () => {
          cancelled.abort();
          return true;
        },
      }),
    );
    await expect(
      f.broker.send("Page.enable", {}, { sessionId: "owned", signal: cancelled.signal }),
    ).rejects.toThrow("cancelled");
    expect(f.writes).toHaveLength(0);
    expect(f.fatal).not.toHaveBeenCalled();
    expect(f.broker.closed).toBe(false);
    f.broker.close();
  });

  it("unsubscribe failure cannot prevent fatal containment and all other retirement", async () => {
    vi.useFakeTimers();
    const f = fixture(capabilities(), { unsubscribeThrows: true });
    const outcomes: string[] = [];
    void f.broker.send("Browser.getVersion").then(
      () => {
        outcomes.push("resolved");
      },
      (error: Error) => {
        outcomes.push(error.message);
      },
    );
    let escaped = false;
    try {
      f.broker.close();
    } catch {
      escaped = true;
    }
    await tick();
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(f.closed).toHaveBeenCalledTimes(1);
    expect(f.removals).toEqual(["message", "close"]);
    expect(outcomes).toEqual(["Browser request refused: closed"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(escaped).toBe(false);
  });

  it("a broker listener resubscription applies to the next event, not this same dispatch", () => {
    const f = fixture();
    let seen = 0;
    let remove = () => {};
    const listener = () => {
      seen++;
      if (seen < 3) {
        remove();
        remove = f.broker.on("Page.loadEventFired", listener);
      }
    };
    remove = f.broker.on("Page.loadEventFired", listener);
    f.receive({ method: "Page.loadEventFired", sessionId: "owned", params: { timestamp: 1 } });
    f.broker.close();
    expect(seen).toBe(1);
  });

  it("a pipe listener resubscription applies to the next message, not this same dispatch", () => {
    const tx = new PassThrough(),
      rx = new PassThrough();
    const pipe = pipeTransport(tx, rx);
    let seen = 0;
    let remove = () => {};
    const listener = () => {
      seen++;
      if (seen < 3) {
        remove();
        remove = pipe.onMessage(listener);
      }
    };
    remove = pipe.onMessage(listener);
    rx.write(Buffer.from("{}\0"));
    pipe.close();
    expect(seen).toBe(1);
  });

  it("normal independent pipe listeners each see one copy and close exactly once", () => {
    const tx = new PassThrough(),
      rx = new PassThrough();
    const pipe = pipeTransport(tx, rx);
    const a = vi.fn(),
      b = vi.fn(),
      closed = vi.fn();
    pipe.onMessage(a);
    pipe.onMessage(b);
    pipe.onClose(closed);
    rx.write(Buffer.from("{}\0"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    pipe.close();
    pipe.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(tx.destroyed && rx.destroyed).toBe(true);
  });
});
