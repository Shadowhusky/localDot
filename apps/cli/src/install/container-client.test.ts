import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { installContainerClient } from "./container-client.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
const client = () => installContainerClient("/private/test/docker.sock"),
  signal = () => new AbortController().signal;
const id = "a".repeat(64);
function response(
  options: {
    status?: number;
    value?: unknown;
    bytes?: Buffer;
    headers?: Record<string, string>;
    complete?: boolean;
    stall?: boolean;
    manualClose?: boolean;
  } = {},
) {
  const bytes = options.bytes ?? Buffer.from(JSON.stringify(options.value ?? {}));
  const res = Object.assign(Readable.from([bytes]), {
    statusCode: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.length),
      ...options.headers,
    },
    complete: options.complete ?? true,
  });
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      req.emit("close");
    }
  };
  req.destroy.mockImplementation(() => {
    if (!options.manualClose) queueMicrotask(close);
  });
  request.mockImplementation((config, callback) => {
    req.end.mockImplementation(() => {
      if (!options.stall) queueMicrotask(() => callback(res));
    });
    config.signal.addEventListener("abort", () => {
      req.emit("error", config.signal.reason);
      res.on("error", () => {});
      res.destroy(config.signal.reason);
    });
    return req;
  });
  return { req, res, close };
}
it("uses fixed local container paths and never includes credentials or a command body", async () => {
  response({ value: [] });
  await client().list(signal());
  const opts = request.mock.calls[0]?.[0];
  expect(opts).toMatchObject({
    socketPath: "/private/test/docker.sock",
    method: "GET",
    agent: false,
    headers: { host: "docker" },
  });
  const url = new URL(opts.path, "http://docker");
  expect(url.pathname).toBe("/v1.47/containers/json");
  expect(url.searchParams.get("all")).toBe("true");
  expect(JSON.parse(url.searchParams.get("filters") ?? "null")).toEqual({
    label: ["localdot.role"],
  });
  response({ status: 204, bytes: Buffer.alloc(0) });
  await client().kill(id, signal());
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    path: `/v1.47/containers/${id}/kill?signal=SIGKILL`,
    method: "POST",
    headers: { "content-length": "0" },
  });
  expect(request.mock.calls.at(-1)?.[0].headers.authorization).toBeUndefined();
});
it("uses 404 only for absent individual containers, never a missing list endpoint", async () => {
  response({ status: 404 });
  expect(await client().inspect(id, signal())).toBeNull();
  response({ status: 404 });
  await expect(client().list(signal())).rejects.toThrow();
});
it.each([
  "null",
  "array-primitive",
  "bad-json",
  "bad-utf8",
  "overflow",
  "length",
  "encoding",
  "incomplete",
  "redirect",
  "server",
])("refuses %s metadata", async (kind) => {
  const options: Parameters<typeof response>[0] = {};
  if (kind === "null") options.bytes = Buffer.from("null");
  if (kind === "array-primitive") options.bytes = Buffer.from("42");
  if (kind === "bad-json") options.bytes = Buffer.from("private raw diagnostic");
  if (kind === "bad-utf8") options.bytes = Buffer.from([255]);
  if (kind === "overflow") options.bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  if (kind === "length") options.headers = { "content-length": "1" };
  if (kind === "encoding") options.headers = { "content-encoding": "gzip" };
  if (kind === "incomplete") options.complete = false;
  if (kind === "redirect") options.status = 302;
  if (kind === "server") options.status = 500;
  const r = response(options);
  await expect(client().inspect(id, signal())).rejects.toThrow(
    /^LocalDot container shutdown could not be confirmed\.$/,
  );
  expect(r.req.destroy).toHaveBeenCalledOnce();
});
it.each(["", "../other", "name?query", "a".repeat(63), "A".repeat(64)])(
  "never signals an invalid ID %j",
  async (invalid) => {
    await expect(client().kill(invalid, signal())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  },
);
it.each([204, 404, 409])(
  "allows status %s only as a kill observation requiring later inspection",
  async (status) => {
    response({ status, bytes: Buffer.alloc(0) });
    await client().kill(id, signal());
  },
);
it("cancellation waits for actual request close", async () => {
  const r = response({ stall: true, manualClose: true }),
    cancel = new AbortController();
  let settled = false;
  const work = client()
    .inspect(id, cancel.signal)
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  cancel.abort(new Error("cancelled"));
  await setImmediate();
  expect(settled).toBe(false);
  expect(r.req.destroy).toHaveBeenCalledOnce();
  r.close();
  expect(await work).toBeInstanceOf(Error);
});
it("bounds a stalled response to ten seconds and drains the transport", async () => {
  vi.useFakeTimers();
  const r = response({ stall: true });
  const work = client()
    .inspect(id, signal())
    .catch((e) => e);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await work).toBeInstanceOf(Error);
  expect(r.req.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["", "relative.sock", "/private/../docker.sock", "/socket?x=1"])(
  "refuses an unsafe socket %j",
  (socket) => {
    expect(() => installContainerClient(socket)).toThrow();
    expect(request).not.toHaveBeenCalled();
  },
);
