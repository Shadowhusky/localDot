// @vitest-environment jsdom
import { LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { OPENING_ROWS, readThread, useEarlierThread } from "./earlier.ts";
import type { ThreadItem } from "./thread.ts";

afterEach(cleanup);

const FIRST = "01JXYZ0000000000000000AAA1",
  SECOND = "01JXYZ0000000000000000AAA2",
  THIRD = "01JXYZ0000000000000000AAA3";

type Logged = readonly [type: string, data: Record<string, unknown>, step?: string];
const ndjson = (events: readonly Logged[]) =>
  events
    .map(([type, data, step], seq) =>
      JSON.stringify(
        LocalDotEvent.parse({
          v: 1,
          id: ulid(),
          seq,
          t: seq * 1000,
          agent: "main",
          type,
          data,
          ...(step ? { step } : {}),
        }),
      ),
    )
    .join("\n");

function log(task: string, reply: string, files: string[] = []) {
  return ndjson([
    ["session.start", { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: task }],
    ["message.user", { messageId: ulid(), text: task, kind: "task" }],
    ["message.assistant", { messageId: ulid(), text: reply }],
    [
      "task.result",
      { summary: reply, files: files.map((name) => ({ name, path: name, bytes: 1 })) },
    ],
    ["session.end", { reason: "done" }],
  ]);
}

// A task that talked between its steps: one before them, one after a failed check, and an answer.
function worked(task: string) {
  const command = (step: string, title: string, ok: boolean): Logged[] => [
    ["step.start", { kind: "shell" }, step],
    ["tool.start", { tool: "shell", title }, step],
    ["tool.end", { ok, exitCode: ok ? 0 : 2 }, step],
    ["step.end", { status: ok ? "ok" : "failed" }, step],
  ];
  return ndjson([
    ["session.start", { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: task }],
    ["message.user", { messageId: ulid(), text: task, kind: "task" }],
    ["message.assistant", { messageId: ulid(), text: "Checking the totals first." }],
    ...command("check", "Check totals", true),
    ...command("schema", "Validate schema", false),
    ["message.assistant", { messageId: ulid(), text: "No schema; writing the report." }],
    ...command("write", "Write report", true),
    ["message.assistant", { messageId: ulid(), text: "The report is ready." }],
    ["task.result", { summary: "Report ready", files: [] }],
    ["session.end", { reason: "done" }],
  ]);
}

function setup() {
  const logs: Record<string, string> = {
    [FIRST]: log("Draw a dog", "Drew it.", ["dog.png"]),
    [SECOND]: log("Make it blue", "Made it blue."),
    [THIRD]: worked("Write the report"),
  };
  const read = vi.fn((id: string) => logs[id]);
  const paths: string[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4747",
    fetchImpl: async (input) => {
      paths.push(new URL(String(input)).pathname);
      const id = new URL(String(input)).pathname.split("/")[3] ?? "";
      const text = read(id);
      return text === undefined
        ? new Response("unknown session", { status: 404 })
        : new Response(text, { headers: { "content-type": "application/x-ndjson" } });
    },
  });
  return { api, read, paths: () => paths };
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
  expect(said(view.result.current.items)).toEqual([
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
  expect(view.result.current.items.at(-1)?.key).toBe("message-shown");
  // Then what was on show gives way to the whole of it, as a fresh load has it.
  await settle();
  expect(said(view.result.current.items).at(-2)).toBe("dot: Made it blue.");
});

it("shows nothing earlier while no task is shown", async () => {
  const f = setup();
  const view = renderHook(() =>
    useEarlierThread(f.api, [FIRST, SECOND], { sessionId: null, items: [] }),
  );
  await settle();
  expect(view.result.current.items).toEqual([]);
  expect(view.result.current.opening).toBe(false);
  expect(f.read).not.toHaveBeenCalled();
});

const rows = (count: number): ThreadItem[] =>
  Array.from({ length: count }, (_, n) => ({
    kind: "message",
    key: `message-${n}`,
    speaker: "user",
    message: { id: `${n}`, role: "user", text: `Row ${n}`, final: true },
  }));

it("opens on enough earlier tasks for its opening rows, then reads one more each time it is asked", async () => {
  const f = setup();
  const view = renderHook(() =>
    useEarlierThread(f.api, [FIRST, SECOND, THIRD], {
      sessionId: THIRD,
      items: rows(OPENING_ROWS - 2),
    }),
  );
  expect(view.result.current.opening).toBe(true);
  await settle();
  expect(f.read.mock.calls.map(([id]) => id)).toEqual([SECOND]);
  expect(view.result.current).toMatchObject({ opening: false, more: true, reading: false });
  expect(said(view.result.current.items)).toEqual([
    "user: Make it blue",
    "dot: Made it blue.",
    `result of ${SECOND}: `,
  ]);
  act(() => view.result.current.older());
  expect(view.result.current.reading).toBe(true);
  await settle();
  expect(f.read.mock.calls.map(([id]) => id)).toEqual([SECOND, FIRST]);
  expect(view.result.current).toMatchObject({ opening: false, more: false, reading: false });
  expect(said(view.result.current.items)[0]).toBe("user: Draw a dog");
});

it("waits for the shown task's own history before opening", async () => {
  const f = setup();
  const view = renderHook(
    ({ ready }) =>
      useEarlierThread(f.api, [FIRST, SECOND], { sessionId: SECOND, items: [] }, ready),
    { initialProps: { ready: false } },
  );
  await settle();
  expect(f.read).not.toHaveBeenCalled();
  expect(view.result.current.opening).toBe(true);
  view.rerender({ ready: true });
  await settle();
  expect(view.result.current.opening).toBe(false);
  expect(f.read.mock.calls.map(([id]) => id)).toEqual([FIRST]);
});

it("reads each earlier task's history, not its whole log", async () => {
  const f = setup();
  renderHook(() => useEarlierThread(f.api, [FIRST, SECOND], { sessionId: SECOND, items: [] }));
  await settle();
  expect(f.paths()).toEqual([`/api/sessions/${FIRST}/history`]);
});

it("reads an earlier task's steps where dot took them, between its words, as that task's", async () => {
  const f = setup();
  const view = renderHook(() =>
    useEarlierThread(f.api, [THIRD, FIRST], { sessionId: FIRST, items: [] }),
  );
  await settle();
  const items = view.result.current.items;
  expect(
    items.map((item) =>
      item.kind === "work"
        ? `steps: ${item.steps.map((step) => step.title).join(", ")} (${item.sessionId})`
        : item.kind === "message"
          ? `${item.narration ? "narrates" : item.speaker}: ${item.message.text}`
          : item.kind,
    ),
  ).toEqual([
    "user: Write the report",
    "narrates: Checking the totals first.",
    `steps: Check totals, Validate schema (${THIRD})`,
    "narrates: No schema; writing the report.",
    `steps: Write report (${THIRD})`,
    "dot: The report is ready.",
    "result",
  ]);
  const [first] = items.filter((item) => item.kind === "work");
  expect(first?.kind === "work" && first.steps.map((step) => step.state)).toEqual([
    "done",
    "failed",
  ]);
});

it("shows which run of a routine each earlier task was", async () => {
  const origin = {
    kind: "routine",
    routineId: "01JXYZ0000000000000000RRR1",
    runId: "01JXYZ0000000000000000RRN1",
    name: "Morning bills",
    dueAt: "2026-10-12T07:30:00.000Z",
  };
  const first = ndjson([
    [
      "session.start",
      { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: "Morning bills", origin },
    ],
    ["message.user", { messageId: ulid(), text: "Check", kind: "task" }],
    ["session.end", { reason: "done" }],
  ]);
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4747",
    fetchImpl: async () =>
      new Response(first, { headers: { "content-type": "application/x-ndjson" } }),
  });
  const items = await readThread(api, FIRST, new AbortController().signal);
  expect(items[0]).toMatchObject({ kind: "origin", origin });
});

