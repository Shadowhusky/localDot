// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
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

it("stays at the end when shorter content and a taller foot arrive in one frame", async () => {
  render(<List />);
  const { element, add, end } = view();
  element.scrollTop = 800;
  await add();
  await add();
  expect(element.scrollTop).toBe(end());
  // A row leaves as the foot under the list grows: the browser clamps the view to the shorter
  // content, and the list then finds itself further from an end the foot has moved.
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
  await act(async () => {
    element.querySelector("li")?.remove();
    element.scrollTop -= 40;
  });
  expect(element.scrollTop).toBe(end());
  await add();
  expect(element.scrollTop).toBe(end());
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

it("follows what a tap unfolds from its first frame, not once the wait for a flick is over", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  fireEvent.touchStart(element, { touches: [{ clientY: 300 }] });
  fireEvent.touchEnd(element, { touches: [], changedTouches: [{ clientY: 300 }] });
  fireEvent.click(element);
  await add();
  expect(element.scrollTop).toBe(end());
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

// A view whose run of steps the reader unfolds.
function Unfolding({ bottom }: { bottom?: number }) {
  const follow = useFollowScroll("task", true);
  const run = useRef<HTMLLIElement>(null);
  return (
    <>
      <div ref={follow.ref} data-testid="view" onScroll={follow.onScroll} {...follow.gestures()}>
        <ul>
          <li ref={run} />
        </ul>
      </div>
      <output data-testid="pinned">{String(follow.pinned)}</output>
      <button type="button" onClick={() => run.current && follow.show(run.current, 16, bottom)}>
        Unfold
      </button>
    </>
  );
}

// The run sits `at` px down the content, `height` px tall (as the time finds it while it unfolds),
// in the 200 px view at the top of the page; the reader has scrolled to 500.
function unfolding(at: number, height: number | ((ms: number) => number), bottom?: number) {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  render(<Unfolding bottom={bottom} />);
  const { element, scroll } = view();
  const run = element.querySelector("li") as HTMLElement;
  const start = performance.now();
  const box = () => {
    const tall = typeof height === "number" ? height : height(performance.now() - start);
    const top = at - element.scrollTop;
    return { top, bottom: top + tall, height: tall } as DOMRect;
  };
  element.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  run.getBoundingClientRect = box;
  scroll(500);
  const frames = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };
  fireEvent.click(screen.getByRole("button", { name: "Unfold" }));
  return { element, frames };
}

it("brings an unfolded run's end into view, eased, and no further", async () => {
  // Its head 150 px down the view, its end 70 px past the view's bottom.
  const { element, frames } = unfolding(650, 120);
  await frames(100);
  expect(element.scrollTop).toBeGreaterThan(500);
  expect(element.scrollTop).toBeLessThan(586);
  await frames(1000);
  // The end 16 px inside the view's bottom.
  expect(element.scrollTop).toBe(586);
  expect(following()).toBe(false);
});

it("brings a run's end up clear of what lies over the view's bottom", async () => {
  const { element, frames } = unfolding(650, 120, 60);
  await frames(1000);
  expect(element.scrollTop).toBe(630);
});

it("keeps the head of a run taller than the view in view", async () => {
  const { element, frames } = unfolding(650, 400);
  await frames(1500);
  // Its head 16 px inside the view's top, the rest under it.
  expect(element.scrollTop).toBe(634);
});

it("leaves the view where it is when nothing of the run is hidden", async () => {
  const { element, frames } = unfolding(520, 100);
  await frames(1500);
  expect(element.scrollTop).toBe(500);
});

it("follows a run down as it unfolds, until it has", async () => {
  const { element, frames } = unfolding(650, (ms) => Math.min(120, (ms / 470) * 120));
  await frames(200);
  const midway = element.scrollTop;
  expect(midway).toBeGreaterThan(500);
  expect(midway).toBeLessThan(586);
  await frames(1500);
  expect(element.scrollTop).toBe(586);
});

it("jumps to an unfolded run's end under reduced motion", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
  const { element, frames } = unfolding(650, 120);
  await frames(20);
  expect(element.scrollTop).toBe(586);
});

it("stops bringing a run into view once the reader scrolls back", async () => {
  const { element, frames } = unfolding(650, 120);
  await frames(100);
  fireEvent.wheel(element, { deltaY: -8 });
  const left = element.scrollTop;
  await frames(1500);
  expect(element.scrollTop).toBe(left);
});

it("stops bringing a run into view when the reader wheels on toward it too", async () => {
  const { element, frames } = unfolding(650, 120);
  await frames(100);
  fireEvent.wheel(element, { deltaY: 8 });
  const left = element.scrollTop;
  await frames(1500);
  expect(element.scrollTop).toBe(left);
});

it("stops bringing a run into view when a key scrolls the list", async () => {
  const { element, frames } = unfolding(650, 120);
  await frames(100);
  fireEvent.keyDown(element, { key: "ArrowDown" });
  const left = element.scrollTop;
  await frames(1500);
  expect(element.scrollTop).toBe(left);
});

it("brings a head above the view's top down into view", async () => {
  // Its head 5 px down the view, under the fade along the top.
  const { element, frames } = unfolding(505, 40);
  await frames(100);
  expect(element.scrollTop).toBeLessThan(500);
  await frames(1000);
  expect(element.scrollTop).toBe(489);
});

it("sees an element in a list of its own only as far as the list shows it", async () => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"],
  });
  function Nested() {
    const follow = useFollowScroll("task", true);
    const list = useRef<HTMLDivElement>(null);
    const row = useRef<HTMLDivElement>(null);
    return (
      <div ref={follow.ref} data-testid="view">
        <ul />
        <div ref={list} data-testid="list">
          <div ref={row} data-testid="row" />
        </div>
        <button
          type="button"
          onClick={() => row.current && follow.show(row.current, 16, 16, list.current)}
        >
          Unfold
        </button>
      </div>
    );
  }
  render(<Nested />);
  const { element } = view();
  element.scrollTop = 500;
  element.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  // The list ends 40 px past the view's bottom; the row runs a long way past that, inside it.
  screen.getByTestId("list").getBoundingClientRect = () =>
    ({ top: 600 - element.scrollTop, bottom: 740 - element.scrollTop }) as DOMRect;
  screen.getByTestId("row").getBoundingClientRect = () =>
    ({ top: 650 - element.scrollTop, bottom: 1400 - element.scrollTop, height: 750 }) as DOMRect;
  fireEvent.click(screen.getByRole("button", { name: "Unfold" }));
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(element.scrollTop).toBe(556);
});

