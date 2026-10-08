import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { installNetworkClient, probeName } from "./network-client.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
const id = "b".repeat(64),
  owner = "a".repeat(32),
  nonce = "c".repeat(32);
const probe = { owner, nonce, name: probeName(owner, nonce), engineId: "engine" };
const client = () => installNetworkClient("/fixture/docker.sock");
function response(
  options: {
    status?: number;
    body?: Buffer;
    headers?: Record<string, string>;
    complete?: boolean;
    manualClose?: boolean;
    stall?: boolean;
  } = {},
) {
  let close!: () => void;
  request.mockImplementation((opts, callback) => {
    const res = Object.assign(Readable.from([options.body ?? Buffer.from(`{"Id":"${id}"}`)]), {
      statusCode: options.status ?? 200,
      headers: options.headers ?? { "content-type": "application/json" },
      complete: options.complete ?? true,
    });
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    let closed = false;
    close = () => {
      if (!closed) {
        closed = true;
        req.emit("close");
      }
    };
    req.destroy.mockImplementation(() => {
      if (!options.manualClose) queueMicrotask(close);
    });
    req.end.mockImplementation(() => {
      if (!options.stall) queueMicrotask(() => callback(res));
    });
    opts.signal.addEventListener("abort", () => {
      req.emit("error", opts.signal.reason);
      res.on("error", () => {});
      res.destroy(opts.signal.reason);
    });
    return req;
  });
  return () => close();
}
it("creates only the owned empty internal probe with fixed isolation settings", async () => {
  response({ status: 201 });
  await client().create(probe, new AbortController().signal);
  const [options] = request.mock.calls[0] ?? [],
    req = request.mock.results[0]?.value;
  expect(options).toMatchObject({
    socketPath: "/fixture/docker.sock",
    method: "POST",
    path: "/v1.47/networks/create",
    agent: false,
  });
  expect(JSON.parse(req.end.mock.calls[0][0].toString())).toEqual({
    Name: probe.name,
    Driver: "bridge",
    Internal: true,
    EnableIPv6: false,
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
    CheckDuplicate: true,
    Labels: { "localdot.install-owner": owner, "localdot.install-probe": nonce },
  });
  expect(options.headers.authorization).toBeUndefined();
  expect(options.headers["X-Registry-Auth"]).toBeUndefined();
  expect(options.hostname).toBeUndefined();
});
it("allows inspection by exact probe name, but deletion only by full ID", async () => {
  response();
  await client().inspect(probe.name, new AbortController().signal);
  expect(request.mock.calls[0]?.[0].path).toBe(`/v1.47/networks/${probe.name}`);
  response({ status: 204, body: Buffer.alloc(0) });
  await client().remove(id, new AbortController().signal);
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    method: "DELETE",
    path: `/v1.47/networks/${id}`,
  });
  await expect(client().remove(probe.name, new AbortController().signal)).rejects.toThrow();
});
it.each(["foreign", "../network", "", "abc"])(
  "refuses reference %j before sending",
  async (ref) => {
    response();
    expect(() => client().inspect(ref, new AbortController().signal)).toThrow();
    await expect(client().remove(ref, new AbortController().signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  },
);
it.each(["status", "type", "encoding", "size", "utf8", "json", "framing", "incomplete"])(
  "rejects %s responses",
  async (kind) => {
    response({
      status: kind === "status" ? 500 : 200,
      headers: {
        "content-type": kind === "type" ? "text/plain" : "application/json",
        ...(kind === "encoding" ? { "content-encoding": "gzip" } : {}),
        ...(kind === "framing" ? { "content-length": "999" } : {}),
      },
      body:
        kind === "size"
          ? Buffer.alloc(1024 * 1024 + 1)
          : kind === "utf8"
            ? Buffer.from([255])
            : kind === "json"
              ? Buffer.from("{")
              : Buffer.from("{}"),
      complete: kind !== "incomplete",
    });
    await expect(client().inspect(id, new AbortController().signal)).rejects.toThrow(
      "could not be completed",
    );
  },
);
it("treats only inspect 404 as absence", async () => {
  response({ status: 404, body: Buffer.from("missing") });
  expect(await client().inspect(id, new AbortController().signal)).toBeNull();
  await expect(client().create(probe, new AbortController().signal)).rejects.toThrow();
});
it.each(["abort", "timeout"])("waits for real request closure after %s", async (kind) => {
  vi.useFakeTimers();
  const close = response({ stall: true, manualClose: true }),
    controller = new AbortController();
  let settled = false;
  const promise = client()
    .inspect(id, controller.signal)
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  if (kind === "abort") controller.abort();
  else await vi.advanceTimersByTimeAsync(10000);
  await Promise.resolve();
  expect(settled).toBe(false);
  close();
  expect(await promise).toBeInstanceOf(Error);
  expect(vi.getTimerCount()).toBe(0);
});
it("starts no request after cancellation or with an invalid probe", async () => {
  response();
  const controller = new AbortController();
  controller.abort();
  await expect(client().create(probe, controller.signal)).rejects.toThrow();
  expect(() =>
    client().create({ ...probe, name: "foreign" }, new AbortController().signal),
  ).toThrow();
  expect(request).not.toHaveBeenCalled();
});
