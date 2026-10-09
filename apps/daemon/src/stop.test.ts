import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runStop } from "./stop.ts";

const CELL = "01J00000000000000000000001",
  SESSION = "01J00000000000000000000002",
  OTHER = "01J00000000000000000000003",
  TOKEN = "private-synthetic-token-0000000000000";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ready = {
  id: CELL,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
function fixture(
  cells: unknown[] = [ready],
  outcome: unknown = { revoked: true, paused: true, closed: false, stopped: false, errors: [] },
) {
  const home = mkdtempSync(join(tmpdir(), "localdot-stop-"));
  roots.push(home);
  chmodSync(home, 0o700);
  writeFileSync(join(home, "daemon-token"), TOKEN, { mode: 0o600 });
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/api/cells")
      ? Response.json(cells)
      : String(url).endsWith("/live")
        ? Response.json({ sessionId: SESSION })
        : Response.json(outcome, { status: 202 }),
  );
  const out = vi.fn(),
    err = vi.fn(),
    abort = new AbortController();
  return {
    home,
    fetchImpl,
    out,
    err,
    abort,
    run: (cellId?: string) =>
      runStop({ home, cellId, signal: abort.signal }, { out, err, fetch: fetchImpl }),
  };
}
it("selects the sole Ready cell and prints only a confirmed actual Stop outcome", async () => {
  const f = fixture();
  expect(await f.run()).toBe(0);
  expect(f.out).toHaveBeenCalledWith(expect.stringContaining("Stop confirmed"));
  expect(f.fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:4750/api/cells",
    `http://127.0.0.1:4750/api/cells/${CELL}/live`,
    `http://127.0.0.1:4750/api/sessions/${SESSION}/stop`,
  ]);
  expect(f.fetchImpl.mock.calls[2]?.[1]?.method).toBe("POST");
  expect(JSON.stringify(f.out.mock.calls)).not.toContain(TOKEN);
});
it("ambiguous selection requests an explicit cell and never sends Stop", async () => {
  const f = fixture([ready, { ...ready, id: OTHER }]);
  expect(await f.run()).toBe(2);
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  expect(f.err).toHaveBeenCalledWith(expect.stringContaining("--cell"));
  expect(await f.run(OTHER)).toBe(0);
  expect(f.fetchImpl.mock.calls[2]?.[0]).toBe(`http://127.0.0.1:4750/api/cells/${OTHER}/live`);
});
it.each(["../../sentinel", "<script>", "", CELL.toLowerCase()])(
  "invalid cell %s never reads a network",
  async (id) => {
    const f = fixture();
    expect(await f.run(id)).toBe(1);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  },
);
it.each([
  { revoked: false, paused: true, closed: false, stopped: false, errors: [] },
  { revoked: true, paused: false, closed: false, stopped: false, errors: [] },
  { revoked: true, paused: true, closed: false, stopped: false, errors: [], permit: true },
])("unconfirmed or extra Stop reply cannot claim success", async (outcome) => {
  const f = fixture([ready], outcome);
  expect(await f.run()).toBe(1);
  expect(f.out).not.toHaveBeenCalled();
});
it("503 and sensitive diagnostics remain bounded and redacted", async () => {
  const f = fixture();
  f.fetchImpl.mockImplementation(async () => new Response(TOKEN + "<img src=x>", { status: 503 }));
  expect(await f.run()).toBe(1);
  expect(JSON.stringify(f.err.mock.calls)).not.toContain(TOKEN);
  expect(f.out).not.toHaveBeenCalled();
});
it("interruption rejects a fetch that ignores cancellation and never prints success", async () => {
  const f = fixture(),
    late = Promise.withResolvers<Response>();
  f.fetchImpl.mockImplementation(async () => late.promise);
  const work = f.run();
  f.abort.abort();
  expect(await work).toBe(130);
  late.resolve(Response.json([ready]));
  expect(f.out).not.toHaveBeenCalled();
});
it("unprotected or symlink token refuses before sending credentials", async () => {
  const f = fixture();
  chmodSync(join(f.home, "daemon-token"), 0o644);
  expect(await f.run()).toBe(1);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  rmSync(join(f.home, "daemon-token"));
  writeFileSync(join(f.home, "other"), TOKEN, { mode: 0o600 });
  symlinkSync(join(f.home, "other"), join(f.home, "daemon-token"));
  expect(await f.run()).toBe(1);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

const everything = {
  sessions: [
    {
      sessionId: SESSION,
      cellId: CELL,
      outcome: { revoked: true, paused: true, closed: false, stopped: false, errors: [] },
    },
  ],
  cells: [],
  routinesPaused: 2,
  launchesCancelled: 0,
  confirmed: true,
};
it("stops everything with one request and says what stopped", async () => {
  const f = fixture([ready], everything);
  expect(
    await runStop(
      { home: f.home, all: true, signal: f.abort.signal },
      { out: f.out, err: f.err, fetch: f.fetchImpl },
    ),
  ).toBe(0);
  expect(f.fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:4750/api/stop-all?by=cli",
  ]);
  expect(f.fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(f.out).toHaveBeenCalledWith(
    "Everything stopped: 1 task stopped, 0 computers frozen, 2 routines paused.",
  );
});
it("reports an unconfirmed Stop everything and fails", async () => {
  const f = fixture([ready], { ...everything, confirmed: false });
  expect(
    await runStop(
      { home: f.home, all: true, signal: f.abort.signal },
      { out: f.out, err: f.err, fetch: f.fetchImpl },
    ),
  ).toBe(1);
  expect(f.err).toHaveBeenCalledWith(expect.stringContaining("Stop everything is unconfirmed"));
});
it("does not combine --all with a computer id", async () => {
  const f = fixture();
  expect(
    await runStop(
      { home: f.home, all: true, cellId: CELL, signal: f.abort.signal },
      { out: f.out, err: f.err, fetch: f.fetchImpl },
    ),
  ).toBe(1);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
