import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { readHostDockerFacts } from "./host-docker-facts.ts";

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request: mock.request }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
type Reply = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  complete: boolean;
  stall: boolean;
  holdClose: boolean;
};
function fixture(hook?: (path: string, reply: Reply) => void) {
  const controller = new AbortController(),
    calls: { path: string; signal: AbortSignal; close: () => void; destroyed: () => boolean }[] =
      [];
  mock.request.mockImplementation((options, callback) => {
    const reply: Reply = {
      status: 200,
      headers: { "content-type": "application/json" },
      complete: true,
      stall: false,
      holdClose: false,
      body: Buffer.from(
        JSON.stringify(
          options.path === "/version"
            ? {
                Version: "29.2.0",
                ApiVersion: "1.52",
                MinAPIVersion: "1.44",
                Os: "linux",
                Arch: "aarch64",
              }
            : { OperatingSystem: "Docker Desktop fixture", MemTotal: 16 * 1024 ** 3 },
        ),
      ),
    };
    hook?.(options.path, reply);
    const req = new EventEmitter();
    let destroyed = false,
      closed = false;
    const response = new Readable({
      read() {
        if (!reply.stall) {
          this.push(reply.body);
          this.push(null);
        }
      },
    });
    Object.assign(response, {
      statusCode: reply.status,
      headers: reply.headers,
      complete: reply.complete,
    });
    const close = () => {
      if (closed) return;
      closed = true;
      options.signal.removeEventListener("abort", abort);
      req.emit("close");
    };
    const abort = () => {
      const error = new Error("private cancellation");
      response.destroy(error);
      req.emit("error", error);
    };
    // Avoid an unobserved error if cancellation precedes the response callback.
    response.on("error", () => {});
    Object.assign(req, {
      end: () =>
        queueMicrotask(() => {
          if (options.signal.aborted) abort();
          else callback(response);
        }),
      destroy: () => {
        destroyed = true;
        response.destroy();
        if (!reply.holdClose) queueMicrotask(close);
        return req;
      },
    });
    options.signal.addEventListener("abort", abort, { once: true });
    calls.push({ path: options.path, signal: options.signal, close, destroyed: () => destroyed });
    return req;
  });
  return {
    controller,
    calls,
    run: () => readHostDockerFacts("/private/fixture/docker.sock", controller.signal),
  };
}
it("reads only bounded version/info JSON from the explicit Unix socket and drains both", async () => {
  const f = fixture();
  expect(await f.run()).toEqual({
    version: "29.2.0",
    apiVersion: "1.52",
    minimumApiVersion: "1.44",
    operatingSystem: "linux",
    architecture: "aarch64",
    desktop: true,
    memoryBytes: 16 * 1024 ** 3,
  });
  expect(f.calls.map((c) => c.path)).toEqual(["/version", "/info"]);
  for (const [options] of mock.request.mock.calls)
    expect(options).toMatchObject({
      socketPath: "/private/fixture/docker.sock",
      agent: false,
      method: "GET",
      headers: { "accept-encoding": "identity" },
    });
  expect(f.calls.every((c) => c.destroyed())).toBe(true);
});
it.each([
  "status",
  "redirect",
  "content",
  "compressed",
  "length",
  "short",
  "huge",
  "partial",
  "utf8",
  "json",
  "array",
  "null",
])("refuses %s evidence and drains both requests", async (fault) => {
  const f = fixture((path, r) => {
    if (path !== "/version") return;
    if (fault === "status") r.status = 500;
    if (fault === "redirect") {
      r.status = 302;
      r.headers.location = "https://foreign.invalid";
    }
    if (fault === "content") r.headers["content-type"] = "text/plain";
    if (fault === "compressed") r.headers["content-encoding"] = "gzip";
    if (fault === "length") r.headers["content-length"] = "invalid";
    if (fault === "short") r.headers["content-length"] = String(r.body.length + 1);
    if (fault === "huge") r.body = Buffer.alloc(1024 * 1024 + 1, 65);
    if (fault === "partial") r.complete = false;
    if (fault === "utf8") r.body = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
    if (fault === "json") r.body = Buffer.from("{private");
    if (fault === "array") r.body = Buffer.from("[]");
    if (fault === "null") r.body = Buffer.from("null");
  });
  await expect(f.run()).rejects.toThrow("prerequisites could not be verified");
  expect(f.calls).toHaveLength(2);
  expect(f.calls.every((c) => c.destroyed())).toBe(true);
});
it("does not finish on the first failure while its cancelled sibling is still closing", async () => {
  const f = fixture((path, r) => {
    if (path === "/version") r.status = 500;
    else {
      r.stall = true;
      r.holdClose = true;
    }
  });
  let settled = false;
  const work = f.run().then(
    () => {
      settled = true;
      return "pass";
    },
    () => {
      settled = true;
      return "fail";
    },
  );
  await vi.waitFor(() => expect(f.calls[1]?.destroyed()).toBe(true));
  expect(f.calls[1]?.signal.aborted).toBe(true);
  expect(settled).toBe(false);
  f.calls[1]?.close();
  expect(await work).toBe("fail");
});
it.each(["cancel", "deadline", "after-eof"])("waits for actual close after %s", async (fault) => {
  vi.useFakeTimers();
  const f = fixture((_path, r) => {
    r.stall = fault !== "after-eof";
    r.holdClose = true;
  });
  let settled = false;
  const work = f.run().then(
    () => {
      settled = true;
      return "pass";
    },
    () => {
      settled = true;
      return "fail";
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  if (fault === "deadline") await vi.advanceTimersByTimeAsync(2500);
  else f.controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(f.calls.every((c) => c.destroyed())).toBe(true);
  f.calls[0]?.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  f.calls[1]?.close();
  expect(await work).toBe("fail");
});
it("does not send either request after prior cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(mock.request).not.toHaveBeenCalled();
});
