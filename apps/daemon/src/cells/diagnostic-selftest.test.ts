import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { SELFTEST_CHECKS } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { probeDiagnosticSelfTest } from "./diagnostic-selftest.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
const endpoint = { baseUrl: "http://127.0.0.1:4887", token: "t".repeat(43) };
const passing = () => ({
  ok: true,
  ms: 12,
  checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "private-cell-output" })),
});
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
  const bytes = options.bytes ?? Buffer.from(JSON.stringify(body));
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
      req.emit("error", new Error("private transport detail"));
      res.on("error", () => {});
      res.destroy(new Error("private body detail"));
    });
    return req;
  });
  return { req, res, close };
}
it("uses a fixed bounded loopback request and returns only recomputed known check verdicts", async () => {
  const r = response(passing());
  const result = await probeDiagnosticSelfTest(endpoint, new AbortController().signal);
  expect(result).toEqual({ ok: true, checks: SELFTEST_CHECKS.map(({ id }) => ({ id, ok: true })) });
  expect(JSON.stringify(result)).not.toContain("private-cell-output");
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    hostname: "127.0.0.1",
    port: 4887,
    path: "/selftest",
    method: "GET",
    agent: false,
    headers: {
      host: "127.0.0.1:4887",
      authorization: `Bearer ${endpoint.token}`,
      "accept-encoding": "identity",
    },
  });
  expect(r.req.destroy).toHaveBeenCalledOnce();
  expect(r.res.destroyed).toBe(true);
});
it.each(["failed", "missing", "duplicate", "wrong-kind"])(
  "refuses a passing verdict for %s checks",
  async (fault) => {
    const report = passing();
    if (fault === "failed")
      report.checks[0] = { ...report.checks[0], ok: false } as (typeof report.checks)[number];
    if (fault === "missing") report.checks.shift();
    if (fault === "duplicate")
      report.checks.push({ ...report.checks[0] } as (typeof report.checks)[number]);
    if (fault === "wrong-kind")
      report.checks[0] = { ...report.checks[0], kind: "trust" } as (typeof report.checks)[number];
    response(report);
    const result = await probeDiagnosticSelfTest(endpoint, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toEqual({ id: "route", ok: false });
  },
);
it.each([
  "redirect",
  "auth",
  "mime",
  "encoding",
  "length",
  "oversize",
  "utf8",
  "incomplete",
  "json",
  "unknown-check",
])("rejects %s responses without leaking body data", async (fault) => {
  const options: Parameters<typeof response>[1] = {};
  let report: unknown = passing();
  if (fault === "redirect") options.status = 302;
  if (fault === "auth") options.status = 401;
  if (fault === "mime") options.headers = { "content-type": "text/plain" };
  if (fault === "encoding") options.headers = { "content-encoding": "gzip" };
  if (fault === "length") options.headers = { "content-length": "1" };
  if (fault === "oversize") {
    options.bytes = Buffer.alloc(65537, 32);
    options.headers = { "content-length": "0" };
  }
  if (fault === "utf8") options.bytes = Buffer.from([0xff]);
  if (fault === "incomplete") options.complete = false;
  if (fault === "json") options.bytes = Buffer.from("private-cell-output");
  if (fault === "unknown-check")
    report = {
      ...passing(),
      checks: [
        ...passing().checks,
        { id: "private-cell-output", kind: "trust", ok: true, detail: "" },
      ],
    };
  const r = response(report, options);
  await expect(probeDiagnosticSelfTest(endpoint, new AbortController().signal)).rejects.toThrow(
    /^The computer self-test could not be confirmed\.$/,
  );
  expect(request).toHaveBeenCalledOnce();
  expect(r.req.destroy).toHaveBeenCalledOnce();
});
it.each([
  "http://localhost:4887",
  "http://127.0.0.1:80",
  "http://127.0.0.1:65536",
  "https://127.0.0.1:4887",
  "http://127.0.0.1:4887/",
  "http://user@127.0.0.1:4887",
  "http://127.0.0.2:4887",
])("rejects noncanonical endpoint %s before dispatch", async (baseUrl) => {
  await expect(
    probeDiagnosticSelfTest({ ...endpoint, baseUrl }, new AbortController().signal),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("rejects invalid credentials before dispatch", async () => {
  await expect(
    probeDiagnosticSelfTest({ ...endpoint, token: "private\nvalue" }, new AbortController().signal),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("snapshots endpoint authority before awaiting the response", async () => {
  response(passing());
  const input = { ...endpoint },
    work = probeDiagnosticSelfTest(input, new AbortController().signal);
  input.baseUrl = "http://foreign.invalid:4887";
  input.token = "changed";
  expect((await work).ok).toBe(true);
  expect(request.mock.calls[0]?.[0].headers.authorization).toBe(`Bearer ${endpoint.token}`);
});
it("does not release a cancelled observation until the actual request closes", async () => {
  const controller = new AbortController(),
    r = response(passing(), { stall: true, manualClose: true });
  let settled = false;
  const work = probeDiagnosticSelfTest(endpoint, controller.signal).catch((error) => {
    settled = true;
    return error;
  });
  controller.abort();
  await setImmediate();
  expect(r.req.destroy).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  r.close();
  expect(await work).toBeInstanceOf(Error);
});
it("times out a stalled request and clears its timer after retirement", async () => {
  vi.useFakeTimers();
  const r = response(passing(), { stall: true });
  const work = probeDiagnosticSelfTest(endpoint, new AbortController().signal).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(8000);
  expect(await work).toBeInstanceOf(Error);
  expect(r.req.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not publish a completed body after cancellation during request retirement", async () => {
  const controller = new AbortController(),
    r = response(passing(), { manualClose: true });
  const work = probeDiagnosticSelfTest(endpoint, controller.signal).catch((error) => error);
  await setImmediate();
  expect(r.req.destroy).toHaveBeenCalledOnce();
  controller.abort();
  r.close();
  expect(await work).toBeInstanceOf(Error);
});
it("does not dispatch after prior cancellation", async () => {
  await expect(probeDiagnosticSelfTest(endpoint, AbortSignal.abort())).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
