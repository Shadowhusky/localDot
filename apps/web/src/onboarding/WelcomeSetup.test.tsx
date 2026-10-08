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
  expect(p.onStart).not.toHaveBeenCalled();
});
it("turns the computer on whenever it can start, with or without a model", () => {
  const p = props();
  const view = render(<WelcomeSetup {...p} />);
  const turnOn = screen.getByRole("button", { name: "Turn on" });
  expect(screen.getByText("Turn on your computer while you choose a model.")).toBeTruthy();
  expect(turnOn.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(turnOn);
  expect(p.onStart).toHaveBeenCalledOnce();
  view.rerender(
    <WelcomeSetup {...p} modelReady modelLabel="Saved provider · saved model" loading />,
  );
  expect(screen.getByRole("status").textContent).toContain("Checking saved settings…");
  expect(turnOn.getAttribute("aria-disabled")).toBeNull();
  view.rerender(<WelcomeSetup {...p} modelReady modelLabel="Saved provider · saved model" />);
  expect(screen.getByRole("status").textContent).toContain("Saved provider · saved model");
  turnOn.focus();
  view.rerender(<WelcomeSetup {...p} canStart={false} starting />);
  expect(turnOn.textContent).toBe("Starting…");
  expect(turnOn.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(turnOn);
  fireEvent.click(turnOn);
  expect(p.onStart).toHaveBeenCalledOnce();
});
it("keeps the first-task hint neutral while saved settings load", () => {
  const p = props();
  const view = render(<WelcomeSetup {...p} loading />);
  const hint = () =>
    screen.getByRole("heading", { name: "Ready for your first task?" }).nextSibling;
  expect(hint()?.textContent).toBe("Turn on your computer to get started.");
  view.rerender(<WelcomeSetup {...p} />);
  expect(hint()?.textContent).toBe("Turn on your computer while you choose a model.");
  view.rerender(<WelcomeSetup {...p} modelReady />);
  expect(hint()?.textContent).toBe(
    "Turn on your computer, then describe what you want in the conversation.",
  );
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
