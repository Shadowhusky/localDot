// @vitest-environment jsdom
import type { AttentionItem } from "@localdot/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { applyChange, useAttention } from "./useAttention.ts";

const A = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const B = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHK";
const item = (
  sessionId: string,
  level: AttentionItem["level"],
  reason: AttentionItem["reason"],
  at = 1,
): AttentionItem => ({
  key: `${sessionId}:${reason}:${at}`,
  sessionId,
  level,
  reason,
  task: "Pay the electricity bill",
  at,
});

beforeEach(() => {
  FakeWebSocket.instances = [];
});

function setup(snapshots: AttentionItem[][] = [[]]) {
  let served = 0;
  const fetchImpl = vi.fn(async () =>
    Response.json({ items: snapshots[Math.min(served++, snapshots.length - 1)] }),
  );
  const api = createApi("t".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "hidden" as DocumentVisibilityState,
    hasFocus: () => false,
  });
  const win = new EventTarget();
  const notices: string[] = [];
  const page = {
    Notification: class {
      static permission: NotificationPermission = "granted";
      onclick = null;
      constructor(title: string) {
        notices.push(title);
      }
      close() {}
    } as never,
    focus: vi.fn(),
    openSession: vi.fn(),
  };
  const opts = { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, doc, win, page };
  const hook = renderHook(() => useAttention(api, vi.fn(), opts));
  return { hook, doc, win, notices, fetchImpl };
}

const change = (socket: FakeWebSocket | undefined, next: AttentionItem, page = false) =>
  act(() =>
    socket?.onmessage?.({ data: JSON.stringify({ type: "attention.change", item: next, page }) }),
  );

describe("useAttention", () => {
  it("orders the list by the shared attention order and drops cleared tasks", () => {
    let list = applyChange([], item(A, "done", "done", 1));
    list = applyChange(list, item(B, "needs_you", "approval", 2));
    expect(list.map((i) => i.level)).toEqual(["needs_you", "done"]);
    list = applyChange(list, item(B, "working", "working", 3));
    expect(list.map((i) => i.sessionId)).toEqual([A]);
  });

  it("loads the snapshot, follows changes and reports presence over the socket", async () => {
    const { hook, doc, win } = setup([[item(A, "done", "done")]]);
    await waitFor(() => expect(hook.result.current.top).toBe("done"));
    expect(hook.result.current.latest).toBeNull();
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toBe("ws://127.0.0.1:4750/api/events");
    act(() => socket?.onopen?.());
    expect(JSON.parse(socket?.sent[0] ?? "{}")).toEqual({
      type: "presence",
      visible: false,
      canNotify: true,
    });
    change(socket, item(B, "needs_you", "approval", 2));
    expect(hook.result.current.items.map((i) => i.sessionId)).toEqual([B, A]);
    expect(hook.result.current.latest?.sessionId).toBe(B);
    act(() =>
      socket?.onmessage?.({ data: JSON.stringify({ type: "routine.changed", routineId: "x" }) }),
    );
    expect(hook.result.current.items).toHaveLength(2);
    Object.assign(doc, { visibilityState: "visible", hasFocus: () => true });
    act(() => {
      doc.dispatchEvent(new Event("visibilitychange"));
      win.dispatchEvent(new Event("focus"));
    });
    expect(JSON.parse(socket?.sent.at(-1) ?? "{}")).toMatchObject({ visible: true });
  });

  it("reads a fresh snapshot after a reconnect, so what cleared meanwhile goes", async () => {
    const { hook, fetchImpl } = setup([[item(A, "done", "done")], []]);
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]?.onopen?.());
    expect(fetchImpl).toHaveBeenCalledOnce();
    act(() => FakeWebSocket.instances[0]?.drop(1006));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]?.onopen?.());
    await waitFor(() => expect(hook.result.current.items).toEqual([]));
  });

  it("shows a notification itself only when the daemon asks and the tab is hidden", async () => {
    const { notices } = setup();
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.onopen?.());
    change(socket, item(A, "needs_you", "approval"));
    expect(notices).toEqual([]);
    change(socket, item(A, "needs_you", "approval"), true);
    expect(notices).toEqual(["dot needs you"]);
    expect(JSON.parse(socket?.sent.at(-1) ?? "{}")).toEqual({
      type: "shown",
      key: item(A, "needs_you", "approval").key,
    });
  });
});
