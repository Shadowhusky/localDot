import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request }));

import { KEYD_PACKAGE } from "../../../../packages/protocol/src/release.ts";
import {
  downloadNativeArchive,
  downloadRegistryResource,
  latestReleaseVersion,
  type RegistryResource,
  registryResourceURL,
} from "./registry-download.ts";

const resource: RegistryResource = { name: "localdot", version: "1.2.3", kind: "metadata" };
const signal = () => new AbortController().signal;
async function read(input = resource, abort = signal()) {
  const chunks: Buffer[] = [];
  for await (const chunk of downloadRegistryResource(input, abort)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function mockResponse({
  status = 200,
  chunks = [Buffer.from("{}")],
  headers = {},
  complete = true,
  stall = false,
  manualClose = false,
}: {
  status?: number;
  chunks?: Buffer[];
  headers?: Record<string, string | undefined>;
  complete?: boolean;
  stall?: boolean;
  manualClose?: boolean;
} = {}) {
  const res = Object.assign(Readable.from(chunks), { statusCode: status, headers, complete });
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      req.emit("close");
    }
  };
  req.destroy.mockImplementation(() => {
    if (!manualClose) queueMicrotask(close);
  });
  request.mockImplementation((_url, options, handler) => {
    req.end.mockImplementation(() => {
      if (!stall) queueMicrotask(() => handler(res));
    });
    options.signal.addEventListener("abort", () => {
      req.emit("error", options.signal.reason);
      res.destroy(options.signal.reason);
      // A response not yet delivered has no consumer to catch its stream error.
      if (stall) res.on("error", () => {});
    });
    return req;
  });
  return { req, res, close };
}
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});

it("resolves latest only as a stable version hint from the fixed package endpoint", async () => {
  const r = mockResponse({
    chunks: [
      Buffer.from(
        JSON.stringify({
          name: "localdot",
          version: "2.3.4",
          dist: { tarball: "https://ignored.invalid/private" },
        }),
      ),
    ],
  });
  expect(await latestReleaseVersion(signal())).toBe("2.3.4");
  expect(request.mock.calls[0]?.[0].href).toBe("https://registry.npmjs.org/localdot/latest");
  expect(request).toHaveBeenCalledOnce();
  expect(r.req.destroy).toHaveBeenCalledOnce();
});
it.each([
  null,
  [],
  { name: "other", version: "2.3.4" },
  { name: "localdot", version: "latest" },
  { name: "localdot", version: "2.3.4-rc.1" },
  { name: "localdot", version: "../private" },
  { name: "localdot", version: `${"1".repeat(65)}.0.0` },
])("rejects invalid stable-version metadata %j", async (raw) => {
  mockResponse({ chunks: [Buffer.from(JSON.stringify(raw))] });
  await expect(latestReleaseVersion(signal())).rejects.toThrow(
    /^Release package download failed\.$/,
  );
});
it.each(["redirect", "utf8", "oversize"])("rejects %s latest metadata", async (kind) => {
  mockResponse(
    kind === "redirect"
      ? { status: 302 }
      : { chunks: [kind === "utf8" ? Buffer.from([255]) : Buffer.alloc(2 * 1024 * 1024 + 1)] },
  );
  await expect(latestReleaseVersion(signal())).rejects.toThrow("download failed");
});

