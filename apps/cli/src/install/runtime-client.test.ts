import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { DockerRequest } from "../../../daemon/src/cells/docker.ts";
import { installRuntimeClient } from "./runtime-client.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
const id = "a".repeat(64),
  ref = `ghcr.io/example/localdot-gate@sha256:${id}`;
const client = (signal = new AbortController().signal) =>
  installRuntimeClient("/private/test/docker.sock", signal);
function response(
  options: {
    status?: number;
    bytes?: Buffer;
    headers?: Record<string, string>;
    complete?: boolean;
    stall?: boolean;
    manualClose?: boolean;
  } = {},
) {
  const bytes = options.bytes ?? Buffer.from("{}");
  const res = Object.assign(Readable.from([bytes]), {
    statusCode: options.status ?? 200,
    complete: options.complete ?? true,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.length),
      ...options.headers,
    },
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
it("uses only the recorded socket and closes the transport for GET/create/exact-ID DELETE", async () => {
  response();
  await client().request({ method: "GET", path: `/images/${encodeURIComponent(ref)}/json` });
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    socketPath: "/private/test/docker.sock",
    agent: false,
    path: `/v1.47/images/${encodeURIComponent(ref)}/json`,
  });
  const created = response({ status: 201, bytes: Buffer.from(JSON.stringify({ Id: id })) });
  await client().request({
    method: "POST",
    path: "/containers/create",
    query: { name: "localdot-gate-test" },
    body: { Image: ref, Env: ["TOKEN=private"] },
  });
  expect(JSON.parse(created.req.end.mock.calls[0]?.[0])).toEqual({
    Image: ref,
    Env: ["TOKEN=private"],
  });
  expect(created.req.destroy).toHaveBeenCalledOnce();
  response({ status: 204, bytes: Buffer.alloc(0) });
  await client().request({ method: "DELETE", path: `/containers/${id}` });
  expect(request.mock.calls.at(-1)?.[0].path).toBe(`/v1.47/containers/${id}`);
});
it("distinguishes absent objects from a failed request without exposing Docker diagnostics", async () => {
  response({ status: 404, bytes: Buffer.from("private diagnostic") });
  await expect(
    client().request({ method: "GET", path: `/containers/${id}/json` }),
  ).rejects.toMatchObject({ status: 404 });
  response({ status: 500, bytes: Buffer.from("private diagnostic") });
  await expect(client().request({ method: "GET", path: `/containers/${id}/json` })).rejects.toThrow(
    /^Computer runtime transport could not be confirmed\.$/,
  );
});
it.each([
  { method: "POST", path: `/containers/${id}/start` },
  { method: "DELETE", path: `/volumes/${id}` },
  { method: "DELETE", path: `/networks/${id}` },
  { method: "DELETE", path: "/containers/localdot-gate" },
  { method: "DELETE", path: `/containers/${id}`, query: { force: "true" } },
  {
    method: "GET",
    path: "/containers/json",
    query: { all: "true", filters: "private invalid JSON" },
  },
  {
    method: "GET",
    path: "/containers/json",
    query: { all: "true", filters: '{"volume":["okay","extra"]}' },
  },
  { method: "GET", path: "/images/latest/json" },
  { method: "GET", path: `/containers/${id}/json`, body: "private" },
  { method: "POST", path: "/containers/create", query: { name: "bad?query" }, body: {} },
  {
    method: "POST",
    path: "/containers/create",
    query: { name: "okay" },
    body: { extra: "x".repeat(256 * 1024) },
  },
] as DockerRequest[])(
  "refuses requests outside the stopped-runtime protocol ($method $path)",
  async (input) => {
    await expect(client().request(input)).rejects.toThrow(
      /^Computer runtime transport could not be confirmed\.$/,
    );
    expect(request).not.toHaveBeenCalled();
  },
);
it.each([
  "redirect",
  "oversize",
  "bad-length",
  "compressed",
  "utf8",
  "truncated",
  "primitive",
  "bad-json",
])("refuses %s replies and drains them", async (fault) => {
  const options: Parameters<typeof response>[0] = {};
  if (fault === "redirect") options.status = 302;
  if (fault === "oversize") options.bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  if (fault === "bad-length") options.headers = { "content-length": "1" };
  if (fault === "compressed") options.headers = { "content-encoding": "gzip" };
  if (fault === "utf8") options.bytes = Buffer.from([255]);
  if (fault === "truncated") options.complete = false;
  if (fault === "primitive") options.bytes = Buffer.from("null");
  if (fault === "bad-json") options.bytes = Buffer.from("private");
  const r = response(options);
  await expect(client().request({ method: "GET", path: `/containers/${id}/json` })).rejects.toThrow(
    /^Computer runtime transport could not be confirmed\.$/,
  );
  expect(r.req.destroy).toHaveBeenCalledOnce();
});
it("retains cancellation ownership until the actual request closes", async () => {
  const r = response({ stall: true, manualClose: true }),
    abort = new AbortController();
  let settled = false;
  const result = client(abort.signal)
    .request({ method: "DELETE", path: `/containers/${id}` })
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  abort.abort();
  await setImmediate();
  expect(settled).toBe(false);
  expect(r.req.destroy).toHaveBeenCalledOnce();
  r.close();
  expect(await result).toBeInstanceOf(Error);
});
it("bounds a stalled exchange and drains before returning", async () => {
  vi.useFakeTimers();
  const r = response({ stall: true });
  const result = client()
    .request({ method: "GET", path: `/containers/${id}/json` })
    .catch((e) => e);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toBeInstanceOf(Error);
  expect(r.req.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
