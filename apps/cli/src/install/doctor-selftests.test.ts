import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { SELFTEST_CHECKS } from "../../../../packages/protocol/src/selftest.ts";
import { requestDoctorSelfTests } from "./doctor-selftests.ts";

const mock = vi.hoisted(() => ({ request: vi.fn(), token: vi.fn(() => "t".repeat(43)) }));
vi.mock("node:http", () => ({ request: mock.request }));
vi.mock("../../../daemon/src/install-token-reader.ts", () => ({ readInstallToken: mock.token }));
afterEach(() => {
  mock.request.mockReset();
  mock.token.mockClear();
  vi.useRealTimers();
});
const expected = {
  home: "/private/fixture",
  port: 4891,
  identity: {
    ownerId: "a".repeat(32),
    release: { version: "1.0.0", packageSha256: "b".repeat(64), manifestSha256: "c".repeat(64) },
  },
  daemonPid: 123,
  keydPid: 456,
  bootId: "01234567-89ab-4cde-8fab-0123456789ab",
};
function response(fault = "", manualClose = false) {
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  let res: Readable | undefined,
    closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      req.emit("close");
    }
  };
  req.destroy.mockImplementation(() => {
    if (!manualClose) queueMicrotask(close);
  });
  mock.request.mockImplementation((config, callback) => {
    req.end.mockImplementation((bytes: Buffer) => {
      const body = {
        v: 1,
        requestId: JSON.parse(bytes.toString()).requestId as string,
        service: { ...structuredClone(expected.identity), pid: expected.daemonPid },
        bootId: expected.bootId,
        cells: [
          {
            id: "01JXYZ00000000000000000001",
            outcome: "passed",
            checks: SELFTEST_CHECKS.map(({ id }) => ({ id, ok: true })),
          },
        ],
      };
      if (fault === "request") body.requestId = "11234567-89ab-4cde-8fab-0123456789ab";
      if (fault === "boot") body.bootId = "11234567-89ab-4cde-8fab-0123456789ab";
      if (fault === "pid") body.service.pid++;
      if (fault === "owner") body.service.ownerId = "d".repeat(32);
      if (fault === "release") body.service.release.version = "9.0.0";
      if (fault === "incomplete-checks") body.cells[0]?.checks.pop();
      if (fault === "false-pass") {
        const check = body.cells[0]?.checks[0];
        if (check) check.ok = false;
      }
      if (fault === "duplicate")
        body.cells.push(structuredClone(body.cells[0] as (typeof body.cells)[number]));
      const data =
        fault === "utf8"
          ? Buffer.from([0xff])
          : fault === "oversize"
            ? Buffer.alloc(65537)
            : Buffer.from(JSON.stringify(body));
      res = Object.assign(Readable.from([data]), {
        statusCode: fault === "redirect" ? 302 : fault === "busy" ? 409 : 200,
        headers: {
          "content-type": fault === "mime" ? "text/plain" : "application/json",
          "content-length": String(data.length),
          ...(fault === "encoding" ? { "content-encoding": "gzip" } : {}),
        },
        complete: fault !== "truncated",
      });
      if (fault !== "stall") queueMicrotask(() => callback(res));
    });
    config.signal.addEventListener("abort", () => {
      req.emit("error", new Error("private error"));
      res?.on("error", () => {});
      res?.destroy(new Error("private body"));
    });
    return req;
  });
  return { req, close };
}
it("sends one authenticated POST with a fresh request identifier to the recorded daemon", async () => {
  const r = response();
  const result = await requestDoctorSelfTests(expected, new AbortController().signal);
  const sent = JSON.parse(r.req.end.mock.calls[0]?.[0].toString());
  expect(sent).toMatchObject({ v: 1, requestId: expect.any(String) });
  expect(result.requestId).toBe(sent.requestId);
  expect(mock.request).toHaveBeenCalledOnce();
  expect(mock.request.mock.calls[0]?.[0]).toMatchObject({
    hostname: "127.0.0.1",
    port: 4891,
    path: "/api/service/self-tests",
    method: "POST",
    agent: false,
    headers: { authorization: `Bearer ${"t".repeat(43)}` },
  });
  expect(mock.token).toHaveBeenCalledWith(expected.home);
  expect(r.req.destroy).toHaveBeenCalledOnce();
});
it.each([
  "request",
  "boot",
  "pid",
  "owner",
  "release",
  "incomplete-checks",
  "false-pass",
  "duplicate",
  "utf8",
  "oversize",
  "redirect",
  "busy",
  "mime",
  "encoding",
  "truncated",
])("refuses %s without retrying the diagnostic POST", async (fault) => {
  response(fault);
  await expect(requestDoctorSelfTests(expected, new AbortController().signal)).rejects.toThrow(
    /^Fresh computer self-tests could not be confirmed\.$/,
  );
  expect(mock.request).toHaveBeenCalledOnce();
});
it("holds the caller until cancelled transport closure", async () => {
  const r = response("stall", true),
    controller = new AbortController();
  let settled = false;
  const work = requestDoctorSelfTests(expected, controller.signal).catch((error) => {
    settled = true;
    return error;
  });
  controller.abort();
  await setImmediate();
  expect(settled).toBe(false);
  expect(r.req.destroy).toHaveBeenCalledOnce();
  r.close();
  expect(await work).toBeInstanceOf(Error);
});
it("rejects cancellation during retirement even after a complete reply", async () => {
  const r = response("", true),
    controller = new AbortController();
  const work = requestDoctorSelfTests(expected, controller.signal).catch((error) => error);
  await setImmediate();
  controller.abort();
  r.close();
  expect(await work).toBeInstanceOf(Error);
});
it("bounds stalled diagnostics without sending another request", async () => {
  vi.useFakeTimers();
  response("stall");
  const work = requestDoctorSelfTests(expected, new AbortController().signal).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(100_000);
  expect(await work).toBeInstanceOf(Error);
  expect(mock.request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
