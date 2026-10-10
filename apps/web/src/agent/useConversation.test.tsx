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

it("does not let a background reload invalidate a pending new conversation", async () => {
  let finish!: (reply: Response) => void;
  const f = setup(async (method) =>
    method === "GET"
      ? Response.json({ sessions: [OLD], more: false })
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  await settle();
  let choosing!: Promise<boolean>;
  act(() => {
    choosing = f.view.result.current.startNew();
  });
  act(() => f.view.result.current.reload());
  await settle();
  await act(async () => {
    finish(Response.json({ sessions: [], more: false }));
    expect(await choosing).toBe(true);
  });
  expect(f.view.result.current.sessions).toEqual([]);
  expect(f.view.result.current.choice).toBe(1);
});

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

it("reads the conversation again after a failed read, waiting longer each time", async () => {
  vi.useFakeTimers();
  try {
    let failures = 2;
    const f = setup(async () =>
      failures-- > 0
        ? new Response("unavailable", { status: 503 })
        : Response.json({ sessions: [LATEST], more: false }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(f.view.result.current.known).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(f.asked).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(f.asked).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(f.asked).toHaveLength(3);
    expect(f.view.result.current).toMatchObject({ known: true, sessions: [LATEST] });
  } finally {
    vi.useRealTimers();
  }
});

it("counts each conversation the user chooses", async () => {
  const f = setup(async (method) =>
    method === "GET"
      ? Response.json({ sessions: [LATEST], more: false })
      : Response.json({ sessions: [], more: false }),
  );
  await settle();
  expect(f.view.result.current.choice).toBe(0);
  await act(async () => {
    await f.view.result.current.startNew();
  });
  expect(f.view.result.current.choice).toBe(1);
  f.view.result.current.reload();
  await settle();
  expect(f.view.result.current.choice).toBe(1);
});

it("knows there is no conversation when the daemon has none to offer", async () => {
  const f = setup(async () => new Response("not found", { status: 404 }));
  await settle();
  expect(f.view.result.current).toMatchObject({ known: true, sessions: [] });
  expect(f.asked).toEqual(["GET /api/conversation"]);
});
