import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { APPROVAL_TIMEOUT_MS } from "@localdot/protocol";
import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootConfig, PROXY_TOKEN } from "./testing/scripted.ts";
import { MAX_REPLY_BYTES, ToolApiError, ToolClient } from "./tool-client.ts";

const RESULT = { ok: true, content: [{ type: "text", text: "finished" }] };
const clients: ToolClient[] = [];
const servers: Server[] = [];
function client(fetchImpl?: typeof fetch, base = "http://127.0.0.1:4751") {
  const c = new ToolClient(base, PROXY_TOKEN, fetchImpl);
  clients.push(c);
  return c;
}
function delayed(ms: number, body = RESULT): typeof fetch {
  return vi.fn(
    async () =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json(body)), ms)),
  ) as typeof fetch;
}
function observe<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  const settled = promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    },
  );
  return { state, settled };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

describe("tool deadlines own the whole response lifetime", () => {
  it("keeps a 600-second shell pending past implicit 300-second defaults and receives headers at six minutes", async () => {
    vi.useFakeTimers();
    const c = client(delayed(360_000));
    const call = observe(c.tool("shell", "c", { command: "fixture", timeout_sec: 600 }));
    await vi.advanceTimersByTimeAsync(300_001);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    await call.settled;
    expect(call.state.value).toEqual(RESULT);
  });
  it("expires an unanswered shell after the approval wait plus its timeout and ten seconds", async () => {
    vi.useFakeTimers();
    const c = client(delayed(APPROVAL_TIMEOUT_MS + 900_000));
    const call = observe(c.tool("shell", "c", { command: "fixture", timeout_sec: 600 }));
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 609_999);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.state.done).toBe(true);
    await call.settled;
    expect(call.state.error).toBeInstanceOf(ToolApiError);
    expect(String(call.state.error)).toContain("cancelled");
  });
  // Evidence: unanswered cards were cancelled at about 117 s, and a hand-off held inside a
  // computer call died with its request. The daemon bounds the work; the brain only waits.
  it.each([
    "computer",
    "shell",
    "files",
    "browser_read",
    "browser_navigate",
    "browser_upload",
    "remember",
    "done",
    "routine",
    "follow_up_at",
  ])("keeps %s pending while the user decides for fifteen minutes", async (name) => {
    vi.useFakeTimers();
    const c = client(delayed(16 * 60_000));
    const call = observe(
      c.tool(name, "c", name === "shell" ? { command: "fixture", timeout_sec: 30 } : {}),
    );
    await vi.advanceTimersByTimeAsync(120_001);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await call.settled;
    expect(call.state.value).toEqual(RESULT);
  });
  it("expires a computer call at the approval wait plus two minutes of work", async () => {
    vi.useFakeTimers();
    const call = observe(client(delayed(APPROVAL_TIMEOUT_MS * 2)).tool("computer", "c", {}));
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 119_999);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await call.settled;
    expect(String(call.state.error)).toContain("cancelled");
  });
  it.each(["update_plan", "switch_screen"])(
    "keeps the base two-minute deadline for %s, which never waits on the user",
    async (name) => {
      vi.useFakeTimers();
      const call = observe(client(delayed(900_000)).tool(name, "c", {}));
      await vi.advanceTimersByTimeAsync(119_999);
      expect(call.state.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await call.settled;
      expect(String(call.state.error)).toContain("cancelled");
    },
  );
  it("keeps ask_user pending for six minutes but expires at thirty-one minutes", async () => {
    vi.useFakeTimers();
    const call = observe(client(delayed(2_000_000)).tool("ask_user", "c", {}));
    await vi.advanceTimersByTimeAsync(360_000);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_499_999);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.state.done).toBe(true);
    await call.settled;
    expect(String(call.state.error)).toContain("cancelled");
  });
  it("keeps a routine's question open for its whole window, and attended questions at thirty-one minutes", async () => {
    vi.useFakeTimers();
    const run = {
      kind: "routine" as const,
      name: "Morning bills",
      profile: "ask_first" as const,
      approvalWindowMinutes: 240,
    };
    const never = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/v1/boot")
        ? Response.json(bootConfig({ run }))
        : new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;
    const routine = client(never);
    await routine.boot();
    const question = observe(routine.tool("ask_user", "c", {}));
    const card = observe(routine.tool("routine", "c", { op: "pause" }));
    const attended = observe(client(delayed(APPROVAL_TIMEOUT_MS)).tool("ask_user", "c", {}));
    await vi.advanceTimersByTimeAsync(240 * 60_000);
    expect(question.state.done).toBe(false);
    expect(card.state.done).toBe(false);
    expect(String(attended.state.error)).toContain("cancelled");
    await vi.advanceTimersByTimeAsync(60_000);
    await question.settled;
    expect(String(question.state.error)).toContain("cancelled");
    expect(card.state.done).toBe(false);
  });
  it("does not expire takeover after sixty-one minutes, then cancels on generation loss", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const call = observe(client(delayed(9_000_000)).tool("request_takeover", "c", {}, stop.signal));
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(call.state.done).toBe(false);
    stop.abort();
    await call.settled;
    expect(String(call.state.error)).toContain("cancelled");
  });
  it.each([
    ["shell", APPROVAL_TIMEOUT_MS + 610_000],
    ["files", APPROVAL_TIMEOUT_MS + 120_000],
    ["update_plan", 120_000],
  ] as const)(
    "keeps the deadline through a silent %s response body and cancels the reader",
    async (name, deadline) => {
      vi.useFakeTimers();
      let cancelled = false;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"ok":'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const c = client(async () => new Response(stream));
      const call = observe(
        c.tool(name, "c", name === "shell" ? { command: "fixture", timeout_sec: 600 } : {}),
      );
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(call.state.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.state.done).toBe(true);
      await call.settled;
      expect(String(call.state.error)).toContain("cancelled");
      expect(cancelled).toBe(true);
    },
  );
  it("bounds boot/body and inbox deadlines, and never admits invalid shell timeouts", async () => {
    vi.useFakeTimers();
    const fake = delayed(900_000);
    const c = client(fake);
    for (const timeout_sec of [0, 601, 1.5, Number.NaN])
      expect(() => c.tool("shell", "c", { command: "x", timeout_sec })).toThrow();
    expect(fake).not.toHaveBeenCalled();
    const boot = observe(c.boot());
    const inbox = observe(c.inbox(0, 30_000));
    await vi.advanceTimersByTimeAsync(30_000);
    await boot.settled;
    expect(String(boot.state.error)).toContain("cancelled");
    expect(inbox.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await inbox.settled;
    expect(String(inbox.state.error)).toContain("cancelled");
  });
});

