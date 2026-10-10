// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
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
