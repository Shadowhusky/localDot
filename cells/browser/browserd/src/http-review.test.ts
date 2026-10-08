import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import { BrowserHttp, type BrowserHttpOptions } from "./http.ts";

const identity = {
  browserCellId: "01K6NZAGJT44QM01BDMEMSHP25",
  parentCellId: "01K6NZAGJT44QM01BDMEMSHP26",
  instance: "54ca7ee3-bff0-40eb-a8c6-08ca30443067",
};
const token = "R".repeat(43);
const tabId = "50cb2d0f-4348-4294-9396-54f0bb730945";
const permit = {
  ...identity,
  revision: 1,
  requestId: "01K6NZAGJT44QM01BDMEMSHP27",
  owner: { sessionId: "01K6NZAGJT44QM01BDMEMSHP28", generation: 1 },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((f) => f()));
  expect(results.filter((r) => r.status === "rejected")).toEqual([]);
});
async function until(test: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (test()) return;
    await delay(5);
  }
  throw new Error("private fixture did not reach condition");
}
async function fixture(overrides: Partial<BrowserHttpOptions> = {}) {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  const state: {
    ready: boolean;
    retirement?: Promise<void>;
    work?: (signal: AbortSignal, value: unknown) => Promise<void>;
    ownerCalls: number;
    effects: number;
    values: unknown[];
  } = { ready: true, ownerCalls: 0, effects: 0, values: [] };
  const action = async (raw: unknown, _tab: string, value: unknown, signal: AbortSignal) => {
    state.ownerCalls++;
    const lease = control.admit(raw);
    try {
      const combined = AbortSignal.any([signal, lease.signal]);
      combined.throwIfAborted();
      lease.check();
      await state.work?.(combined, value);
      combined.throwIfAborted();
      lease.check();
      state.effects++;
      state.values.push(value);
      return { armedMono: 1, pressMono: 2, presses: [2], injector: "xtest" as const };
    } finally {
      lease.finish();
    }
  };
  const fence = vi.fn(() => {
    state.ready = false;
    void control.close();
  });
  const stop = vi.fn(async () => {
    state.retirement ??= control.close();
    await state.retirement;
  });
  const service = new BrowserHttp({
    config: {
      ...identity,
      serviceToken: token,
      streamToken: "S".repeat(43),
      gateAddress: "10.0.0.2",
      scale: 1,
    },
    instance: identity.instance,
    control,
    targets: {
      tabs: () => [{ id: tabId, ready: true, title: "private-title", url: "private-url" }],
    },
    input: {
      inject: action,
      type: async (raw, tab, value, signal, progress) => {
        await action(raw, tab, value, signal);
        await progress({ count: 1, pressMono: 2, chunk: "private-progress" });
        return { done: true, count: 1, armedMono: 1, firstPressMono: 2, injector: "xtest" };
      },
    },
    observation: {
      observe: async (raw, tab, signal) => {
        await action(raw, tab, undefined, signal);
        return {
          frame: {
            frameId: "01K6NZAGJT44QM01BDMEMSHP29",
            width: 1280,
            height: 800,
            image: "masked",
            pointer: { x: 0, y: 0 },
            windows: [],
          },
          targets: [],
        };
      },
    },
    ready: () => state.ready,
    retirement: () => state.retirement,
    fence,
    stop,
    ...overrides,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const address = service.server.address();
  if (!address || typeof address === "string") throw new Error("fixture listen");
  const sockets: Socket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await service.close().catch(() => {});
    expect(service.server.listening).toBe(false);
  });
  const send = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          method,
          path,
          headers: {
            authorization: `Bearer ${token}`,
            ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("aborted", () => reject(new Error("response closed")));
          response.once("end", () =>
            resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      request.setTimeout(3000, () => request.destroy(new Error("fixture client deadline")));
      request.once("error", reject);
      request.end(data);
    });
  const raw = async (initial: string | Buffer) => {
    const socket = connect(address.port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => {});
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const closed = once(socket, "close").then(() => text);
    socket.setTimeout(3000, () => socket.destroy());
    await once(socket, "connect");
    socket.write(initial);
    return { socket, closed, output: () => text };
  };
  return { service, control, state, send, raw, fence, stop };
}
const body = () => ({ permit, tabId, request: { text: "private-中文" } });
const requestHead = (path: string, size: number) =>
  `POST ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${size}\r\n\r\n`;