describe("authenticated gate transport", () => {
  it("owns a real dispatcher that survives delayed headers and body while a tiny default control fails", async () => {
    const server = createServer((req, res) => {
      req.resume();
      const response = JSON.stringify(RESULT);
      if (req.url === "/headers" || req.headers["x-test"] === "headers") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(response);
        }, 1600).unref();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(response.slice(0, 5));
        setTimeout(() => res.end(response.slice(5)), 1600).unref();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tiny = new Agent({ headersTimeout: 10, bodyTimeout: 10 });
    try {
      await expect(undiciFetch(`${base}/headers`, { dispatcher: tiny })).rejects.toMatchObject({
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      });
      const response = await undiciFetch(`${base}/body`, { dispatcher: tiny });
      await expect(response.text()).rejects.toMatchObject({
        cause: { code: "UND_ERR_BODY_TIMEOUT" },
      });
      // Both production paths use the actual owned Agent, not an injected fetch implementation.
      const c = client(undefined, base);
      await expect(c.tool("shell", "c", { command: "fixture", timeout_sec: 600 })).resolves.toEqual(
        RESULT,
      );
      // Boot takes the delayed-header branch through a separate local fixture path rewrite.
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        req.resume();
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(bootConfig()));
        }, 1600).unref();
      });
      await expect(c.boot()).resolves.toMatchObject({ task: "Find the weather in Lyon" });
    } finally {
      await tiny.destroy();
    }
  }, 12_000);
  it("authenticates exactly the gate, disables redirects and keeps peer errors secret", async () => {
    const seen: RequestInit[] = [];
    const c = client(async (_url, init) => {
      seen.push(init ?? {});
      return new Response("credential-from-peer", { status: 401 });
    });
    await expect(c.tool("files", "c", {})).rejects.toMatchObject({
      status: 401,
    });
    expect(seen[0]).toMatchObject({
      redirect: "error",
      headers: { authorization: `Bearer ${PROXY_TOKEN}` },
    });
    await expect(c.boot()).rejects.not.toThrow("credential-from-peer");
  });
  it("parses daemon 400/404 tool refusals but never replays a mutation after an uncertain send", async () => {
    for (const status of [400, 404])
      expect(
        await client(async () => Response.json({ ok: false, content: [] }, { status })).tool(
          "missing",
          "c",
          {},
        ),
      ).toEqual({ ok: false, content: [] });
    const fake = vi.fn(async () => {
      throw new TypeError("lost", { cause: { code: "ECONNREFUSED" } });
    });
    await expect(client(fake).appendTranscript([{ role: "user", content: "x" }])).rejects.toThrow(
      "connection failed",
    );
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("retries only refused boot connections within the same deadline", async () => {
    vi.useFakeTimers();
    const fake = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline", { cause: { code: "ECONNREFUSED" } }))
      .mockResolvedValueOnce(Response.json(bootConfig()));
    const promise = client(fake).boot();
    await vi.advanceTimersByTimeAsync(100);
    expect((await promise).task).toBe("Find the weather in Lyon");
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it("preserves durable inbox metadata, sends acknowledgement-only retries and refuses invalid cursors", async () => {
    const item = {
      role: "user" as const,
      content: "exact inbox text",
      sourceInbox: { seq: 2, messageId: "01JXYZ0000000000000000AAAA" },
    };
    const bodies: unknown[] = [];
    const c = client(async (_url, init) => {
      if (init?.body) {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      return Response.json({ messages: [item] });
    });
    expect(await c.transcript()).toEqual([item]);
    await c.appendTranscript([item], 2);
    await c.appendTranscript([], 2);
    expect(bodies).toEqual([
      { messages: [item], inboxAfter: 2 },
      { messages: [], inboxAfter: 2 },
    ]);
    await expect(c.appendTranscript([])).rejects.toThrow();
    for (const cursor of [-1, 0.5]) await expect(c.appendTranscript([], cursor)).rejects.toThrow();
    expect(bodies).toHaveLength(2);
  });
  it("aborts pending work and refuses future work after idempotent close", async () => {
    const fake = vi.fn(async () => new Promise<Response>(() => {}));
    const c = client(fake);
    const call = observe(c.tool("request_takeover", "c", {}));
    await c.close();
    await c.close();
    expect(call.state.done).toBe(true);
    await call.settled;
    expect(String(call.state.error)).toContain("cancelled");
    await expect(c.boot()).rejects.toThrow("cancelled");
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("caps actual streamed bytes even without content-length and cancels oversized responses", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(MAX_REPLY_BYTES));
        c.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(client(async () => new Response(stream)).tool("files", "c", {})).rejects.toThrow(
      "size limit",
    );
    expect(cancelled).toBe(true);
  });
  it("validates frame paths and region bounds before sending the gate token", async () => {
    const fake = vi.fn(async () => new Response("png"));
    const c = client(fake);
    expect(() => c.frame("../../elsewhere")).toThrow();
    expect(() => c.frame("01JXYZ0000000000000000AAAA", { x: 1279, y: 0, w: 2, h: 10 })).toThrow();
    expect(fake).not.toHaveBeenCalled();
    expect(await c.frame("01JXYZ0000000000000000AAAA")).toBe(Buffer.from("png").toString("base64"));
  });
});
