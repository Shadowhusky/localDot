// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { openSocket } from "./socket.ts";

describe("openSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("opens with both subprotocols, delivers messages, and reconnects with backoff until closed", () => {
    const got: string[] = [];
    const handle = openSocket({
      url: "ws://127.0.0.1:4750/api/cells/1/status",
      protocols: ["localdot.v1", "localdot.token.t"],
      handlers: { onMessage: (d) => got.push(d) },
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      backoffMs: { min: 100, max: 400 },
    });
    const first = FakeWebSocket.instances[0];
    expect(first?.protocols).toEqual(["localdot.v1", "localdot.token.t"]);
    first?.onopen?.();
    first?.onmessage?.({ data: '{"a":1}' });
    expect(got).toEqual(['{"a":1}']);
    first?.onclose?.();
    vi.advanceTimersByTime(99);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]?.onclose?.();
    vi.advanceTimersByTime(200);
    expect(FakeWebSocket.instances).toHaveLength(3);
    handle.close();
    expect(FakeWebSocket.instances[2]?.closed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  // The daemon refuses an upgrade (a revoked token's 403, an unknown cell's 404) before the
  // handshake, and the browser reports only a close (1006) that never followed an open.
  it("tells its owner each time a socket closes before it ever opened, and keeps retrying", () => {
    const refused: number[] = [];
    let closes = 0;
    const handle = openSocket({
      url: "ws://127.0.0.1:4750/api/cells/1/status",
      protocols: ["localdot.v1"],
      handlers: {
        onMessage: () => {},
        onClose: () => {
          closes += 1;
        },
        onRefused: () => refused.push(FakeWebSocket.instances.length),
      },
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      backoffMs: { min: 100, max: 400 },
    });
    FakeWebSocket.instances[0]?.onclose?.();
    expect(refused).toEqual([1]);
    vi.advanceTimersByTime(100);
    const second = FakeWebSocket.instances[1];
    second?.onopen?.();
    second?.onclose?.();
    expect(refused).toEqual([1]);
    vi.advanceTimersByTime(100);
    FakeWebSocket.instances[2]?.onclose?.();
    expect(refused).toEqual([1, 3]);
    expect(closes).toBe(3);
    handle.close();
    expect(refused).toEqual([1, 3]);
  });
  it("sends only while a connection is open, and never queues", () => {
    const handle = openSocket({
      url: "ws://127.0.0.1:4750/api/events",
      protocols: ["localdot.v1"],
      handlers: { onMessage: () => {} },
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      backoffMs: { min: 100, max: 400 },
    });
    expect(handle.send("early")).toBe(false);
    const socket = FakeWebSocket.instances[0];
    socket?.onopen?.();
    expect(handle.send("hello")).toBe(true);
    socket?.onclose?.();
    expect(handle.send("late")).toBe(false);
    expect(socket?.sent).toEqual(["hello"]);
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances[1]?.sent).toEqual([]);
    handle.close();
  });
});

it("refreshes a silent OPEN socket on app return and rejects its late events", () => {
  FakeWebSocket.instances = [];
  let seq = 4;
  const message = vi.fn();
  const close = vi.fn();
  const handle = openSocket({
    url: () => `ws://localhost/stream?fromSeq=${seq}`,
    protocols: [],
    handlers: { onMessage: message, onClose: close },
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  const old = FakeWebSocket.instances[0];
  old?.open();
  seq = 12;
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(old?.closed).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  expect(FakeWebSocket.instances[1]?.url).toContain("fromSeq=12");
  old?.onmessage?.({ data: "stale" });
  old?.onclose?.();
  const fresh = FakeWebSocket.instances[1];
  fresh?.open();
  fresh?.onmessage?.({ data: "current" });
  expect(message.mock.calls).toEqual([["current"]]);
  expect(handle.send("live")).toBe(true);
  expect(fresh?.sent).toEqual(["live"]);
  handle.close();
  window.dispatchEvent(new Event("online"));
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it("keeps a healthy connection on window focus, but still reconnects on a following visibility return", () => {
  FakeWebSocket.instances = [];
  const handle = openSocket({
    url: "ws://localhost/status",
    protocols: [],
    handlers: { onMessage() {} },
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  const first = FakeWebSocket.instances[0];
  first?.open();
  window.dispatchEvent(new Event("focus"));
  expect(first?.closed).toBe(false);
  expect(FakeWebSocket.instances).toHaveLength(1);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(first?.closed).toBe(true);
  expect(FakeWebSocket.instances).toHaveLength(2);
  handle.close();
});
