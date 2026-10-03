import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_METHODS } from "./protocol.ts";
import { AppServerRpc, type AppServerRpcOptions, RPC_MAX_LINE_BYTES, RpcError } from "./rpc.ts";

const controllers: AppServerRpc[] = [];
afterEach(() => {
  for (const rpc of controllers.splice(0)) rpc.close();
  vi.useRealTimers();
});
function setup(
  overrides: Partial<AppServerRpcOptions> = {},
  reply?: (msg: Record<string, unknown>) => unknown,
) {
  const input = new PassThrough(),
    output = new PassThrough(),
    owner = new AbortController();
  const sent: Record<string, unknown>[] = [],
    failures: RpcError[] = [],
    notes: string[] = [];
  let buf = "";
  output.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      sent.push(m);
      const r = reply?.(m);
      if (r !== undefined) input.write(`${JSON.stringify(r)}\n`);
    }
  });
  const rpc = new AppServerRpc({
    input,
    output,
    signal: owner.signal,
    onFailure: (e) => {
      failures.push(e);
    },
    onServerRequest: () => ({ result: {}, current: () => true }),
    onNotification: (m) => {
      notes.push(m);
    },
    ...overrides,
  });
  controllers.push(rpc);
  const send = (m: unknown) => input.write(`${JSON.stringify(m)}\n`);
  const request = (
    method: (typeof CLIENT_METHODS)[number] = "account/read",
    signal = new AbortController().signal,
    timeoutMs = 1000,
  ) => rpc.request(method, {}, { signal, timeoutMs, validateResult: (r) => r });
  return { rpc, input, output, owner, sent, failures, notes, send, request };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("owned bounded Codex JSONL transport", () => {
  it("speaks the exact envelope and installs pending ownership before an immediate reply", async () => {
    const p = setup({}, (m) =>
      m.method === "account/read"
        ? { id: m.id, result: { ok: 1 } }
        : m.method === "model/list"
          ? { id: m.id, error: { code: -32600, message: "FAKE-SECRET-UPSTREAM" } }
          : undefined,
    );
    expect(await p.request()).toEqual({ ok: 1 });
    const e = await p.request("model/list").catch((e) => e);
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(-32600);
    expect((e as RpcError).message).not.toContain("FAKE-");
    p.rpc.notify("initialized", {});
    expect(p.sent).toEqual([
      { id: 1, method: "account/read", params: {} },
      { id: 2, method: "model/list", params: {} },
      { method: "initialized", params: {} },
    ]);
  });
  it("refuses every forbidden outbound method and notification at runtime with fixed diagnostics", async () => {
    const p = setup();
    for (const m of [
      "command/exec",
      "fs/writeFile",
      "thread/shellCommand",
      "config/value/write",
      "feedback/upload",
      "plugin/install",
      "FAKE-SECRET-METHOD",
    ]) {
      const pending = p.request(m as never);
      void pending.catch(() => {});
      expect(p.sent).toEqual([]);
      const e = await pending.catch((e) => e);
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).message).not.toContain(m);
      expect((e as RpcError).method).toBe("rpc");
    }
    expect(() => p.rpc.notify("FAKE-SECRET-NOTE" as never, {})).toThrow(RpcError);
    expect(p.sent).toEqual([]);
    expect(Object.isFrozen(CLIENT_METHODS)).toBe(true);
  });
  it("abort before allocation sends nothing, and abort after write rejects exactly once", async () => {
    const p = setup(),
      canceled = new AbortController();
    canceled.abort();
    await expect(p.request("turn/start", canceled.signal)).rejects.toThrow(RpcError);
    expect(p.sent).toEqual([]);
    const a = new AbortController(),
      waiting = p.request("turn/start", a.signal);
    let rejected = 0;
    void waiting.catch(() => {
      rejected++;
    });
    a.abort();
    await expect(waiting).rejects.toThrow(RpcError);
    p.send({ id: 1, result: { late: true } });
    await flush();
    expect(rejected).toBe(1);
    expect(p.failures).toEqual([]);
  });
  it("owner abort fences callbacks synchronously and rejects pending and all later requests", async () => {
    let callbackSignal!: AbortSignal;
    const p = setup({
      onServerRequest: (_m, _p, ctx) => {
        callbackSignal = ctx.signal;
        return new Promise(() => {});
      },
    });
    p.send({ id: 0, method: "approval" });
    const waiting = p.request();
    void waiting.catch(() => {});
    p.owner.abort();
    expect(callbackSignal.aborted).toBe(true);
    await expect(waiting).rejects.toThrow(RpcError);
    await expect(p.request()).rejects.toThrow(RpcError);
    expect(() => p.rpc.notify("initialized", {})).toThrow(RpcError);
    expect(p.sent).toHaveLength(1);
    expect(p.failures).toEqual([]);
  });
  it("already retired owner acquires no listeners or writes", async () => {
    const owner = new AbortController();
    owner.abort();
    const p = setup({ signal: owner.signal });
    await expect(p.request()).rejects.toThrow(RpcError);
    expect(p.input.listenerCount("data")).toBe(0);
    expect(p.sent).toEqual([]);
  });
  it("timeouts release their slot and abort listener without retiring transport", async () => {
    vi.useFakeTimers();
    const p = setup(),
      signal = new AbortController().signal;
    const waiting = p.request("account/read", signal, 10);
    const caught = waiting.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(((await caught) as RpcError).code).toBe(-32001);
    expect(vi.getTimerCount()).toBe(0);
    p.send({ id: 1, result: { late: true } });
    const next = p.request();
    p.send({ id: 2, result: 2 });
    expect(await next).toBe(2);
    expect(p.failures).toEqual([]);
  });
  it("close clears every pending timeout and signal listener without waiting for server handlers", async () => {
    vi.useFakeTimers();
    const p = setup({ onServerRequest: () => new Promise(() => {}) });
    p.send({ id: 0, method: "approval", params: {} });
    const waits = Array.from({ length: 4 }, () => p.request().catch((e) => e));
    p.rpc.close();
    expect(vi.getTimerCount()).toBe(0);
    expect((await Promise.all(waits)).every((e) => e instanceof RpcError)).toBe(true);
    expect(p.sent).toHaveLength(4);
  });
  it("dispatches server ID zero and notifications, checking authority at the final write", async () => {
    const p = setup({
      onServerRequest: async (m) => ({ result: { method: m }, current: () => true }),
    });
    p.send({ id: 0, method: "item/fileChange/requestApproval", params: {} });
    p.send({ method: "turn/started", params: {} });
    await flush();
    expect(p.sent).toEqual([{ id: 0, result: { method: "item/fileChange/requestApproval" } }]);
    expect(p.notes).toEqual(["turn/started"]);
  });
  it.each(["guard", "close", "abort"])(
    "discards a delayed reply after %s retirement",
    async (how) => {
      let resolve!: (r: { result: unknown; current: () => boolean }) => void,
        live = true;
      const p = setup({
        onServerRequest: () =>
          new Promise((r) => {
            resolve = r;
          }),
      });
      p.send({ id: 0, method: "approval", params: {} });
      if (how === "guard") live = false;
      else if (how === "close") p.rpc.close();
      else p.owner.abort();
      resolve({ result: { accepted: true }, current: () => live });
      await flush();
      expect(p.sent).toEqual([]);
      expect(p.failures).toEqual([]);
    },
  );
  it("serializes first and rechecks guard after a result getter retires authority", async () => {
    let live = true;
    const p = setup({
      onServerRequest: () => ({
        result: {
          get accepted() {
            live = false;
            return true;
          },
        },
        current: () => live,
      }),
    });
    p.send({ id: 0, method: "approval" });
    await flush();
    expect(p.sent).toEqual([]);
  });
  it.each(["server", "notification", "guard"])(
    "consumes asynchronous %s failures and retires once without raw messages",
    async (which) => {
      const raw = new Error("FAKE-AUTH-CAPABILITY");
      const p = setup(
        which === "server"
          ? {
              onServerRequest: async () => {
                throw raw;
              },
            }
          : which === "notification"
            ? {
                onNotification: async () => {
                  throw raw;
                },
              }
            : {
                onServerRequest: () => ({
                  result: {},
                  current: () => {
                    throw raw;
                  },
                }),
              },
      );
      const waiting = p.request().catch((e) => e);
      p.send(which === "notification" ? { method: "turn/started" } : { id: 0, method: "approval" });
      await flush();
      expect(await waiting).toBeInstanceOf(RpcError);
      expect(p.failures).toHaveLength(1);
      expect(p.failures[0]?.message).not.toContain("FAKE-");
      expect(p.sent).toHaveLength(1);
    },
  );
  it("sanitizes server error replies, and refuses unguarded or malformed handler replies", async () => {
    const p = setup({
      onServerRequest: () => ({
        error: { code: -32601, message: "FAKE-SECRET" },
        current: () => true,
      }),
    });
    p.send({ id: "s", method: "unknown" });
    await flush();
    expect(p.sent).toEqual([
      { id: "s", error: { code: -32601, message: "localDot does not handle this Codex request." } },
    ]);
    const q = setup({ onServerRequest: () => ({ result: {} }) as never });
    q.send({ id: 0, method: "approval" });
    await flush();
    expect(q.failures).toHaveLength(1);
    expect(q.sent).toEqual([]);
  });
  it.each([
    null,
    [],
    1,
    "text",
    {},
    { result: {} },
    { id: 1 },
    { id: 1, result: {}, error: { code: 1, message: "m" } },
    { id: null, result: {} },
    { id: 1.5, result: {} },
    { id: 1, error: { code: "1", message: "m" } },
    { id: 1, error: { code: 1, message: 3 } },
    { method: 1 },
    { method: "" },
    { method: "x", result: {} },
    { id: 1, method: "x", error: {} },
    { jsonrpc: "2.0", id: 1, result: {} },
  ])("rejects malformed envelope %# as an owned failure", async (frame) => {
    const p = setup();
    const waiting = p.request().catch((e) => e);
    p.send(frame);
    await flush();
    expect(await waiting).toBeInstanceOf(RpcError);
    expect(p.failures).toHaveLength(1);
    expect(p.sent).toHaveLength(1);
  });
  it("rejects non-JSON and invalid UTF-8 without leaking line contents", async () => {
    for (const bytes of [Buffer.from("FAKE-SECRET\n"), Buffer.from([0xc3, 0x28, 0x0a])]) {
      const p = setup();
      p.input.write(bytes);
      await flush();
      expect(p.failures).toHaveLength(1);
      expect(p.failures[0]?.message).not.toContain("FAKE-");
    }
  });
  it("handles multibyte characters split across chunks and multiple lines per chunk", async () => {
    const p = setup();
    const waiting = p.request();
    const bytes = Buffer.from(
      JSON.stringify({ id: 1, result: "中文😀" }) +
        "\n" +
        JSON.stringify({ method: "note", params: {} }) +
        "\n",
    );
    const mid = bytes.indexOf(Buffer.from("中")) + 1;
    p.input.write(bytes.subarray(0, mid));
    p.input.write(bytes.subarray(mid));
    expect(await waiting).toBe("中文😀");
    expect(p.notes).toEqual(["note"]);
  });
  it("rejects a truncated final frame and owns clean EOF as transport failure", async () => {
    for (const partial of ["", '{"id":1']) {
      const p = setup(),
        waiting = p.request().catch((e) => e);
      if (partial) p.input.write(partial);
      p.input.end();
      await flush();
      expect(await waiting).toBeInstanceOf(RpcError);
      expect(p.failures).toHaveLength(1);
    }
  });
  it("enforces 8 MiB by bytes, accepts the exact boundary, and rejects chunked overrun early", async () => {
    const p = setup(),
      waiting = p.request();
    const prefix = '{"id":1,"result":"',
      suffix = '"}';
    const payload =
      prefix + "a".repeat(RPC_MAX_LINE_BYTES - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(payload)).toBe(RPC_MAX_LINE_BYTES);
    p.input.write(`${payload}\n`);
    expect(((await waiting) as string).length).toBe(
      RPC_MAX_LINE_BYTES - prefix.length - suffix.length,
    );
    const q = setup();
    q.input.write(Buffer.alloc(RPC_MAX_LINE_BYTES, 0x61));
    q.input.write("中");
    await flush();
    expect(q.failures).toHaveLength(1);
  });
  it("fences the entire transport if the required result schema rejects", async () => {
    const p = setup();
    const waiting = p.rpc
      .request(
        "account/read",
        {},
        {
          signal: new AbortController().signal,
          validateResult: () => {
            throw new Error("FAKE-SECRET-VALIDATOR");
          },
        },
      )
      .catch((e) => e);
    const other = p.request().catch((e) => e);
    p.send({ id: 1, result: {} });
    expect(await waiting).toBeInstanceOf(RpcError);
    expect(await other).toBeInstanceOf(RpcError);
    expect(p.failures).toHaveLength(1);
    expect(p.sent).toHaveLength(2);
  });
  it("a validating callback cannot resolve a retired request", async () => {
    const p = setup();
    const waiting = p.rpc
      .request(
        "account/read",
        {},
        {
          signal: new AbortController().signal,
          validateResult: (r) => {
            p.owner.abort();
            return r;
          },
        },
      )
      .catch((e) => e);
    p.send({ id: 1, result: 1 });
    expect(await waiting).toBeInstanceOf(RpcError);
  });
  it.each(["input-error", "input-close", "output-error", "output-close"])(
    "owns %s and ignores late pipe errors after close",
    async (which) => {
      const p = setup(),
        waiting = p.request().catch((e) => e);
      if (which === "input-error") p.input.emit("error", new Error("FAKE-RAW"));
      if (which === "output-error") p.output.emit("error", new Error("FAKE-RAW"));
      if (which === "input-close") p.input.emit("close");
      if (which === "output-close") p.output.emit("close");
      await flush();
      expect(await waiting).toBeInstanceOf(RpcError);
      expect(p.failures).toHaveLength(1);
      p.input.emit("error", new Error("late"));
      p.output.emit("error", new Error("late"));
      expect(p.failures).toHaveLength(1);
    },
  );
  it("owns asynchronous write callback EPIPE and onFailure rejection without unhandled rejection", async () => {
    const output = new Writable({
      write(_chunk, _enc, cb) {
        queueMicrotask(() => cb(new Error("FAKE-EPIPE")));
      },
    });
    const failures: RpcError[] = [];
    const p = setup({
      output,
      onFailure: async (e) => {
        failures.push(e);
        throw new Error("FAKE-HOOK");
      },
    });
    const waiting = p.request().catch((e) => e);
    await flush();
    expect(await waiting).toBeInstanceOf(RpcError);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).not.toContain("FAKE-");
  });
  it("refuses circular or oversized output before allocating a request and sanitizes thrown getters", async () => {
    const p = setup(),
      circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const params of [
      circular,
      { body: "x".repeat(RPC_MAX_LINE_BYTES) },
      {
        get auth() {
          throw new Error("FAKE-GETTER");
        },
      },
    ])
      await expect(
        p.rpc.request("account/read", params, {
          signal: new AbortController().signal,
          validateResult: (r) => r,
        }),
      ).rejects.toThrow(RpcError);
    expect(p.sent).toEqual([]);
    expect(p.failures).toEqual([]);
  });
  it("bounds concurrent pending requests and handler work independently", async () => {
    const p = setup();
    const waits = Array.from({ length: 64 }, () => p.request().catch((e) => e));
    await expect(p.request()).rejects.toThrow(RpcError);
    expect(p.sent).toHaveLength(64);
    p.rpc.close();
    await Promise.all(waits);
    const q = setup({ onServerRequest: () => new Promise(() => {}) });
    for (let i = 0; i < 65; i++) q.send({ id: i, method: "approval" });
    expect(q.failures).toHaveLength(1);
    expect(q.sent).toEqual([]);
  });
  it("rejects duplicate in-flight server IDs and ignores valid unknown response IDs", async () => {
    const p = setup({ onServerRequest: () => new Promise(() => {}) });
    p.send({ id: 0, method: "approval" });
    p.send({ id: 0, method: "approval" });
    expect(p.failures).toHaveLength(1);
    const q = setup();
    q.send({ id: 999, result: { late: true } });
    q.send({ id: "unmatched", error: { code: 1, message: "raw" } });
    expect(q.failures).toEqual([]);
  });
  it("passes an aborted signal to retired handlers and releases data/end listeners", async () => {
    let signal!: AbortSignal;
    const p = setup({
      onServerRequest: (_m, _p, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    });
    p.send({ id: 0, method: "approval" });
    p.rpc.close();
    expect(signal.aborted).toBe(true);
    expect(p.input.listenerCount("data")).toBe(0);
    expect(p.input.listenerCount("end")).toBe(0);
  });
});
it("does not mistake a synchronous notification burst for pending asynchronous callbacks", () => {
  const p = setup();
  p.input.write(
    `${Array.from({ length: 256 }, (_, i) => JSON.stringify({ method: "note", params: { i } })).join("\n")}\n`,
  );
  expect(p.notes).toHaveLength(256);
  expect(p.failures).toEqual([]);
});
it("rechecks retirement after serializing outbound request parameters", async () => {
  const p = setup();
  await expect(
    p.rpc.request(
      "account/read",
      {
        get auth() {
          p.owner.abort();
          return "fake";
        },
      },
      { signal: new AbortController().signal, validateResult: (r) => r },
    ),
  ).rejects.toThrow(RpcError);
  expect(p.sent).toEqual([]);
});
it("refuses missing request validators and invalid deadlines without sending", async () => {
  const p = setup();
  for (const timeoutMs of [-1, 0, 1.5, Infinity, 120001])
    await expect(
      p.rpc.request(
        "account/read",
        {},
        { signal: new AbortController().signal, timeoutMs, validateResult: (r) => r },
      ),
    ).rejects.toThrow(RpcError);
  await expect(
    p.rpc.request("account/read", {}, { signal: new AbortController().signal } as never),
  ).rejects.toThrow(RpcError);
  expect(p.sent).toEqual([]);
});

