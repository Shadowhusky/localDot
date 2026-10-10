import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type TypeProgress, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import { BrowserControl } from "./control.ts";
import { BROWSER_HTTP_BODY_BYTES, BROWSER_HTTP_BODY_MS, BrowserHttp } from "./http.ts";
import { BrowserInputError } from "./input.ts";
import { BrowserNavigation } from "./navigation-owner.ts";

const browserCellId = "01K6NZAGJT44QM01BDMEMSHP25";
const parentCellId = "01K6NZAGJT44QM01BDMEMSHP26";
const instance = "54ca7ee3-bff0-40eb-a8c6-08ca30443067";
const tabId = "50cb2d0f-4348-4294-9396-54f0bb730945";
const serviceToken = "a".repeat(43);
const identity = { browserCellId, parentCellId, instance };
const owner = { sessionId: "01K6NZAGJT44QM01BDMEMSHP27", generation: 1 };
const permit: BrowserActionPermit = { ...identity, revision: 1, requestId: ulid(), owner };
const cleanups: (() => Promise<void>)[] = [];

interface Reply {
  status: number;
  text: string;
  headers: Record<string, unknown>;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await sleep(2);
  }
  throw new Error("fixture condition not reached");
}

async function setup(enableNavigation = true) {
  const clearSelections = vi.fn(async () => {});
  const control = new BrowserControl({
    ...identity,
    clearSelections,
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  let retired: Promise<void> | undefined;
  let ready = true;
  let work: (signal: AbortSignal) => Promise<void> = async () => {};
  let typeWork: (
    signal: AbortSignal,
    progress: (value: TypeProgress) => void | Promise<void>,
  ) => Promise<void> = async (_signal, progress) => {
    await progress({ count: 1, pressMono: 10, chunk: "private-chunk-canary" });
    await progress({ count: 2, pressMono: 12, chunk: "private-chunk-canary" });
  };
  let closing: Promise<void> | undefined;
  const navigate = vi.fn(async (_tab: string, _url: string, signal?: AbortSignal) => {
    if (!signal) throw new Error("navigation signal missing");
    await work(signal);
  });
  const navigation = new BrowserNavigation(control, { navigate });
  const admission = async (
    raw: unknown,
    signal: AbortSignal,
    effect: (signal: AbortSignal) => Promise<void>,
  ) => {
    const lease = control.admit(raw);
    try {
      lease.check();
      await effect(AbortSignal.any([signal, lease.signal]));
      signal.throwIfAborted();
      lease.check();
    } finally {
      lease.finish();
    }
  };
  const inject = vi.fn(
    async (raw: unknown, _tab: string, _request: unknown, signal: AbortSignal) => {
      await admission(raw, signal, work);
      return { pressMono: 2, presses: [2], armedMono: 1, injector: "xtest" as const };
    },
  );
  const type = vi.fn(
    async (
      raw: unknown,
      _tab: string,
      _request: unknown,
      signal: AbortSignal,
      progress: (value: TypeProgress) => void | Promise<void>,
    ) => {
      await admission(raw, signal, (combined) => typeWork(combined, progress));
      return {
        done: true as const,
        count: 2,
        firstPressMono: 10,
        armedMono: 1,
        injector: "xtest" as const,
      };
    },
  );
  const manual = vi.fn(async (raw: unknown, _request: unknown, signal: AbortSignal) => {
    const lease = control.admitManual(raw);
    try {
      lease.check();
      await work(AbortSignal.any([signal, lease.signal]));
      signal.throwIfAborted();
      lease.check();
      return {
        kind: "text" as const,
        receipt: {
          done: true as const,
          count: 2,
          firstPressMono: 10,
          armedMono: 1,
          injector: "xtest" as const,
        },
      };
    } finally {
      lease.finish();
    }
  });
  const observe = vi.fn(async (raw: unknown, _tab: string, signal: AbortSignal) => {
    await admission(raw, signal, work);
    return {
      frame: {
        frameId: ulid(),
        width: 1280,
        height: 800,
        image: "masked-image",
        pointer: { x: 0, y: 0 },
        windows: [],
      },
      targets: [],
    };
  });
  const lookup = vi.fn(
    async (raw: unknown, _tab: string, _request: unknown, signal: AbortSignal) => {
      await admission(raw, signal, work);
      return { target: null, window: null, ms: 1 };
    },
  );
  const timing = vi.fn(
    async (raw: unknown, _tab: string, _request: unknown, signal: AbortSignal) => {
      await admission(raw, signal, work);
      return { mono: 10 };
    },
  );
  const read = vi.fn(async (raw: unknown, _tab: string, _request: unknown, signal: AbortSignal) => {
    await admission(raw, signal, work);
    return {
      url: "https://example.test/",
      title: "Public page",
      text: "Public body",
      outline: "",
      truncated: false,
    };
  });
  const stop = vi.fn(() => {
    retired ??= closing ?? Promise.resolve();
    return retired;
  });
  const fence = vi.fn(() => {
    ready = false;
    closing = control.close();
  });
  const workWindow = { update: vi.fn(async () => {}), hide: vi.fn(async () => {}), close: vi.fn() };
  const service = new BrowserHttp({
    workWindow,
    config: {
      browserCellId,
      parentCellId,
      serviceToken,
      streamToken: "b".repeat(43),
      gateAddress: "10.0.0.2",
      scale: 2,
      fullcolor: false,
    },
    instance,
    control,
    targets: {
      tabs: () => [
        { id: tabId, ready: true, title: "private-title-canary", url: "private-url-canary" },
      ],
    },
    input: {
      inject,
      type,
      timing,
      manual,
      secret: async (_permit, _tab, _request, signal) => {
        await work(signal);
        return { filled: false, rememberable: true };
      },
    },
    observation: { observe, lookup, read },
    navigation: enableNavigation ? navigation : undefined,
    ready: () => ready,
    fence,
    stop,
    retirement: () => retired,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const address = service.server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const sockets: Socket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await service.close();
  });
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: string[] = [],
  ): Promise<Reply> => {
    const bytes =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          method,
          path,
          headers: [
            "host",
            "localhost",
            "authorization",
            `Bearer ${serviceToken}`,
            ...(bytes
              ? ["content-type", "application/json", "content-length", String(bytes.length)]
              : []),
            ...headers,
          ],
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString(),
              headers: response.headers,
            }),
          );
        },
      );
      request.once("error", reject);
      request.end(bytes);
    });
  };
  const raw = async (data: string): Promise<Socket> => {
    const socket = connect(address.port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(data);
    return socket;
  };
  return {
    workWindow,
    service,
    control,
    send,
    raw,
    inject,
    type,
    observe,
    lookup,
    read,
    timing,
    manual,
    navigate,
    stop,
    fence,
    clearSelections,
    setWork: (effect: typeof work) => {
      work = effect;
    },
    setTypeWork: (effect: typeof typeWork) => {
      typeWork = effect;
    },
    setRetirement: (value: Promise<void>) => {
      retired = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("authenticated browser HTTP transport", () => {
  it("returns a bounded sign-in refusal without exposing device error text", async () => {
    const peer = await setup();
    peer.setWork(async () => {
      throw new BrowserInputError("login-form");
    });
    const body = {
      permit,
      tabId,
      request: { origin: "https://github.com", at: { x: 400, y: 300 } },
    };
    const reply = await peer.send("POST", "/secret", body);
    expect(reply.status).toBe(422);
    expect(JSON.parse(reply.text)).toEqual({ error: "login-form" });
    peer.setWork(async () => {
      throw new Error("private-password-canary");
    });
    const unknown = await peer.send("POST", "/secret", body);
    expect(unknown.status).toBe(409);
    expect(unknown.text).not.toContain("private-password-canary");
  });

  it("separates authenticated manual grants from agent permits and drops plaintext", async () => {
    const peer = await setup();
    const { owner: _, ...user } = { ...permit, revision: 2 };
    const body = { permit: user, request: { kind: "text", text: "密碼" } };
    expect((await peer.send("POST", "/manual", body)).status).toBe(409);
    expect((await peer.send("PUT", "/control", { ...user, holder: "user" })).status).toBe(200);
    expect((await peer.send("POST", "/manual", { ...body, tabId })).status).toBe(400);
    expect((await peer.send("POST", "/manual", { ...body, permit })).status).toBe(400);
    const reply = await peer.send("POST", "/manual", body);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual({
      kind: "text",
      receipt: { done: true, count: 2, firstPressMono: 10, armedMono: 1, injector: "xtest" },
    });
    expect(reply.text).not.toContain("密碼");
    expect(reply.headers["content-type"]).toBe("application/json");
  });

  it("holds the shared input slot during manual work and drains it before handback cleanup", async () => {
    const peer = await setup();
    const { owner: _, ...user } = { ...permit, revision: 2 };
    await peer.send("PUT", "/control", { ...user, holder: "user" });
    const barrier = Promise.withResolvers<void>();
    let running: AbortSignal | undefined;
    peer.setWork(async (signal) => {
      running = signal;
      await barrier.promise;
    });
    const body = { permit: user, request: { kind: "text", text: "密碼" } };
    const pending = peer.send("POST", "/manual", body);
    await until(() => !!running);
    expect((await peer.send("POST", "/manual", body)).status).toBe(409);
    peer.clearSelections.mockClear();
    const returning = peer.send("PUT", "/control", { ...permit, revision: 3, holder: "agent" });
    await until(() => running?.aborted === true);
    expect(peer.clearSelections).not.toHaveBeenCalled();
    barrier.resolve();
    expect((await pending).status).toBe(409);
    expect((await returning).status).toBe(200);
    expect(peer.clearSelections).toHaveBeenCalledTimes(1);
  });
  it.each(["lookup", "timing", "read"] as const)(
    "authenticates and cancels the %s gateway route during takeover",
    async (route) => {
      const peer = await setup();
      const request =
        route === "lookup"
          ? { kind: "focused" }
          : route === "read"
            ? { maxChars: 500 }
            : { kind: "clock" };
      expect((await peer.send("POST", `/${route}`, { permit, tabId, request })).status).toBe(200);
      expect(peer[route]).toHaveBeenCalledExactlyOnceWith(
        permit,
        tabId,
        request,
        expect.any(AbortSignal),
      );
      const held = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      peer.setWork(async (current) => {
        signal = current;
        await held.promise;
        current.throwIfAborted();
      });
      const pending = peer.send("POST", `/${route}`, { permit, tabId, request });
      await until(() => Boolean(signal));
      expect((await peer.send("POST", "/input", { permit, tabId, request: {} })).status).toBe(409);
      const takeover = peer.send("PUT", "/control", {
        ...identity,
        revision: 2,
        requestId: ulid(),
        holder: "user",
      });
      await until(() => signal?.aborted === true);
      held.resolve();
      expect((await pending).status).toBe(409);
      expect((await takeover).status).toBe(200);
      expect((await peer.send("POST", `/${route}`, { permit, tabId, request })).status).toBe(409);
    },
  );
  it("dispatches an admitted navigation and returns no destination text", async () => {
    const peer = await setup();
    const url = "https://example.test/private?secret=private-canary";
    const reply = await peer.send("POST", "/navigate", { permit, tabId, url });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual({ done: true });
    expect(peer.navigate).toHaveBeenCalledExactlyOnceWith(tabId, url, expect.any(AbortSignal));
    expect(reply.text).not.toContain("private");
  });

  it.each([
    { permit, tabId, url: "https://example.test/", extra: true },
    { permit, tabId },
    { permit, tabId, url: 42 },
    { permit, tabId, url: "x".repeat(8193) },
  ])("rejects malformed navigation bodies before dispatch", async (body) => {
    const peer = await setup();
    expect((await peer.send("POST", "/navigate", body)).status).toBe(400);
    expect(peer.navigate).not.toHaveBeenCalled();
  });

  it("refuses navigation without a wired owner or current authority", async () => {
    const unavailable = await setup(false);
    expect(
      (await unavailable.send("POST", "/navigate", { permit, tabId, url: "https://example.test/" }))
        .status,
    ).toBe(503);
    const peer = await setup();
    expect(
      (
        await peer.send("POST", "/navigate", {
          permit: { ...permit, revision: 2 },
          tabId,
          url: "https://example.test/",
        })
      ).status,
    ).toBe(409);
    expect(
      (await peer.send("POST", "/navigate", { permit, tabId, url: "file:///tmp/private" })).status,
    ).toBe(409);
    expect(peer.navigate).not.toHaveBeenCalled();
    expect(unavailable.navigate).not.toHaveBeenCalled();
  });

  it("shares navigation arbitration with input, type and observation while allowing takeover", async () => {
    const peer = await setup();
    const complete = Promise.withResolvers<void>();
    let operationSignal: AbortSignal | undefined;
    peer.setWork(async (signal) => {
      operationSignal = signal;
      await complete.promise;
    });
    const pending = peer.send("POST", "/navigate", { permit, tabId, url: "https://example.test/" });
    await until(() => peer.navigate.mock.calls.length === 1);
    for (const path of ["/input", "/type", "/observe", "/navigate"]) {
      const body =
        path === "/observe"
          ? { permit, tabId }
          : path === "/navigate"
            ? { permit, tabId, url: "https://example.test/" }
            : { permit, tabId, request: {} };
      const reply = await peer.send("POST", path, body);
      expect(reply.status).toBe(409);
      expect(JSON.parse(reply.text)).toEqual({ error: "busy" });
    }
    const takeover = peer.send("PUT", "/control", {
      ...identity,
      revision: 2,
      requestId: ulid(),
      holder: "user",
    });
    await until(() => operationSignal?.aborted === true);
    complete.resolve();
    expect((await pending).status).toBe(409);
    expect((await takeover).status).toBe(200);
    expect(peer.navigate).toHaveBeenCalledTimes(1);
    expect(peer.inject).not.toHaveBeenCalled();
    expect(peer.type).not.toHaveBeenCalled();
    expect(peer.observe).not.toHaveBeenCalled();
  });

  it("returns a bounded identity and opaque tabs without private metadata", async () => {
    const peer = await setup();
    const health = await peer.send("GET", "/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toEqual({
      ...identity,
      ready: true,
      holder: "agent",
      width: 1280,
      height: 800,
    });
    expect(health.headers["cache-control"]).toBe("no-store");
    const tabs = await peer.send("GET", "/tabs");
    expect(JSON.parse(tabs.text)).toEqual({ tabs: [{ id: tabId, ready: true }] });
    expect(tabs.text).not.toContain("private-");
    expect(tabs.text).not.toContain(serviceToken);
  });

  it.each(["", "Bearer wrong", `bearer ${serviceToken}`, `Bearer ${"a".repeat(42)}`])(
    "rejects invalid raw authorization %#",
    async (authorization) => {
      const peer = await setup();
      const socket = await peer.raw(
        `POST /input HTTP/1.1\r\nHost: localhost\r\n${authorization ? `Authorization: ${authorization}\r\n` : ""}Content-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk.toString();
      });
      await once(socket, "close");
      expect(output).toContain("401");
      expect(peer.inject).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate authentication and content headers", async () => {
    const peer = await setup();
    for (const headers of [
      ["Authorization", `Bearer ${serviceToken}`],
      ["Content-Type", "application/json"],
    ]) {
      const reply = await peer.send("POST", "/input", { permit, tabId, request: {} }, headers);
      expect(reply.status).toBe(400);
    }
    expect(peer.inject).not.toHaveBeenCalled();
  });

  it.each([
    "/health?x=1",
    "/%68ealth",
    "/health/",
    "http://localhost/health",
    "/cdp",
    "/capture",
    "/input",
  ])('rejects route alias or raw escape "%s"', async (path) => {
    const peer = await setup();
    expect((await peer.send("GET", path)).status).toBe(404);
    expect(peer.inject).not.toHaveBeenCalled();
    expect(peer.observe).not.toHaveBeenCalled();
  });

  it("rejects browser-origin calls, GET bodies and content encodings", async () => {
    const peer = await setup();
    expect(
      (await peer.send("GET", "/health", undefined, ["origin", "https://hostile.test"])).status,
    ).toBe(400);
    expect((await peer.send("GET", "/tabs", {})).status).toBe(400);
    expect((await peer.send("POST", "/input", {}, ["content-encoding", "identity"])).status).toBe(
      400,
    );
    expect(peer.inject).not.toHaveBeenCalled();
  });

  it.each([Buffer.from('{"invalid":'), Buffer.from([0x22, 0xc0, 0xaf, 0x22]), Buffer.from("null")])(
    "rejects invalid JSON, UTF8 or envelope %# without disclosure",
    async (body) => {
      const peer = await setup();
      expect(await peer.send("POST", "/observe", body)).toMatchObject({
        status: 400,
        text: '{"error":"request"}',
      });
      expect(peer.observe).not.toHaveBeenCalled();
    },
  );

  it("bounds declared and chunked bodies before an owner sees them", async () => {
    const peer = await setup();
    expect(
      (await peer.send("POST", "/input", Buffer.alloc(BROWSER_HTTP_BODY_BYTES + 1, 65))).status,
    ).toBe(413);
    const socket = await peer.raw(
      `POST /input HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${serviceToken}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${(BROWSER_HTTP_BODY_BYTES + 1).toString(16)}\r\n${"a".repeat(BROWSER_HTTP_BODY_BYTES + 1)}\r\n0\r\n\r\n`,
    );
    let output = "";
    socket.on("data", (chunk) => {
      output += chunk.toString();
    });
    await once(socket, "close");
    expect(output).toContain("413");
    expect(peer.inject).not.toHaveBeenCalled();
  });

  it(
    "a stalled body owns no effect slot and cannot delay takeover",
    async () => {
      const peer = await setup();
      const socket = await peer.raw(
        `POST /input HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${serviceToken}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
      );
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk.toString();
      });
      const reply = await peer.send("PUT", "/control", {
        ...identity,
        revision: 2,
        requestId: ulid(),
        holder: "user",
      });
      expect(reply.status).toBe(200);
      expect(peer.control.holder).toBe("user");
      await Promise.race([
        once(socket, "close"),
        sleep(BROWSER_HTTP_BODY_MS + 1500).then(() => {
          throw new Error("body deadline absent");
        }),
      ]);
      expect(output).toContain("408");
      expect(peer.inject).not.toHaveBeenCalled();
    },
    BROWSER_HTTP_BODY_MS + 2500,
  );

  it("valid actions go through their owners and type progress drops private chunks", async () => {
    const peer = await setup();
    const body = { permit, tabId, request: { text: "private-request-canary" } };
    expect((await peer.send("POST", "/input", body)).status).toBe(200);
    expect((await peer.send("POST", "/observe", { permit, tabId })).status).toBe(200);
    const reply = await peer.send("POST", "/type", body);
    expect(reply.status).toBe(200);
    const records = reply.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ kind: "progress", count: 1, pressMono: 10 });
    expect(records[1]).toEqual({ kind: "progress", count: 2, pressMono: 12 });
    expect(records[2].kind).toBe("result");
    expect(reply.text).not.toContain("private-");
  });

  it.each([
    { permit: { ...permit, instance: "f9c94278-5903-4ab5-a1cb-1d8c81207c69" }, tabId },
    { permit: { ...permit, owner: { ...owner, generation: 2 } }, tabId },
    { permit: { ...permit, revision: 2 }, tabId },
    { permit: { ...permit, requestId: ulid() }, tabId },
  ])("real control refuses stale authority before owner effects %#", async (body) => {
    const peer = await setup();
    const effect = vi.fn(async () => {});
    peer.setWork(effect);
    expect((await peer.send("POST", "/observe", body)).status).toBe(409);
    expect(effect).not.toHaveBeenCalled();
  });

  it("refuses malformed/extra envelopes and tab identifiers", async () => {
    const peer = await setup();
    for (const body of [
      { permit, tabId, request: {} },
      { permit, tabId: "raw-target-id" },
      { permit: { ...permit, extra: true }, tabId },
    ])
      expect((await peer.send("POST", "/observe", body)).status).toBe(400);
    expect(peer.observe).not.toHaveBeenCalled();
  });

  it("serializes effects across routes while takeover bypasses the slot and drains the lease", async () => {
    const peer = await setup();
    const release = Promise.withResolvers<void>();
    let operationSignal: AbortSignal | undefined;
    peer.setWork(async (signal) => {
      operationSignal = signal;
      await release.promise;
      signal.throwIfAborted();
    });
    const active = peer.send("POST", "/input", { permit, tabId, request: {} });
    await until(() => Boolean(operationSignal));
    expect((await peer.send("POST", "/observe", { permit, tabId })).text).toBe('{"error":"busy"}');
    expect(peer.observe).not.toHaveBeenCalled();
    let completed = false;
    const takeover = peer
      .send("PUT", "/control", { ...identity, revision: 2, requestId: ulid(), holder: "user" })
      .then((reply) => {
        completed = true;
        return reply;
      });
    await until(() => operationSignal?.aborted === true);
    expect(peer.control.holder).toBe("user");
    expect(completed).toBe(false);
    release.resolve();
    expect((await active).status).toBe(409);
    expect((await takeover).status).toBe(200);
  });

  it("client disconnect aborts admitted work and releases the global slot", async () => {
    const peer = await setup();
    let operationSignal: AbortSignal | undefined;
    peer.setWork(async (signal) => {
      operationSignal = signal;
      await once(signal, "abort");
      signal.throwIfAborted();
    });
    const body = JSON.stringify({ permit, tabId, request: {} });
    const socket = await peer.raw(
      `POST /input HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${serviceToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await until(() => Boolean(operationSignal));
    socket.destroy();
    await until(() => operationSignal?.aborted === true);
    peer.setWork(async () => {});
    await sleep(10);
    expect((await peer.send("POST", "/observe", { permit, tabId })).status).toBe(200);
  });

  it("Stop fences immediately, waits for physical drain and refuses stale identity", async () => {
    const peer = await setup();
    expect(
      (
        await peer.send("POST", "/stop", {
          ...identity,
          instance: "f9c94278-5903-4ab5-a1cb-1d8c81207c69",
        })
      ).status,
    ).toBe(409);
    expect(peer.stop).not.toHaveBeenCalled();
    const drain = Promise.withResolvers<void>();
    peer.setRetirement(drain.promise);
    let completed = false;
    const stopped = peer.send("POST", "/stop", identity).then((reply) => {
      completed = true;
      return reply;
    });
    await until(() => peer.fence.mock.calls.length === 1);
    expect(peer.control.holder).toBe("user");
    expect(completed).toBe(false);
    expect(JSON.parse((await peer.send("GET", "/health")).text).ready).toBe(false);
    drain.resolve();
    expect((await stopped).status).toBe(200);
    expect((await peer.send("POST", "/stop", identity)).status).toBe(200);
    expect(peer.stop).toHaveBeenCalledTimes(1);
    expect((await peer.send("POST", "/observe", { permit, tabId })).status).toBe(503);
  });

  it("terminal helper errors wait for containment and reveal no exception cause", async () => {
    const peer = await setup();
    const drain = Promise.withResolvers<void>();
    peer.setWork(async () => {
      peer.setRetirement(drain.promise);
      throw new Error("private-helper-cause");
    });
    let completed = false;
    const action = peer.send("POST", "/input", { permit, tabId, request: {} }).then((reply) => {
      completed = true;
      return reply;
    });
    await until(() => peer.inject.mock.calls.length === 1);
    await sleep(10);
    expect(completed).toBe(false);
    drain.resolve();
    expect(await action).toMatchObject({ status: 409, text: '{"error":"refused"}' });
  });

  it("does not expose effects before runtime readiness", async () => {
    const peer = await setup();
    peer.setReady(false);
    expect((await peer.send("GET", "/tabs")).status).toBe(503);
    expect((await peer.send("POST", "/input", { permit, tabId, request: {} })).status).toBe(503);
    expect(peer.inject).not.toHaveBeenCalled();
  });

  it("a retiring runtime cannot admit work even if readiness is stale", async () => {
    const peer = await setup();
    peer.setRetirement(Promise.resolve());
    expect(JSON.parse((await peer.send("GET", "/health")).text).ready).toBe(false);
    expect((await peer.send("POST", "/observe", { permit, tabId })).status).toBe(503);
    expect(peer.observe).not.toHaveBeenCalled();
  });

  it("takeover cannot acknowledge safe handoff while a fatal helper is still retiring", async () => {
    const peer = await setup();
    const dispatched = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<void>();
    let operationSignal: AbortSignal | undefined;
    peer.setWork(async (signal) => {
      operationSignal = signal;
      await dispatched.promise;
      signal.throwIfAborted();
    });
    const active = peer.send("POST", "/input", { permit, tabId, request: {} });
    await until(() => Boolean(operationSignal));
    let completed = false;
    const takeover = peer
      .send("PUT", "/control", {
        ...identity,
        revision: 2,
        requestId: ulid(),
        holder: "user",
      })
      .then((reply) => {
        completed = true;
        return reply;
      });
    await until(() => operationSignal?.aborted === true);
    peer.setRetirement(drain.promise);
    dispatched.resolve();
    await sleep(10);
    expect(completed).toBe(false);
    drain.resolve();
    expect((await takeover).status).toBe(503);
    expect((await active).status).toBe(409);
    expect(peer.control.holder).toBe("user");
  });

  it("Stop during an admitted effect cancels immediately and acknowledges only after drain", async () => {
    const peer = await setup();
    const dispatched = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<void>();
    let operationSignal: AbortSignal | undefined;
    peer.setWork(async (signal) => {
      operationSignal = signal;
      await dispatched.promise;
      signal.throwIfAborted();
    });
    const active = peer.send("POST", "/observe", { permit, tabId });
    await until(() => Boolean(operationSignal));
    peer.setRetirement(drain.promise);
    let completed = false;
    const stopping = peer.send("POST", "/stop", identity).then((reply) => {
      completed = true;
      return reply;
    });
    await until(() => operationSignal?.aborted === true);
    expect(completed).toBe(false);
    dispatched.resolve();
    await sleep(10);
    expect(completed).toBe(false);
    drain.resolve();
    expect((await stopping).status).toBe(200);
    expect((await active).status).toBe(409);
    expect(peer.control.holder).toBe("user");
  });

  it("disconnect during streamed typing cancels the owner and releases authority", async () => {
    const peer = await setup();
    let operationSignal: AbortSignal | undefined;
    peer.setTypeWork(async (signal, progress) => {
      operationSignal = signal;
      await progress({ count: 1, pressMono: 10, chunk: "private-progress-canary" });
      if (!signal.aborted) await once(signal, "abort");
      signal.throwIfAborted();
    });
    const body = JSON.stringify({ permit, tabId, request: { text: "private-input-canary" } });
    const socket = await peer.raw(
      `POST /type HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${serviceToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    let output = "";
    socket.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes('"kind":"progress"')) socket.destroy();
    });
    await until(() => operationSignal?.aborted === true);
    expect(output).not.toContain("private-");
    await sleep(10);
    expect((await peer.send("POST", "/observe", { permit, tabId })).status).toBe(200);
  });

  it("an unfinished socket write cannot keep an owner lease indefinitely", async () => {
    const peer = await setup();
    let completed = false;
    let delivered = 0;
    let stalledWrites = 0;
    peer.service.server.prependListener("request", (request, response) => {
      if (request.url !== "/type") return;
      const write = response.write.bind(response);
      vi.spyOn(response, "write").mockImplementation((chunk) => {
        stalledWrites += 1;
        return write(chunk);
      });
    });
    peer.setTypeWork(async (_signal, progress) => {
      try {
        await progress({ count: 1, pressMono: 10 });
        delivered += 1;
      } finally {
        completed = true;
      }
    });
    const body = JSON.stringify({ permit, tabId, request: {} });
    const socket = await peer.raw(
      `POST /type HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${serviceToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    let output = "";
    socket.on("data", (chunk) => {
      output += chunk.toString();
    });
    for (let attempt = 0; attempt < 80 && !completed; attempt += 1) await sleep(50);
    expect(completed).toBe(true);
    expect(stalledWrites).toBe(1);
    expect(delivered).toBe(0);
    expect(output).toContain('"kind":"progress"');
    socket.destroy();
    expect((await peer.send("POST", "/observe", { permit, tabId })).status).toBe(200);
  });
});

it("shows passive work only for agent control and hides it before observation", async () => {
  const f = await setup();
  const update = { phase: "task/step", visible: true, title: "Checking", text: "redacted output" };
  expect((await f.send("POST", "/work-window", update)).status).toBe(200);
  expect(f.workWindow.update).toHaveBeenCalledWith(update);
  await f.send("POST", "/observe", { permit, tabId });
  expect(f.workWindow.hide.mock.invocationCallOrder[0]).toBeLessThan(
    f.observe.mock.invocationCallOrder[0] ?? 0,
  );
  await f.control.set({ ...identity, revision: 2, requestId: ulid(), holder: "user" });
  expect((await f.send("POST", "/work-window", update)).status).toBe(409);
  expect(f.workWindow.update).toHaveBeenCalledTimes(1);
  expect((await f.send("POST", "/work-window", { ...update, visible: false })).status).toBe(200);
});