const message = (key: string): ThreadItem => ({
  kind: "message",
  key: `message-${key}`,
  speaker: "user",
  message: { id: key, role: "user", text: key, final: true },
});

it("keeps every task that has been on show, however late the list of tasks learns of them", async () => {
  const f = setup();
  const view = renderHook(({ sessions, shown }) => useEarlierThread(f.api, sessions, shown), {
    initialProps: {
      sessions: [] as string[],
      shown: { sessionId: FIRST as string | null, items: rows(OPENING_ROWS) },
    },
  });
  await settle();
  const first = view.result.current.owner;
  view.rerender({ sessions: [], shown: { sessionId: SECOND, items: [message("second")] } });
  expect(view.result.current.items).toHaveLength(OPENING_ROWS);
  view.rerender({ sessions: [], shown: { sessionId: THIRD, items: [message("third")] } });
  // Both tasks before the one shown stay, oldest first, and the conversation is still the one it was.
  expect(view.result.current.items.at(0)?.key).toBe("message-0");
  expect(view.result.current.items.at(-1)?.key).toBe("message-second");
  expect(view.result.current.owner).toBe(first);
  expect(view.result.current.opening).toBe(false);
  // The list comes in: nothing above moves.
  view.rerender({
    sessions: [FIRST, SECOND, THIRD],
    shown: { sessionId: THIRD, items: [message("third")] },
  });
  expect(view.result.current.items.at(-1)?.key).toBe("message-second");
  expect(view.result.current.owner).toBe(first);
  // Both are read from their history in the end, as a fresh load has them.
  await settle();
  expect(said(view.result.current.items)).toEqual([
    "user: Draw a dog",
    "dot: Drew it.",
    `result of ${FIRST}: dog.png`,
    "user: Make it blue",
    "dot: Made it blue.",
    `result of ${SECOND}: `,
  ]);
});