it("holds what the reader pressed while what lies above it folds", async () => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"],
  });
  function Accordion() {
    const follow = useFollowScroll("task", true);
    const row = useRef<HTMLDivElement>(null);
    return (
      <div ref={follow.ref} data-testid="view">
        <ul />
        <div ref={row} data-testid="row" />
        <button
          type="button"
          onClick={() => {
            if (!row.current) return;
            follow.anchorTo(row.current);
            follow.show(row.current, 16);
          }}
        >
          Unfold
        </button>
      </div>
    );
  }
  render(<Accordion />);
  const { element } = view();
  element.scrollTop = 500;
  element.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const start = performance.now();
  // 200 px folds away above the row over 300 ms, with the row itself staying 60 px tall.
  const at = () => 600 - Math.min(200, ((performance.now() - start) / 300) * 200);
  const row = screen.getByTestId("row");
  Object.defineProperty(row, "offsetTop", { configurable: true, get: at });
  row.getBoundingClientRect = () => {
    const top = at() - element.scrollTop;
    return { top, bottom: top + 60, height: 60 } as DOMRect;
  };
  fireEvent.click(screen.getByRole("button", { name: "Unfold" }));
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  // Within what folds between two frames.
  expect(Math.abs(row.getBoundingClientRect().top - 100)).toBeLessThan(12);
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(element.scrollTop).toBeCloseTo(300);
  expect(row.getBoundingClientRect().top).toBeCloseTo(100);
});

// A reader above the end, over rows whose place and height the test sets: [top in the content, height].
function Rows({ count, whole }: { count: number; whole?: () => boolean }) {
  const follow = useFollowScroll("task", true, whole);
  return (
    <div ref={follow.ref} data-testid="view" onScroll={follow.onScroll} {...follow.gestures()}>
      <ul>
        {Array.from({ length: count }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows, placed by the test.
          <li key={index} data-anchor="" />
        ))}
      </ul>
    </div>
  );
}

function placed(rows: [number, number][]) {
  const { element, scroll, end } = view();
  const items = [...element.querySelectorAll("li")];
  element.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const place = () => {
    items.forEach((item, index) => {
      const [top, height] = rows[index] ?? [0, 0];
      Object.defineProperties(item, {
        offsetTop: { configurable: true, value: top },
        offsetHeight: { configurable: true, value: height },
      });
      item.getBoundingClientRect = () =>
        ({ top: top - element.scrollTop, bottom: top + height - element.scrollTop }) as DOMRect;
    });
  };
  place();
  // What an animation does before the frame's callbacks; the hook hears of it after them.
  const drift = (next: [number, number][]) => {
    rows.splice(0, rows.length, ...next);
    place();
  };
  const change = async (next: [number, number][]) => {
    drift(next);
    await act(async () => {
      element.querySelector("ul")?.append(document.createTextNode(""));
    });
  };
  return { element, scroll, end, drift, change };
}

const frame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

it("keeps what the reader sees when the row their view starts inside folds away above it", async () => {
  render(<Rows count={2} />);
  const { element, scroll, change } = placed([
    [0, 600],
    [600, 100],
  ]);
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(500);
  await frame();
  // The first row, its top above the view, folds from 600 to 60; the next row comes up with it.
  await change([
    [0, 60],
    [60, 100],
  ]);
  expect(element.scrollTop).toBe(-40);
});

