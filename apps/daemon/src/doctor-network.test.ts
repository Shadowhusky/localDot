import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runDoctorNetworkProbe } from "./doctor-network.ts";

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request: mock.request }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
type Reply = {
  status: number;
  value: unknown;
  headers: Record<string, string>;
  complete: boolean;
  holdClose: boolean;
  stall: boolean;
};
type Call = {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal;
  close: () => void;
  destroyed: () => boolean;
};
type State = {
  engine: { ID: string; OSType: string; Architecture: string };
  network: Record<string, unknown> | null;
};
function fixture(hook?: (call: Call, reply: Reply, state: State) => void) {
  const controller = new AbortController(),
    calls: Call[] = [],
    id = "a".repeat(64);
  const state: State = {
    engine: { ID: "fixture-engine", OSType: "linux", Architecture: "aarch64" },
    network: null,
  };
  mock.request.mockImplementation((options, callback) => {
    const req = new EventEmitter();
    let response: Readable | undefined,
      closed = false,
      destroyed = false,
      holdClose = false,
      aborted = false;
    const close = () => {
      if (closed) return;
      closed = true;
      options.signal.removeEventListener("abort", abort);
      req.emit("close");
    };
    const abort = () => {
      if (aborted || closed) return;
      aborted = true;
      const error = new Error("private abort");
      response?.destroy(error);
      req.emit("error", error);
    };
    Object.assign(req, {
      end(payload?: Buffer) {
        const call: Call = {
          method: options.method,
          path: options.path.replace(/^\/v[0-9.]+/, ""),
          body: payload ? JSON.parse(payload.toString()) : undefined,
          signal: options.signal,
          close,
          destroyed: () => destroyed,
        };
        calls.push(call);
        const reply: Reply = {
          status: 200,
          value: null,
          headers: { "content-type": "application/json" },
          complete: true,
          holdClose: false,
          stall: false,
        };
        if (call.path === "/info") reply.value = { ...state.engine };
        else if (call.method === "POST" && call.path === "/networks/create") {
          state.network = {
            ...call.body,
            Id: id,
            Containers: {},
            IPAM: { Config: [{ Subnet: "172.20.0.0/24" }] },
          };
          reply.status = 201;
          reply.value = { Id: id };
        } else if (call.path.startsWith("/networks/")) {
          const ref = call.path.slice("/networks/".length);
          const found = state.network && [state.network.Name, state.network.Id].includes(ref);
          if (!found) {
            reply.status = 404;
            reply.value = { message: "missing" };
          } else if (call.method === "DELETE") {
            state.network = null;
            reply.status = 204;
            reply.value = undefined;
          } else reply.value = structuredClone(state.network);
        } else throw new Error(`Unexpected request ${call.path}`);
        hook?.(call, reply, state);
        holdClose = reply.holdClose;
        const body = Buffer.isBuffer(reply.value)
          ? reply.value
          : reply.value === undefined
            ? Buffer.alloc(0)
            : Buffer.from(JSON.stringify(reply.value));
        response = new Readable({
          read() {
            if (!reply.stall) {
              this.push(body);
              this.push(null);
            }
          },
        });
        response.on("error", () => {});
        Object.assign(response, {
          statusCode: reply.status,
          headers: reply.headers,
          complete: reply.complete,
        });
        queueMicrotask(() => {
          if (options.signal.aborted) abort();
          else callback(response);
        });
      },
      destroy() {
        destroyed = true;
        response?.destroy();
        if (!holdClose) queueMicrotask(close);
        return req;
      },
    });
    options.signal.addEventListener("abort", abort, { once: true });
    return req;
  });
  return {
    controller,
    calls,
    state,
    id,
    run: (name?: string) =>
      runDoctorNetworkProbe("/private/fixture/docker.sock", name, controller.signal),
  };
}
it("labels only this invocation, inspects engine and ownership, and removes only the immutable empty-network ID", async () => {
  const f = fixture();
  expect((await f.run()).ok).toBe(true);
  const create = f.calls.find((c) => c.method === "POST");
  expect(create?.body).toMatchObject({
    Internal: true,
    Driver: "bridge",
    EnableIPv6: false,
    CheckDuplicate: true,
    Labels: { "localdot.doctor-probe": expect.stringMatching(/^[a-f0-9]{32}$/) },
  });
  expect(create?.body?.Name).toMatch(/^localdot-doctor-probe-[a-f0-9]{32}$/);
  expect(f.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
    `/networks/${f.id}`,
  ]);
  expect(f.calls.some((c) => c.path === "/networks")).toBe(false);
  expect(f.calls.every((c) => c.destroyed())).toBe(true);
  expect(f.state.network).toBeNull();
});
it("supports the test namespace but does not replace a preexisting network with the requested name", async () => {
  const f = fixture();
  f.state.network = { Name: "localdot-test-taken", Id: f.id, Labels: {}, Containers: {} };
  expect((await f.run("localdot-test-taken")).ok).toBe(false);
  expect(f.calls.some((c) => c.method !== "GET")).toBe(false);
  expect(f.state.network).not.toBeNull();
});
it.each(["labels", "endpoints", "id", "driver", "engine"])(
  "does not delete when %s ownership proof changes",
  async (fault) => {
    let namedReads = 0;
    const f = fixture((call, reply, state) => {
      if (call.method === "GET" && call.path.startsWith("/networks/localdot-")) namedReads++;
      if (state.network && namedReads === 3) {
        if (fault === "engine") state.engine.ID = "other-engine";
        else {
          if (fault === "labels") state.network.Labels = { "localdot.doctor-probe": "foreign" };
          if (fault === "endpoints") state.network.Containers = { foreign: {} };
          if (fault === "id") state.network.Id = "b".repeat(64);
          if (fault === "driver") state.network.Driver = "overlay";
          reply.value = structuredClone(state.network);
        }
      }
    });
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining("cleanup could not be confirmed"),
    });
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(f.state.network).not.toBeNull();
  },
);
it("recovers a lost create reply using the exact nonce label, never the name alone", async () => {
  const f = fixture((call, reply) => {
    if (call.method === "POST") reply.status = 500;
  });
  expect((await f.run()).ok).toBe(false);
  expect(f.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
    `/networks/${f.id}`,
  ]);
  expect(f.state.network).toBeNull();
});
it("accepts a lost delete reply only after verifying ID/name absence and the same engine", async () => {
  const f = fixture((call, reply) => {
    if (call.method === "DELETE") reply.status = 500;
  });
  expect((await f.run()).ok).toBe(true);
  expect(f.state.network).toBeNull();
  expect(f.calls.at(-1)?.path).toBe("/info");
});
it.each(["no-subnet", "not-internal", "gateway", "ipv6"])(
  "reports %s isolation failure while cleaning up only its own empty probe",
  async (fault) => {
    const f = fixture((call, _reply, state) => {
      if (call.method === "POST" && state.network) {
        if (fault === "no-subnet") state.network.IPAM = null;
        if (fault === "not-internal") state.network.Internal = false;
        if (fault === "gateway")
          state.network.IPAM = { Config: [{ Subnet: "172.20.0.0/24", Gateway: "172.20.0.1" }] };
        if (fault === "ipv6") state.network.EnableIPv6 = true;
      }
    });
    expect((await f.run()).ok).toBe(false);
    expect(f.state.network).toBeNull();
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  },
);
it.each([
  "status",
  "content",
  "encoding",
  "length",
  "truncated",
  "utf8",
  "oversize",
  "array",
  "null",
])("refuses %s transport evidence before creating anything", async (fault) => {
  const f = fixture((_call, reply) => {
    if (fault === "status") reply.status = 302;
    if (fault === "content") reply.headers["content-type"] = "text/plain";
    if (fault === "encoding") reply.headers["content-encoding"] = "gzip";
    if (fault === "length") reply.headers["content-length"] = "0";
    if (fault === "truncated") reply.complete = false;
    if (fault === "utf8") reply.value = Buffer.from([255]);
    if (fault === "oversize") reply.value = Buffer.alloc(1024 * 1024 + 1);
    if (fault === "array") reply.value = [];
    if (fault === "null") reply.value = null;
  });
  expect((await f.run()).ok).toBe(false);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.destroyed()).toBe(true);
});
it("does not begin cleanup until a cancelled create request physically closes", async () => {
  const f = fixture((call, reply) => {
    if (call.method === "POST") reply.holdClose = true;
  });
  const work = f.run();
  await vi.waitFor(() => expect(f.calls.find((c) => c.method === "POST")?.destroyed()).toBe(true));
  const create = f.calls.find((c) => c.method === "POST"),
    before = f.calls.length;
  f.controller.abort();
  await Promise.resolve();
  expect(f.calls).toHaveLength(before);
  create?.close();
  expect((await work).ok).toBe(false);
  expect(f.state.network).toBeNull();
  expect(f.calls.find((c) => c.method === "DELETE")?.signal.aborted).toBe(false);
});
it("keeps cleanup pending through its own request close when the caller cancels", async () => {
  const f = fixture((call, reply) => {
    if (call.method === "DELETE") reply.holdClose = true;
  });
  let settled = false;
  const work = f.run().then((v) => {
    settled = true;
    return v;
  });
  await vi.waitFor(() =>
    expect(f.calls.find((c) => c.method === "DELETE")?.destroyed()).toBe(true),
  );
  const removal = f.calls.find((c) => c.method === "DELETE");
  f.controller.abort();
  await Promise.resolve();
  expect(removal?.signal.aborted).toBe(false);
  expect(settled).toBe(false);
  removal?.close();
  expect((await work).ok).toBe(false);
});
it("preserves cleanup failure instructions even when the caller also cancels", async () => {
  const f = fixture((call, _reply, state) => {
    if (call.method === "POST") {
      state.network = { ...state.network, Labels: {} };
      f.controller.abort();
    }
  });
  expect(await f.run()).toMatchObject({
    ok: false,
    detail: expect.stringContaining("cleanup could not be confirmed"),
  });
  expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
});
it("deadline cancellation waits for actual request retirement", async () => {
  vi.useFakeTimers();
  const f = fixture((_call, reply) => {
    reply.stall = true;
    reply.holdClose = true;
  });
  let settled = false;
  const work = f.run().then((v) => {
    settled = true;
    return v;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(settled).toBe(false);
  expect(f.calls[0]?.destroyed()).toBe(true);
  f.calls[0]?.close();
  expect((await work).ok).toBe(false);
});
it("sends no requests after prior cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  expect((await f.run()).ok).toBe(false);
  expect(mock.request).not.toHaveBeenCalled();
});
it.each(["foreign", "localdot-test-../foreign", "localdot-test-x?force=true", "localdot-test-x\n"])(
  "refuses unsafe name %j without a request",
  async (name) => {
    const f = fixture();
    expect((await f.run(name)).ok).toBe(false);
    expect(mock.request).not.toHaveBeenCalled();
  },
);