describe("independent authenticated browser HTTP boundaries", () => {
  it("P1 valid fragmented UTF8 reaches the current owner exactly once without reflection", async () => {
    const f = await fixture();
    const data = Buffer.from(JSON.stringify(body()));
    const split = data.indexOf(Buffer.from("中")) + 1;
    const r = await f.raw(
      Buffer.concat([Buffer.from(requestHead("/input", data.length)), data.subarray(0, split)]),
    );
    await delay(10);
    expect(f.state.ownerCalls).toBe(0);
    r.socket.write(data.subarray(split));
    expect(await r.closed).toContain("200 OK");
    expect(f.state.effects).toBe(1);
    expect(f.state.values).toEqual([body().request]);
    expect(r.output()).not.toContain("private-");
  });
  it("B1 mixed-case duplicate auth and even empty Origin refuse before owner admission", async () => {
    const f = await fixture();
    const data = JSON.stringify(body());
    for (const extra of [`aUtHoRiZaTiOn: Bearer ${token}\r\n`, "Origin:\r\n"]) {
      const r = await f.raw(
        requestHead("/input", Buffer.byteLength(data)).replace("\r\n\r\n", `\r\n${extra}\r\n`) +
          data,
      );
      expect(await r.closed).toContain("400 Bad Request");
    }
    expect(f.state.ownerCalls).toBe(0);
    expect(f.state.effects).toBe(0);
  });
  it("B2 a body completed after takeover cannot reuse its old permit", async () => {
    const f = await fixture();
    const data = JSON.stringify(body());
    const r = await f.raw(requestHead("/input", Buffer.byteLength(data)) + data.slice(0, 5));
    const takeover = await f.send("PUT", "/control", {
      ...identity,
      revision: 2,
      requestId: "01K6NZAGJT44QM01BDMEMSHP30",
      holder: "user",
    });
    expect(takeover.status).toBe(200);
    expect(f.control.holder).toBe("user");
    r.socket.write(data.slice(5));
    expect(await r.closed).toContain("409 Conflict");
    expect(f.state.effects).toBe(0);
  });
  it("B3 a body completed after Stop cannot start work but repeated authenticated Stop is valid", async () => {
    const f = await fixture();
    const data = JSON.stringify(body());
    const r = await f.raw(requestHead("/input", Buffer.byteLength(data)) + data.slice(0, 5));
    expect((await f.send("POST", "/stop", identity)).status).toBe(200);
    r.socket.write(data.slice(5));
    expect(await r.closed).toContain("503 Service Unavailable");
    expect(f.state.ownerCalls).toBe(0);
    expect((await f.send("POST", "/stop", identity)).status).toBe(200);
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("B4 cross-route busy arbitration cannot start a second owner before the first settles", async () => {
    const f = await fixture();
    const finish = Promise.withResolvers<void>();
    let entered = false;
    f.state.work = async () => {
      if (entered) return;
      entered = true;
      await finish.promise;
    };
    const first = f.send("POST", "/input", body());
    await until(() => entered);
    try {
      const next = await f.send("POST", "/observe", { permit, tabId });
      expect(next).toEqual({ status: 409, text: '{"error":"busy"}' });
      expect(f.state.ownerCalls).toBe(1);
    } finally {
      finish.resolve();
      expect((await first).status).toBe(200);
    }
    expect(f.state.effects).toBe(1);
  });
  it("B5 a failed physical retirement destroys the response and exposes no private cause", async () => {
    const f = await fixture();
    f.state.work = async () => {
      const rejected = Promise.reject(new Error("private-retirement"));
      void rejected.catch(() => {});
      f.state.retirement = rejected;
      throw new Error("private-helper");
    };
    const outcome = await f.send("POST", "/input", body()).then(
      () => "acknowledged",
      () => "closed",
    );
    expect(outcome).toBe("closed");
    expect(f.state.effects).toBe(0);
  });
  it("B6 a synchronous fence failure still attempts physical stop once and stays failed", async () => {
    const stop = vi.fn(async () => {});
    const fence = vi.fn(() => {
      throw new Error("private-fence");
    });
    const f = await fixture({ fence, stop });
    const first = f.service.stop();
    const next = f.service.stop();
    expect(next).toBe(first);
    await expect(first).rejects.toThrow("Browser service request refused");
    expect(stop).toHaveBeenCalledOnce();
    expect(fence).toHaveBeenCalledOnce();
    expect(JSON.parse((await f.send("GET", "/health")).text).ready).toBe(false);
  });
  it("B7 reentrant Stop shares completion and no acknowledgment precedes physical drain", async () => {
    const drain = Promise.withResolvers<void>();
    let f: Awaited<ReturnType<typeof fixture>>;
    let nested: Promise<void> | undefined;
    f = await fixture({
      fence: () => {
        nested = f.service.stop();
      },
      stop: () => drain.promise,
    });
    const first = f.service.stop();
    expect(nested).toBe(first);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await delay(15);
    expect(settled).toBe(false);
    drain.resolve();
    await first;
    expect(settled).toBe(true);
  });
  it("B8 ordinary private owner errors are fixed and release the effect slot", async () => {
    const f = await fixture();
    f.state.work = async () => {
      throw new Error("private-owner-cause");
    };
    expect(await f.send("POST", "/input", body())).toEqual({
      status: 409,
      text: '{"error":"refused"}',
    });
    f.state.work = undefined;
    expect((await f.send("POST", "/input", body())).status).toBe(200);
    expect(f.state.effects).toBe(1);
  });
  it("B9 streaming progress drops text while a valid result stays usable", async () => {
    const f = await fixture();
    const r = await f.send("POST", "/type", body());
    expect(r.status).toBe(200);
    const entries = r.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[0]).toEqual({ kind: "progress", count: 1, pressMono: 2 });
    expect(entries[1].kind).toBe("result");
    expect(r.text).not.toContain("private-");
    expect(f.state.effects).toBe(1);
  });
  it("B10 idle connection saturation rejects excess peers and restores capacity after close", async () => {
    const f = await fixture();
    const peers = [];
    for (let index = 0; index < 64; index++) peers.push(await f.raw(""));
    const extra = await f.raw(
      `GET /health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    expect(await extra.closed.catch(() => "reset")).toMatch(/^(?:reset)?$/u);
    peers[0]?.socket.destroy();
    await peers[0]?.closed;
    let count = 64;
    for (let attempt = 0; attempt < 100 && count >= 64; attempt++) {
      await delay(5);
      count = await new Promise<number>((resolve, reject) =>
        f.service.server.getConnections((error, value) => (error ? reject(error) : resolve(value))),
      );
    }
    expect(count).toBe(63);
    expect((await f.send("GET", "/health")).status).toBe(200);
    expect(f.state.ownerCalls).toBe(0);
  });
});
