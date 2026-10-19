// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileScreen } from "./useMobileScreen.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("coalesces resize writes outside observer delivery and cancels them on unmount", () => {
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  let height = 300;
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => height);
  function Fixture() {
    const screen = useMobileScreen(true);
    return (
      <main ref={screen.ref}>
        <div className="stage-frame" />
      </main>
    );
  }
  const view = render(<Fixture />);
  const host = view.container.querySelector("main");
  expect(host?.style.getPropertyValue("--mobile-screen-height")).toBe("300px");
  height = 500;
  act(() => {
    resized();
    resized();
    resized();
  });
  expect(frames).toHaveLength(1);
  expect(host?.style.getPropertyValue("--mobile-screen-height")).toBe("300px");
  act(() => frames[0]?.(0));
  expect(host?.style.getPropertyValue("--mobile-screen-height")).toBe("500px");
  act(() => resized());
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(2);
});