it("bounds queued pipe output when Codex stops reading", () => {
  const output = new Writable({ write(_c, _e, _cb) {} });
  const p = setup({
    output,
    onServerRequest: () => ({ result: "x".repeat(1024 * 1024), current: () => true }),
  });
  for (let i = 0; i < 9; i++) p.send({ id: i, method: "approval" });
  expect(p.failures).toHaveLength(1);
  expect(output.writableLength).toBeLessThanOrEqual(RPC_MAX_LINE_BYTES + 1);
});

it("consumes a rejected async validator before rejecting its required response", async () => {
  const p = setup(),
    rejected = Promise.reject(new Error("INERT_ASYNC_VALIDATOR"));
  const originalThen = rejected.then.bind(rejected);
  void originalThen(undefined, () => {});
  const subscription = vi.spyOn(rejected, "then");
  const waiting = p.rpc
    .request(
      "account/read",
      {},
      { signal: new AbortController().signal, validateResult: () => rejected },
    )
    .catch((e) => e);
  p.send({ id: 1, result: {} });
  await flush();
  expect(await waiting).toBeInstanceOf(RpcError);
  expect(subscription).toHaveBeenCalled();
  expect(p.failures).toHaveLength(1);
});
it.each([false, true])(
  "does not authorize a reply with an async guard result %s",
  async (allowed) => {
    const p = setup({
      onServerRequest: () => ({
        result: { action: "accept" },
        current: (async () => allowed) as unknown as () => boolean,
      }),
    });
    p.send({ id: 0, method: "approval" });
    await flush();
    expect(p.sent).toEqual([]);
    expect(p.failures).toHaveLength(1);
  },
);
it("consumes a rejected async guard and refuses other nonboolean authority", async () => {
  const rejected = Promise.reject(new Error("INERT_ASYNC_GUARD"));
  const originalThen = rejected.then.bind(rejected);
  void originalThen(undefined, () => {});
  const subscription = vi.spyOn(rejected, "then");
  const p = setup({
    onServerRequest: () => ({
      result: { action: "accept" },
      current: (() => rejected) as unknown as () => boolean,
    }),
  });
  p.send({ id: 0, method: "approval" });
  await flush();
  expect(p.sent).toEqual([]);
  expect(p.failures).toHaveLength(1);
  expect(subscription).toHaveBeenCalled();
  const q = setup({
    onServerRequest: () => ({
      result: { action: "accept" },
      current: (() => 1) as unknown as () => boolean,
    }),
  });
  q.send({ id: 0, method: "approval" });
  await flush();
  expect(q.sent).toEqual([]);
  expect(q.failures).toHaveLength(1);
});
