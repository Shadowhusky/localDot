import { EventEmitter } from "node:events";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendContainerInput } from "./stdin.ts";

vi.mock("node:http", () => ({ request: vi.fn() }));

function fixture(onCreate?: (lifetime: AbortController, pending: RequestOwner) => void) {
  vi.useFakeTimers();
  const lifetime = new AbortController();
  const pending = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  let staged: Buffer | undefined;
  const socket = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    end: vi.fn((bytes: Buffer, _done: () => void) => {
      staged = bytes;
    }),
  });
  vi.mocked(request).mockImplementation(() => {
    onCreate?.(lifetime, pending);
    return pending as unknown as ReturnType<typeof request>;
  });
  const result = sendContainerInput(
    { socketPath: "/synthetic/scoped.sock" },
    "b".repeat(64),
    Buffer.from("owned-synthetic-material"),
    lifetime.signal,
  ).then(
    () => "delivered",
    (error: unknown) => error,
  );
  return { lifetime, pending, socket, result, staged: () => staged };
}
type RequestOwner = EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("scoped bootstrap retirement bypasses", () => {
  it("settles once and attempts both owners during reentrant throwing destruction", async () => {
    const f = fixture();
    f.pending.emit("upgrade", { statusCode: 101 }, f.socket, Buffer.alloc(0));
    f.socket.destroy.mockImplementation(() => {
      f.socket.emit("error", new Error("private-nested-socket-detail"));
      f.socket.emit("close");
      throw new Error("private-socket-retirement-detail");
    });
    f.pending.destroy.mockImplementation(() => {
      f.pending.emit("error", new Error("private-nested-request-detail"));
      throw new Error("private-request-retirement-detail");
    });
    expect(() => f.pending.emit("error", new Error("private-trigger"))).not.toThrow();
    await expect(f.result).resolves.toEqual(new Error("Browser private input handoff failed"));
    expect(f.socket.destroy).toHaveBeenCalledOnce();
    expect(f.pending.destroy).toHaveBeenCalledOnce();
    expect(f.staged()?.every((byte) => byte === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains late request destruction failure after construction abort without writing", async () => {
    const f = fixture((lifetime, pending) => {
      lifetime.abort();
      pending.destroy.mockImplementation(() => {
        pending.emit("error", new Error("private-late-error"));
        throw new Error("private-late-retirement");
      });
    });
    await expect(f.result).resolves.toEqual(new Error("Browser private input handoff failed"));
    expect(f.pending.destroy).toHaveBeenCalledOnce();
    expect(f.pending.end).not.toHaveBeenCalled();
    expect(() =>
      f.pending.emit("upgrade", { statusCode: 101 }, f.socket, Buffer.alloc(0)),
    ).not.toThrow();
    expect(f.socket.destroy).toHaveBeenCalledOnce();
    expect(f.socket.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a request once when its HTTP end throws before any upgrade", async () => {
    const f = fixture((_lifetime, pending) => {
      pending.end.mockImplementation(() => {
        throw new Error("private-request-end-detail");
      });
    });
    await expect(f.result).resolves.toEqual(new Error("Browser private input handoff failed"));
    expect(f.pending.end).toHaveBeenCalledOnce();
    expect(f.pending.destroy).toHaveBeenCalledOnce();
    expect(f.socket.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