it("constructs only the two release package URLs from exact versions", () => {
  expect(registryResourceURL(resource).href).toBe("https://registry.npmjs.org/localdot/1.2.3");
  expect(registryResourceURL({ ...resource, kind: "archive" }).href).toBe(
    "https://registry.npmjs.org/localdot/-/localdot-1.2.3.tgz",
  );
  expect(registryResourceURL({ ...resource, kind: "attestation" }).href).toBe(
    "https://registry.npmjs.org/-/npm/v1/attestations/localdot@1.2.3",
  );
  const name = KEYD_PACKAGE;
  expect(
    registryResourceURL({ ...resource, name, kind: "archive", version: "1.2.3-rc.1" }).href,
  ).toBe(`https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-1.2.3-rc.1.tgz`);
  expect(registryResourceURL({ ...resource, name }).href).toContain(encodeURIComponent(name));
  for (const value of [
    { name: "unrelated" },
    { version: "latest" },
    { version: "1.2.3/../../other" },
    { version: "1.2.3?token=secret" },
    { kind: "other" },
  ])
    expect(() => registryResourceURL({ ...resource, ...value } as RegistryResource)).toThrow(
      "download failed",
    );
  expect(request).not.toHaveBeenCalled();
});
it("uses direct credential-free HTTPS and returns raw bytes after closure", async () => {
  const { req } = mockResponse({
    chunks: [Buffer.from("ab"), Buffer.from("cd")],
    headers: { "content-length": "4" },
  });
  await expect(read()).resolves.toEqual(Buffer.from("abcd"));
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    method: "GET",
    agent: false,
    minVersion: "TLSv1.2",
    headers: { accept: "application/json", "accept-encoding": "identity" },
  });
  expect(req.destroy).toHaveBeenCalled();
});
it.each([301, 302, 307, 401, 404, 500])(
  "refuses HTTP %s without following a redirect or retrying",
  async (status) => {
    mockResponse({ status, headers: { location: "https://elsewhere.invalid" } });
    await expect(read()).rejects.toThrow("download failed");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { "content-encoding": "gzip" },
  { "content-length": "-1" },
  { "content-length": "" },
  { "content-length": "2.0" },
  { "content-length": "2097153" },
  { "content-length": "9999999999999999999999" },
  { "content-length": "1" },
])("rejects invalid encoding, length and length mismatches: %j", async (headers) => {
  mockResponse({ headers });
  await expect(read()).rejects.toThrow("download failed");
});
it("enforces streaming size limits even without content-length and refuses incomplete HTTP bodies", async () => {
  mockResponse({ chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.from("x")] });
  await expect(read()).rejects.toThrow("download failed");
  mockResponse({ complete: false });
  await expect(read()).rejects.toThrow("download failed");
});
it("waits for request closure on consumer early return", async () => {
  const { req, close } = mockResponse({ manualClose: true });
  const body = downloadRegistryResource(resource, signal())[Symbol.asyncIterator]();
  expect((await body.next()).done).toBe(false);
  let settled = false;
  const done = body.return?.().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(req.destroy).toHaveBeenCalled());
  expect(settled).toBe(false);
  close();
  await done;
  expect(settled).toBe(true);
});
it("waits for request closure on failure before returning control", async () => {
  const { req, close } = mockResponse({ manualClose: true, status: 500 });
  let settled = false;
  const result = read().catch((error) => {
    settled = true;
    return error;
  });
  await vi.waitFor(() => expect(req.destroy).toHaveBeenCalled());
  expect(settled).toBe(false);
  close();
  expect(await result).toBeInstanceOf(Error);
});
it("terminates stalled requests at the deadline and preserves caller cancellation", async () => {
  vi.useFakeTimers();
  mockResponse({ stall: true });
  const timed = read().catch((error) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await timed).toBeInstanceOf(Error);
  const controller = new AbortController(),
    reason = new Error("cancelled");
  mockResponse({ stall: true });
  const cancelled = read(resource, controller.signal).catch((error) => error);
  controller.abort(reason);
  expect(await cancelled).toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});
it("makes no request after a pre-existing cancellation", async () => {
  const controller = new AbortController(),
    reason = new Error("stop");
  controller.abort(reason);
  await expect(read(resource, controller.signal)).rejects.toBe(reason);
  expect(request).not.toHaveBeenCalled();
});

it("downloads scoped native archives using only a constructed npm URL", async () => {
  mockResponse({ chunks: [Buffer.from("archive")] });
  const chunks: Buffer[] = [];
  for await (const chunk of downloadNativeArchive(
    { name: "@img/sharp-darwin-arm64", version: "0.35.5" },
    signal(),
  ))
    chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("archive");
  expect(request.mock.calls[0]?.[0].href).toBe(
    "https://registry.npmjs.org/@img/sharp-darwin-arm64/-/sharp-darwin-arm64-0.35.5.tgz",
  );
  expect(request.mock.calls[0]?.[1].headers).toEqual({
    accept: "application/octet-stream",
    "accept-encoding": "identity",
  });
});
it.each([
  { name: "../secret", version: "1.0.0" },
  { name: "https://elsewhere.invalid", version: "1.0.0" },
  { name: "sharp", version: "latest" },
  { name: "sharp", version: "1.0.0?secret" },
])("refuses native archive URL injection before connecting: %j", async (pkg) => {
  await expect(
    downloadNativeArchive(pkg, signal())[Symbol.asyncIterator]().next(),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("enforces the native compressed cap and refuses native redirects", async () => {
  const pkg = { name: "sharp", version: "0.35.5" };
  mockResponse({ headers: { "content-length": "67108865" } });
  await expect(
    downloadNativeArchive(pkg, signal())[Symbol.asyncIterator]().next(),
  ).rejects.toThrow();
  mockResponse({ status: 302, headers: { location: "https://elsewhere.invalid" } });
  await expect(
    downloadNativeArchive(pkg, signal())[Symbol.asyncIterator]().next(),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});
