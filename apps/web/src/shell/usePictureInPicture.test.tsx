// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTuckOnReading } from "./usePictureInPicture.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Fixture({ enabled, tuck }: { enabled: boolean; tuck(): void }) {
  const going = useTuckOnReading(enabled, tuck);
  return (
    <aside className="rail-chat" data-going={going || undefined}>
      <div className="thread-body">
        <div className="thread-scroll" style={{ overflowY: "auto" }}>
          <p>Earlier</p>
        </div>
      </div>
    </aside>
  );
}

// A thread with more to show than its height, as jsdom lays nothing out.
function tall(length: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(length);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
}

function drag(target: Element, dx: number, dy: number) {
  const at = (x: number, y: number) => [{ identifier: 1, target, clientX: x, clientY: y }];
  target.dispatchEvent(
    Object.assign(new Event("touchstart", { bubbles: true }), { touches: at(100, 100) }),
  );
  target.dispatchEvent(
    Object.assign(new Event("touchmove", { bubbles: true }), { touches: at(100 + dx, 100 + dy) }),
  );
}

it("tucks the screen when a finger reads up or down a thread with more to show", () => {
  tall(900);
  const tuck = vi.fn();
  const view = render(<Fixture enabled tuck={tuck} />);
  const line = view.getByText("Earlier");
  drag(line, 2, 6);
  expect(tuck).not.toHaveBeenCalled();
  drag(line, 2, 40);
  expect(tuck).toHaveBeenCalledOnce();
});

it("leaves the screen for a sideways swipe, a thread that fits, or when it cannot tuck", () => {
  const tuck = vi.fn();
  tall(900);
  const view = render(<Fixture enabled tuck={tuck} />);
  drag(view.getByText("Earlier"), 60, 20);
  expect(tuck).not.toHaveBeenCalled();
  view.rerender(<Fixture enabled={false} tuck={tuck} />);
  drag(view.getByText("Earlier"), 0, 60);
  expect(tuck).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  tall(400);
  view.rerender(<Fixture enabled tuck={tuck} />);
  drag(view.getByText("Earlier"), 0, 60);
  expect(tuck).not.toHaveBeenCalled();
});

it("says the reading goes on until the finger lifts and the scroll has rested", () => {
  vi.useFakeTimers();
  tall(900);
  const view = render(<Fixture enabled tuck={() => {}} />);
  const rail = view.container.querySelector(".rail-chat");
  act(() => drag(view.getByText("Earlier"), 0, 40));
  expect(rail).toHaveProperty("dataset.going", "true");
  // Held, it never rests, however long.
  act(() => vi.advanceTimersByTime(1_000));
  expect(rail).toHaveProperty("dataset.going", "true");
  act(() => {
    document.dispatchEvent(Object.assign(new Event("touchend"), { touches: [] }));
  });
  // A glide goes on scrolling after the finger lifts.
  act(() => vi.advanceTimersByTime(100));
  act(() => {
    document.dispatchEvent(new Event("scroll"));
  });
  act(() => vi.advanceTimersByTime(100));
  expect(rail).toHaveProperty("dataset.going", "true");
  act(() => vi.advanceTimersByTime(100));
  expect(rail?.hasAttribute("data-going")).toBe(false);
});
