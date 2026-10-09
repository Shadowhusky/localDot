// @vitest-environment jsdom
import { LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { EARLIER_SHOWN, leftToReplay, useEarlierThread } from "./earlier.ts";
import type { ThreadItem } from "./thread.ts";

afterEach(cleanup);

const FIRST = "01JXYZ0000000000000000AAA1",
  SECOND = "01JXYZ0000000000000000AAA2",
  THIRD = "01JXYZ0000000000000000AAA3";

function log(task: string, reply: string, files: string[] = []) {
  const events = [
    ["session.start", { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: task }],
    ["message.user", { messageId: ulid(), text: task, kind: "task" }],
    ["message.assistant", { messageId: ulid(), text: reply }],
    [
      "task.result",
      { summary: reply, files: files.map((name) => ({ name, path: name, bytes: 1 })) },
    ],
    ["session.end", { reason: "done" }],
  ] as const;
  return events
    .map(([type, data], seq) =>
      JSON.stringify(
        LocalDotEvent.parse({ v: 1, id: ulid(), seq, t: seq * 1000, agent: "main", type, data }),
      ),
    )
    .join("\n");
}

function setup() {
  const logs: Record<string, string> = {
    [FIRST]: log("Draw a dog", "Drew it.", ["dog.png"]),
    [SECOND]: log("Make it blue", "Made it blue."),
  };
  const read = vi.fn((id: string) => logs[id]);
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4747",
    fetchImpl: async (input) => {
      const id = new URL(String(input)).pathname.split("/")[3] ?? "";
      const text = read(id);
      return text === undefined
        ? new Response("unknown session", { status: 404 })
        : new Response(text, { headers: { "content-type": "application/x-ndjson" } });
    },
  });
  return { api, read };
}
const said = (items: readonly ThreadItem[]) =>
  items.flatMap((item) =>
    item.kind === "message"
      ? [`${item.speaker}: ${item.message.text}`]
      : item.kind === "result"
        ? [`result of ${item.result.sessionId}: ${item.result.files.map((f) => f.name)}`]
        : [],
  );
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

it("shows the conversation's earlier tasks above the latest, oldest first, each read once", async () => {
  const f = setup();
  const view = renderHook(({ shown }) => useEarlierThread(f.api, [FIRST, SECOND, THIRD], shown), {
    initialProps: { shown: { sessionId: THIRD, items: [] as ThreadItem[] } },
  });
  await settle();
  expect(said(view.result.current)).toEqual([
    "user: Draw a dog",
    "dot: Drew it.",
    `result of ${FIRST}: dog.png`,
    "user: Make it blue",
    "dot: Made it blue.",
    `result of ${SECOND}: `,
  ]);
  view.rerender({ shown: { sessionId: THIRD, items: [] } });
  await settle();
  expect(f.read.mock.calls.map(([id]) => id).sort()).toEqual([FIRST, SECOND]);
});

it("carries the shown task's thread over as it is when the next task takes its place", async () => {
  const f = setup();
  const shownItems: ThreadItem[] = [
    {
      kind: "message",
      key: "message-shown",
      speaker: "user",
      message: { id: "shown", role: "user", text: "Make it blue", final: true },
    },
  ];
  const view = renderHook(({ sessions, shown }) => useEarlierThread(f.api, sessions, shown), {
    initialProps: { sessions: [FIRST, SECOND], shown: { sessionId: SECOND, items: shownItems } },
  });
  await settle();
  // The next task starts before the conversation is read again.
  view.rerender({ sessions: [FIRST, SECOND], shown: { sessionId: THIRD, items: [] } });
  expect(view.result.current.at(-1)?.key).toBe("message-shown");
  await settle();
  expect(f.read.mock.calls.map(([id]) => id)).toEqual([FIRST]);
});

it("shows nothing earlier while no task is shown", async () => {
  const f = setup();
  const view = renderHook(() =>
    useEarlierThread(f.api, [FIRST, SECOND], { sessionId: null, items: [] }),
  );
  await settle();
  expect(view.result.current).toEqual([]);
  expect(f.read).not.toHaveBeenCalled();
});

it("says when the conversation goes back further than the thread shows", () => {
  const ids = Array.from({ length: EARLIER_SHOWN + 2 }, () => ulid());
  const latest = ids.at(-1) ?? null;
  expect(leftToReplay(ids.slice(-(EARLIER_SHOWN + 1)), latest, false)).toBe(false);
  expect(leftToReplay(ids, latest, false)).toBe(true);
  expect(leftToReplay([FIRST, SECOND], SECOND, true)).toBe(true);
  expect(leftToReplay([], null, true)).toBe(false);
});