it("leaves the view alone when the row it starts inside grows", async () => {
  render(<Rows count={2} />);
  const { element, scroll, change } = placed([
    [0, 600],
    [600, 100],
  ]);
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(500);
  await frame();
  await change([
    [0, 700],
    [700, 100],
  ]);
  expect(element.scrollTop).toBe(500);
});

it("goes from where the reader was when rows leaving above leave the view past the new end", async () => {
  render(<Rows count={2} />);
  const { element, scroll, change } = placed([
    [1000, 100],
    [1100, 100],
  ]);
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(1050);
  await frame();
  // The browser has clamped the view to the shorter content before the hook hears of it.
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 600 });
  element.scrollTop = 400;
  await change([
    [300, 100],
    [400, 100],
  ]);
  // The anchor came up 700: the reader's 1050 goes to 350, not the clamped 400 to -300.
  expect(element.scrollTop).toBe(350);
});

it("goes from where the reader was when rows leave above a finger at the end", async () => {
  render(<Rows count={2} />);
  const { element, scroll, change } = placed([
    [1000, 100],
    [1100, 100],
  ]);
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1250 });
  scroll(1050);
  fireEvent.touchStart(element, { touches: [{ clientY: 300 }] });
  // Still following as the finger comes down; the browser clamps the view to the shorter content.
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 600 });
  element.scrollTop = 400;
  await change([
    [300, 100],
    [400, 100],
  ]);
  expect(element.scrollTop).toBe(350);
});

it("holds what the reader sees through every frame of a fold above it", async () => {
  render(<Rows count={2} />);
  const { element, scroll, drift, change } = placed([
    [0, 700],
    [700, 100],
  ]);
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(750);
  await frame();
  await change([
    [0, 690],
    [690, 100],
  ]);
  expect(element.scrollTop).toBe(740);
  // The scroll event of that move, then the fold's next step by the time of the frame's callbacks.
  fireEvent.scroll(element);
  drift([
    [0, 680],
    [680, 100],
  ]);
  await frame();
  await change([
    [0, 680],
    [680, 100],
  ]);
  expect(element.scrollTop).toBe(730);
});

it("follows no end that is only the end of a page of rows", async () => {
  let whole = false;
  render(<Rows count={1} whole={() => whole} />);
  const { element, end, scroll } = placed([[0, 100]]);
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(100);
  fireEvent.wheel(element, { deltaY: 120 });
  scroll(end());
  expect(element.scrollTop).toBe(end());
  // Nothing brought the reader back: a row arriving does not pull the view along.
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 2000 });
  await act(async () => {
    element.querySelector("ul")?.append(document.createTextNode(""));
  });
  expect(element.scrollTop).toBeLessThan(end());
  whole = true;
  fireEvent.wheel(element, { deltaY: 120 });
  scroll(end());
  expect(element.scrollTop).toBe(end());
});

it("reads nothing and moves nothing while the list is out of the page", async () => {
  render(<Rows count={1} />);
  const { element, scroll, change } = placed([[500, 100]]);
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(450);
  await frame();
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 0 });
  await change([[0, 0]]);
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 200 });
  await change([[500, 100]]);
  expect(element.scrollTop).toBe(450);
});

it("still follows when content that shortened under the end has grown back by the time it hears", async () => {
  render(<List />);
  const { element, add, end } = view();
  element.scrollTop = end();
  await add();
  expect(element.scrollTop).toBe(end());
  // Rows left above and the browser clamped the view, then more rows came, all within one task.
  element.scrollTop = end() - 300;
  await act(async () => {
    const list = element.querySelector("ul") as HTMLElement;
    list.firstElementChild?.remove();
    list.append(document.createElement("li"), document.createElement("li"));
  });
  expect(element.scrollTop).toBe(end());
});

it("still follows when the view grew taller and rows came before it heard", async () => {
  render(<List />);
  const { element, add, end } = view();
  element.scrollTop = end();
  await add();
  // The window opens up: the browser clamps the view to the old content's end, and a row comes
  // before the list hears of either.
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 260 });
  element.scrollTop = end();
  await add();
  expect(element.scrollTop).toBe(end());
});

it("still follows when the view grew taller and rows came before its scroll event", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 260 });
  element.scrollTop = end();
  await act(async () => {
    element.querySelector("ul")?.append(document.createElement("li"));
    fireEvent.scroll(element);
  });
  expect(following()).toBe(true);
  expect(element.scrollTop).toBe(end());
});

it("leaves the end for a scroll back further than the view grew", async () => {
  render(<Reader />);
  const { element, add, end, scroll } = view();
  scroll(end());
  await add();
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 260 });
  fireEvent.wheel(element, { deltaY: -120 });
  scroll(end() - 200);
  await add();
  expect(following()).toBe(false);
});
