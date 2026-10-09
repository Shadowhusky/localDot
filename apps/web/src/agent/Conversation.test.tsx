// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation.tsx";
import { OPENING_ROWS } from "./earlier.ts";
import type { AgentMessage, AgentQuestion } from "./model.ts";
import { Outbox } from "./outbox.ts";
import { threadItems } from "./thread.ts";

const spoken = vi.hoisted(() => ({ announce: vi.fn(), withdraw: vi.fn() }));
vi.mock("../ui/Announcer.tsx", () => spoken);

beforeEach(() => {
  spoken.announce.mockClear();
  spoken.withdraw.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const message = (id: string, text = "Same message", role: "user" | "assistant" = "user") =>
  ({ id, role, text, final: true }) as AgentMessage;
const items = (messages: AgentMessage[], questions: AgentQuestion[] = []) =>
  threadItems(messages, questions);
const history = () => screen.getByRole("region", { name: "Conversation history" });
// `threadEnd` is where the thread's last row ends; below it there is only the foot.
function scrolled(top: number, height = 1000, view = 200, threadEnd = height) {
  const scroller = history().closest(".thread-scroll") as HTMLElement;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: height },
    clientHeight: { configurable: true, value: view },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: view }) as DOMRect;
  history().getBoundingClientRect = () => ({ top: -top, bottom: threadEnd - top }) as DOMRect;
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
  return scroller;
}

