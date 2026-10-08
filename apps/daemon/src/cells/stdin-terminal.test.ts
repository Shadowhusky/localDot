import { EventEmitter } from "node:events";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendContainerInput } from "./stdin.ts";

vi.mock("node:http", () => ({ request: vi.fn() }));

function fixture() {
  vi.useFakeTimers();
  const lifetime = new AbortController();
  const pending = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  let staged: Buffer | undefined;
  let flush = () => {};
  const socket = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    end: vi.fn((bytes: Buffer, done: () => void) => {
      staged = bytes;
      flush = done;
    }),
  });
  vi.mocked(request).mockReturnValue(pending as unknown as ReturnType<typeof request>);
  let outcome: unknown;
  const result = sendContainerInput(
    { socketPath: "/synthetic/docker.sock" },
    "a".repeat(64),
    Buffer.from("synthetic-private-staging"),
    lifetime.signal,
  ).then(
    () => {
      outcome = "success";
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  const upgrade = () => pending.emit("upgrade", { statusCode: 101 }, socket, Buffer.alloc(0));
  return {
    lifetime,
    pending,
    socket,
    result,
    upgrade,
    flush: () => flush(),
    staged: () => staged,
    outcome: () => outcome,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("private input terminal cleanup", () => {
  it.each(["socket", "request"] as const)(
    "refuses a flush whose %s cleanup throws",
    async (owner) => {
      const f = fixture();
      f.upgrade();
      (owner === "socket" ? f.socket : f.pending).destroy.mockImplementation(() => {
        throw new Error("private-cleanup-detail");
      });
      expect(() => f.flush()).not.toThrow();
      await f.result;
      expect(f.outcome()).toEqual(new Error("Browser private input handoff failed"));
      expect(f.staged()?.every((byte) => byte === 0)).toBe(true);
      expect(f.socket.destroy).toHaveBeenCalledOnce();
      expect(f.pending.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("contains a failed late socket retirement after cancellation", async () => {
    const f = fixture();
    f.lifetime.abort();
    f.socket.destroy.mockImplementation(() => {
      throw new Error("private-socket-detail");
    });
    expect(() => f.upgrade()).not.toThrow();
    await f.result;
    expect(f.outcome()).toEqual(new Error("Browser private input handoff failed"));
    expect(f.socket.end).not.toHaveBeenCalled();
    expect(f.socket.destroy).toHaveBeenCalledOnce();
    expect(f.pending.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains response retirement failure and still closes its request", async () => {
    const f = fixture();
    const response = Object.assign(new EventEmitter(), {
      destroy: vi.fn(() => {
        throw new Error("private-response-detail");
      }),
    });
    expect(() => f.pending.emit("response", response)).not.toThrow();
    await f.result;
    expect(f.outcome()).toEqual(new Error("Browser private input handoff failed"));
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(f.pending.destroy).toHaveBeenCalledOnce();
    expect(f.socket.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles generically when writing throws after taking the private buffer", async () => {
    const f = fixture();
    let accepted: Buffer | undefined;
    f.socket.end.mockImplementation((bytes) => {
      accepted = bytes;
      throw new Error("private-write-detail");
    });
    expect(() => f.upgrade()).not.toThrow();
    await f.result;
    expect(f.outcome()).toEqual(new Error("Browser private input handoff failed"));
    expect(accepted?.every((byte) => byte === 0)).toBe(true);
    expect(f.socket.destroy).toHaveBeenCalledOnce();
    expect(f.pending.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
