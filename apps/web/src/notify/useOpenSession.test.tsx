// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LANDING_MS, type OpenSessionProps, useOpenSession } from "./useOpenSession.ts";

const LIVE = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const OTHER = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHK";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function heading(id: string) {
  const element = document.createElement("h2");
  element.id = id;
  element.tabIndex = -1;
  document.body.append(element);
  return element;
}

function setup(initial: Partial<OpenSessionProps> = {}) {
  const select = vi.fn();
  const take = vi.fn(async (_id: string) => true);
  let props: OpenSessionProps = {
    known: false,
    sessionId: null,
    decision: null,
    take,
    select,
    ...initial,
  };
  const hook = renderHook((current: OpenSessionProps) => useOpenSession(current), {
    initialProps: props,
  });
  return {
    select,
    take,
    open: (id: string) => act(() => hook.result.current(id)),
    set: (next: Partial<OpenSessionProps>) => {
      props = { ...props, ...next };
      hook.rerender(props);
    },
  };
}

it("holds a link that arrives while the page opens, then lands on the live task's decision", () => {
  const f = setup();
  f.open(LIVE);
  expect(f.select).not.toHaveBeenCalled();
  f.set({ known: true, sessionId: LIVE });
  expect(f.select).toHaveBeenCalledWith(null);
  const card = heading(`approval-${LIVE}`);
  f.set({ decision: card.id });
  act(() => vi.advanceTimersToNextFrame());
  expect(document.activeElement).toBe(card);
});

it("takes up another task's conversation and lands on its decision, not the one left behind", async () => {
  const left = heading("approval-left");
  const f = setup({ known: true, sessionId: LIVE, decision: left.id });
  f.open(OTHER);
  await act(async () => {});
  expect(f.take).toHaveBeenCalledWith(OTHER);
  expect(f.select).not.toHaveBeenCalled();
  act(() => vi.advanceTimersToNextFrame());
  expect(document.activeElement).not.toBe(left);
  const card = heading("approval-other");
  f.set({ sessionId: OTHER, decision: card.id });
  act(() => vi.advanceTimersToNextFrame());
  expect(document.activeElement).toBe(card);
});

it("waits for the page to settle before taking another task up", () => {
  const f = setup({ known: false, sessionId: LIVE });
  f.open(OTHER);
  expect(f.take).not.toHaveBeenCalled();
  f.set({ known: true });
  expect(f.take).toHaveBeenCalledWith(OTHER);
});

it("opens in Replay a task no conversation can take up", async () => {
  const f = setup({ known: true, sessionId: LIVE, take: vi.fn(async () => false) });
  f.open(OTHER);
  await act(async () => {});
  expect(f.select).toHaveBeenCalledWith(OTHER);
});

it("focuses a decision already on show, and none that turns up long after the tap", () => {
  const card = heading("ask-1");
  const f = setup({ known: true, sessionId: LIVE, decision: card.id });
  f.open(LIVE);
  act(() => vi.advanceTimersToNextFrame());
  expect(document.activeElement).toBe(card);
  card.blur();
  f.set({ decision: null });
  f.open(LIVE);
  vi.advanceTimersByTime(LANDING_MS + 1);
  const late = heading("approval-2");
  f.set({ decision: late.id });
  act(() => vi.advanceTimersToNextFrame());
  expect(document.activeElement).not.toBe(late);
});
