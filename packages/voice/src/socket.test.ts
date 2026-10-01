import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSocket } from "./socket.ts";
import { socketFactory } from "./testing.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceSocket", () => {
  it("offers localdot.v1, plus the token subprotocol when it has one", () => {
    const { sockets, create } = socketFactory();
    new VoiceSocket(
      "ws://127.0.0.1:4753/voice/tts",
      { text: () => {}, binary: () => {} },
      { create },
    ).connect();
    new VoiceSocket(
      "ws://x/voice/tts",
      { text: () => {}, binary: () => {} },
      { create, token: "abc" },
    ).connect();
    expect(sockets.map((s) => s.protocols)).toEqual([
      ["localdot.v1"],
      ["localdot.v1", "localdot.token.abc"],
    ]);
    expect(sockets[0]?.binaryType).toBe("arraybuffer");
  });

  it("hands text and binary to their handlers and sends only while open", () => {
    const { sockets, create } = socketFactory();
    const texts: string[] = [];
    const bytes: number[][] = [];
    const socket = new VoiceSocket(
      "ws://x",
      { text: (t) => texts.push(t), binary: (b) => bytes.push([...b]) },
      { create },
    );
    socket.connect();
    expect(socket.send("early")).toBe(false);
    sockets[0]?.open();
    expect(socket.send("hello")).toBe(true);
    sockets[0]?.receive('{"type":"ready"}');
    sockets[0]?.receive(new Uint8Array([1, 2]).buffer);
    expect(texts).toEqual(['{"type":"ready"}']);
    expect(bytes).toEqual([[1, 2]]);
    expect(sockets[0]?.sent).toEqual(["hello"]);
  });

  it("reconnects with growing delays until it is closed", () => {
    const { sockets, create } = socketFactory();
    const status: boolean[] = [];
    const socket = new VoiceSocket(
      "ws://x",
      { text: () => {}, binary: () => {}, status: (s) => status.push(s) },
      { create },
    );
    socket.connect();
    sockets[0]?.close();
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]?.close();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    sockets[2]?.open();
    socket.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
    expect(status).toEqual([false, false, true, false]);
  });

  it("ignores a replaced socket's late close and messages", () => {
    const { sockets, create } = socketFactory({ lateClose: true });
    const texts: string[] = [];
    const status: boolean[] = [];
    const socket = new VoiceSocket(
      "ws://x",
      { text: (t) => texts.push(t), binary: () => {}, status: (s) => status.push(s) },
      { create },
    );
    socket.connect();
    sockets[0]?.open();
    socket.close();
    socket.connect();
    sockets[1]?.open();
    sockets[0]?.receive('{"type":"stale"}');
    sockets[0]?.closed();
    vi.advanceTimersByTime(60_000);
    expect(socket.open).toBe(true);
    expect(socket.send("listen")).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(texts).toEqual([]);
    expect(status).toEqual([true, false, true]);
  });
});