it("opens anew on a list that names none of the tasks seen, and on nothing shown", async () => {
  const f = setup();
  const view = renderHook(({ sessions, shown }) => useEarlierThread(f.api, sessions, shown), {
    initialProps: {
      sessions: [FIRST],
      shown: { sessionId: FIRST as string | null, items: rows(2) },
    },
  });
  await settle();
  view.rerender({ sessions: [SECOND, THIRD], shown: { sessionId: THIRD, items: rows(2) } });
  expect(view.result.current.owner).toBe(SECOND);
  expect(view.result.current.opening).toBe(true);
  expect(view.result.current.items.map((item) => item.key)).not.toContain("message-0");
  view.rerender({ sessions: [], shown: { sessionId: null, items: [] } });
  expect(view.result.current.owner).toBe("");
  expect(view.result.current.items).toEqual([]);
});

it("reads no earlier task until asked once the shown task fills the thread by itself", async () => {
  const f = setup();
  const view = renderHook(() =>
    useEarlierThread(f.api, [FIRST, SECOND, THIRD], {
      sessionId: THIRD,
      items: rows(OPENING_ROWS),
    }),
  );
  await settle();
  expect(view.result.current).toMatchObject({ opening: false, more: true, reading: false });
  expect(f.read).not.toHaveBeenCalled();
  act(() => view.result.current.older());
  await settle();
  expect(f.read.mock.calls.map(([id]) => id)).toEqual([SECOND]);
});

it("keeps what was on show if the task's history can't be read after all", async () => {
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4747",
    fetchImpl: async () => new Response("gone", { status: 404 }),
  });
  const view = renderHook(({ sessions, shown }) => useEarlierThread(api, sessions, shown), {
    initialProps: {
      sessions: [FIRST],
      shown: { sessionId: FIRST as string | null, items: [message("shown")] },
    },
  });
  await settle();
  view.rerender({ sessions: [FIRST], shown: { sessionId: SECOND, items: [] } });
  await settle();
  expect(view.result.current.items.map((item) => item.key)).toEqual(["message-shown"]);
});

it("reads a task that failed to load again, showing nothing of it meanwhile", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const logs = log("Draw a dog", "Drew it.");
    let fail = true;
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4747",
      fetchImpl: async () =>
        fail
          ? new Response("down", { status: 503 })
          : new Response(logs, { headers: { "content-type": "application/x-ndjson" } }),
    });
    const view = renderHook(() =>
      useEarlierThread(api, [FIRST, SECOND], { sessionId: SECOND, items: [] }),
    );
    const run = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    await run(5);
    expect(view.result.current).toMatchObject({ items: [], opening: false, reading: false });
    fail = false;
    await run(1100);
    expect(said(view.result.current.items)[0]).toBe("user: Draw a dog");
  } finally {
    vi.useRealTimers();
  }
});

it("does not read again a task that no longer exists", async () => {
  const f = setup();
  const view = renderHook(() =>
    useEarlierThread(f.api, ["01JXYZ0000000000000000AAA9", THIRD], { sessionId: THIRD, items: [] }),
  );
  await settle();
  expect(view.result.current.items).toEqual([]);
  expect(f.read).toHaveBeenCalledTimes(1);
});
