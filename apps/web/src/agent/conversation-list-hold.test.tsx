// @vitest-environment jsdom
import type { ConversationEntry } from "@localdot/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import {
  dropConversations,
  holdConversations,
  readConversationsAgain,
  showOrganized,
  useRecentConversations,
} from "./conversation-list.ts";

beforeEach(() => vi.stubGlobal("WebSocket", FakeWebSocket));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(n: number): ConversationEntry {
  const sessionId = `01M4ECBR5X0R92SYA389FM3Q${String(n).padStart(2, "0")}`;
  return {
    sessionId,
    sessions: [sessionId],
    title: `Conversation ${n}`,
    said: "Do it",
    startedAt: new Date(2026, 9, 9).toISOString(),
    ended: "done",
  };
}

function daemon(listed: { current: ConversationEntry[] }) {
  const reads = { count: 0 };
  const fetchImpl = (async () => {
    reads.count++;
    return Response.json({ conversations: listed.current, archivedCount: 0 });
  }) as typeof fetch;
  return { reads, api: createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1" }) };
}

const titles = (entries: readonly ConversationEntry[]) => entries.map((each) => each.title);

async function opened(listed: { current: ConversationEntry[] }) {
  const { api, reads } = daemon(listed);
  const hook = renderHook(() => useRecentConversations(api, true));
  await waitFor(() => expect(hook.result.current.entries.length).toBe(listed.current.length));
  return { api, reads, hook };
}

it("keeps its rows through a read while held, then reads what the daemon now has", async () => {
  const listed = { current: [entry(1), entry(2), entry(3)] };
  const { api, reads, hook } = await opened(listed);
  const letGo = holdConversations(api);
  listed.current = [entry(1), entry(3)];
  const before = reads.count;
  act(() => readConversationsAgain(api));
  act(() => hook.result.current.retry());
  await act(() => new Promise((done) => setTimeout(done, 5)));
  expect(reads.count).toBe(before);
  expect(titles(hook.result.current.entries)).toEqual([
    "Conversation 1",
    "Conversation 2",
    "Conversation 3",
  ]);
  act(() => letGo());
  await waitFor(() => expect(titles(hook.result.current.entries)).toHaveLength(2));
  expect(reads.count).toBe(before + 1);
});

it("waits for the last of several holds, and letting go twice counts once", async () => {
  const listed = { current: [entry(1), entry(2)] };
  const { api, reads, hook } = await opened(listed);
  const first = holdConversations(api);
  const second = holdConversations(api);
  listed.current = [entry(1)];
  const before = reads.count;
  act(() => first());
  act(() => first());
  await act(() => new Promise((done) => setTimeout(done, 5)));
  expect(reads.count).toBe(before);
  act(() => second());
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(1));
});

it("takes out those asked at once, whatever is held", async () => {
  const listed = { current: [entry(1), entry(2), entry(3)] };
  const { api, hook } = await opened(listed);
  const letGo = holdConversations(api);
  act(() => dropConversations(api, [entry(2).sessionId, entry(3).sessionId]));
  expect(titles(hook.result.current.entries)).toEqual(["Conversation 1"]);
  listed.current = [entry(1)];
  act(() => letGo());
});

it("shows filing for several in one change, leaving the view at once", async () => {
  const listed = { current: [entry(1), entry(2), entry(3)] };
  const { api, hook } = await opened(listed);
  let renders = 0;
  const counted = renderHook(() => {
    renders++;
    return useRecentConversations(api, true);
  });
  const before = renders;
  act(() => showOrganized(api, [entry(1).sessionId, entry(3).sessionId], { archived: true }));
  expect(titles(hook.result.current.entries)).toEqual(["Conversation 2"]);
  expect(titles(counted.result.current.entries)).toEqual(["Conversation 2"]);
  expect(renders - before).toBe(1);
});
