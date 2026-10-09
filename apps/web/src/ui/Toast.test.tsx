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
      <div ref={hud}>
        Working <button type="button">Stop</button>
      </div>
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
  wait(SETTLE);
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

// A toast shows once it has settled.
const SETTLE = 400;

describe("Toaster", () => {
  it("shows one toast at a time in a labelled region, the next once the first has gone", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads", tone: "success" });
    show({ title: "Key moved to Keys" });
    expect(within(region()).getAllByRole("listitem")).toHaveLength(1);
    expect(toasts()).toEqual(["Saved to Downloads"]);
    wait(1600);
    expect(toasts()).toEqual(["Key moved to Keys"]);
  });

  it("reads each toast out through the one polite region as it shows", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads", description: "summary.txt · 2 KB", tone: "success" });
    expect(screen.getByRole("status").textContent).toBe("Saved to Downloads. summary.txt · 2 KB");
    expect(region().querySelector("[aria-live]")).toBeNull();
  });

  it("shows nothing for a state that passes before it settles", () => {
    render(<Stage />);
    act(() => {
      kit.showToast({ id: "connection", title: "Reconnecting…" });
    });
    wait(SETTLE - 1);
    act(() => kit.dismissToast("connection"));
    wait(10_000);
    expect(toasts()).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("holds the time while focus is in the toast", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads" });
    act(() => screen.getByRole("button", { name: "Dismiss" }).focus());
    wait(20_000);
    expect(toasts()).toEqual(["Saved to Downloads"]);
    act(() => screen.getByRole("button", { name: "After the stage" }).focus());
    wait(4000);
    expect(toasts()).toEqual([]);
  });

  it("dismisses the focused toast on Escape, keeps the key from the page and brings the next", () => {
    const onKeyDown = vi.fn();
    document.addEventListener("keydown", onKeyDown);
    render(<Stage />);
    show({ title: "Couldn't confirm the stop", tone: "danger" });
    show({ title: "Saved to Downloads" });
    const close = screen.getByRole("button", { name: "Dismiss" });
    act(() => close.focus());
    fireEvent.keyDown(close, { key: "Escape" });
    expect(toasts()).toEqual(["Saved to Downloads"]);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop" }));
    document.removeEventListener("keydown", onKeyDown);
  });

  it("gives focus back to where it came from when the toast goes", () => {
    render(<Stage />);
    const stop = screen.getByRole("button", { name: "Stop" });
    const after = screen.getByRole("button", { name: "After the stage" });
    const from = (origin: HTMLElement, reach: () => HTMLElement) => {
      act(() => origin.focus());
      const target = reach();
      act(() => target.focus());
      return target;
    };

    show({ title: "Saved to Downloads" });
    fireEvent.click(from(stop, () => screen.getByRole("button", { name: "Dismiss" })));
    expect(toasts()).toEqual([]);
    expect(document.activeElement).toBe(stop);

    show({ title: "Key moved to Keys" });
    fireEvent.keyDown(
      from(after, () => screen.getByRole("button", { name: "Dismiss" })),
      { key: "Escape" },
    );
    expect(document.activeElement).toBe(after);

    const onAction = vi.fn();
    show({ title: "Moved to Downloads", action: { label: "Undo", onAction } });
    fireEvent.click(from(stop, () => screen.getByRole("button", { name: "Undo" })));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(stop);
  });

  it("gives focus to the anchor when it did not come into the toast from anywhere", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads" });
    const close = screen.getByRole("button", { name: "Dismiss" });
    act(() => close.focus());
    fireEvent.click(close);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop" }));
  });

  it("keeps the next one waiting while a press on the toast lasts, until its click is done", () => {
    render(<Stage />);
    show({ title: "Key moved to Keys", action: { label: "Undo", onAction() {} } });
    const undo = screen.getByRole("button", { name: "Undo" });
    fireEvent.pointerDown(undo, { pointerType: "touch" });
    show({ title: "Saved to Downloads" });
    wait(10_000);
    expect(toasts()).toEqual(["Key moved to Keys"]);
    fireEvent.pointerUp(undo, { pointerType: "touch" });
    expect(toasts()).toEqual(["Key moved to Keys"]);
    fireEvent.click(undo);
    wait(0);
    expect(toasts()).toEqual(["Saved to Downloads"]);
  });

  it("stands the toast's time still while the page is hidden", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const turn = (to: boolean) => {
      hidden = to;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    render(<Stage />);
    show({ title: "Saved to Downloads" });
    wait(1000);
    turn(true);
    wait(60_000);
    expect(toasts()).toEqual(["Saved to Downloads"]);
    turn(false);
    wait(2999);
    expect(toasts()).toEqual(["Saved to Downloads"]);
    wait(1);
    expect(toasts()).toEqual([]);
  });

  it("drops a waiting toast's reading when it is withdrawn, and reads one out urgently when asked", () => {
    render(<Stage />);
    show({ title: "Saved to Downloads", action: { label: "Open", onAction() {} } });
    const moved = show({ title: "Key moved to Keys" });
    act(() => kit.dismissToast(moved));
    wait(10_000);
    expect(toasts()).toEqual(["Saved to Downloads"]);
    expect(screen.getByRole("status").textContent).toBe("Saved to Downloads");
    show({ title: "Couldn't stop the task", tone: "danger", urgency: "assertive" });
    wait(6000);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't stop the task");
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

  it("keeps its region mounted, so a toast adds nothing beside it in the page", () => {
    const { container } = render(<Stage />);
    const after = screen.getByRole("button", { name: "After the stage" });
    const before = [...(container.firstElementChild?.children ?? [])];
    show({ title: "Saved to Downloads" });
    expect([...(container.firstElementChild?.children ?? [])]).toEqual(before);
    expect(region().nextElementSibling).toBe(after);
  });
});
