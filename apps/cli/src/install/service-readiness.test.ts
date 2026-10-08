import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceReadinessReply } from "../../../../packages/protocol/src/install-services.ts";
import { verifyServiceReadiness, waitForServiceReadiness } from "./service-readiness.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));
const roots: string[] = [];
afterEach(async () => {
  request.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const token = "t".repeat(43),
  signal = () => new AbortController().signal;
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "localdot-ready-client-"));
  roots.push(home);
  await writeFile(join(home, "daemon-token"), token, { mode: 0o600 });
  const identity = {
    ownerId: "e".repeat(32),
    release: {
      version: "1.2.3",
      packageSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
    },
  };
  const expected = { home, port: 4750, identity, daemonPid: 41, keydPid: 42 };
  const reply = ServiceReadinessReply.parse({
    v: 1,
    service: { ...structuredClone(identity), pid: 41 },
    bootId: "6f62ba31-5079-42b2-b851-e142a6bb8c69",
    recovery: "ready",
    keyd: { service: { ...structuredClone(identity), pid: 42 }, bootId: "keyd-boot-1" },
    checks: { recovery: true, admission: true, keydIdentity: true, audit: true, hairpin: true },
    ready: true,
  });
  return { expected, reply };
}
function response(
  body: unknown,
  options: {
    status?: number;
    headers?: Record<string, string>;
    bytes?: Buffer;
    complete?: boolean;
    stall?: boolean;
    manualClose?: boolean;
  } = {},
) {
  const data = options.bytes ?? Buffer.from(JSON.stringify(body));
  const res = Object.assign(Readable.from([data]), {
    statusCode: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(data.length),
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

it("checks the authenticated exact release and both launched PIDs on a fixed loopback request", async () => {
  const f = await fixture(),
    r = response(f.reply);
  expect(await verifyServiceReadiness(f.expected, signal())).toEqual(f.reply);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    hostname: "127.0.0.1",
    port: 4750,
    path: "/api/service/ready",
    method: "GET",
    agent: false,
    headers: {
      host: "127.0.0.1:4750",
      authorization: `Bearer ${token}`,
      "accept-encoding": "identity",
    },
  });
  expect(r.req.destroy).toHaveBeenCalledOnce();
  expect(r.res.destroyed).toBe(true);
});
it.each([
  "daemon-pid",
  "keyd-pid",
  "owner",
  "version",
  "package",
  "manifest",
  "recovery",
  "admission",
  "audit",
  "hairpin",
  "keyd-identity",
])("refuses %s mismatch rather than accepting HTTP success", async (kind) => {
  const f = await fixture();
  if (kind === "daemon-pid") f.reply.service.pid++;
  if (kind === "keyd-pid" && f.reply.keyd) f.reply.keyd.service.pid++;
  if (kind === "owner") f.reply.service.ownerId = "f".repeat(32);
  if (kind === "version") f.reply.service.release.version = "9.9.9";
  if (kind === "package") f.reply.service.release.packageSha256 = "d".repeat(64);
  if (kind === "manifest") f.reply.service.release.manifestSha256 = "d".repeat(64);
  if (kind === "recovery") f.reply.recovery = "starting";
  if (kind === "admission") f.reply.checks.admission = false;
  if (kind === "audit") f.reply.checks.audit = false;
  if (kind === "hairpin") f.reply.checks.hairpin = false;
  if (kind === "keyd-identity" && f.reply.keyd) f.reply.keyd.service.ownerId = "f".repeat(32);
  response(f.reply);
  await expect(verifyServiceReadiness(f.expected, signal())).rejects.toThrow(
    /^The installed services have not confirmed release readiness\.$/,
  );
});
it.each([503, 401, 302, 404, 500])("does not follow or accept HTTP %s", async (status) => {
  const f = await fixture(),
    r = response(f.reply, { status, headers: { location: "https://foreign.invalid" } });
  await expect(verifyServiceReadiness(f.expected, signal())).rejects.toThrow("not confirmed");
  expect(request).toHaveBeenCalledOnce();
  expect(r.res.destroyed).toBe(true);
});
it.each(["overflow", "length", "encoding", "content-type", "utf8", "json", "incomplete", "extra"])(
  "refuses malformed %s responses with a bounded generic error",
  async (kind) => {
    const f = await fixture();
    const options: Parameters<typeof response>[1] = {};
    if (kind === "overflow") options.bytes = Buffer.alloc(8193);
    if (kind === "length") options.headers = { "content-length": "1" };
    if (kind === "encoding") options.headers = { "content-encoding": "gzip" };
    if (kind === "content-type") options.headers = { "content-type": "text/html" };
    if (kind === "utf8") options.bytes = Buffer.from([0xff]);
    if (kind === "json") options.bytes = Buffer.from("private server error");
    if (kind === "incomplete") options.complete = false;
    response(kind === "extra" ? { ...f.reply, foreign: true } : f.reply, options);
    await expect(verifyServiceReadiness(f.expected, signal())).rejects.toThrow(
      /^The installed services have not confirmed release readiness\.$/,
    );
  },
);
it("snapshots expected release and process identities before waiting for the response", async () => {
  const f = await fixture();
  response(f.reply);
  const result = verifyServiceReadiness(f.expected, signal());
  f.expected.identity.release.manifestSha256 = "d".repeat(64);
  f.expected.daemonPid = 0;
  expect((await result).ready).toBe(true);
});
it("refuses unsafe token files before sending a request", async () => {
  const f = await fixture();
  await chmod(join(f.expected.home, "daemon-token"), 0o644);
  await expect(verifyServiceReadiness(f.expected, signal())).rejects.toThrow("not confirmed");
  expect(request).not.toHaveBeenCalled();
});
it("cancels only its request and waits for actual request close", async () => {
  const f = await fixture(),
    r = response(f.reply, { stall: true, manualClose: true });
  const controller = new AbortController(),
    reason = new Error("cancel");
  let settled = false;
  const result = verifyServiceReadiness(f.expected, controller.signal)
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  controller.abort(reason);
  await setImmediate();
  expect(r.req.destroy).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  r.close();
  expect(await result).toBe(reason);
});
it("bounds a stalled response and refuses a pre-cancelled request", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const r = response(f.reply, { stall: true });
  const result = verifyServiceReadiness(f.expected, signal()).catch((e) => e);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toBeInstanceOf(Error);
  expect(r.req.destroy).toHaveBeenCalledOnce();
  request.mockClear();
  const controller = new AbortController();
  controller.abort(new Error("cancel"));
  await expect(verifyServiceReadiness(f.expected, controller.signal)).rejects.toThrow("cancel");
  expect(request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("waits through recovering HTTP503 and retains the original expected identity", async () => {
  const f = await fixture();
  const first = response(f.reply, { status: 503 });
  const firstRequest = request.getMockImplementation();
  response(f.reply);
  const nextRequest = request.getMockImplementation();
  if (!firstRequest || !nextRequest) throw new Error();
  request.mockReset().mockImplementationOnce(firstRequest).mockImplementation(nextRequest);
  const work = waitForServiceReadiness(f.expected, signal());
  f.expected.daemonPid = 99;
  f.expected.identity.release.version = "9.0.0";
  expect((await work).ready).toBe(true);
  expect(first.req.destroy).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(["identity", "unauthorized", "malformed"])(
  "does not retry a permanent %s readiness failure",
  async (kind) => {
    const f = await fixture();
    if (kind === "identity") f.reply.service.pid++;
    response(kind === "malformed" ? {} : f.reply, { status: kind === "unauthorized" ? 401 : 200 });
    await expect(waitForServiceReadiness(f.expected, signal())).rejects.toThrow("not confirmed");
    expect(request).toHaveBeenCalledOnce();
  },
);
it.each(["caller", "deadline"])(
  "stops a pending readiness wait at its %s cancellation",
  async (kind) => {
    const f = await fixture(),
      caller = new AbortController(),
      deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const r = response(f.reply, { status: 503 });
    const work = waitForServiceReadiness(f.expected, caller.signal).catch((error) => error);
    await setImmediate();
    expect(r.req.destroy).toHaveBeenCalledOnce();
    if (kind === "caller") caller.abort(new Error("caller cancelled"));
    else deadline.abort(new Error("deadline"));
    expect(await work).toBeInstanceOf(Error);
    expect(timeout).toHaveBeenCalledWith(180_000);
    expect(request).toHaveBeenCalledOnce();
  },
);
