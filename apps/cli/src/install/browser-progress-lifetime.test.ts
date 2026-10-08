import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { startInstallProgressBrowser } from "./browser-progress.ts";

const mock = vi.hoisted(() => ({ create: vi.fn(), open: vi.fn() }));
vi.mock("node:http", () => ({ createServer: mock.create }));
vi.mock("./browser-open.ts", async (original) => ({
  ...(await original<typeof import("./browser-open.ts")>()),
  openInstallerBrowser: mock.open,
}));
afterEach(() => {
  vi.useRealTimers();
  mock.create.mockReset();
  mock.open.mockReset();
});
function fixture() {
  const controller = new AbortController(),
    io = { out: vi.fn(), err: vi.fn() };
  const server = Object.assign(new EventEmitter(), {
    maxConnections: 0,
    setTimeout: vi.fn(),
    address: () => ({ port: 53321 }),
    listen: vi.fn((_options: unknown, ready: () => void) => {
      queueMicrotask(ready);
    }),
    close: vi.fn((done: () => void) => {
      server.emit("close");
      done();
    }),
    closeAllConnections: vi.fn(),
  });
  mock.create.mockReturnValue(server);
  mock.open.mockResolvedValue(true);
  return {
    controller,
    io,
    server,
    start: () => startInstallProgressBrowser(4750, controller.signal, io),
  };
}
it("listens only on ephemeral IPv4 loopback, then closes after bounded final delivery wait", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.start();
  await vi.runAllTicks();
  const browser = await pending;
  expect(f.server.listen).toHaveBeenCalledWith(
    { host: "127.0.0.1", port: 0, signal: f.controller.signal },
    expect.any(Function),
  );
  expect(mock.open.mock.calls[0]?.[0]).toMatch(
    /^http:\/\/127\.0\.0\.1:53321\/#progress=[A-Za-z0-9_-]{43}$/,
  );
  let done = false;
  const ending = browser?.finish("failed").then((value) => {
    done = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(4999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await ending).toBe(false);
  await browser?.close();
  expect(f.server.close).toHaveBeenCalledOnce();
  expect(f.server.closeAllConnections).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("closes immediately on cancellation, including while waiting for browser delivery", async () => {
  const f = fixture(),
    browser = await f.start();
  const done = browser?.finish("ready", `http://127.0.0.1:4750/#code=${"a".repeat(43)}`);
  f.controller.abort();
  expect(await done).toBe(false);
  await browser?.close();
  expect(f.server.close).toHaveBeenCalledOnce();
});
it("does not wait for a browser that could not be opened", async () => {
  const f = fixture();
  mock.open.mockResolvedValue(false);
  const browser = await f.start();
  expect(await browser?.finish("failed")).toBe(false);
  expect(f.io.err).toHaveBeenCalledWith(
    "Could not open browser progress. Follow setup in this terminal.",
  );
  expect(f.server.close).toHaveBeenCalledOnce();
});
it("closes a failed listener without surfacing raw OS errors or failing setup", async () => {
  const f = fixture();
  f.server.listen.mockImplementation(() => {
    queueMicrotask(() => f.server.emit("error", new Error("private detail")));
  });
  expect(await f.start()).toBeUndefined();
  expect(mock.open).not.toHaveBeenCalled();
  expect(f.server.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private detail");
});
it("does nothing for pre-cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  expect(await f.start()).toBeUndefined();
  expect(mock.create).not.toHaveBeenCalled();
});
it("drains a delivered ready response and closes without waiting for the grace deadline", async () => {
  const f = fixture(),
    browser = await f.start();
  const url = `http://127.0.0.1:4750/#code=${"b".repeat(43)}`;
  const done = browser?.finish("ready", url);
  const capability = new URL(mock.open.mock.calls[0]?.[0]).hash.slice("#progress=".length);
  const response = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(() => response.emit("finish")),
  });
  mock.create.mock.calls[0]?.[1](
    {
      method: "GET",
      url: "/status",
      headers: { host: "127.0.0.1:53321", authorization: `Bearer ${capability}` },
    },
    response,
  );
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ phase: "ready", url }));
  expect(await done).toBe(true);
  expect(f.server.close).toHaveBeenCalledOnce();
});
