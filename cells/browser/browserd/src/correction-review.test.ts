import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedCdp, MAX_CDP_PENDING } from "./cdp.ts";
import type { CdpCapabilities } from "./cdp-guard.ts";
import { type CdpTransport, pipeTransport } from "./pipe.ts";

function capabilities(overrides: Partial<CdpCapabilities> = {}): CdpCapabilities {
  return {
    downloadDir: "/private/downloads",
    uploadDir: "/private/uploads",
    ownsTarget: () => false,
    ownsSession: (id) => id === "owned",
    ownsWindow: () => false,
    ownsNode: () => false,
    ownsDownload: () => false,
    allowsUpload: () => false,
    ...overrides,
  };
}
function fixture(caps = capabilities()) {
  let receive = (_text: string) => {};
  const writes: Record<string, unknown>[] = [];
  const broker = new GuardedCdp(
    {
      write: (text) => {
        writes.push(JSON.parse(text) as Record<string, unknown>);
      },
      close: () => {},
      onClose: () => () => {},
      onMessage: (listener) => {
        receive = listener;
        return () => {};
      },
    },
    caps,
    () => {},
  );
  return { broker, writes, receive: (v: unknown) => receive(JSON.stringify(v)) };
}
afterEach(() => vi.useRealTimers());

describe("scoped correction boundary checks", () => {
  it("fatal hook precedes every cleanup and all attempts survive throwing callbacks", async () => {
    vi.useFakeTimers();
    const sequence: string[] = [];
    let receive = (_text: string) => {};
    const transport: CdpTransport = {
      write: () => {
        sequence.push("write");
      },
      onMessage: (listener) => {
        receive = listener;
        return () => {
          sequence.push("unsubscribe-message");
          throw new Error("private-one");
        };
      },
      onClose: () => () => {
        sequence.push("unsubscribe-close");
        throw new Error("private-two");
      },
      close: () => {
        sequence.push("transport-close");
        throw new Error("private-three");
      },
    };
    let rejectedReentrant: Promise<string> | undefined;
    const broker = new GuardedCdp(transport, capabilities(), () => {
      sequence.push("fatal");
      receive(JSON.stringify({ id: 1, result: { late: true } }));
      rejectedReentrant = broker.send("Browser.getVersion").then(
        () => "resolved",
        (e: Error) => e.message,
      );
      throw new Error("private-fatal");
    });
    const replies = [1, 2].map(() =>
      broker.send("Browser.getVersion").then(
        () => "resolved",
        (e: Error) => e.message,
      ),
    );
    expect(() => broker.close()).not.toThrow();
    await expect(Promise.all(replies)).resolves.toEqual([
      "Browser request refused: closed",
      "Browser request refused: closed",
    ]);
    await expect(rejectedReentrant).resolves.toBe("Browser request refused: closed");
    expect(sequence).toEqual([
      "write",
      "write",
      "fatal",
      "unsubscribe-message",
      "unsubscribe-close",
      "transport-close",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    broker.close();
    expect(sequence).toHaveLength(6);
  });

  it("broker skips a removed next listener and defers additions to the next packet", () => {
    const f = fixture(),
      seen: string[] = [];
    const late = () => {
      seen.push("late");
    };
    let changed = false,
      removeNext = () => {};
    f.broker.on("Page.loadEventFired", () => {
      seen.push("first");
      if (!changed) {
        changed = true;
        removeNext();
        f.broker.on("Page.loadEventFired", late);
      }
    });
    removeNext = f.broker.on("Page.loadEventFired", () => {
      seen.push("removed");
    });
    try {
      const packet = { method: "Page.loadEventFired", sessionId: "owned", params: {} };
      f.receive(packet);
      expect(seen).toEqual(["first"]);
      f.receive(packet);
      expect(seen).toEqual(["first", "first", "late"]);
    } finally {
      f.broker.close();
    }
  });

  it("pipe skips a removed next listener and defers additions to the next packet", () => {
    const tx = new PassThrough(),
      rx = new PassThrough(),
      pipe = pipeTransport(tx, rx);
    const seen: string[] = [],
      late = () => {
        seen.push("late");
      };
    let changed = false,
      removeNext = () => {};
    pipe.onMessage(() => {
      seen.push("first");
      if (!changed) {
        changed = true;
        removeNext();
        pipe.onMessage(late);
      }
    });
    removeNext = pipe.onMessage(() => {
      seen.push("removed");
    });
    try {
      rx.write(Buffer.from("{}\0"));
      expect(seen).toEqual(["first"]);
      rx.write(Buffer.from("{}\0"));
      expect(seen).toEqual(["first", "first", "late"]);
    } finally {
      pipe.close();
    }
  });

  it("capacity returned by a nested acknowledgement allows the outer owned request", async () => {
    const pending: Promise<unknown>[] = [];
    let f!: ReturnType<typeof fixture>;
    f = fixture(
      capabilities({
        ownsSession: () => {
          for (let i = 0; i < MAX_CDP_PENDING; i++)
            pending.push(f.broker.send("Browser.getVersion"));
          f.receive({ id: 1, result: {} });
          return true;
        },
      }),
    );
    const outer = f.broker.send("Page.enable", {}, { sessionId: "owned" });
    const all = Promise.all([...pending, outer]);
    try {
      expect(f.writes).toHaveLength(MAX_CDP_PENDING + 1);
      for (let id = 2; id <= MAX_CDP_PENDING; id++) f.receive({ id, result: {} });
      // The ownership predicate for the final reply must not enqueue another batch.
      // A root reply is unnecessary here: close proves all remaining ownership settles.
      f.broker.close();
      await expect(all).rejects.toThrow("closed");
    } finally {
      f.broker.close();
      await all.catch(() => {});
    }
  });
});
