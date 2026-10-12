import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { basename, join } from "node:path";
import { type CodexTurnEpoch, prepareOwnedCodexRoots } from "@localdot/codex-harness";
import {
  DEFAULT_RESEARCH_BUDGET,
  offeredTools,
  TOOL_NAMES,
  type ToolResult,
  ulid,
} from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actPolicy } from "../policy.ts";
import { redactor } from "../redact.ts";
import { ResearchLog } from "../research.ts";
import { AgentSession } from "../session.ts";
import { toolHarness } from "../testing/harness.ts";
import { dispatchTool } from "../tools/index.ts";
import {
  MAX_MCP_CONNECTIONS,
  MAX_MCP_MESSAGE_BYTES,
  type McpEndpoint,
  McpEndpointError,
  type McpEndpointInput,
  openMcpEndpoint,
} from "./mcp-endpoint.ts";

const harnesses: ReturnType<typeof toolHarness>[] = [];
const endpoints: McpEndpoint[] = [],
  clients: Socket[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const e of endpoints.splice(0)) await e.close();
  for (const h of harnesses.splice(0)) h.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const PNG = "iVBORw0KGgo=";
const tick = () => new Promise<void>((r) => setTimeout(r, 10));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function client(socket: string) {
  const sock = connect(socket);
  clients.push(sock);
  let buf = "",
    id = 0;
  const waiting = new Map<number, (m: Record<string, unknown>) => void>(),
    messages: Record<string, unknown>[] = [];
  sock.on("error", () => {});
  sock.on("data", (d) => {
    buf += d.toString();
    for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, n));
      buf = buf.slice(n + 1);
      messages.push(msg);
      const done = waiting.get(msg.id);
      waiting.delete(msg.id);
      done?.(msg);
    }
  });
  const closed = new Promise<void>((r) => sock.once("close", r));
  const send = (m: unknown) => sock.write(`${JSON.stringify(m)}\n`);
  function request(method: string, params: unknown, requestId = ++id) {
    return new Promise<Record<string, unknown>>((r) => {
      waiting.set(requestId, r);
      send({ jsonrpc: "2.0", id: requestId, method, params });
    });
  }
  const ready = async () => {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fixture", version: "0.154.0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return { sock, request, send, ready, closed, messages };
}
async function fixture(
  options: Partial<Pick<McpEndpointInput, "dispatch" | "onResult" | "onRetire">> = {},
  installTurn = true,
  sharedSession?: AgentSession,
) {
  const base = mkdtempSync("/tmp/ld7-");
  roots.push(base);
  const real = join(base, "user");
  mkdirSync(real, { mode: 0o700 });
  const owned = prepareOwnedCodexRoots(join(base, "ld"), real),
    session =
      sharedSession ??
      new AgentSession(ulid(), "fixture-cell", "fixture", {
        append: (_id, event) => event as never,
      }),
    generation = session.generation ?? session.beginBrain(),
    auth = new AbortController(),
    stop = new AbortController();
  let authGeneration = 1;
  const calls: { name: string; input: unknown; context: unknown }[] = [],
    results: string[] = [],
    retired: string[] = [];
  const ep = await openMcpEndpoint({
    roots: owned,
    session,
    generation,
    authGeneration: 1,
    currentAuthGeneration: () => authGeneration,
    authSignal: auth.signal,
    signal: stop.signal,
    dispatch: async (name, _id, input, context) => {
      calls.push({ name, input, context });
      return {
        status: 200,
        result: {
          ok: true,
          content: [{ type: "image", frameId: ulid(), mediaType: "image/png", data: PNG }],
        },
      };
    },
    onResult: (name) => {
      results.push(name);
    },
    onRetire: (reason) => {
      retired.push(reason);
    },
    ...options,
  });
  endpoints.push(ep);
  const frame = ulid(),
    epochAbort = new AbortController(),
    epoch: CodexTurnEpoch = Object.freeze({
      id: 1,
      signal: epochAbort.signal,
      basisFrameId: frame,
    });
  if (installTurn) ep.setTurn(epoch);
  const c = client(ep.socket);
  await c.ready();
  return {
    ep,
    c,
    owned,
    base,
    session,
    generation,
    auth,
    stop,
    epoch,
    epochAbort,
    frame,
    calls,
    results,
    retired,
    setAuth: (n: number) => {
      authGeneration = n;
    },
  };
}
const call = (
  c: ReturnType<typeof client>,
  name = "computer",
  args: unknown = { action: "screenshot" },
  id?: number,
) => c.request("tools/call", { name, arguments: args }, id);
describe("private Codex MCP capability", () => {
  it("owns a 128-bit canonical 0700 folder and 0600 socket and cleans that exact directory", async () => {
    const f = await fixture();
    expect(basename(f.ep.dir)).toMatch(/^[a-f0-9]{32}$/);
    expect(f.ep.dir).toBe(join(f.owned.runRoot, basename(f.ep.dir)));
    expect(f.ep.socket).toBe(join(f.ep.dir, "m.sock"));
    expect(lstatSync(f.ep.dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(f.ep.socket).isSocket()).toBe(true);
    expect(lstatSync(f.ep.socket).mode & 0o777).toBe(0o600);
    await f.ep.close();
    expect(existsSync(f.ep.dir)).toBe(false);
    expect(existsSync(f.owned.home)).toBe(true);
  });
  it("lists exactly the shared v1 tools with computer basedOn omitted, even before first turn", async () => {
    const f = await fixture({}, false),
      reply = await f.c.request("tools/list", {});
    const tools = (
      reply.result as { tools: { name: string; inputSchema: { properties: object } }[] }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([...offeredTools(false)]);
    expect(
      Object.keys(tools.find((t) => t.name === "computer")?.inputSchema.properties ?? {}),
    ).not.toContain("basedOn");
    expect(JSON.stringify(reply)).not.toContain("$schema");
    const denied = await call(f.c);
    expect(denied).toHaveProperty("error");
    expect(f.calls).toEqual([]);
  });
  it("lists the task's connected apps' tools after the v1 table", async () => {
    const f = await fixture({}, false);
    const spec = {
      name: "linear__list_issues",
      app: "Linear",
      description: "Linear (the user's connected app): List issues.",
      inputSchema: { type: "object", properties: { team: { type: "string" } } },
    };
    f.session.connectors = { specs: [spec], get: () => undefined };
    const reply = await f.c.request("tools/list", {});
    const tools = (reply.result as { tools: { name: string; description: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([...offeredTools(false), "linear__list_issues"]);
    expect(tools.at(-1)).toMatchObject({
      description: spec.description,
      inputSchema: spec.inputSchema,
    });
  });
  it("lists the research tool to a research task", async () => {
    const session = new AgentSession(ulid(), "fixture-cell", "fixture", {
      append: (_id, event) => event as never,
    });
    session.research = new ResearchLog(DEFAULT_RESEARCH_BUDGET, () => {});
    const f = await fixture({}, false, session),
      reply = await f.c.request("tools/list", {});
    const tools = (reply.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });
  it("captures one full-frame turn basis, ignores caller basedOn and preserves it after newer results", async () => {
    const f = await fixture();
    f.session.lastFrameId = ulid();
    for (let i = 0; i < 2; i++) {
      const r = await call(f.c, "computer", {
        action: "click",
        point: { x: 900, y: 400 },
        basedOn: ulid(),
      });
      expect(r.result).toMatchObject({
        isError: false,
        content: [{ type: "image", data: PNG, mimeType: "image/png" }],
      });
      f.session.lastFrameId = ulid();
    }
    expect(f.calls.map((c) => (c.input as { basedOn: string }).basedOn)).toEqual([
      f.frame,
      f.frame,
    ]);
    expect(f.results).toEqual(["computer", "computer"]);
  });
  it("bases browser_act's coordinate on the turn's screenshot, whatever the caller says", async () => {
    const f = await fixture();
    await call(f.c, "browser_act", {
      action: "click",
      ref: "e4",
      coordinate: [100, 200],
      basedOn: ulid(),
    });
    expect(f.calls.map((c) => c.input)).toEqual([
      { action: "click", ref: "e4", coordinate: [100, 200], basedOn: f.frame },
    ]);
  });
  it("refuses a batch longer than a model's batch without dispatching it", async () => {
    const f = await fixture();
    const key = { action: "key", keys: ["Tab"] };
    const long = await call(f.c, "computer", { action: "batch", steps: Array(9).fill(key) });
    expect(long.result).toMatchObject({ isError: true });
    expect(JSON.stringify(long.result)).toContain("at most 8 steps");
    expect(f.calls).toEqual([]);
    await call(f.c, "computer", { action: "batch", steps: Array(8).fill(key) });
    expect(f.calls).toHaveLength(1);
  });
  it("dispatches unknown names through the same daemon policy and generation context", async () => {
    let context: unknown;
    const f = await fixture({
      dispatch: async (_n, id, _args, ctx) => {
        context = ctx;
        expect(id).toMatch(/^codex-[0-9A-HJKMNP-TV-Z]{26}$/);
        return {
          status: 404,
          result: { ok: false, content: [{ type: "text", text: "not a v1 tool" }] },
        };
      },
    });
    expect((await call(f.c, "exec_command", {})).result).toMatchObject({ isError: true });
    expect(context).toMatchObject({
      generation: f.generation,
      authGeneration: 1,
      turnEpoch: f.epoch,
      basisFrameId: f.frame,
    });
  });
  it("runs admitted calls one at a time in wire order", async () => {
    const gate = deferred<void>(),
      order: string[] = [];
    const f = await fixture({
      dispatch: async (_n, _id, args) => {
        const tag = (args as { tag: string }).tag;
        order.push(`start ${tag}`);
        if (tag === "a") await gate.promise;
        order.push(`end ${tag}`);
        return { status: 200, result: { ok: true, content: [] } };
      },
    });
    const a = call(f.c, "files", { tag: "a" }),
      b = call(f.c, "files", { tag: "b" });
    await tick();
    expect(order).toEqual(["start a"]);
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });
  it.each([
    "close",
    "turn",
    "done",
    "disconnect",
    "cancel",
    "replacement",
    "auth",
    "takeover",
    "stop",
  ])("fences A, queued B and stale images after %s", async (kind) => {
    let admittedSignal!: AbortSignal;
    const gate = deferred<ToolResult>(),
      started = deferred<void>(),
      calls: string[] = [],
      results: string[] = [];
    const f = await fixture({
      dispatch: async (_n, _id, args, ctx) => {
        admittedSignal = ctx.signal;
        calls.push((args as { tag: string }).tag);
        started.resolve();
        const result = await gate.promise;
        if (ctx.signal.aborted) return { status: 200, result: { ok: false, content: [] } };
        return { status: 200, result };
      },
      onResult: () => {
        results.push("success");
      },
    });
    void call(f.c, "files", { tag: "a" });
    void call(f.c, "files", { tag: "b" });
    await started.promise;
    await tick();
    if (kind === "close") await f.ep.close();
    if (kind === "turn") f.ep.retireTurn(f.epoch);
    if (kind === "disconnect") f.c.sock.destroy();
    if (kind === "cancel")
      f.c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    if (kind === "replacement") {
      f.session.retireBrain(f.generation);
      f.session.beginBrain();
    }
    if (kind === "auth") {
      f.setAuth(2);
      f.auth.abort();
    }
    if (kind === "takeover") void f.session.takeover("login", "fixture").catch(() => {});
    if (kind === "stop") f.stop.abort();
    if (kind === "disconnect" || kind === "cancel")
      await new Promise<void>((resolve) => {
        if (admittedSignal.aborted) resolve();
        else admittedSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    gate.resolve({
      ok: true,
      ...(kind === "done" ? { final: true } : {}),
      content: [{ type: "image", frameId: ulid(), mediaType: "image/png", data: PNG }],
    });
    await tick();
    await tick();
    expect(calls).toEqual(["a"]);
    expect(results).toEqual(kind === "done" ? ["success"] : []);
    expect(f.c.messages.filter((m) => JSON.stringify(m).includes(PNG))).toEqual([]);
    if (kind === "takeover") expect(f.session.controlHeld).toBe(true);
  });
  it("cancels request ID zero through the transport", async () => {
    const started = deferred<void>();
    let signal!: AbortSignal;
    const f = await fixture({
      dispatch: async (_n, _i, _a, ctx) => {
        signal = ctx.signal;
        started.resolve();
        return new Promise(() => {});
      },
    });
    void call(f.c, "files", {}, 0);
    await started.promise;
    f.c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0 } });
    await tick();
    expect(signal.aborted).toBe(true);
    await f.ep.close();
  });
  it("retires the whole turn on structured stale cancellation before returning its newer image", async () => {
    const f = await fixture({
      dispatch: async () => ({
        status: 200,
        result: {
          ok: false,
          cancelled: "stale",
          content: [{ type: "image", frameId: ulid(), mediaType: "image/png", data: PNG }],
        },
      }),
    });
    void call(f.c);
    await tick();
    expect(f.retired).toContain("stale");
    expect(f.c.messages.filter((m) => JSON.stringify(m).includes(PNG))).toEqual([]);
    expect(() =>
      f.ep.setTurn(Object.freeze({ ...f.epoch, id: 2, basisFrameId: ulid() })),
    ).toThrow();
  });
  it("bounds globally pending tool work at eight without dispatching excess", async () => {
    const gate = deferred<void>(),
      started = deferred<void>();
    let n = 0;
    const f = await fixture({
      dispatch: async () => {
        n++;
        started.resolve();
        await gate.promise;
        return { status: 200, result: { ok: true, content: [] } };
      },
    });
    for (let i = 0; i < 8; i++) void call(f.c, "files", { i });
    await started.promise;
    void call(f.c, "files", { i: 9 });
    await tick();
    const refused = f.c.messages.find((message) => message.id === 10);
    expect(refused?.error).toMatchObject({ code: -32000 });
    expect(n).toBe(1);
    gate.resolve();
    await tick();
    expect(n).toBe(8);
  });
  it("admits four live connections and drops the fifth", async () => {
    const f = await fixture(),
      extra = Array.from({ length: MAX_MCP_CONNECTIONS - 1 }, () => client(f.ep.socket));
    await Promise.all(extra.map((c) => c.ready()));
    expect(f.ep.connections()).toBe(4);
    const last = client(f.ep.socket);
    await last.closed;
    expect(f.ep.connections()).toBe(4);
  });
  it("refuses forged roots and swapped parent links without leaking socket capabilities", async () => {
    const f = await fixture();
    await expect(
      openMcpEndpoint({
        roots: { ...f.owned },
        session: f.session,
        generation: f.generation,
        authGeneration: 1,
        currentAuthGeneration: () => 1,
        authSignal: new AbortController().signal,
        signal: new AbortController().signal,
        dispatch: async () => ({ status: 200, result: { ok: true, content: [] } }),
      }),
    ).rejects.toThrow("The localDot Codex tool bridge could not be opened.");
    await f.ep.close();
    const foreign = join(f.base, "foreign");
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(join(foreign, "sentinel"), "fixture-owned data");
    rmSync(f.owned.runRoot, { recursive: true });
    symlinkSync(foreign, f.owned.runRoot);
    await expect(
      openMcpEndpoint({
        roots: f.owned,
        session: f.session,
        generation: f.generation,
        authGeneration: 1,
        currentAuthGeneration: () => 1,
        authSignal: new AbortController().signal,
        signal: new AbortController().signal,
        dispatch: async () => ({ status: 200, result: { ok: true, content: [] } }),
      }),
    ).rejects.toThrow(McpEndpointError);
    expect(readdirSync(foreign)).toEqual(["sentinel"]);
  });
  it("drops malformed or oversized input with safe diagnostics and no tool calls", async () => {
    const f = await fixture();
    const c = client(f.ep.socket);
    await c.ready();
    c.sock.write("null\n");
    await c.closed;
    expect(f.calls).toEqual([]);
    const d = client(f.ep.socket);
    await d.ready();
    d.sock.write(Buffer.alloc(MAX_MCP_MESSAGE_BYTES + 1, 0x61));
    await d.closed;
    expect(d.sock.destroyed).toBe(true);
    expect(f.calls).toEqual([]);
  });
  it("close completes while a dispatcher ignores abort and caller remains alive", async () => {
    const started = deferred<void>();
    const f = await fixture({
      dispatch: async () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    void call(f.c);
    await started.promise;
    await f.ep.close();
    expect(f.session.stopped).toBe(false);
    expect(existsSync(f.ep.dir)).toBe(false);
  });
});

it("releases admission slots when the MCP SDK refuses malformed tool params before dispatch", async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) {
    const invalid = await f.c.request("tools/call", { name: 3, arguments: {} });
    expect(invalid).toHaveProperty("error");
  }
  expect(f.calls).toEqual([]);
  const successful = await call(f.c);
  expect(successful.result).toBeDefined();
  expect(successful.result).toHaveProperty("isError", false);
  expect(f.calls).toHaveLength(1);
});
it("does not retire the current epoch through an identical cloned epoch", async () => {
  const f = await fixture();
  f.ep.retireTurn(Object.freeze({ ...f.epoch }));
  expect((await call(f.c)).result).toHaveProperty("isError", false);
});
it("rechecks tool authority at the transport write after a result getter retires the turn", async () => {
  let endpoint!: McpEndpoint, epoch!: CodexTurnEpoch;
  const f = await fixture({
    dispatch: async () => ({
      status: 200,
      result: {
        ok: true,
        content: [
          {
            type: "image",
            frameId: ulid(),
            mediaType: "image/png",
            get data() {
              endpoint.retireTurn(epoch);
              return PNG;
            },
          },
        ],
      },
    }),
  });
  endpoint = f.ep;
  epoch = f.epoch;
  const reply = await call(f.c);
  expect(reply).toHaveProperty("error");
  expect(JSON.stringify(reply)).not.toContain(PNG);
});
it("consumes a rejected async result hook and retires before publishing success", async () => {
  const rejected = Promise.reject(new Error("INERT_HOOK_AUTH_CAPABILITY"));
  const originalThen = rejected.then.bind(rejected);
  void originalThen(undefined, () => {});
  const subscribed = vi.spyOn(rejected, "then");
  const f = await fixture({ onResult: () => rejected });
  const reply = await call(f.c);
  expect(reply).toHaveProperty("error");
  expect(subscribed).toHaveBeenCalled();
  expect(f.retired).toContain("failure");
  expect(JSON.stringify(reply)).not.toContain("INERT_");
});
it("refuses a changed auth generation even without its owner's abort notification", async () => {
  const f = await fixture();
  f.setAuth(2);
  void call(f.c);
  await tick();
  expect(f.calls).toEqual([]);
  await f.c.closed;
});
it("accepts byte-bounded chunked UTF8 frames and drops invalid UTF8", async () => {
  const f = await fixture(),
    id = 12,
    message = `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { padding: "中😀" } })}\n`,
    bytes = Buffer.from(message),
    mid = bytes.indexOf(Buffer.from("中")) + 1;
  f.c.sock.write(bytes.subarray(0, mid));
  f.c.sock.write(bytes.subarray(mid));
  await vi.waitFor(() => expect(f.c.messages.some((m) => m.id === id && "result" in m)).toBe(true));
  const c = client(f.ep.socket);
  await c.ready();
  c.sock.write(Buffer.from([0xc3, 0x28, 0x0a]));
  await c.closed;
});
it("accepts the exact 4 MiB inbound line limit", async () => {
  const f = await fixture(),
    prefix = '{"jsonrpc":"2.0","id":11,"method":"tools/list","params":{"padding":"',
    suffix = '"}}';
  const line = prefix + "x".repeat(MAX_MCP_MESSAGE_BYTES - prefix.length - suffix.length) + suffix;
  expect(Buffer.byteLength(line)).toBe(MAX_MCP_MESSAGE_BYTES);
  f.c.sock.write(`${line}\n`);
  for (let i = 0; i < 20 && !f.c.messages.some((m) => m.id === 11); i++) await tick();
  expect(f.c.messages.find((m) => m.id === 11)).toHaveProperty("result");
});
it("rejects Stop before or during socket startup and leaves no owned run directory", async () => {
  const f = await fixture();
  await f.ep.close();
  for (const early of [true, false]) {
    const stop = new AbortController();
    if (early) stop.abort();
    const starting = openMcpEndpoint({
      roots: f.owned,
      session: f.session,
      generation: f.generation,
      authGeneration: 1,
      currentAuthGeneration: () => 1,
      authSignal: new AbortController().signal,
      signal: stop.signal,
      dispatch: async () => ({ status: 200, result: { ok: true, content: [] } }),
    });
    if (!early) stop.abort();
    await expect(starting).rejects.toThrow(McpEndpointError);
    expect(readdirSync(f.owned.runRoot)).toEqual([]);
  }
});
it("refuses overlong canonical socket paths and does not echo them or leave a directory", async () => {
  const base = mkdtempSync("/tmp/ld7-");
  roots.push(base);
  const user = join(base, "user");
  mkdirSync(user, { mode: 0o700 });
  const owned = prepareOwnedCodexRoots(join(base, `nested-${"a".repeat(90)}`), user),
    session = new AgentSession(ulid(), "fixture", "fixture", { append: (_id, e) => e as never }),
    generation = session.beginBrain();
  await expect(
    openMcpEndpoint({
      roots: owned,
      session,
      generation,
      authGeneration: 1,
      currentAuthGeneration: () => 1,
      authSignal: new AbortController().signal,
      signal: new AbortController().signal,
      dispatch: async () => ({ status: 200, result: { ok: true, content: [] } }),
    }),
  ).rejects.toThrow("The localDot Codex tool bridge could not be opened.");
  expect(readdirSync(owned.runRoot)).toEqual([]);
});

it.each(["normal", "png", "journal"])(
  "uses the shared dispatcher stale cause to cancel the turn without replaying the click after %s",
  async (failure) => {
    const h = toolHarness();
    harnesses.push(h);
    h.setOutcome(() => ({ ok: false, cancelled: "stale", frameId: ulid() }));
    if (failure === "png")
      vi.spyOn(h.tools.png, "png").mockRejectedValue(new Error("fixture image read failed"));
    if (failure === "journal") {
      const append = h.session.append.bind(h.session);
      vi.spyOn(h.session, "append").mockImplementation((type, data, step) => {
        if (type === "step.end" && h.actions.length)
          throw new Error("fixture journal write failed");
        return append(type, data, step);
      });
    }
    const f = await fixture(
      {
        dispatch: (name, id, args, ctx) =>
          dispatchTool(
            { tools: h.tools, policy: actPolicy },
            h.session,
            name,
            id,
            args,
            redactor([]),
            ctx.generation,
            ctx.signal,
          ),
      },
      true,
      h.session,
    );
    const first = call(f.c, "computer", { action: "click", point: { x: 10, y: 20 } }),
      second = call(f.c, "computer", { action: "click", point: { x: 11, y: 21 } });
    expect(await first).toHaveProperty("error");
    expect(await second).toHaveProperty("error");
    expect(h.actions).toHaveLength(1);
    expect(h.session.toolCalls).toBe(1);
    expect(h.actions[0]?.action).toHaveProperty("basedOn", f.frame);
    expect(f.retired).toEqual(["stale"]);
  },
);
it("shares the daemon takeover drain and preserves control when the Codex caller retires", async () => {
  const h = toolHarness();
  harnesses.push(h);
  const gate = deferred<{ kind: "act" }>(),
    entered = deferred<void>(),
    observe = vi.spyOn(h.tools.gateway, "observe");
  const f = await fixture(
    {
      dispatch: (name, id, args, ctx) =>
        dispatchTool(
          {
            tools: h.tools,
            policy: {
              decide: () => {
                entered.resolve();
                return gate.promise;
              },
            },
          },
          h.session,
          name,
          id,
          args,
          redactor([]),
          ctx.generation,
          ctx.signal,
        ),
    },
    true,
    h.session,
  );
  const waiting = call(f.c);
  await entered.promise;
  const takeover = dispatchTool(
    { tools: h.tools, policy: actPolicy },
    h.session,
    "request_takeover",
    "manual",
    { reason: "login", note: "fixture" },
    redactor([]),
    f.generation,
  );
  await tick();
  expect(h.session.controlHeld).toBe(true);
  expect(h.events().filter((e) => e.type === "takeover.request")).toEqual([]);
  gate.resolve({ kind: "act" });
  expect(await waiting).toHaveProperty("error");
  await tick();
  expect(observe).not.toHaveBeenCalled();
  expect(h.events().filter((e) => e.type === "takeover.request")).toHaveLength(1);
  h.session.retireBrain(f.generation);
  expect((await takeover).result.ok).toBe(false);
  expect(h.session.controlHeld).toBe(true);
  expect(() => h.session.beginBrain()).toThrow();
  const requestId = h.session.pendingTakeover;
  if (!requestId) throw new Error("fixture missing takeover");
  expect(h.session.endTakeover(requestId, undefined)).toBe(true);
  await tick();
  expect(observe).not.toHaveBeenCalled();
});
