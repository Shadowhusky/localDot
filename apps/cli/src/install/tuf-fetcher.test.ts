import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request }));

import { DownloadHTTPError } from "tuf-js/dist/error.js";
import { downloadTufBytes, SIGSTORE_TUF_MIRROR } from "./tuf-fetcher.ts";

function response(
  status = 200,
  chunks = [Buffer.from("{}")],
  headers: Record<string, string | undefined> = {},
) {
  const res = Object.assign(Readable.from(chunks), { statusCode: status, headers });
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  request.mockImplementation((_url, options, handler) => {
    req.end.mockImplementation(() => queueMicrotask(() => handler(res)));
    options.signal.addEventListener("abort", () => {
      req.emit("error", options.signal.reason);
      res.destroy();
    });
    return req;
  });
  return { res, req };
}
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
const url = `${SIGSTORE_TUF_MIRROR}/timestamp.json`;
const signal = () => new AbortController().signal;

it("uses credential-free direct HTTPS and bounds the response stream", async () => {
  const { req } = response();
  await expect(downloadTufBytes(url, 10, signal())).resolves.toEqual(Buffer.from("{}"));
  expect(request.mock.calls[0]?.[0].href).toBe(url);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    agent: false,
    minVersion: "TLSv1.2",
    method: "GET",
    headers: { accept: "application/json", "accept-encoding": "identity" },
  });
  expect(req.destroy).toHaveBeenCalled();
  response(200, [Buffer.from("123"), Buffer.from("456")]);
  await expect(downloadTufBytes(url, 5, signal())).rejects.toThrow("could not be downloaded");
});
it("does not follow redirects and preserves only TUF's HTTP status semantics", async () => {
  for (const status of [302, 403, 404, 500]) {
    response(status, [], { location: "https://untrusted.invalid" });
    await expect(downloadTufBytes(url, 10, signal())).rejects.toBeInstanceOf(DownloadHTTPError);
  }
  expect(request).toHaveBeenCalledTimes(4);
});
it("refuses compressed, oversized and invalid content-length responses", async () => {
  for (const headers of [
    { "content-encoding": "gzip" },
    { "content-length": "100" },
    { "content-length": "-1" },
  ]) {
    response(200, [], headers);
    await expect(downloadTufBytes(url, 10, signal())).rejects.toThrow("could not be downloaded");
  }
});
it("aborts a stalled request on the total request deadline and caller cancellation", async () => {
  vi.useFakeTimers();
  request.mockImplementation((_url, options) => {
    const req = Object.assign(new EventEmitter(), { end() {} });
    options.signal.addEventListener("abort", () => req.emit("error", options.signal.reason));
    return req;
  });
  const timed = downloadTufBytes(url, 10, signal()).catch((error) => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await timed).toBeInstanceOf(Error);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const cancelled = downloadTufBytes(url, 10, controller.signal).catch((error) => error);
  controller.abort(reason);
  expect(await cancelled).toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});
