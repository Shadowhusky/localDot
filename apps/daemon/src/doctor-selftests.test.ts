import { SELFTEST_CHECKS } from "@localdot/protocol";
import { expect, it, vi } from "vitest";
import { DoctorSelfTestsReply } from "../../../packages/protocol/src/doctor-selftests.ts";
import { createApp } from "./app.ts";
import type { CellSummary } from "./cells/types.ts";
import type { EventLog } from "./event-log.ts";

const id = "01JXYZ00000000000000000001",
  requestId = "01234567-89ab-4cde-8fab-0123456789ab";
function fixture() {
  const snapshot = {
    v: 1,
    service: {
      ownerId: "a".repeat(32),
      release: { version: "1.0.0", packageSha256: "b".repeat(64), manifestSha256: "c".repeat(64) },
      pid: 123,
    },
    bootId: requestId,
    recovery: "ready",
    keyd: {
      service: {
        ownerId: "a".repeat(32),
        release: {
          version: "1.0.0",
          packageSha256: "b".repeat(64),
          manifestSha256: "c".repeat(64),
        },
        pid: 456,
      },
      bootId: "keyd-boot",
    },
    checks: { recovery: true, admission: true, keydIdentity: true, audit: true, hairpin: true },
    ready: true,
  };
  const readiness = { snapshot: vi.fn(async () => structuredClone(snapshot)) };
  const cells = {
    list: vi.fn(() => [{ id }] as CellSummary[]),
    diagnoseSelfTest: vi.fn(async (_id: string, _signal: AbortSignal) => ({
      ok: true,
      checks: SELFTEST_CHECKS.map(({ id }) => ({ id, ok: true })),
    })),
  };
  const app = createApp({
    token: "fixture-token",
    port: 4891,
    eventLog: {} as EventLog,
    doctorSelfTests: { cells, readiness: readiness as never },
  });
  const call = (
    options: {
      headers?: Record<string, string>;
      body?: unknown;
      method?: string;
      signal?: AbortSignal;
    } = {},
  ) =>
    app.request("http://127.0.0.1:4891/api/service/self-tests", {
      method: options.method ?? "POST",
      headers: {
        authorization: "Bearer fixture-token",
        "content-type": "application/json",
        ...options.headers,
      },
      ...(options.method === "GET" || options.method === "HEAD"
        ? {}
        : { body: JSON.stringify(options.body ?? { v: 1, requestId }) }),
      signal: options.signal,
    });
  return { snapshot, readiness, cells, call };
}
it("returns a fresh bounded verdict bound to the request and running daemon", async () => {
  const f = fixture(),
    response = await f.call(),
    body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body).toMatchObject({
    v: 1,
    requestId,
    service: f.snapshot.service,
    bootId: requestId,
    cells: [{ id, outcome: "passed" }],
  });
  expect(f.cells.diagnoseSelfTest).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(f.readiness.snapshot).toHaveBeenCalledTimes(2);
});
it.each<Record<string, string>>([
  { authorization: "Bearer wrong" },
  { host: "foreign.invalid" },
  { origin: "https://foreign.invalid" },
])("guards diagnostics before touching cells: %j", async (headers) => {
  const f = fixture(),
    response = await f.call({ headers });
  expect([401, 403]).toContain(response.status);
  expect(f.cells.diagnoseSelfTest).not.toHaveBeenCalled();
  expect(f.readiness.snapshot).not.toHaveBeenCalled();
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it.each(["GET", "HEAD"])("does not run diagnostics through %s", async (method) => {
  const f = fixture();
  expect((await f.call({ method })).status).toBe(404);
  expect(f.cells.diagnoseSelfTest).not.toHaveBeenCalled();
});
it.each([{}, { v: 1, requestId, extra: true }, { v: 1, requestId: "private-input" }])(
  "refuses malformed bodies before probing",
  async (body) => {
    const f = fixture();
    expect((await f.call({ body })).status).toBe(400);
    expect(f.cells.diagnoseSelfTest).not.toHaveBeenCalled();
  },
);
it("refuses an oversized request", async () => {
  const f = fixture();
  expect((await f.call({ body: { v: 1, requestId, pad: "x".repeat(1100) } })).status).toBe(413);
  expect(f.cells.diagnoseSelfTest).not.toHaveBeenCalled();
});
it.each(["service", "keyd", "inventory", "unready"])(
  "discards observations when %s changes",
  async (fault) => {
    const f = fixture();
    f.cells.diagnoseSelfTest.mockImplementation(async () => {
      if (fault === "service") f.snapshot.bootId = "11234567-89ab-4cde-8fab-0123456789ab";
      if (fault === "keyd") f.snapshot.keyd.bootId = "keyd-restarted";
      if (fault === "inventory") f.cells.list.mockReturnValue([]);
      if (fault === "unready") {
        f.snapshot.ready = false;
        f.snapshot.recovery = "failed";
        f.snapshot.checks.recovery = false;
      }
      return { ok: true, checks: SELFTEST_CHECKS.map(({ id }) => ({ id, ok: true })) };
    });
    const response = await f.call();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  },
);
it("reports busy/unavailable computers separately and preserves failed check verdicts", async () => {
  const f = fixture(),
    other = "01JXYZ00000000000000000002";
  f.cells.list.mockReturnValue([{ id }, { id: other }] as CellSummary[]);
  f.cells.diagnoseSelfTest.mockRejectedValueOnce(new Error("private-input")).mockResolvedValueOnce({
    ok: false,
    checks: SELFTEST_CHECKS.map(({ id }) => ({ id, ok: false })),
  });
  const response = await f.call(),
    body = DoctorSelfTestsReply.parse(await response.json());
  expect(response.status).toBe(200);
  expect(body.cells.map((cell) => cell.outcome)).toEqual(["unavailable", "failed"]);
  expect(JSON.stringify(body)).not.toContain("private-input");
});
it("holds single-run admission until cancelled cell work settles", async () => {
  const f = fixture(),
    controller = new AbortController();
  let finish: (() => void) | undefined;
  f.cells.diagnoseSelfTest.mockImplementation(async (_id, signal) => {
    await new Promise<void>((r) => {
      finish = r;
    });
    signal.throwIfAborted();
    return { ok: true, checks: [] };
  });
  const work = f.call({ signal: controller.signal });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  controller.abort();
  expect((await f.call()).status).toBe(409);
  finish?.();
  expect((await work).status).toBe(503);
  f.cells.list.mockReturnValue([]);
  expect((await f.call()).status).toBe(200);
});
