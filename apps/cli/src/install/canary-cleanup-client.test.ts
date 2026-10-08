import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { canaryCleanupClient } from "./canary-cleanup-client.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
const id = "a".repeat(64),
  home = `localdot-canary-${"b".repeat(32)}-home`,
  desktop = `localdot-canary-${"b".repeat(32)}-desktop`;
const signal = () => new AbortController().signal;
const client = () => canaryCleanupClient("/fixture/docker.sock");
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
    const res = Object.assign(Readable.from([options.body ?? Buffer.from("{}")]), {
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

it("uses fixed local paths with no body, force flags, auth or environmental host", async () => {
  response();
  await client().inspect("desktop", desktop, signal());
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    socketPath: "/fixture/docker.sock",
    method: "GET",
    path: `/v1.47/containers/${desktop}/json`,
    agent: false,
  });
  response({ status: 204, body: Buffer.alloc(0) });
  await client().stop(id, signal());
  expect(request.mock.calls.at(-1)?.[0].path).toBe(`/v1.47/containers/${id}/stop?t=3`);
  await client().remove("desktop", id, signal());
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    method: "DELETE",
    path: `/v1.47/containers/${id}`,
  });
  await client().remove("home", home, signal());
  expect(request.mock.calls.at(-1)?.[0].path).toBe(`/v1.47/volumes/${home}`);
  for (const [options] of request.mock.calls) {
    expect(options.hostname).toBeUndefined();
    expect(options.headers.authorization).toBeUndefined();
    expect(options.headers["X-Registry-Auth"]).toBeUndefined();
  }
  for (const result of request.mock.results) expect(result.value.end).toHaveBeenCalledWith();
});

it("checks all stopped and running containers referencing only the exact diagnostic volume", async () => {
  response({ body: Buffer.from("[]") });
  expect(await client().volumeReferences(home, signal())).toEqual([]);
  const path = new URL(request.mock.calls[0]?.[0].path, "http://fixture.invalid");
  expect(path.pathname).toBe("/v1.47/containers/json");
  expect(path.searchParams.get("all")).toBe("true");
  expect(JSON.parse(path.searchParams.get("filters") ?? "")).toEqual({ volume: [home] });
});

it.each(["foreign", "../container", "", "abcd", home])(
  "refuses an invalid container reference %j",
  async (reference) => {
    expect(() => client().inspect("desktop", reference, signal())).toThrow();
    await expect(client().stop(reference, signal())).rejects.toThrow();
    await expect(client().remove("desktop", reference, signal())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  },
);
it("cannot delete a container or network by name, nor access an arbitrary volume", async () => {
  await expect(client().remove("desktop", desktop, signal())).rejects.toThrow();
  await expect(
    client().remove("internal", desktop.replace("desktop", "internal"), signal()),
  ).rejects.toThrow();
  expect(() => client().inspect("home", id, signal())).toThrow();
  expect(() => client().volumeReferences("production-home", signal())).toThrow();
  expect(request).not.toHaveBeenCalled();
});

it.each([
  "redirect",
  "type",
  "encoding",
  "oversize",
  "utf8",
  "json",
  "length",
  "incomplete",
  "null",
])("refuses %s response", async (fault) => {
  response({
    status: fault === "redirect" ? 302 : 200,
    headers: {
      "content-type": fault === "type" ? "text/plain" : "application/json",
      ...(fault === "encoding" ? { "content-encoding": "gzip" } : {}),
      ...(fault === "length" ? { "content-length": "999" } : {}),
    },
    body:
      fault === "oversize"
        ? Buffer.alloc(4 * 1024 * 1024 + 1)
        : fault === "utf8"
          ? Buffer.from([255])
          : fault === "json"
            ? Buffer.from("{")
            : fault === "null"
              ? Buffer.from("null")
              : Buffer.from("{}"),
    complete: fault !== "incomplete",
  });
  await expect(client().inspect("desktop", id, signal())).rejects.toThrow(
    "Diagnostic cleanup transport failed",
  );
});

it.each([204, 304, 404])(
  "accepts stop status %s for subsequent ownership inspection",
  async (status) => {
    response({ status, body: Buffer.alloc(0) });
    await client().stop(id, signal());
  },
);
it.each([200, 304, 409, 500])("refuses deletion status %s", async (status) => {
  response({ status, body: Buffer.alloc(0) });
  await expect(client().remove("desktop", id, signal())).rejects.toThrow();
});

it.each(["success", "malformed", "abort", "timeout", "abort-during-drain"])(
  "retains transport ownership until close on %s",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const close = response({
      manualClose: true,
      stall: fault === "abort" || fault === "timeout",
      body: Buffer.from(fault === "malformed" ? "{" : "{}"),
    });
    const controller = new AbortController();
    let settled = false;
    const result = client()
      .inspect("desktop", id, controller.signal)
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    await setImmediate();
    if (fault === "abort" || fault === "abort-during-drain") controller.abort();
    if (fault === "timeout") await vi.advanceTimersByTimeAsync(10_000);
    await setImmediate();
    expect(settled).toBe(false);
    close();
    const value = await result;
    if (fault === "success") expect(value).toEqual({});
    else expect(value).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not request after pre-cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(client().inspect("desktop", id, controller.signal)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
