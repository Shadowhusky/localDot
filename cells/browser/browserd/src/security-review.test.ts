import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CDP_REQUEST_TIMEOUT_MS, GuardedCdp } from "./cdp.ts";
import { type CdpCapabilities, guardCdpCommand } from "./cdp-guard.ts";
import { type CdpTransport, MAX_CDP_MESSAGE_BYTES, pipeTransport } from "./pipe.ts";

function capabilities(overrides: Partial<CdpCapabilities> = {}): CdpCapabilities {
  return {
    downloadDir: "/private/downloads",
    uploadDir: "/private/uploads",
    ownsTarget: (id) => id === "target",
    ownsSession: (id) => id === "owned",
    ownsWindow: (id) => id === 4,
    ownsNode: (session, id) => session === "owned" && id === 17,
    ownsDownload: () => false,
    allowsUpload: () => false,
    ...overrides,
  };
}
function fixture(caps = capabilities()) {
  let receive = (_text: string) => {};
  const writes: Record<string, unknown>[] = [];
  const closed = vi.fn(),
    fatal = vi.fn();
  const transport: CdpTransport = {
    write: (text) => {
      writes.push(JSON.parse(text) as Record<string, unknown>);
    },
    close: closed,
    onMessage: (listener) => {
      receive = listener;
      return () => {};
    },
    onClose: () => () => {},
  };
  return {
    broker: new GuardedCdp(transport, caps, fatal),
    writes,
    closed,
    fatal,
    receive: (value: unknown) => receive(JSON.stringify(value)),
  };
}
const outcome = (promise: Promise<Readonly<Record<string, unknown>>>) =>
  promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
afterEach(() => vi.useRealTimers());

