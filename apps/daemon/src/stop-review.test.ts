import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runStop } from "./stop.ts";

const CELL = "01J00000000000000000000001",
  SESSION = "01J00000000000000000000002",
  TOKEN = "owned-review-not-real-token-00000000000";
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ready = {
  id: CELL,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-task6-cli-review-"));
  roots.push(home);
  chmodSync(home, 0o700);
  writeFileSync(join(home, "daemon-token"), TOKEN, { mode: 0o600 });
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/api/cells")
      ? Response.json([ready])
      : String(url).endsWith("/live")
        ? Response.json({ sessionId: SESSION })
        : Response.json(
            { revoked: false, paused: false, closed: true, stopped: true, errors: [] },
            { status: 202 },
          ),
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
    run: () => runStop({ home, signal: abort.signal }, { out, err, fetch: fetchImpl }),
  };
}
it("closed plus stopped confirms the fallback and carries credentials only in local request headers", async () => {
  const f = fixture();
  expect(await f.run()).toBe(0);
  expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  expect(f.out).toHaveBeenCalledWith(
    "Stop confirmed: the computer is stopped and its key listener is closed.",
  );
  for (const [url, init] of f.fetchImpl.mock.calls) {
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:4750\/api\//);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  }
  expect(JSON.stringify([f.out.mock.calls, f.err.mock.calls])).not.toContain(TOKEN);
});
it.each(["public home", "hard-linked token", "symlink home"] as const)(
  "%s refuses before sending the owned inert token",
  async (mode) => {
    const f = fixture();
    let home = f.home;
    if (mode === "public home") chmodSync(home, 0o740);
    if (mode === "hard-linked token")
      linkSync(join(home, "daemon-token"), join(home, "token-copy"));
    if (mode === "symlink home") {
      home = join(f.home, "linked-home");
      symlinkSync(f.home, home);
    }
    const code = await runStop(
      { home, signal: f.abort.signal },
      { out: f.out, err: f.err, fetch: f.fetchImpl },
    );
    expect(f.fetchImpl).toHaveBeenCalledTimes(0);
    expect(code).toBe(1);
    expect(f.out).not.toHaveBeenCalled();
    expect(JSON.stringify(f.err.mock.calls)).not.toContain(TOKEN);
  },
);
it.each(["declared", "cumulative", "malformed UTF8"] as const)(
  "%s body refusal cancels reading and never dispatches Stop",
  async (mode) => {
    const f = fixture(),
      cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (mode === "malformed UTF8") c.enqueue(new Uint8Array([0xff]));
        else c.enqueue(new Uint8Array(131073).fill(32));
      },
      cancel,
    });
    f.fetchImpl.mockImplementation(
      async () =>
        new Response(stream, {
          headers: mode === "declared" ? { "content-length": "262145" } : undefined,
        }),
    );
    expect(await f.run()).toBe(1);
    expect(f.out).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBeLessThanOrEqual(3);
  },
);
it("whole command deadline cancels a stalled reply body and produces no confirmed Stop", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    cancel = vi.fn();
  f.fetchImpl.mockImplementation(
    async () => new Response(new ReadableStream<Uint8Array>({ cancel })),
  );
  const work = f.run();
  await vi.advanceTimersByTimeAsync(35000);
  expect(await work).toBe(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.out).not.toHaveBeenCalled();
  expect(JSON.stringify(f.err.mock.calls)).not.toContain(TOKEN);
});
