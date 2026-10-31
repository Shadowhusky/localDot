// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { SessionRail } from "./SessionRail.tsx";
import { useDockMagnify } from "./useDockMagnify.ts";

const TITLES = ["Plan the trip", "Book the hotel", "Tidy the photos", "Pay the bill", "Call mum"];

// Which media queries match: the device's pointer, and whether motion is reduced.
let media = { reduce: false, mouse: true };
beforeEach(() => {
  media = { reduce: false, mouse: true };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("reduce")
        ? media.reduce
        : query.includes("hover: hover") && media.mouse;
    },
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The collapsed rail's list as the browser lays it out: a group's label, then marks 36 px tall and
// 2 px apart.
function Rail() {
  const list = useRef<HTMLDivElement>(null);
  useDockMagnify(list, true);
  return (
    <nav className="sessions">
      <div ref={list} className="sessions-scroll" data-testid="list">
        <ul>
          {TITLES.map((title, n) => (
            <li key={title} className="sessions-item" data-flip={`s${n}`}>
              <button type="button">
                <span className="sessions-title">{title}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function rail() {
  render(<Rail />);
  const list = screen.getByTestId("list");
  Object.defineProperty(list, "clientHeight", { value: 600 });
  const marks = [...list.querySelectorAll<HTMLElement>(".sessions-item")];
  marks.forEach((mark, n) => {
    Object.defineProperties(mark, {
      offsetTop: { value: 32 + n * 38 },
      offsetHeight: { value: 36 },
      offsetLeft: { value: 8 },
      offsetWidth: { value: 40 },
    });
  });
  const frames = (count: number) => {
    for (let n = 0; n < count; n++) act(() => vi.advanceTimersToNextFrame());
  };
  frames(1);
  const names = [...document.querySelectorAll<HTMLElement>(".sessions-dock > [data-dock-name]")];
  expect(names.map((name) => name.textContent)).toEqual(TITLES);
  const shown = () =>
    Object.fromEntries(names.map((name) => [name.dataset.dockName, Number(name.style.opacity)]));
  const scales = () => marks.map((mark) => mark.style.scale);
  const mouse = (type: "pointerMove" | "pointerLeave", mark: number, pointerType = "mouse") =>
    fireEvent[type](list, { pointerType, clientY: 32 + mark * 38 + 18 });
  return { list, marks, shown, scales, frames, mouse };
}

it("magnifies the marks under the mouse, the one under it most, and names those near it", () => {
  const { marks, shown, scales, frames, mouse } = rail();
  mouse("pointerMove", 2);
  frames(40);
  const grown = scales().map(Number);
  expect(grown[2]).toBeGreaterThan(1.7);
  expect(grown[1]).toBeLessThan(grown[2] as number);
  expect(grown[0]).toBeLessThan(grown[1] as number);
  expect(marks[2]?.hasAttribute("data-under")).toBe(true);
  const names = shown();
  expect(names.s2).toBe(1);
  expect(names.s1).toBeGreaterThan(0);
  expect(names.s1).toBeLessThan(1);
  expect(names.s0).toBeLessThan(names.s1 as number);

  mouse("pointerLeave", 2);
  frames(60);
  expect(scales()).toEqual(marks.map(() => ""));
  expect(Object.values(shown())).toEqual(marks.map(() => 0));
  expect(document.querySelector(".sessions-dock")?.hasAttribute("data-magnify")).toBe(false);
});

it("holds the marks still and unnamed while a row's menu is open", async () => {
  const { marks, shown, scales, frames, mouse } = rail();
  mouse("pointerMove", 2);
  frames(40);
  const held = scales();
  await act(async () => marks[2]?.setAttribute("data-menu", ""));
  mouse("pointerLeave", 2);
  frames(40);
  expect(scales()).toEqual(held);
  expect(Object.values(shown())).toEqual(marks.map(() => 0));
  await act(async () => marks[2]?.removeAttribute("data-menu"));
  frames(60);
  expect(scales()).toEqual(marks.map(() => ""));
});

// Taking up a conversation runs a view transition, which gives the page's root the pointer until it
// ends, though the pointer hasn't moved.
function switching() {
  const view = rail();
  vi.spyOn(view.list, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 56,
    bottom: 600,
  } as DOMRect);
  const root = document.documentElement;
  const at = (mark: number, clientX = 20) => ({
    pointerType: "mouse",
    clientX,
    clientY: 32 + mark * 38 + 18,
  });
  view.mouse("pointerMove", 1);
  view.frames(40);
  fireEvent.pointerLeave(view.list, { ...at(1), relatedTarget: root });
  const largest = () => {
    const grown = view.scales().map(Number);
    return grown.indexOf(Math.max(...grown));
  };
  return { ...view, root, at, largest };
}

it("keeps the lens through a view transition and follows the pointer there until it leaves", () => {
  const { marks, root, at, largest, scales, frames } = switching();
  frames(40);
  expect(largest()).toBe(1);
  expect(Number(scales()[1])).toBeGreaterThan(1.7);
  expect(marks[1]?.hasAttribute("data-under")).toBe(true);

  fireEvent.pointerMove(root, at(3));
  frames(40);
  expect(largest()).toBe(3);
  expect(Number(scales()[3])).toBeGreaterThan(1.7);

  fireEvent.pointerMove(root, at(3, 300));
  frames(60);
  expect(scales()).toEqual(marks.map(() => ""));
});

it("lets the lens go once the page has the pointer back off the list", () => {
  const { marks, scales, frames } = switching();
  frames(10);
  fireEvent.pointerOver(document.body, { pointerType: "mouse", clientX: 300, clientY: 100 });
  frames(60);
  expect(scales()).toEqual(marks.map(() => ""));
});

it("eases in rather than jumping to its full size", () => {
  const { scales, frames, mouse } = rail();
  mouse("pointerMove", 2);
  frames(1);
  const first = Number(scales()[2]);
  frames(3);
  const later = Number(scales()[2]);
  expect(first).toBeGreaterThan(1);
  expect(first).toBeLessThan(1.3);
  expect(later).toBeGreaterThan(first);
});

it("under reduced motion grows nothing and names only the mark under the mouse", () => {
  media.reduce = true;
  const { marks, shown, scales, frames, mouse } = rail();
  mouse("pointerMove", 3);
  frames(10);
  expect(scales()).toEqual(marks.map(() => ""));
  expect(shown()).toEqual({ s0: 0, s1: 0, s2: 0, s3: 1, s4: 0 });
  mouse("pointerLeave", 3);
  frames(2);
  expect(shown().s3).toBe(0);
});

it("names the mark reached from the keyboard", () => {
  const matches = Element.prototype.matches;
  // jsdom never matches :focus-visible; a browser does for focus moved by the keyboard.
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, query) {
    return query === ":focus-visible" || matches.call(this, query);
  });
  const { marks, shown, scales, frames } = rail();
  act(() => marks[4]?.querySelector("button")?.focus());
  frames(2);
  expect(shown()).toEqual({ s0: 0, s1: 0, s2: 0, s3: 0, s4: 1 });
  expect(scales()).toEqual(marks.map(() => ""));
  act(() => marks[4]?.querySelector("button")?.blur());
  frames(2);
  expect(shown().s4).toBe(0);
});

it("leaves a touch on the list alone", () => {
  const { marks, shown, scales, frames, mouse } = rail();
  mouse("pointerMove", 1, "touch");
  frames(10);
  expect(scales()).toEqual(marks.map(() => ""));
  expect(Object.values(shown())).toEqual(marks.map(() => 0));
});

it("gives the collapsed rail its dock only where there is a mouse", async () => {
  vi.useRealTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1",
    fetchImpl: (async () => Response.json({ conversations: [] })) as typeof fetch,
  });
  const props = {
    api,
    current: null,
    facts: { live: null, needsYou: new Set<string>() },
    onExpandedChange: vi.fn(),
    onPick: vi.fn(),
    onNew: vi.fn(),
  };
  const view = render(<SessionRail {...props} expanded={false} />);
  expect(document.querySelector(".sessions-dock")).not.toBeNull();
  view.rerender(<SessionRail {...props} expanded />);
  expect(document.querySelector(".sessions-dock")).toBeNull();
  view.unmount();
  media.mouse = false;
  render(<SessionRail {...props} expanded={false} />);
  expect(document.querySelector(".sessions-dock")).toBeNull();
});
