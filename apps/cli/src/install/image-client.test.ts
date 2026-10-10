import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ImagePin, imageRef } from "../../../../packages/protocol/src/release.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));

import { installImageClient } from "./image-client.ts";

const pin = ImagePin.parse({
  repository: "ghcr.io/shadowhusky/localdot-desktop",
  digest: `sha256:${"a".repeat(64)}`,
  platforms: ["linux/arm64", "linux/amd64"],
});
const signal = () => new AbortController().signal;
const client = () => installImageClient("/fixture/docker.sock");
interface ResponseOptions {
  status?: number;
  chunks?: Buffer[];
  headers?: Record<string, string | undefined>;
  complete?: boolean;
  stall?: boolean;
  manualClose?: boolean;
}
function mockResponse(input: ResponseOptions | ((path: string) => ResponseOptions) = {}) {
  const requests: Array<{
    req: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    close: () => void;
  }> = [];
  request.mockImplementation((options, callback) => {
    const cfg = typeof input === "function" ? input(options.path) : input;
    const res = Object.assign(Readable.from(cfg.chunks ?? [Buffer.from("{}\n")]), {
      statusCode: cfg.status ?? 200,
      headers: cfg.headers ?? {},
      complete: cfg.complete ?? true,
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
      if (!cfg.manualClose) queueMicrotask(close);
    });
    req.end.mockImplementation(() => {
      if (!cfg.stall) queueMicrotask(() => callback(res));
    });
    options.signal.addEventListener("abort", () => {
      req.emit("error", options.signal.reason);
      if (cfg.stall) res.on("error", () => {});
      res.destroy(options.signal.reason);
    });
    requests.push({ req, close });
    return req;
  });
  return requests;
}
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
it("uses only the local Unix socket and exact digest/platform without credentials or body", async () => {
  mockResponse({ chunks: [Buffer.from('{"status":"Downloading"}\n')] });
  await client().pull(pin, signal(), vi.fn());
  expect(request).toHaveBeenCalledOnce();
  const options = request.mock.calls[0]?.[0];
  expect(options).toMatchObject({
    socketPath: "/fixture/docker.sock",
    method: "POST",
    agent: false,
    headers: {
      host: "docker",
      accept: "application/json",
      "accept-encoding": "identity",
      "content-length": "0",
    },
  });
  const url = new URL(options.path, "http://docker");
  expect(url.pathname).toBe("/v1.47/images/create");
  expect([...url.searchParams]).toEqual([
    ["fromImage", imageRef(pin)],
    ["platform", "linux/arm64"],
  ]);
  expect(options.headers["X-Registry-Auth"]).toBeUndefined();
  expect(options.hostname).toBeUndefined();
});
it.each([
  "",
  "/",
  "tcp://elsewhere:2375",
  "relative.sock",
  "/x/../docker.sock",
  "/x?token",
  "/x\n",
])("refuses unsafe socket %j before a request", (path) => {
  expect(() => installImageClient(path)).toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("encodes exact inspect references and treats only 404 as missing", async () => {
  mockResponse();
  await client().inspect(pin, signal());
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    method: "GET",
    path: `/v1.47/images/${encodeURIComponent(imageRef(pin))}/json`,
  });
  mockResponse({ status: 404, chunks: [Buffer.from('{"message":"no such image"}')] });
  expect(await client().inspect(pin, signal())).toBeNull();
  mockResponse({ status: 500 });
  await expect(client().inspect(pin, signal())).rejects.toThrow();
});
it("pulls the explicitly selected AMD64 release and rejects missing platform pins", async () => {
  mockResponse({ chunks: [Buffer.from('{"status":"Downloading"}\n')] });
  const amd64 = installImageClient("/fixture/docker.sock", "amd64");
  await amd64.pull(pin, signal(), vi.fn());
  expect(
    new URL(request.mock.calls[0]?.[0].path, "http://docker").searchParams.get("platform"),
  ).toBe("linux/amd64");
  request.mockClear();
  await expect(
    amd64.pull({ ...pin, platforms: ["linux/arm64"] }, signal(), vi.fn()),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("normalizes Docker's arm64 alias but requires a Desktop Linux engine and stable ID", async () => {
  mockResponse((path) => ({
    chunks: [
      Buffer.from(
        JSON.stringify(
          path === "/version"
            ? { Os: "linux", Arch: "aarch64" }
            : { ID: "engine-1", OperatingSystem: "Docker Desktop" },
        ),
      ),
    ],
  }));
  expect(await client().engine(signal())).toEqual({
    id: "engine-1",
    operatingSystem: "linux",
    architecture: "arm64",
  });
  expect(request.mock.calls.map(([options]) => options.path)).toEqual(["/version", "/v1.47/info"]);
});
it.each(["amd64", "remote-engine", "invalid-id"])("refuses %s engine facts", async (kind) => {
  mockResponse((path) => ({
    chunks: [
      Buffer.from(
        JSON.stringify(
          path === "/version"
            ? { Os: "linux", Arch: kind === "amd64" ? "amd64" : "arm64" }
            : {
                ID: kind === "invalid-id" ? "\n" : "engine-1",
                OperatingSystem: kind === "remote-engine" ? "Linux" : "Docker Desktop",
              },
        ),
      ),
    ],
  }));
  await expect(client().engine(signal())).rejects.toThrow();
});
it.each([301, 302, 307, 401, 404, 500])(
  "refuses pull HTTP %s without retry or redirect",
  async (status) => {
    mockResponse({ status, headers: { location: "https://elsewhere.invalid" } });
    await expect(client().pull(pin, signal(), vi.fn())).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  },
);
it.each([
  { chunks: [Buffer.from('{"error":"secret response"}\n')] },
  { complete: false },
  { headers: { "content-length": "16777217" } },
  { headers: { "content-length": "1" } },
  { headers: { "content-length": "-1" } },
  { headers: { "content-encoding": "gzip" } },
])(
  "rejects streaming failure or invalid headers %# without exposing response text",
  async (options) => {
    mockResponse(options);
    await expect(client().pull(pin, signal(), vi.fn())).rejects.toThrow(
      "Docker image preparation failed. Check Docker Desktop and retry.",
    );
  },
);
it("bounds inspect metadata without a content-length and rejects malformed JSON", async () => {
  mockResponse({ chunks: [Buffer.alloc(2 * 1024 * 1024 + 1)] });
  await expect(client().inspect(pin, signal())).rejects.toThrow();
  mockResponse({ chunks: [Buffer.from("not json")] });
  await expect(client().inspect(pin, signal())).rejects.toThrow();
});
it("does not settle pull failure until the request is actually closed", async () => {
  const calls = mockResponse({ manualClose: true, chunks: [Buffer.from('{"error":"failed"}\n')] });
  let settled = false;
  const result = client()
    .pull(pin, signal(), vi.fn())
    .catch((e) => {
      settled = true;
      return e;
    });
  await vi.waitFor(() => expect(calls[0]?.req.destroy).toHaveBeenCalled());
  expect(settled).toBe(false);
  calls[0]?.close();
  expect(await result).toBeInstanceOf(Error);
});
it("cancels or times out stalled requests and waits for closure", async () => {
  vi.useFakeTimers();
  mockResponse({ stall: true });
  const expired = client()
    .pull(pin, signal(), vi.fn())
    .catch((e) => e);
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(await expired).toBeInstanceOf(Error);
  const calls = mockResponse({ stall: true, manualClose: true }),
    controller = new AbortController(),
    reason = new Error("stop");
  let settled = false;
  const result = client()
    .pull(pin, controller.signal, vi.fn())
    .catch((e) => {
      settled = true;
      return e;
    });
  controller.abort(reason);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls[0]?.req.destroy).toHaveBeenCalled();
  expect(settled).toBe(false);
  calls[0]?.close();
  expect(await result).toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});
it("makes no request for malformed pins or pre-existing cancellation", async () => {
  mockResponse();
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(client().pull(pin, controller.signal, vi.fn())).rejects.toThrow("stop");
  await expect(client().inspect({ ...pin, digest: "latest" }, signal())).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
