import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { probeInstalledPort } from "./doctor-port.ts";

const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("node:net", () => ({ createServer: mock.create }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
function fixture() {
  const controller = new AbortController(),
    server = new EventEmitter();
  let options: { host: string; port: number; exclusive: boolean; signal: AbortSignal } | undefined;
  let listening: (() => void) | undefined, closed: (() => void) | undefined;
  const listen = vi.fn((input, callback) => {
    options = input;
    listening = callback;
    return server;
  });
  const close = vi.fn((callback) => {
    closed = callback;
    return server;
  });
  Object.assign(server, { listen, close });
  mock.create.mockReturnValue(server);
  return {
    controller,
    server,
    listen,
    close,
    options: () => options,
    listening: () => listening?.(),
    closed: () => {
      server.emit("close");
      closed?.();
    },
    run: () => probeInstalledPort(4891, controller.signal),
  };
}
it("binds only the recorded numeric loopback port and waits for closure before saying free", async () => {
  const f = fixture();
  let settled = false;
  const work = f.run().then((v) => {
    settled = true;
    return v;
  });
  expect(f.options()).toMatchObject({ host: "127.0.0.1", port: 4891, exclusive: true });
  f.listening();
  await Promise.resolve();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  f.closed();
  expect(await work).toBe("free");
  const socket = { destroy: vi.fn() };
  mock.create.mock.calls[0]?.[0](socket);
  expect(socket.destroy).toHaveBeenCalledTimes(1);
});
it.each(["EADDRINUSE", "EACCES"])("reports %s after the probe closes", async (code) => {
  const f = fixture();
  const work = f.run();
  f.server.emit("error", Object.assign(new Error("private error"), { code }));
  expect(f.close).toHaveBeenCalledTimes(1);
  f.closed();
  expect(await work).toBe(code === "EADDRINUSE" ? "occupied" : "unavailable");
});
it.each(["cancel-bind", "cancel-close", "deadline"])(
  "retains the pending listener until actual close on %s",
  async (fault) => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const work = f.run().then(
      (v) => {
        settled = true;
        return v;
      },
      () => {
        settled = true;
        return "cancelled";
      },
    );
    if (fault === "cancel-close") f.listening();
    if (fault === "deadline") await vi.advanceTimersByTimeAsync(2500);
    else f.controller.abort();
    expect(f.options()?.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.closed();
    expect(await work).toBe(fault === "deadline" ? "unavailable" : "cancelled");
  },
);
it("does not create a listener after prior cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(mock.create).not.toHaveBeenCalled();
});
it.each([0, 1023, 65536, 4891.5, Number.NaN])(
  "rejects invalid recorded port %s without a listener",
  async (port) => {
    fixture();
    await expect(probeInstalledPort(port, new AbortController().signal)).rejects.toThrow();
    expect(mock.create).not.toHaveBeenCalled();
  },
);
