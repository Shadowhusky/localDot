// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FINISH_FIRST, useConversation } from "./useConversation.ts";

const spoken = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("../ui/Announcer.tsx", () => spoken);
afterEach(() => {
  cleanup();
  spoken.announce.mockClear();
});

const OLD = "01JXYZ0000000000000000AAA1",
  LATEST = "01JXYZ0000000000000000AAA2";

function setup(reply: (method: string, path: string, body: unknown) => Promise<Response>) {
  const asked: string[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4747",
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      asked.push(`${method} ${path}`);
      return reply(method, path, init?.body ? JSON.parse(String(init.body)) : undefined);
    },
  });
  return { view: renderHook(() => useConversation(api)), asked };
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

it("reads which conversation is current, and the choice of a new or an older one", async () => {
  const f = setup(async (method, path, body) => {
    if (method === "GET") return Response.json({ sessions: [OLD, LATEST], more: false });
    if (path.endsWith("/new")) return Response.json({ sessions: [], more: false });
    return Response.json({ sessions: [(body as { sessionId: string }).sessionId], more: true });
  });
  expect(f.view.result.current.known).toBe(false);
  await settle();
  expect(f.view.result.current).toMatchObject({ known: true, sessions: [OLD, LATEST] });
  await act(async () => expect(await f.view.result.current.startNew()).toBe(true));
  expect(f.view.result.current.sessions).toEqual([]);
  await act(async () => expect(await f.view.result.current.continueFrom(OLD)).toBe(true));
  expect(f.view.result.current).toMatchObject({ sessions: [OLD], more: true });
  expect(f.asked).toEqual([
    "GET /api/conversation",
    "POST /api/conversation/new",
    "POST /api/conversation/continue",
  ]);
});

it("never lets a slower read undo a choice made after it", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = setup(async (method) => {
    if (method === "GET") {
      await slow;
      return Response.json({ sessions: [OLD, LATEST], more: false });
    }
    return Response.json({ sessions: [], more: false });
  });
  await act(async () => {
    await f.view.result.current.startNew();
  });
  release();
  await settle();
  expect(f.view.result.current.sessions).toEqual([]);
});

it("says to finish the task at work first when the daemon refuses", async () => {
  const f = setup(async (method) =>
    method === "GET"
      ? Response.json({ sessions: [LATEST], more: false })
      : new Response(FINISH_FIRST, { status: 409 }),
  );
  await settle();
  await act(async () => expect(await f.view.result.current.startNew()).toBe(false));
  expect(f.view.result.current.sessions).toEqual([LATEST]);
  expect(spoken.announce).toHaveBeenCalledWith("conversation", FINISH_FIRST, "assertive");
});
