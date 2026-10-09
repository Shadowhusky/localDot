// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../lib/api.ts";
import { useWhatDotKnows } from "./useWhatDotKnows.ts";

afterEach(cleanup);
const FACT = {
  id: "01JXYZ0000000000000000AAAA",
  file: "USER.md" as const,
  text: "Lives in Lisbon",
  source: { kind: "user" as const },
  at: "2026-10-08",
  pinned: false,
  revision: "0123456789abcdef",
};
function server(opts: { staleOnce?: boolean } = {}) {
  let facts = [FACT];
  let stale = opts.staleOnce ?? false;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${pathname}`);
    if (pathname === "/api/agent/memory/entries" && method === "GET")
      return Response.json({
        dir: "~/.localdot/memory",
        files: [
          { file: "USER.md", entries: facts },
          { file: "MEMORY.md", entries: [] },
        ],
      });
    if (pathname === "/api/agent/memory/entries" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const added = { ...FACT, id: "01JXYZ0000000000000000BBBB", text: body.text };
      facts = [...facts, added];
      return Response.json(
        { changeId: "01JXYZ0000000000000000CHNG", entry: added },
        { status: 201 },
      );
    }
    if (pathname.startsWith("/api/agent/memory/entries/") && method === "PUT") {
      if (stale) {
        stale = false;
        facts = [{ ...FACT, revision: "1111111111111111" }];
        return new Response("changed", { status: 409 });
      }
      return Response.json({ changeId: "01JXYZ0000000000000000CHN2" });
    }
    if (pathname === "/api/agent/people") return Response.json({ people: [] });
    if (pathname === "/api/agent/recent-activity")
      return Response.json({
        enabled: true,
        tasks: [
          {
            sessionId: "01JXYZ0000000000000000TASK",
            title: "Book a table",
            outcome: "done",
            day: "2026-10-08",
          },
        ],
      });
    return new Response("", { status: 404 });
  });
  return { api: createApi("a".repeat(43), { fetchImpl, origin: "http://fixture.test" }), calls };
}

describe("what dot knows", () => {
  it("reads nothing while Settings is closed, then facts, people and recent tasks", async () => {
    const { api, calls } = server();
    const { result, rerender } = renderHook(({ open }) => useWhatDotKnows(api, open), {
      initialProps: { open: false },
    });
    expect(calls).toEqual([]);
    rerender({ open: true });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.files["USER.md"].map((f) => f.text)).toEqual(["Lives in Lisbon"]);
    expect(result.current.recent.map((t) => t.title)).toEqual(["Book a table"]);
  });
  it("adds a fact, answers its change id and reads again", async () => {
    const { api } = server();
    const { result } = renderHook(() => useWhatDotKnows(api, true));
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    let changeId = "";
    await act(async () => {
      changeId = await result.current.addFact("USER.md", "Prefers aisle seats");
    });
    expect(changeId).toBe("01JXYZ0000000000000000CHNG");
    await waitFor(() =>
      expect(result.current.files["USER.md"].map((f) => f.text)).toContain("Prefers aisle seats"),
    );
  });
  it("reads again and fails when a fact changed meanwhile", async () => {
    const { api } = server({ staleOnce: true });
    const { result } = renderHook(() => useWhatDotKnows(api, true));
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    await act(async () => {
      await expect(result.current.editFact(FACT, { text: "Lives in Porto" })).rejects.toMatchObject(
        { reason: "stale" },
      );
    });
    await waitFor(() =>
      expect(result.current.files["USER.md"][0]?.revision).toBe("1111111111111111"),
    );
  });
});
