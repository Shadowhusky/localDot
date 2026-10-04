// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation.tsx";
import type { AgentMessage } from "./model.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const message = (id: string, text = "Same message"): AgentMessage => ({
  id,
  role: "user",
  text,
  final: true,
});
describe("conversation ownership and scrolling", () => {
  it.each([true, false])(
    "reconciles hidden updates on return without moving a reader who scrolled up (bottom=%s)",
    (bottom) => {
      const messages = [message("one")];
      const view = render(<Conversation messages={messages} truncated={false} />);
      const history = screen.getByRole("region", { name: "Conversation history" });
      Object.defineProperties(history, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 200 },
      });
      history.scrollTop = bottom ? 800 : 100;
      fireEvent.scroll(history);
      view.rerender(<Conversation messages={messages} truncated={false} visible={false} />);
      Object.defineProperties(history, {
        scrollHeight: { configurable: true, value: 0 },
        clientHeight: { configurable: true, value: 0 },
      });
      fireEvent.scroll(history); // A hidden layout must not overwrite the reader's remembered intent.
      const changed = [...messages, message("two")];
      view.rerender(<Conversation messages={changed} truncated={false} visible={false} />);
      expect(history.scrollTop).toBe(bottom ? 800 : 100);
      Object.defineProperties(history, {
        scrollHeight: { configurable: true, value: 1400 },
        clientHeight: { configurable: true, value: 200 },
      });
      view.rerender(<Conversation messages={changed} truncated={false} visible />);
      if (bottom) {
        expect(history.scrollTop).toBe(1400);
        expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
      } else {
        expect(history.scrollTop).toBe(100);
        expect(screen.getByRole("button", { name: "New messages" })).toBeTruthy();
      }
    },
  );
  it("keeps identical messages separate and replaces the same assistant's streaming content", () => {
    const messages = [
      message("one"),
      message("two"),
      { ...message("assistant", "writing"), role: "assistant" as const, final: false },
    ];
    const view = render(<Conversation messages={messages} truncated={false} />);
    expect(screen.getAllByText("Same message")).toHaveLength(2);
    const assistant = screen.getByText("writing").closest("article");
    view.rerender(
      <Conversation
        messages={[
          messages[0] as AgentMessage,
          messages[1] as AgentMessage,
          { ...message("assistant", "Finished"), role: "assistant", final: true },
        ]}
        truncated={false}
      />,
    );
    expect(screen.getByText("Finished").closest("article")).toBe(assistant);
    expect(screen.queryByText("writing")).toBeNull();
  });
  it("preserves a reader's scroll position and offers an explicit return to new messages", () => {
    const view = render(<Conversation messages={[message("one")]} truncated={false} />);
    const history = screen.getByRole("region", { name: "Conversation history" });
    Object.defineProperties(history, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    history.scrollTop = 100;
    fireEvent.scroll(history);
    view.rerender(
      <Conversation messages={[message("one"), message("two", "New arrival")]} truncated={false} />,
    );
    expect(history.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "New messages" }));
    expect(history.scrollTop).toBe(1000);
    view.rerender(
      <Conversation
        messages={[message("one"), message("two"), message("three")]}
        truncated={false}
      />,
    );
    expect(history.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
  });
  it("copies only the displayed bounded non-key-shaped text after user activation", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <Conversation
        messages={[
          message("one", "可见 text"),
          message("two", `sk-proj-${"a".repeat(156)}`),
          message("three", "x".repeat(8001)),
        ]}
        truncated={true}
      />,
    );
    expect(writeText).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Copy your message" });
    fireEvent.click(buttons[0] as HTMLElement);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("可见 text");
    fireEvent.click(buttons[1] as HTMLElement);
    fireEvent.click(buttons[2] as HTMLElement);
    expect(writeText).toHaveBeenCalledOnce();
    expect(await screen.findByText("Message copied.")).toBeTruthy();
    expect(screen.getByText(/Earlier history is kept/)).toBeTruthy();
  });
});

it("mounts only a bounded page of 10,000 messages and keeps reading/copy identity through a live addition", () => {
  const data = Array.from({ length: 10_000 }, (_, n) => message(`message-${n}`, `Content ${n}`));
  const v = render(<Conversation messages={data} truncated={false} ownerKey="large-task" />);
  const history = screen.getByRole("region", { name: "Conversation history" });
  expect(history.querySelectorAll("article.message")).toHaveLength(100);
  fireEvent.click(screen.getByRole("button", { name: "Older messages" }));
  const retained = screen.getByText("Content 9800").closest("article");
  v.rerender(
    <Conversation
      messages={[...data, message("new", "Newest content")]}
      truncated={false}
      ownerKey="large-task"
    />,
  );
  expect(screen.getByText("Content 9800").closest("article")).toBe(retained);
  expect(history.querySelectorAll("article.message")).toHaveLength(100);
  expect(screen.queryByText("Newest content")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New messages" }));
  expect(screen.getByText("Newest content")).toBeTruthy();
  expect(history.querySelectorAll("article.message")).toHaveLength(100);
});

it("announces completed replies without reading each streaming delta", async () => {
  const reply = (text: string, final: boolean): AgentMessage => ({
    id: "reply",
    role: "assistant",
    text,
    final,
  });
  const v = render(<Conversation messages={[reply("First", false)]} truncated={false} />);
  const live = screen.getByRole("status");
  expect(live.textContent).toBe("");
  v.rerender(<Conversation messages={[reply("First second", false)]} truncated={false} />);
  expect(live.textContent).toBe("");
  v.rerender(<Conversation messages={[reply("First second complete", true)]} truncated={false} />);
  expect(live.textContent).toBe("dot replied: First second complete");
  v.rerender(
    <Conversation
      messages={[
        reply("First second complete", true),
        { ...reply("New streaming text", false), id: "next" },
      ]}
      truncated={false}
    />,
  );
  expect(live.textContent).toBe("dot replied: First second complete");
});

it("retires the previous task's reply announcement when the conversation owner changes", () => {
  const reply: AgentMessage = {
    id: "previous-reply",
    role: "assistant",
    text: "Previous task result",
    final: true,
  };
  const v = render(<Conversation messages={[reply]} truncated={false} ownerKey="first-task" />);
  expect(screen.getByRole("status").textContent).toBe("dot replied: Previous task result");
  v.rerender(<Conversation messages={[]} truncated={false} ownerKey="second-task" />);
  expect(screen.getByRole("status").textContent).toBe("");
});
