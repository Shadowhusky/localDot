import { EventEmitter } from "node:events";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendContainerInput } from "./stdin.ts";

vi.mock("node:http", () => ({ request: vi.fn() }));

function fixture(constructionAbort = false) {
  vi.useFakeTimers();
  const lifetime = new AbortController();
  const pending = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    end: vi.fn(),
  });
  let staged: Buffer | undefined;
  let flush = () => {};
  const socket = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    end: vi.fn((bytes: Buffer, done: () => void) => {
      staged = bytes;
      flush = done;
    }),
  });
  vi.mocked(request).mockImplementation(() => {
    if (constructionAbort) lifetime.abort();
    return pending as unknown as ReturnType<typeof request>;
  });
  const original = Buffer.from("synthetic-owned-staging");
  let terminal = "pending";
  const result = sendContainerInput(
    { socketPath: "/owned-fixture/docker.sock" },
    "a".repeat(64),
    original,
    lifetime.signal,
  ).then(
    () => {
      terminal = "success";
    },
    () => {
      terminal = "refused";
    },
  );
  const upgrade = () => pending.emit("upgrade", { statusCode: 101 }, socket, Buffer.alloc(0));
  return {
    lifetime,
    pending,
    socket,
    original,
    upgrade,
    result,
    flush: () => flush(),
    staged: () => staged,
    terminal: () => terminal,
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("independent private-input transport ownership", () => {
  it("copies bytes before caller mutation and clears only owned staging after one flush", async () => {
    const test = fixture();
    test.original.fill(120);
    test.upgrade();
    expect(test.staged()?.toString()).toBe("synthetic-owned-staging");
    test.flush();
    await test.result;
    expect(test.terminal()).toBe("success");
    expect(test.staged()?.every((byte) => byte === 0)).toBe(true);
    expect(test.original.every((byte) => byte === 120)).toBe(true);
    expect(test.pending.destroy).toHaveBeenCalledOnce();
    expect(test.socket.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a request returned after cancellation during its construction", async () => {
    const test = fixture(true);
    await test.result;
    expect(test.terminal()).toBe("refused");
    expect(test.pending.end).not.toHaveBeenCalled();
    expect(
      test.pending.destroy,
      "cancelled construction must retain and destroy the late request",
    ).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a late upgrade after cancellation without sending any payload", async () => {
    const test = fixture();
    test.lifetime.abort();
    await test.result;
    test.upgrade();
    expect(test.terminal()).toBe("refused");
    expect(test.socket.end).not.toHaveBeenCalled();
    expect(test.socket.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not promote an aborted in-flight write when its callback arrives later", async () => {
    const test = fixture();
    test.upgrade();
    test.lifetime.abort();
    await test.result;
    test.flush();
    expect(test.terminal()).toBe("refused");
    expect(test.staged()?.every((byte) => byte === 0)).toBe(true);
    expect(test.pending.destroy).toHaveBeenCalledOnce();
    expect(test.socket.destroy).toHaveBeenCalledOnce();
  });

  it.each(["socket", "request"] as const)(
    "a throwing %s retirement cannot skip staging erasure or leave delivery pending",
    async (owner) => {
      const test = fixture();
      test.upgrade();
      const target = owner === "socket" ? test.socket : test.pending;
      target.destroy.mockImplementation(() => {
        throw new Error("private-retirement-detail");
      });
      let thrown: unknown;
      try {
        test.pending.emit("error", new Error("private-transport-detail"));
      } catch (error) {
        thrown = error;
      }
      await Promise.resolve();
      expect(
        {
          thrown: thrown === undefined,
          terminal: test.terminal(),
          stagingCleared: test.staged()?.every((byte) => byte === 0),
          requestAttempted: test.pending.destroy.mock.calls.length,
          socketAttempted: test.socket.destroy.mock.calls.length,
        },
        "all terminal cleanup must run and settle despite one retirement failure",
      ).toEqual({
        thrown: true,
        terminal: "refused",
        stagingCleared: true,
        requestAttempted: 1,
        socketAttempted: 1,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("refuses unexpected peer data with generic settlement and cleared staging", async () => {
    const test = fixture();
    test.upgrade();
    test.socket.emit("data", Buffer.from("private-peer-text"));
    await test.result;
    expect(test.terminal()).toBe("refused");
    expect(test.staged()?.every((byte) => byte === 0)).toBe(true);
    expect(test.socket.destroy).toHaveBeenCalledOnce();
    expect(test.pending.destroy).toHaveBeenCalledOnce();
  });
});