describe("independent CDP authority and framing controls", () => {
  it("P1 owned query returns exactly its matching response without fatal containment", async () => {
    const f = fixture();
    const reply = outcome(f.broker.send("Page.enable", {}, { sessionId: "owned" }));
    try {
      expect(f.writes).toEqual([{ id: 1, method: "Page.enable", params: {}, sessionId: "owned" }]);
      f.receive({ id: 1, sessionId: "owned", result: { accepted: true } });
      await expect(reply).resolves.toEqual({ value: { accepted: true } });
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.broker.close();
      await reply;
    }
  });

  it("P2 explicit chooser receipt permits one owned staged upload and parameters are copied", async () => {
    const allows = vi.fn(
      (session: string, node: number, files: readonly string[]) =>
        session === "owned" && node === 17 && files[0] === "/private/uploads/approved",
    );
    const caps = capabilities({ allowsUpload: allows });
    const files = ["/private/uploads/approved"];
    const command = guardCdpCommand(
      "DOM.setFileInputFiles",
      { backendNodeId: 17, files },
      caps,
      "owned",
    );
    files[0] = "/private/uploads/other";
    expect(command.params.files).toEqual(["/private/uploads/approved"]);
    expect(Object.isFrozen(command.params.files)).toBe(true);
    const f = fixture(caps);
    const reply = outcome(f.broker.send(command.method, command.params, { sessionId: "owned" }));
    try {
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]?.params).toEqual({
        backendNodeId: 17,
        files: ["/private/uploads/approved"],
      });
      f.receive({ id: 1, sessionId: "owned", result: {} });
      await expect(reply).resolves.toEqual({ value: {} });
    } finally {
      f.broker.close();
      await reply;
    }
  });

  it("an in-directory file without a chooser receipt causes zero native writes", async () => {
    const f = fixture();
    const reply = outcome(
      f.broker.send(
        "DOM.setFileInputFiles",
        {
          backendNodeId: 17,
          files: ["/private/uploads/approved"],
        },
        { sessionId: "owned" },
      ),
    );
    try {
      expect(f.writes).toHaveLength(0);
      await expect(reply).resolves.toEqual({ error: "Browser command refused: upload" });
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.broker.close();
      await reply;
    }
  });

  it("a node owned by another session causes zero native writes", async () => {
    const f = fixture(capabilities({ ownsSession: () => true }));
    const reply = outcome(
      f.broker.send("DOM.getBoxModel", { backendNodeId: 17 }, { sessionId: "other" }),
    );
    try {
      expect(f.writes).toHaveLength(0);
      await expect(reply).resolves.toEqual({ error: "Browser command refused: scope" });
    } finally {
      f.broker.close();
      await reply;
    }
  });

  it("evaluation cookie and storage commands have no native write path", async () => {
    const f = fixture();
    try {
      for (const method of ["Runtime.evaluate", "Network.getAllCookies", "Storage.getCookies"])
        await expect(f.broker.send(method, {}, { sessionId: "owned" })).rejects.toThrow("method");
      expect(f.writes).toHaveLength(0);
    } finally {
      f.broker.close();
    }
  });

  it("a complete frame above the byte cap never reaches consumers", () => {
    const tx = new PassThrough(),
      rx = new PassThrough();
    const pipe = pipeTransport(tx, rx),
      seen = vi.fn(),
      closed = vi.fn();
    pipe.onMessage(seen);
    pipe.onClose(closed);
    try {
      rx.write(Buffer.concat([Buffer.alloc(MAX_CDP_MESSAGE_BYTES + 1, 65), Buffer.from([0])]));
      rx.emit("data", Buffer.from("{}\0"));
      expect(seen).toHaveBeenCalledTimes(0);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(tx.destroyed && rx.destroyed).toBe(true);
    } finally {
      pipe.close();
    }
  });

  it("malformed UTF8 retires a pipe after a valid message without delivering later data", () => {
    const tx = new PassThrough(),
      rx = new PassThrough();
    const pipe = pipeTransport(tx, rx),
      seen = vi.fn();
    pipe.onMessage(seen);
    try {
      rx.write(Buffer.from([123, 125, 0, 255, 0, 123, 125, 0]));
      expect(seen.mock.calls).toEqual([["{}"]]);
      expect(tx.destroyed && rx.destroyed).toBe(true);
    } finally {
      pipe.close();
    }
  });

  it("a foreign flattened response cannot publish a result to an owned request", async () => {
    const f = fixture();
    const reply = outcome(f.broker.send("Page.enable", {}, { sessionId: "owned" }));
    try {
      f.receive({ id: 1, sessionId: "foreign", result: { privateValue: "foreign-reply" } });
      await expect(reply).resolves.toEqual({ error: "Browser request refused: protocol" });
      expect(f.fatal).toHaveBeenCalledTimes(1);
      expect(f.closed).toHaveBeenCalledTimes(1);
    } finally {
      f.broker.close();
      await reply;
    }
  });

  it("a duplicate reply cannot satisfy the next request", async () => {
    const f = fixture();
    const first = outcome(f.broker.send("Browser.getVersion"));
    f.receive({ id: 1, result: { version: 1 } });
    await expect(first).resolves.toEqual({ value: { version: 1 } });
    const second = outcome(f.broker.send("Browser.getVersion"));
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    try {
      f.receive({ id: 1, result: { version: 0 } });
      await Promise.resolve();
      expect(settled).toBe(false);
      f.receive({ id: 2, result: { version: 2 } });
      await expect(second).resolves.toEqual({ value: { version: 2 } });
    } finally {
      f.broker.close();
      await second;
    }
  });

  it("post-write cancellation prevents every subsequent native write", async () => {
    const f = fixture(),
      abort = new AbortController();
    const first = outcome(
      f.broker.send("Page.enable", {}, { sessionId: "owned", signal: abort.signal }),
    );
    abort.abort();
    const second = outcome(f.broker.send("Browser.getVersion"));
    try {
      expect(f.writes).toHaveLength(1);
      await expect(first).resolves.toEqual({ error: "Browser request refused: cancelled" });
      await expect(second).resolves.toEqual({ error: "Browser request refused: closed" });
      expect(f.fatal).toHaveBeenCalledTimes(1);
    } finally {
      f.broker.close();
      await first;
      await second;
    }
  });

  it("the request deadline retires the pipe even after unrelated replies", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      reply = outcome(f.broker.send("Browser.getVersion"));
    try {
      await vi.advanceTimersByTimeAsync(CDP_REQUEST_TIMEOUT_MS - 1);
      f.receive({ id: 90, result: {} });
      expect(f.fatal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(reply).resolves.toEqual({ error: "Browser request refused: timeout" });
      expect(f.fatal).toHaveBeenCalledTimes(1);
      expect(f.closed).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.broker.close();
      await reply;
    }
  });

  it("browser error details stay private and an acknowledged failure permits a later query", async () => {
    const f = fixture();
    const first = outcome(f.broker.send("Browser.getVersion"));
    f.receive({ id: 1, error: { code: -32000, message: "private-token-must-not-escape" } });
    await expect(first).resolves.toEqual({ error: "Browser request refused: failed" });
    const second = outcome(f.broker.send("Browser.getVersion"));
    try {
      expect(f.writes).toHaveLength(2);
      f.receive({ id: 2, result: {} });
      await expect(second).resolves.toEqual({ value: {} });
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.broker.close();
      await second;
    }
  });
});
