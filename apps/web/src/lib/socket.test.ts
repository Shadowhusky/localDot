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
});
