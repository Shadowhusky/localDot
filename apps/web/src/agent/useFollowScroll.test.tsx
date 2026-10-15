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
});

function List() {
  const follow = useFollowScroll("task", true, { glide: false });
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
  return { element, add };
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

// A view whose scrolls go through the hook, as the conversation's do.
function Reader() {
  const follow = useFollowScroll("task", true, { glide: false });
  return (
    <div
      ref={follow.ref}
      data-testid="view"
      onScroll={() => follow.onScroll()}
      onWheel={(event) => (event.deltaY > 0 ? follow.resume() : follow.interrupt())}
      onPointerDown={() => follow.interrupt()}
      onPointerUp={() => follow.resume()}
    >
      <ul />
      <output data-testid="pinned">{String(follow.pinned)}</output>
    </div>
  );
}

it("follows again when the reader scrolls back down while rows arrive, landing just short of the end", async () => {
  render(<Reader />);
  const { element, add } = view();
  element.scrollTop = 800;
  await add();
  // Up to read an earlier message: no longer following.
  fireEvent.wheel(element, { deltaY: -120 });
  element.scrollTop = 500;
  fireEvent.scroll(element);
  expect(screen.getByTestId("pinned").textContent).toBe("false");
  // Back down to the end, while two rows arrive: the reader comes to rest 56 px short of it.
  await add();
  await add();
  fireEvent.wheel(element, { deltaY: 120 });
  element.scrollTop = element.scrollHeight - element.clientHeight - 56;
  fireEvent.scroll(element);
  expect(screen.getByTestId("pinned").textContent).toBe("true");
  await add();
  expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
});

it("lets a reader who scrolls up stay where they are as rows arrive", async () => {
  render(<Reader />);
  const { element, add } = view();
  element.scrollTop = 800;
  await add();
  fireEvent.wheel(element, { deltaY: -120 });
  element.scrollTop = element.scrollHeight - element.clientHeight - 56;
  fireEvent.scroll(element);
  await add();
  expect(screen.getByTestId("pinned").textContent).toBe("false");
  expect(element.scrollTop).toBe(784);
});

it("keeps following through a wheel down at the end and a click that scrolls nothing", async () => {
  render(<Reader />);
  const { element, add } = view();
  element.scrollTop = 800;
  await add();
  fireEvent.wheel(element, { deltaY: 120 });
  await add();
  expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
  fireEvent.pointerDown(element);
  fireEvent.pointerUp(element);
  await add();
  expect(screen.getByTestId("pinned").textContent).toBe("true");
  expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
});
