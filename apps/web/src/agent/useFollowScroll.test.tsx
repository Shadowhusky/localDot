// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFollowScroll } from "./useFollowScroll.ts";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function List() {
  const follow = useFollowScroll("task", true);
  return (
    <div ref={follow.ref} data-testid="view">
      <ul />
    </div>
  );
}

// A view 200 px tall over content whose height grows with every row added.
function view() {
  const element = document.querySelector("[data-testid=view]") as HTMLElement;
  const list = element.querySelector("ul") as HTMLElement;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, get: () => 1000 + list.children.length * 40 },
  });
  const add = async () => {
    await act(async () => {
      list.append(document.createElement("li"));
    });
  };
  const end = () => element.scrollHeight - element.clientHeight;
  // The browser scrolls the view, then tells the list.
  const scroll = (top: number) => {
    element.scrollTop = top;
    fireEvent.scroll(element);
  };
  return { element, add, end, scroll };
}

it("holds the end as rows arrive while following it", async () => {
  render(<List />);
  const { element, add } = view();
  element.scrollTop = 800;
  await add();
  expect(element.scrollTop).toBe(840);
});

it("leaves the view where a control taking the focus brought it, before its scroll event", async () => {
  render(<List />);
  const { element, add } = view();
  element.scrollTop = 800;
  await add();
  // Brought up to a control at the top, as focus does; the scroll event comes a frame later.
  element.scrollTop = 0;
  await add();
  expect(element.scrollTop).toBe(0);
});

// A view whose scrolls and gestures go through the hook, as the lists' do.
function Reader({ onGesture }: { onGesture?(): void }) {
  const follow = useFollowScroll("task", true);
  return (
    <>
      <div
        ref={follow.ref}
        data-testid="view"
        onScroll={follow.onScroll}
        {...follow.gestures(onGesture)}
      >
        <ul />
      </div>
      <output data-testid="pinned">{String(follow.pinned)}</output>
      <button type="button" onClick={follow.jump}>
        Jump to latest
      </button>
    </>
  );
}
const following = () => screen.getByTestId("pinned").textContent === "true";

it("stays where the reader scrolls back to in small steps, however fast rows arrive", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  // A trackpad's steps are a few px each: every one is the reader's, and none is undone.
  for (let step = 1; step <= 5; step++) {
    fireEvent.wheel(element, { deltaY: -8 });
    scroll(element.scrollTop - 8);
    await add();
    expect(following()).toBe(false);
    expect(element.scrollTop).toBe(840 - 8 * step);
  }
  await add();
  expect(element.scrollTop).toBe(800);
});

it("stays where a finger drags the list back to, in small steps, as rows arrive", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  fireEvent.touchStart(element, { touches: [{ clientY: 300 }] });
  for (let step = 1; step <= 5; step++) {
    scroll(element.scrollTop - 8);
    await add();
  }
  fireEvent.touchEnd(element, { touches: [], changedTouches: [{ clientY: 340 }] });
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  await add();
  expect(following()).toBe(false);
  expect(element.scrollTop).toBe(800);
});

it("lets a reader who scrolls up stay where they are as rows arrive", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(end() - 56);
  await add();
  expect(following()).toBe(false);
  expect(element.scrollTop).toBe(784);
});

it("never follows the end again for a scroll down the reader did not make", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(end() - 60);
  // A row measured above the view, or an image loading there, shifts it 40 px down.
  scroll(element.scrollTop + 40);
  await add();
  expect(following()).toBe(false);
  expect(element.scrollTop).toBe(820);
});

it("follows again when the reader scrolls back down to the end, as rows arrive meanwhile", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(500);
  expect(following()).toBe(false);
  // Back down toward the end; two rows arrive on the way, so the wheel comes to rest 56 px short.
  fireEvent.wheel(element, { deltaY: 120 });
  await add();
  await add();
  scroll(end() - 56);
  expect(following()).toBe(true);
  await add();
  expect(element.scrollTop).toBe(end());
});

it("stays back when a gesture toward the end comes to rest short of it", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(500);
  fireEvent.wheel(element, { deltaY: 120 });
  scroll(end() - 100);
  await add();
  expect(following()).toBe(false);
  expect(element.scrollTop).toBe(740);
});

it("follows again after a swipe or a key that brings the reader to the end", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  fireEvent.keyDown(element, { key: "PageUp" });
  scroll(400);
  expect(following()).toBe(false);
  // A flick toward the end: what arrives under the finger, or while the list coasts, waits.
  fireEvent.touchStart(element, { touches: [{ clientY: 600 }] });
  scroll(700);
  scroll(end() - 10);
  expect(following()).toBe(true);
  fireEvent.touchEnd(element, { touches: [], changedTouches: [{ clientY: 200 }] });
  await add();
  expect(element.scrollTop).toBe(830);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(element.scrollTop).toBe(end());

  fireEvent.keyDown(element, { key: "ArrowUp" });
  scroll(end() - 200);
  expect(following()).toBe(false);
  fireEvent.keyDown(element, { key: "End" });
  scroll(end());
  expect(following()).toBe(true);
});

it("keeps following through a tap at the end, holding the rows under the finger until it lifts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const taken = vi.fn();
  render(<Reader onGesture={taken} />);
  const { element, add, end, scroll } = view();
  scroll(end());
  fireEvent.touchStart(element, { touches: [{ clientY: 300 }] });
  await add();
  // The row about to be tapped stays where the finger is.
  expect(element.scrollTop).toBe(800);
  fireEvent.touchEnd(element, { touches: [], changedTouches: [{ clientY: 300 }] });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(following()).toBe(true);
  expect(element.scrollTop).toBe(end());
  expect(taken).toHaveBeenCalledOnce();
});

it("keeps following through a wheel down at the end and a click that scrolls nothing", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  fireEvent.wheel(element, { deltaY: 120 });
  await add();
  expect(element.scrollTop).toBe(end());
  fireEvent.pointerDown(element, { pointerId: 1, pointerType: "mouse", button: 0 });
  await add();
  expect(element.scrollTop).toBe(840);
  fireEvent.pointerUp(element, { pointerId: 1, pointerType: "mouse", button: 0 });
  expect(following()).toBe(true);
  expect(element.scrollTop).toBe(end());
  await add();
  expect(element.scrollTop).toBe(end());
});

it("follows again on a wheel down when the end is already in view", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  fireEvent.wheel(element, { deltaY: -40 });
  expect(following()).toBe(false);
  fireEvent.wheel(element, { deltaY: 40 });
  expect(following()).toBe(true);
  await add();
  expect(element.scrollTop).toBe(end());
});

it("stops a jump to the end where it is once the reader scrolls back", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  render(<Reader />);
  const { element, end, scroll } = view();
  scroll(end());
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(100);
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(following()).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  fireEvent.scroll(element);
  const reached = element.scrollTop;
  expect(reached).toBeGreaterThan(100);
  expect(reached).toBeLessThan(end());
  fireEvent.wheel(element, { deltaY: -8 });
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(following()).toBe(false);
  expect(element.scrollTop).toBe(reached);
});

it("lands a jump on the end as it moves", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(100);
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  fireEvent.scroll(element);
  await add();
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  fireEvent.scroll(element);
  expect(following()).toBe(true);
  expect(element.scrollTop).toBe(end());
});