describe("the conversation thread", () => {
  it("shows you in a bubble and dot under its name once per run of its messages", () => {
    render(
      <Conversation
        items={items([
          message("one", "Draw a dog"),
          message("two", "Opening the paint app.", "assistant"),
          message("three", "Drawing the ears now.", "assistant"),
          message("four", "Make it brown"),
        ])}
        truncated={false}
      />,
    );
    const rows = [...document.querySelectorAll(".thread-row")];
    expect(rows.map((row) => row.getAttribute("data-speaker"))).toEqual([
      "user",
      "dot",
      "dot",
      "user",
    ]);
    expect(rows.map((row) => row.hasAttribute("data-group-start"))).toEqual([
      true,
      true,
      false,
      true,
    ]);
    expect(document.querySelectorAll(".thread-who")).toHaveLength(1);
    expect(rows[0]?.querySelector(".thread-bubble")?.textContent).toBe("Draw a dog");
    expect(rows[1]?.querySelector(".thread-bubble")).toBeNull();
  });

  it("shows files sent with your message as chips, and when a message was sent", () => {
    render(
      <Conversation
        items={items([
          {
            ...message(
              "one",
              "Read both files\n\nAttached files on this computer:\n- ~/Downloads/one.txt\n- ~/Downloads/two.csv",
            ),
            kind: "steer",
          },
          { ...message("two", "Then tidy up"), kind: "followup", queued: true },
          { ...message("three", "One more"), kind: "followup" },
        ])}
        truncated={false}
      />,
    );
    const [first, second, third] = document.querySelectorAll(".thread-message");
    expect(first?.querySelector(".thread-bubble")?.textContent).toBe("Read both files");
    expect(
      within(first as HTMLElement).getByRole("list", { name: "Attached files" }).textContent,
    ).toBe("one.txttwo.csv");
    expect(first?.textContent).not.toContain("Attached files on this computer");
    expect(first?.querySelector(".thread-tag")?.textContent).toBe("Sent while working");
    expect(second?.querySelector(".thread-tag")?.textContent).toBe("After this task");
    expect(third?.querySelector(".thread-tag")).toBeNull();
  });

  it("keeps the slot a sending message waits in right after the empty prompt, which it then hides", () => {
    render(<Conversation items={[]} truncated={false} />);
    expect(document.querySelector(".thread-empty + .thread-outbox")).not.toBeNull();
  });

  it("keeps a streaming message in place as its text grows and when it finishes", () => {
    const writing = { ...message("reply", "Look", "assistant"), final: false };
    const view = render(<Conversation items={items([writing])} truncated={false} />);
    const article = screen.getByText("Look").closest("article");
    expect(article?.hasAttribute("data-streaming")).toBe(true);
    view.rerender(
      <Conversation
        items={items([{ ...writing, text: "Looking at the totals.", final: true }])}
        truncated={false}
      />,
    );
    expect(screen.getByText("Looking at the totals.").closest("article")).toBe(article);
    expect(article?.hasAttribute("data-streaming")).toBe(false);
  });

  it("copies a message after a press, shows a check for a moment, and never copies a key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <Conversation
        items={items([message("one", "可见 text"), message("two", `sk-proj-${"a".repeat(156)}`)])}
        truncated={false}
      />,
    );
    expect(writeText).not.toHaveBeenCalled();
    const [plain, key] = screen.getAllByRole("button", { name: "Copy your message" });
    expect(key?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(key as HTMLElement);
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(plain as HTMLElement));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("可见 text");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(spoken.announce).toHaveBeenLastCalledWith("thread", "Copied.");
    await act(async () => vi.advanceTimersByTime(1600));
    expect(screen.getAllByRole("button", { name: "Copy your message" })).toHaveLength(2);
  });

  it("asks a question as dot and shows your answer as your own message under it", () => {
    const question: AgentQuestion = {
      askId: "ask",
      seq: 3,
      question: "Which format?",
      options: [{ key: "A", text: "Markdown" }],
      allowText: true,
      answer: { askId: "ask", by: "user", option: "A", text: "With headings" },
    };
    render(
      <Conversation
        items={items(
          [
            { ...message("one", "Write it up"), seq: 1 },
            { ...message("two", "Done.", "assistant"), seq: 9 },
          ],
          [question],
        )}
        truncated={false}
      />,
    );
    const rows = [...document.querySelectorAll(".thread-row")];
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
      "message",
      "question",
      "answer",
      "message",
    ]);
    expect(within(rows[1] as HTMLElement).getByText("Which format?")).toBeTruthy();
    expect(rows[2]?.querySelector(".thread-bubble")?.textContent).toBe("Markdown\n\nWith headings");
    expect(document.querySelectorAll("form,input,textarea")).toHaveLength(0);
  });

  it("offers the newest messages after the reader scrolls back, counting what arrived", () => {
    const view = render(<Conversation items={items([message("one")])} truncated={false} />);
    const jump = () => document.querySelector(".thread-jump") as HTMLElement;
    expect(jump().hasAttribute("data-shown")).toBe(false);
    scrolled(100);
    expect(jump().hasAttribute("data-shown")).toBe(true);
    expect(within(jump()).getByRole("button", { name: "Jump to latest" })).toBeTruthy();
    view.rerender(
      <Conversation
        items={items([message("one"), message("two", "New arrival", "assistant")])}
        truncated={false}
      />,
    );
    expect(within(jump()).getByRole("button", { name: "1 new message" }).textContent).toBe("1 new");
    scrolled(800);
    expect(jump().hasAttribute("data-shown")).toBe(false);
  });

  it("names what arrived while the reader was away: one kind by its name, a mix as updates", () => {
    const question: AgentQuestion = {
      askId: "ask",
      question: "Which format?",
      options: [{ key: "A", text: "Markdown" }],
      allowText: false,
    };
    const view = render(<Conversation items={items([message("one")])} truncated={false} />);
    const jump = () => document.querySelector(".thread-jump") as HTMLElement;
    scrolled(100);
    view.rerender(<Conversation items={items([message("one")], [question])} truncated={false} />);
    expect(within(jump()).getByRole("button", { name: "1 new question" }).textContent).toBe(
      "1 new",
    );
    view.rerender(
      <Conversation
        items={items([message("one"), message("two", "Here it is", "assistant")], [question])}
        truncated={false}
      />,
    );
    expect(within(jump()).getByRole("button", { name: "2 new updates" })).toBeTruthy();
  });

  it("brings the end, where your message waits, into view from a page of earlier messages", () => {
    const data = Array.from({ length: 260 }, (_, n) => message(`message-${n}`, `Content ${n}`));
    function Sender() {
      const outbox = useContext(Outbox);
      return (
        <button type="button" onClick={() => outbox?.show()}>
          Send
        </button>
      );
    }
    render(<Conversation items={items(data)} truncated={false} composer={<Sender />} />);
    const scroller = history().closest(".thread-scroll") as HTMLElement;
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    fireEvent.click(screen.getByRole("button", { name: "Older messages" }));
    expect(screen.getByText("Loading later…")).toBeTruthy();
    const outbox = history().querySelector(".thread-outbox");
    expect(outbox?.closest("[hidden]")).toBeNull();
    expect(outbox?.previousElementSibling?.textContent).toBe("Loading later…");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByText("Loading later…")).toBeNull();
    expect(screen.getByText("Content 259")).toBeTruthy();
    expect(scrollTo).toHaveBeenCalled();
  });

  it("turns the jump button into the way to a message's choice while one waits", () => {
    const reach = vi.fn();
    function Waiting() {
      const outbox = useContext(Outbox);
      useEffect(() => {
        outbox?.needs(reach);
        return () => outbox?.needs(null);
      }, [outbox]);
      return null;
    }
    const view = render(
      <Conversation items={items([message("one")])} truncated={false} composer={<Waiting />} />,
    );
    const jump = () => document.querySelector(".thread-jump") as HTMLElement;
    scrolled(100);
    const check = within(jump()).getByRole("button", { name: "Check your last message" });
    fireEvent.click(check);
    expect(reach).toHaveBeenCalledOnce();
    view.rerender(<Conversation items={items([message("one")])} truncated={false} />);
    expect(within(jump()).getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("offers nothing to jump to when only the composer lies past the view", () => {
    render(<Conversation items={items([message("one")])} truncated={false} />);
    const jump = () => document.querySelector(".thread-jump") as HTMLElement;
    scrolled(500, 1000, 200, 650);
    expect(jump().hasAttribute("data-shown")).toBe(false);
    expect(jump().hasAttribute("inert")).toBe(true);
    scrolled(400, 1000, 200, 650);
    expect(jump().hasAttribute("data-shown")).toBe(true);
  });
});

it("mounts a bounded window of 10,000 messages and keeps the reader's rows through a live addition", () => {
  const data = Array.from({ length: 10_000 }, (_, n) => message(`message-${n}`, `Content ${n}`));
  const v = render(<Conversation items={items(data)} truncated={false} ownerKey="large-task" />);
  expect(history().querySelectorAll("article.thread-message")).toHaveLength(OPENING_ROWS);
  fireEvent.click(screen.getByRole("button", { name: "Older messages" }));
  const kept = screen.getByText("Content 9960").closest("article");
  expect(screen.getByText("Content 9940")).toBeTruthy();
  v.rerender(
    <Conversation
      items={items([...data, message("new", "Newest content")])}
      truncated={false}
      ownerKey="large-task"
    />,
  );
  expect(screen.getByText("Content 9960").closest("article")).toBe(kept);
  expect(history().querySelectorAll("article.thread-message")).toHaveLength(OPENING_ROWS);
  expect(screen.queryByText("Newest content")).toBeNull();
  // Each move keeps half the window, so two reach the newest end.
  fireEvent.click(screen.getByRole("button", { name: "Newer messages" }));
  expect(screen.queryByText("Newest content")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Newer messages" }));
  expect(screen.getByText("Newest content")).toBeTruthy();
  expect(history().querySelectorAll("article.thread-message")).toHaveLength(OPENING_ROWS);
});

it("announces completed replies without reading each streaming delta", () => {
  const reply = (text: string, final: boolean): AgentMessage => ({
    id: "reply",
    role: "assistant",
    text,
    final,
  });
  const v = render(<Conversation items={items([reply("First", false)])} truncated={false} />);
  v.rerender(<Conversation items={items([reply("First second", false)])} truncated={false} />);
  expect(spoken.announce).not.toHaveBeenCalled();
  v.rerender(
    <Conversation items={items([reply("First second complete", true)])} truncated={false} />,
  );
  expect(spoken.announce).toHaveBeenCalledExactlyOnceWith(
    "thread",
    "dot replied: First second complete",
  );
  v.rerender(
    <Conversation
      items={items([
        reply("First second complete", true),
        { ...reply("New streaming text", false), id: "next" },
      ])}
      truncated={false}
    />,
  );
  expect(spoken.announce).toHaveBeenCalledOnce();
});

it("says nothing while the conversation is out of view", () => {
  render(
    <Conversation
      items={items([message("reply", "Done.", "assistant")])}
      truncated={false}
      visible={false}
    />,
  );
  expect(spoken.announce).not.toHaveBeenCalled();
});

it("retires the previous task's reply announcement when the conversation owner changes", () => {
  const reply = message("previous-reply", "Previous task result", "assistant");
  const v = render(<Conversation items={items([reply])} truncated={false} ownerKey="first-task" />);
  expect(spoken.announce).toHaveBeenLastCalledWith("thread", "dot replied: Previous task result");
  expect(spoken.withdraw).not.toHaveBeenCalled();
  v.rerender(<Conversation items={[]} truncated={false} ownerKey="second-task" />);
  expect(spoken.withdraw).toHaveBeenCalledExactlyOnceWith("thread");
  // The thread has no live region of its own; the page's one is the Announcer's.
  expect(screen.queryByRole("status")).toBeNull();
});

it("says earlier history lives in the task log when the projection dropped it", () => {
  render(<Conversation items={items([message("one")])} truncated />);
  expect(screen.getByText("Earlier messages are kept in the task log.")).toBeTruthy();
});

it("says the conversation's older tasks are in Replay", () => {
  render(<Conversation items={items([message("one")])} truncated earlierInReplay />);
  expect(screen.getByText("Earlier messages are in Replay.")).toBeTruthy();
  expect(screen.queryByText("Earlier messages are kept in the task log.")).toBeNull();
});

describe("opening on a snapshot", () => {
  const newRows = () => [...history().querySelectorAll(".thread-row[data-new]")];
  it("shows message-shaped bones while the history arrives, then all of it at once and unanimated", () => {
    const opened = [message("one", "Draw a dog"), message("two", "Drew it.", "assistant")];
    const view = render(<Conversation items={[]} truncated={false} ownerKey="task" loading />);
    expect(history().querySelectorAll(".thread-bone")).toHaveLength(8);
    expect(screen.getByRole("status").textContent).toBe("Loading the conversation");
    expect(screen.queryByText("What should we do?")).toBeNull();
    view.rerender(
      <Conversation items={items(opened.slice(0, 1))} truncated={false} ownerKey="task" loading />,
    );
    expect(screen.queryByText("Draw a dog")).toBeNull();
    view.rerender(<Conversation items={items(opened)} truncated={false} ownerKey="task" />);
    expect(history().querySelectorAll(".thread-bone")).toHaveLength(0);
    expect(screen.getByText("Draw a dog")).toBeTruthy();
    expect(newRows()).toEqual([]);
    // Only what arrives after it eases in.
    view.rerender(
      <Conversation
        items={items([...opened, message("three", "Make it blue")])}
        truncated={false}
        ownerKey="task"
      />,
    );
    expect(newRows().map((row) => row.textContent)).toEqual(["Make it blue"]);
  });

  it("asks for the conversation's earlier tasks from the top once the page has no older rows", () => {
    const older = vi.fn();
    const view = render(
      <Conversation
        items={items([message("one")])}
        truncated={false}
        earlier={{ more: true, reading: false, older }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Older messages" }));
    expect(older).toHaveBeenCalledOnce();
    view.rerender(
      <Conversation
        items={items([message("one")])}
        truncated={false}
        earlier={{ more: true, reading: true, older }}
      />,
    );
    expect(screen.getByRole("img", { name: "Loading earlier messages" })).toBeTruthy();
    view.rerender(
      <Conversation
        items={items([message("one")])}
        truncated={false}
        earlierInReplay
        earlier={{ more: false, reading: false, older }}
      />,
    );
    expect(document.querySelector(".thread-older")).toBeNull();
    expect(screen.getByText("Earlier messages are in Replay.")).toBeTruthy();
  });
});
