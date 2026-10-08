// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Kit = typeof import("./Toast.tsx") & typeof import("./Announcer.tsx");
let kit: Kit;

// A fresh module for each test, so no toast or held timer carries over.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.resetModules();
  kit = { ...(await import("./Toast.tsx")), ...(await import("./Announcer.tsx")) };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Stage() {
  const hud = useRef<HTMLDivElement>(null);
  return (
    <div>
      <kit.Announcer />
      <div ref={hud}>Working</div>
      <kit.Toaster anchor={hud} />
      <button type="button">After the stage</button>
    </div>
  );
}

function show(...args: Parameters<Kit["showToast"]>) {
  let id = "";
  act(() => {
    id = kit.showToast(...args);
  });
  return id;
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function toasts() {
  return screen.queryAllByRole("listitem").map((item) => item.querySelector("p")?.textContent);
}

const region = () => screen.getByRole("region", { name: "Notifications" });

describe("Toaster", () => {
  it("lists toasts newest first in a labelled region", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads", tone: "success" });
    show({ title: "Key moved to Keys" });
    expect(within(region()).getAllByRole("listitem")).toHaveLength(2);
    expect(toasts()).toEqual(["Key moved to Keys", "Saved to Downloads"]);
  });

  it("reads each toast out through the one polite region", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads", description: "summary.txt · 2 KB", tone: "success" });
    expect(screen.getByRole("status").textContent).toBe("Saved to Downloads. summary.txt · 2 KB");
    expect(region().querySelector("[aria-live]")).toBeNull();
  });

  it("lets a result go after four seconds in front, and keeps a failure", () => {
    render(<Stage />);
    show({ title: "Couldn't confirm the stop", tone: "danger" });
    show({ title: "Stopped", tone: "success" });
    wait(3999);
    expect(toasts()).toEqual(["Stopped", "Couldn't confirm the stop"]);
    wait(1);
    expect(toasts()).toEqual(["Couldn't confirm the stop"]);
    wait(60_000);
    expect(toasts()).toEqual(["Couldn't confirm the stop"]);
  });

  it("holds the time while focus is in the stack, and opens the stack out", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads" });
    show({ title: "Key moved to Keys" });
    const [front, behind] = screen.getAllByRole("listitem");
    expect(behind?.hasAttribute("inert")).toBe(true);
    act(() =>
      within(front as HTMLElement)
        .getByRole("button", { name: "Dismiss" })
        .focus(),
    );
    expect(region().hasAttribute("data-expanded")).toBe(true);
    expect(behind?.hasAttribute("inert")).toBe(false);
    wait(20_000);
    expect(toasts()).toEqual(["Key moved to Keys", "Saved to Downloads"]);
    act(() => screen.getByRole("button", { name: "After the stage" }).focus());
    wait(4000);
    expect(toasts()).toEqual(["Saved to Downloads"]);
  });

  it("dismisses the focused toast on Escape and keeps the key from reaching the page", () => {
    const onKeyDown = vi.fn();
    document.addEventListener("keydown", onKeyDown);
    render(<Stage />);
    show({ title: "Saved to Downloads" });
    show({ title: "Couldn't confirm the stop", tone: "danger" });
    const close = within(screen.getAllByRole("listitem")[0] as HTMLElement).getByRole("button", {
      name: "Dismiss",
    });
    act(() => close.focus());
    fireEvent.keyDown(close, { key: "Escape" });
    expect(toasts()).toEqual(["Saved to Downloads"]);
    expect(onKeyDown).not.toHaveBeenCalled();
    // Focus moved on to the toast now in front rather than falling to the page.
    expect(document.activeElement?.closest("li")?.textContent).toContain("Saved to Downloads");
    document.removeEventListener("keydown", onKeyDown);
  });

  it("runs an action once and lets the toast go", () => {
    const onAction = vi.fn();
    render(<Stage />);
    show({ title: "Key moved to Keys", action: { label: "Undo", onAction } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([]);
  });

  it("turns a toast into its follow-up in place when the action shows one under the same id", () => {
    render(<Stage />);
    const recheck = () => kit.showToast({ id: "stop", title: "Stopped", tone: "success" });
    show({
      id: "stop",
      title: "Couldn't confirm the stop",
      tone: "danger",
      action: { label: "Check again", onAction: recheck },
    });
    const item = screen.getByRole("listitem");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(toasts()).toEqual(["Stopped"]);
    expect(screen.getByRole("listitem")).toBe(item);
    expect(item.hasAttribute("data-leaving")).toBe(false);
  });

  it("shows three at most and brings the next forward as the front one goes", () => {
    render(<Stage />);
    for (const title of ["One", "Two", "Three", "Four"]) show({ title, persist: true });
    expect(toasts()).toEqual(["Four", "Three", "Two"]);
    fireEvent.click(
      within(screen.getAllByRole("listitem")[0] as HTMLElement).getByRole("button", {
        name: "Dismiss",
      }),
    );
    expect(toasts()).toEqual(["Three", "Two", "One"]);
  });

  it("keeps its region mounted, so a toast adds nothing beside it in the page", () => {
    const { container } = render(<Stage />);
    const after = screen.getByRole("button", { name: "After the stage" });
    const before = [...(container.firstElementChild?.children ?? [])];
    show({ title: "Saved to Downloads" });
    expect([...(container.firstElementChild?.children ?? [])]).toEqual(before);
    expect(region().nextElementSibling).toBe(after);
  });
});
