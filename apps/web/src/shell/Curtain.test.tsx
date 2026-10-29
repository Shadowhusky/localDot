// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Curtain, type FreshStartAction } from "./Curtain.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const curtain = (phase: "starting" | "stopping", updating: boolean) =>
  render(
    <Curtain
      phase={phase}
      first={false}
      waking={false}
      updating={updating}
      caption=""
      action={{ kind: "stop", enabled: false }}
      onAction={() => {}}
      showDot={false}
    />,
  );

it("says the computer is updating through its stop and its start", () => {
  for (const phase of ["stopping", "starting"] as const) {
    curtain(phase, true);
    expect(screen.getByRole("heading").textContent).toBe("Updating your computer");
    expect(screen.getByText(/Your files and sign-ins stay/)).toBeTruthy();
    cleanup();
  }
  curtain("starting", false);
  expect(screen.getByRole("heading").textContent).toBe("Starting your computer");
});

const stuck = (freshStart: FreshStartAction, onAction = () => {}) =>
  render(
    <Curtain
      phase="failed"
      first={false}
      waking={false}
      caption="Some other words"
      action={{ kind: "start", enabled: true }}
      onAction={onAction}
      replace={{ enabled: true, busy: false, run: () => {} }}
      freshStart={freshStart}
      showDot={false}
    />,
  );

it("offers to start anyway once Docker's memory advice is shown", () => {
  const advice =
    "Two running computers need about 10 GB for Docker; it has 8 GB. Raise it in Docker Desktop → Settings → Resources.";
  const onAction = vi.fn();
  const startAnyway = vi.fn();
  render(
    <Curtain
      phase="stopped"
      first={false}
      waking={false}
      caption=""
      notice={advice}
      action={{ kind: "start", enabled: true }}
      onAction={onAction}
      startAnyway={startAnyway}
      showDot={false}
    />,
  );
  expect(screen.getByText(advice)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
  expect(startAnyway).toHaveBeenCalledOnce();
  expect(onAction).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
});

it("names Start fresh as the way out of an update that can't be finished", () => {
  stuck({ busy: false, run: () => {} });
  expect(screen.getByRole("heading").textContent).toBe("Your computer needs a fresh start");
  expect(
    screen.getByText("The update couldn't be finished. Start fresh to use your computer again."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Replace computer" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Start again|Turn on/ })).toBeNull();
});

it("asks before Start fresh erases the computer, and Cancel leaves it be", () => {
  const run = vi.fn();
  const onAction = vi.fn();
  stuck({ busy: false, run }, onAction);
  fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  const dialog = screen.getByRole("alertdialog", { name: "Start fresh?" });
  expect(
    within(dialog).getByText("Your computer's files are erased. Your sign-ins are kept."),
  ).toBeTruthy();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(run).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  const again = screen.getByRole("alertdialog", { name: "Start fresh?" });
  fireEvent.click(within(again).getByRole("button", { name: "Start fresh" }));
  expect(run).toHaveBeenCalledOnce();
  expect(onAction).not.toHaveBeenCalled();
});

it("shows a fresh start going on, then why it didn't finish", () => {
  stuck({ busy: true, run: () => {} });
  expect(screen.getByRole("heading").textContent).toBe("Starting fresh");
  expect(screen.getByText(/Setting up a clean computer/)).toBeTruthy();
  cleanup();
  stuck({ busy: false, note: "Starting fresh didn't finish. Try again.", run: () => {} });
  expect(screen.getByText("Starting fresh didn't finish. Try again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start fresh" })).toBeTruthy();
});

it("never calls a live, suspended or reconnecting viewer an off computer during an exit", () => {
  for (const phase of ["live", "suspended", "reconnecting", "frozen"] as const) {
    const view = render(
      <Curtain
        phase={phase}
        first={false}
        waking={false}
        caption=""
        onAction={() => {}}
        showDot={false}
      />,
    );
    expect(screen.queryByText("Your computer is off")).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    view.unmount();
  }
});

it("offers explicit retry while slow restoration stays under the loading curtain", () => {
  const reload = vi.fn();
  render(
    <Curtain
      phase="checking"
      first={false}
      waking={false}
      caption=""
      onAction={() => {}}
      showDot={false}
      onReload={reload}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(reload).toHaveBeenCalledOnce();
  expect(screen.queryByText("Your computer is off")).toBeNull();
});

it("shows Docker prerequisite rather than starting or destructive recovery controls", () => {
  const retry = vi.fn(),
    reset = vi.fn();
  render(
    <Curtain
      phase="unavailable"
      runtimeProblem="docker"
      onRuntimeRetry={retry}
      first={false}
      waking={true}
      caption=""
      onAction={reset}
      showDot={false}
      freshStart={{ busy: true, run: reset }}
      replace={{ enabled: true, busy: false, run: reset }}
    />,
  );
  expect(screen.getByRole("heading").textContent).toBe("Docker isn't available");
  expect(screen.queryByRole("button", { name: /Start fresh|Replace computer|Turn on/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(reset).not.toHaveBeenCalled();
});
