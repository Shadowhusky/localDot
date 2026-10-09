// @vitest-environment jsdom
import { MANUAL_STREAM_CLOSE, ulid } from "@localdot/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { openManualChannel } from "./manual-channel.ts";
import { useManualChannel } from "./useManualChannel.ts";

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const channel = (onEnd = vi.fn()) =>
  openManualChannel({
    url: "ws://127.0.0.1:4768/stream",
    protocols: ["localdot.v1"],
    onEnd,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });

it("keeps input made while the socket opens, in order, and settles once the daemon has it all", async () => {
  const opened = channel(),
    socket = FakeWebSocket.instances[0] as FakeWebSocket;
  opened.send({ kind: "text", text: "u" });
  opened.send({ kind: "key", combo: ["tab"] });
  expect(socket.sent).toEqual([]);
  let drained: boolean | undefined;
  void opened.drained(1000).then((value) => {
    drained = value;
  });
  socket.open();
  opened.send({ kind: "text", text: "p" });
  expect(socket.sent.map((data) => JSON.parse(data))).toEqual([
    { kind: "text", text: "u" },
    { kind: "key", combo: ["tab"] },
    { kind: "text", text: "p" },
  ]);
  socket.onmessage?.({ data: JSON.stringify({ done: 2 }) });
  await Promise.resolve();
  expect(drained).toBeUndefined();
  socket.onmessage?.({ data: JSON.stringify({ done: 3 }) });
  await Promise.resolve();
  expect(drained).toBe(true);
  expect(await opened.drained(1000)).toBe(true);
});

it("reports a drop by the daemon but not its own close, and never settles unacknowledged input as sent", async () => {
  const onEnd = vi.fn(),
    opened = channel(onEnd),
    socket = FakeWebSocket.instances[0] as FakeWebSocket;
  socket.open();
  opened.send({ kind: "text", text: "lost" });
  const drained = opened.drained(1000);
  socket.drop(MANUAL_STREAM_CLOSE.changed);
  expect(await drained).toBe(false);
  expect(onEnd).toHaveBeenCalledExactlyOnceWith(MANUAL_STREAM_CLOSE.changed);
  opened.send({ kind: "text", text: "after" });
  expect(socket.sent).toHaveLength(1);

  const mine = vi.fn(),
    second = channel(mine);
  second.close();
  expect(mine).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const third = channel(),
    late = third.drained(50);
  third.send({ kind: "key", combo: ["enter"] });
  const waited = third.drained(50);
  vi.advanceTimersByTime(60);
  expect(await late).toBe(true);
  expect(await waited).toBe(false);
});

it("opens one stream for the user's control, reopens it after a drop, and stays shut once input is uncertain", () => {
  vi.useFakeTimers();
  const api = createApi("a".repeat(43), { origin: "http://127.0.0.1:4768" }),
    session = ulid(),
    request = ulid(),
    ended = vi.fn();
  const view = renderHook(
    (ids: { session: string | null; request: string | null }) =>
      useManualChannel(api, ids.session, ids.request, ended),
    { initialProps: { session: null as string | null, request: null as string | null } },
  );
  expect(FakeWebSocket.instances).toHaveLength(0);
  view.rerender({ session, request });
  const first = FakeWebSocket.instances[0] as FakeWebSocket;
  expect(first.url).toBe(
    `ws://127.0.0.1:4768/api/agent/sessions/${session}/takeover/${request}/stream`,
  );
  expect(first.protocols).toEqual(["localdot.v1", `localdot.token.${"a".repeat(43)}`]);
  first.open();
  view.result.current.send({ kind: "text", text: "x" });
  expect(first.sent).toEqual([JSON.stringify({ kind: "text", text: "x" })]);
  act(() => first.drop(1006));
  expect(ended).toHaveBeenCalledOnce();
  view.result.current.send({ kind: "text", text: "dropped" });
  act(() => vi.advanceTimersByTime(300));
  const second = FakeWebSocket.instances[1] as FakeWebSocket;
  expect(second).toBeDefined();
  second.open();
  act(() => second.drop(MANUAL_STREAM_CLOSE.uncertain));
  act(() => vi.advanceTimersByTime(5000));
  expect(FakeWebSocket.instances).toHaveLength(2);
  view.rerender({ session: null, request: null });
  view.rerender({ session, request });
  const third = FakeWebSocket.instances[2] as FakeWebSocket;
  view.rerender({ session: null, request: null });
  expect(third.closed).toBe(true);
  view.unmount();
});
