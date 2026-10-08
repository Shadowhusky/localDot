// @vitest-environment jsdom
import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StageCanvas } from "../stage/StageCanvas.tsx";
import { FakeWorker, fakeChromium } from "../testing/fake-chromium.ts";
import { APPEARANCE_EVENT, APPEARANCE_KEY, useAppearance } from "./appearance.ts";
import { WelcomeSetup, type WelcomeSetupProps } from "./WelcomeSetup.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.appearance;
});
function props(): WelcomeSetupProps {
  return {
    modelReady: false,
    loading: false,
    autonomy: DEFAULT_AUTONOMY,
    appearance: { value: "graphite", saved: true, change: vi.fn() },
    starting: false,
    canStart: true,
    onSettings: vi.fn(),
    onStart: vi.fn(),
  };
}
it("guides model and autonomy setup through the existing settings controls", () => {
  const p = props();
  render(<WelcomeSetup {...p} />);
  const model = screen.getByRole("button", { name: "Choose model" });
  fireEvent.click(model);
  expect(p.onSettings).toHaveBeenCalledWith(model);
  const autonomy = screen.getByRole("button", { name: "Review autonomy" });
  fireEvent.click(autonomy);
  expect(p.onSettings).toHaveBeenCalledWith(autonomy, "autonomy");
  expect(
    (screen.getByRole("button", { name: "Start your computer" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(p.onStart).not.toHaveBeenCalled();
});
it("enables computer startup only after model readiness and lifecycle permission", () => {
  const p = props();
  p.modelReady = true;
  p.modelLabel = "Saved provider · saved model";
  const view = render(<WelcomeSetup {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Start your computer" }));
  expect(p.onStart).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toContain("Saved provider · saved model");
  view.rerender(<WelcomeSetup {...p} canStart={false} />);
  expect(
    (screen.getByRole("button", { name: "Start your computer" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  view.rerender(<WelcomeSetup {...p} loading />);
  expect(
    (screen.getByRole("button", { name: "Start your computer" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it("uses saved policy values without changing policy or storing keys", () => {
  const p = props();
  p.autonomy = { ...DEFAULT_AUTONOMY, reading: "ask", browsing: "ask" };
  render(<WelcomeSetup {...p} />);
  expect(screen.getByText(/0 action types can act/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Midnight" }));
  expect(p.appearance.change).toHaveBeenCalledWith("midnight");
  expect(localStorage.length).toBe(0);
  expect(p.onStart).not.toHaveBeenCalled();
});
it("persists only a bounded theme name and reacts to another tab's preference", () => {
  const hook = renderHook(() => useAppearance());
  act(() => hook.result.current.change("midnight"));
  expect(document.documentElement.dataset.appearance).toBe("midnight");
  expect(localStorage.getItem(APPEARANCE_KEY)).toBe("midnight");
  localStorage.setItem(APPEARANCE_KEY, "unrecognized");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY })));
  expect(hook.result.current.value).toBe("graphite");
});
it("keeps a theme usable without claiming persistence when storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const hook = renderHook(() => useAppearance());
  act(() => hook.result.current.change("midnight"));
  expect(hook.result.current.value).toBe("midnight");
  expect(hook.result.current.saved).toBe(false);
});
it("updates the current canvas worker and removes the listener when it closes", () => {
  const restore = fakeChromium();
  try {
    const view = render(<StageCanvas />);
    const worker = FakeWorker.instances[0];
    document.documentElement.style.setProperty("--color-void", "#090e18");
    act(() => window.dispatchEvent(new Event(APPEARANCE_EVENT)));
    expect(worker?.sent.at(-1)?.message).toMatchObject({
      type: "theme",
      theme: { void: { color: 0x090e18, alpha: 1 } },
    });
    view.unmount();
    const count = worker?.sent.length;
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    expect(worker?.sent.length).toBe(count);
  } finally {
    restore();
  }
});
