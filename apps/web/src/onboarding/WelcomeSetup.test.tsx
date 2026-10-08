// @vitest-environment jsdom
import { CAREFUL_AUTONOMY } from "@localdot/protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
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
    appearance: { value: "graphite", saved: true, change: vi.fn() },
    starting: false,
    canStart: true,
    onSettings: vi.fn(),
    onStart: vi.fn(),
  };
}
const step = (title: string) => {
  const row = screen.getByRole("heading", { name: title }).closest("li");
  if (!row) throw new Error(`no step ${title}`);
  return {
    row,
    state: () => within(row).getByRole("img").getAttribute("data-state"),
    detail: () => row.querySelector(".welcome-step-detail")?.textContent,
  };
};
it("guides model and autonomy setup through the existing settings controls", () => {
  const p = props();
  render(<WelcomeSetup {...p} />);
  const model = within(step("Model").row).getByRole("button", { name: "Choose" });
  fireEvent.click(model);
  expect(p.onSettings).toHaveBeenCalledWith(model);
  const checks = within(step("When dot checks with you").row).getByRole("button", {
    name: "Review",
  });
  expect(checks.getAttribute("aria-describedby")).toContain(
    screen.getByRole("heading", { name: "When dot checks with you" }).id,
  );
  fireEvent.click(checks);
  expect(p.onSettings).toHaveBeenCalledWith(checks, "autonomy");
  expect(p.onStart).not.toHaveBeenCalled();
});
it("shows the model as the one step left, and turns it done once a model is saved", () => {
  const p = props();
  const view = render(<WelcomeSetup {...p} loading />);
  const states = () =>
    ["Model", "Appearance", "When dot checks with you"].map((t) => step(t).state());
  expect(states()).toEqual(["todo", "done", "todo"]);
  view.rerender(<WelcomeSetup {...p} />);
  expect(states()).toEqual(["todo", "done", "done"]);
  view.rerender(<WelcomeSetup {...p} modelReady modelLabel="Saved provider · saved model" />);
  expect(states()).toEqual(["done", "done", "done"]);
  expect(step("Model").detail()).toBe("Saved provider · saved model");
  expect(within(step("Model").row).getByRole("button").textContent).toBe("Change");
  view.rerender(
    <WelcomeSetup
      {...p}
      autonomy={{ reading: "act" } as unknown as WelcomeSetupProps["autonomy"]}
    />,
  );
  expect(step("When dot checks with you").state()).toBe("failed");
});
it("offers one primary action, Turn on, whenever the computer can start", () => {
  const p = props();
  const view = render(<WelcomeSetup {...p} />);
  const turnOn = screen.getByRole("button", { name: "Turn on" });
  expect(turnOn.dataset.variant).toBe("primary");
  expect(document.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
  expect(screen.getByText("You can turn it on while you choose a model.")).toBeTruthy();
  expect(turnOn.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(turnOn);
  expect(p.onStart).toHaveBeenCalledOnce();
  view.rerender(<WelcomeSetup {...p} modelReady loading />);
  expect(step("Model").detail()).toBe("Checking your saved model…");
  expect(turnOn.getAttribute("aria-disabled")).toBeNull();
  turnOn.focus();
  view.rerender(<WelcomeSetup {...p} canStart={false} starting />);
  expect(turnOn.textContent).toBe("Turn on");
  expect(turnOn.getAttribute("aria-busy")).toBe("true");
  expect(turnOn.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(turnOn);
  fireEvent.click(turnOn);
  expect(p.onStart).toHaveBeenCalledOnce();
  view.rerender(<WelcomeSetup {...p} canStart={false} />);
  expect(turnOn.getAttribute("aria-disabled")).toBe("true");
  expect(turnOn.getAttribute("aria-describedby")).toBeTruthy();
});
it("keeps the hint under Turn on in its place while saved settings load", () => {
  const p = props();
  const view = render(<WelcomeSetup {...p} loading />);
  const note = () => document.querySelector(".welcome-note");
  expect(note()?.textContent).toBe("");
  view.rerender(<WelcomeSetup {...p} />);
  expect(note()?.textContent).toBe("You can turn it on while you choose a model.");
  view.rerender(<WelcomeSetup {...p} modelReady />);
  expect(note()?.textContent).toBe("Then tell dot what to do in the conversation.");
});
it("says in words when dot checks with you, and changes nothing itself", () => {
  const p = props();
  const view = render(<WelcomeSetup {...p} />);
  expect(step("When dot checks with you").detail()).toBe(
    "Asks before buying, sending, posting or deleting.",
  );
  view.rerender(<WelcomeSetup {...p} autonomy={CAREFUL_AUTONOMY} />);
  expect(step("When dot checks with you").detail()).toMatch(/^Asks before every step/);
  fireEvent.click(screen.getByRole("radio", { name: "Midnight" }));
  expect(p.appearance.change).toHaveBeenCalledWith("midnight");
  expect(localStorage.length).toBe(0);
  expect(p.onStart).not.toHaveBeenCalled();
});
it("draws the theme choices with the kit and no native radio on screen", () => {
  render(<WelcomeSetup {...props()} />);
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  expect(group.classList.contains("ui-radio-cards")).toBe(true);
  expect(within(group).getAllByRole("radio")).toHaveLength(2);
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
