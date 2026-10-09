// @vitest-environment jsdom
import type { AttentionItem } from "@localdot/protocol";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { useSeenReporting } from "./useSeenReporting.ts";

const A = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const done: AttentionItem = {
  key: `${A}:done:4`,
  sessionId: A,
  level: "done",
  reason: "done",
  task: "Tidy the downloads",
  at: 1,
};

function setup(visible: boolean, items: AttentionItem[]) {
  const posted: string[] = [];
  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    posted.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
  const api = createApi("t".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: (visible ? "visible" : "hidden") as DocumentVisibilityState,
    hasFocus: () => visible,
  });
  const host = { doc, win: new EventTarget() };
  return { api, host, items, posted, doc };
}

describe("useSeenReporting", () => {
  it("reports a Done task once it is on screen in a focused tab", async () => {
    const s = setup(true, [done]);
    const { rerender } = renderHook(() => useSeenReporting(s.api, s.items, A, s.host));
    await waitFor(() => expect(s.posted).toEqual([JSON.stringify({ sessionId: A })]));
    rerender();
    expect(s.posted).toHaveLength(1);
  });

  it("waits until the tab is visible, and never reports Needs you or another task", async () => {
    const s = setup(false, [done]);
    renderHook(() => useSeenReporting(s.api, s.items, A, s.host));
    expect(s.posted).toEqual([]);
    Object.assign(s.doc, { visibilityState: "visible", hasFocus: () => true });
    s.doc.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    const n = setup(true, [{ ...done, level: "needs_you", reason: "approval" }]);
    renderHook(() => useSeenReporting(n.api, n.items, A, n.host));
    const other = setup(true, [done]);
    renderHook(() => useSeenReporting(other.api, other.items, null, other.host));
    expect(n.posted).toEqual([]);
    expect(other.posted).toEqual([]);
  });
});
