// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation.tsx";
import type { LiveWork } from "./LiveWorkLine.tsx";
import type { AgentMessage, AgentResult, AgentWords } from "./model.ts";
import type { ThreadItem, WorkStep } from "./thread.ts";

const drawn = vi.hoisted(() => ({ work: 0, results: 0 }));

vi.mock("./LiveWorkLine.tsx", async (load) => {
  const real = await load<typeof import("./LiveWorkLine.tsx")>();
  return {
    ...real,
    LiveWorkLine(props: Parameters<typeof real.LiveWorkLine>[0]) {
      // The foot's line is the live one; the thread's rows are earlier turns.
      if (!props.live) drawn.work += 1;
      return real.LiveWorkLine(props);
    },
  };
});

vi.mock("./ResultFiles.tsx", async (load) => {
  const real = await load<typeof import("./ResultFiles.tsx")>();
  return {
    ...real,
    ResultCard(props: Parameters<typeof real.ResultCard>[0]) {
      drawn.results += 1;
      return real.ResultCard(props);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const message = (id: string, text: string) =>
  ({ id, role: "user", text, final: true }) as AgentMessage;
const step = (key: string, state: WorkStep["state"] = "done") =>
  ({ key, title: `Step ${key}`, meta: "", time: "", state, startT: 1, endT: 2 }) as WorkStep;
// The model keeps its messages and results; the thread's items around them are rebuilt by every
// event, with new objects for the same steps.
const first = message("1", "Draw a dog");
const second = message("2", "Now a cat");
const result: AgentResult = { id: "result-1", summary: "Drew the dog.", files: [] };
const thread = (): ThreadItem[] => [
  { kind: "message", key: "message-1", speaker: "user", message: first },
  {
    kind: "work",
    key: "work-1",
    speaker: "dot",
    turn: "message-1",
    steps: [step("a"), step("b")],
    startMs: 0,
  },
  { kind: "result", key: "result-1", speaker: "dot", result },
  { kind: "message", key: "message-2", speaker: "user", message: second },
  {
    kind: "work",
    key: "work-2",
    speaker: "dot",
    turn: "message-2",
    steps: [step("c", "doing")],
    startMs: 10,
  },
];
const live = (nowMs: number): LiveWork => ({ phase: "running", label: "Drawing", nowMs });

it("leaves earlier turns' work lines and results alone while the clock ticks and events arrive", () => {
  const view = render(
    <Conversation items={thread()} truncated={false} live={live(1000)} onReplay={() => {}} />,
  );
  const before = { ...drawn };
  expect(before.work).toBeGreaterThan(0);
  expect(before.results).toBeGreaterThan(0);
  for (const nowMs of [2000, 3000, 4000])
    view.rerender(
      <Conversation items={thread()} truncated={false} live={live(nowMs)} onReplay={() => {}} />,
    );
  expect(drawn).toEqual(before);
  // A step of the earlier turn that changes is drawn.
  view.rerender(
    <Conversation
      items={thread().map((item) =>
        item.key === "work-1" && item.kind === "work"
          ? { ...item, steps: [step("a"), step("b", "failed")] }
          : item,
      )}
      truncated={false}
      live={live(5000)}
      onReplay={() => {}}
    />,
  );
  expect(drawn.work).toBe(before.work + 1);
  expect(drawn.results).toBe(before.results);
});

it("draws a message's new words from the feed when it says they came, with the page left alone", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let said = { id: "3", role: "assistant", text: "Opening", final: false } as AgentMessage;
  const listeners = new Set<() => void>();
  const words: AgentWords = {
    read: () => ({ model: { messages: new Map([[said.id, said]]) } }) as never,
    subscribeWords: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const items: ThreadItem[] = [
    { kind: "message", key: "message-3", speaker: "dot", message: said },
  ];
  const view = render(<Conversation items={items} truncated={false} words={words} />);
  expect(view.container.querySelector(".safe-markdown")?.textContent).toBe("Opening");
  now += 100;
  said = { ...said, text: "Opening the sheet" };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(view.container.querySelector(".safe-markdown")?.textContent).toBe("Opening the sheet");
});
