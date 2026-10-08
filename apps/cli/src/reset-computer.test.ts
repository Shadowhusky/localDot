import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ComputerResetRecord } from "../../../packages/protocol/src/computer-reset.ts";
import { runResetComputer } from "./reset-computer.ts";

const old = "01JXYZ00000000000000000001",
  fresh = "01JXYZ00000000000000000002",
  requestId = "01JXYZ00000000000000000003";
const token = "t".repeat(43);
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-reset-cli-"));
  roots.push(home);
  writeFileSync(join(home, "daemon-token"), token, { mode: 0o600 });
  const record: ComputerResetRecord = {
    v: 1,
    requestId,
    oldCellId: old,
    newCellId: fresh,
    phase: "ready",
    source: {
      scale: 2,
      browser: null,
      desktop: {
        workload: { name: `desktop-${old}`, id: "a".repeat(64) },
        gate: { name: `gate-${old}`, id: "b".repeat(64) },
        internalNetwork: { name: `internal-${old}`, id: "c".repeat(64) },
        egressNetwork: { name: `egress-${old}`, id: "d".repeat(64) },
        volume: `home-${old}`,
      },
    },
  };
  const abort = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(record));
  const io = {
    out: vi.fn<(message: string) => void>(),
    err: vi.fn<(message: string) => void>(),
    fetch,
  };
  const options = {
    home,
    port: 4891,
    cellId: old,
    requestId,
    operation: "reset" as const,
    signal: abort.signal,
  };
  const output = () => JSON.stringify([...io.out.mock.calls, ...io.err.mock.calls]);
  return { record, abort, fetch, io, options, output };
}
it("sends exactly one confirmed POST and prints the generated request ID before dispatch", async () => {
  const f = fixture();
  f.fetch.mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(f.output()).toContain(body.requestId);
    expect(body).toEqual({
      requestId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      eraseComputer: true,
    });
    expect(url).toBe(`http://127.0.0.1:4891/api/cells/${old}/reset`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    });
    return Response.json({ ...f.record, requestId: body.requestId });
  });
  expect(await runResetComputer({ ...f.options, requestId: undefined }, f.io)).toBe(0);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.output()).toContain(fresh);
  expect(f.output()).not.toContain(token);
});
it("status only reads the named request and reports an incomplete phase without a retry", async () => {
  const f = fixture();
  f.record.phase = "creating";
  expect(await runResetComputer({ ...f.options, operation: "status" }, f.io)).toBe(1);
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(
    `http://127.0.0.1:4891/api/cells/${old}/reset/${requestId}`,
    expect.objectContaining({ method: "GET" }),
  );
  expect(f.fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
  expect(f.output()).toContain(`--request ${requestId} --status`);
  expect(f.output()).toContain(`--request ${requestId} --erase-computer`);
});
it.each([
  "lost reply",
  "conflict",
  "redirect",
  "wrong identity",
  "extra fields",
  "oversized",
  "length mismatch",
])("keeps the same request and never retries after %s", async (kind) => {
  const f = fixture();
  const marker = "private-fixture-diagnostic";
  f.fetch.mockImplementation(async () => {
    if (kind === "lost reply") throw new Error(marker);
    if (kind === "conflict") return new Response(marker, { status: 409 });
    if (kind === "redirect")
      return new Response(null, { status: 302, headers: { location: "https://invalid.example/" } });
    if (kind === "wrong identity") return Response.json({ ...f.record, requestId: fresh });
    if (kind === "extra fields") return Response.json({ ...f.record, token: marker });
    if (kind === "oversized")
      return new Response("x".repeat(65537), { headers: { "content-type": "application/json" } });
    return Response.json(f.record, { headers: { "content-length": "1" } });
  });
  expect(await runResetComputer(f.options, f.io)).toBe(1);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.output()).toContain(requestId);
  expect(f.output()).toContain("unconfirmed");
  expect(f.output()).not.toContain(marker);
  expect(f.output()).not.toContain(token);
});
it("cancels a stalled response body on interrupt while retaining the same recovery request", async () => {
  const f = fixture(),
    cancel = vi.fn(),
    started = Promise.withResolvers<void>();
  f.fetch.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            started.resolve();
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const pending = runResetComputer(f.options, f.io);
  await started.promise;
  f.abort.abort();
  expect(await pending).toBe(130);
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.output()).toContain(`--request ${requestId}`);
});
it("bounds status waiting even when transport ignores abort", async () => {
  const f = fixture();
  f.fetch.mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers();
  const pending = runResetComputer({ ...f.options, operation: "status" }, f.io);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toBe(1);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.output()).toContain("unconfirmed");
});
it("rejects invalid options or prior cancellation without reading authority or sending anything", async () => {
  const f = fixture();
  expect(
    await runResetComputer({ ...f.options, home: "/missing", cellId: "private-invalid-id" }, f.io),
  ).toBe(1);
  expect(f.output()).not.toContain("private-invalid-id");
  f.abort.abort();
  expect(await runResetComputer(f.options, f.io)).toBe(130);
  expect(f.fetch).not.toHaveBeenCalled();
});
