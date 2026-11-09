// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AppUpdateStatus,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import { AppUpdateOverlay, AppUpdateSettings } from "./AppUpdateSettings.tsx";
import type { AppUpdateControl } from "./useAppUpdate.ts";

afterEach(cleanup);
const base: AppUpdateStatus = {
  supported: true,
  installOnLaunchSupported: false,
  currentVersion: "0.1.0-rc.19",
  phase: "downloading",
  preferences: { ...DEFAULT_APP_UPDATES },
  checkedAt: 1,
  availableVersion: "0.1.0-rc.21",
  dismissedVersion: null,
  error: null,
  progress: { step: "images", value: 0.55, detail: "Preparing the computer · 1.4 of 3.1 GB" },
  notes: [
    { version: "0.1.0-rc.21", markdown: "## What's new\n\n- Quicker updates." },
    { version: "0.1.0-rc.20", markdown: "## Fixes\n\n- An older fix." },
  ],
  updating: false,
  unsupported: null,
};
function show(status: Partial<AppUpdateStatus>, control: Partial<AppUpdateControl> = {}) {
  const update: AppUpdateControl = {
    status: { ...base, ...status },
    error: null,
    busy: false,
    starting: false,
    restarting: false,
    reconnecting: false,
    wait: "normal",
    check: vi.fn(),
    update: vi.fn(),
    preferences: vi.fn(),
    ...control,
  };
  render(<AppUpdateSettings update={update} />);
}

it("shows one bar with its detail, and the newest notes open over the older ones folded", () => {
  show({});
  const bar = screen.getByRole("progressbar", { name: "Update progress" });
  expect(bar.getAttribute("aria-valuenow")).toBe("0.55");
  expect(bar.getAttribute("aria-valuetext")).toBe("Preparing the computer · 1.4 of 3.1 GB");
  expect(screen.getByText("Preparing the computer · 1.4 of 3.1 GB")).toBeTruthy();
  const notes = screen.getByRole("region", { name: "What's new in 0.1.0-rc.21" });
  expect(within(notes).getByText("Quicker updates.")).toBeTruthy();
  const older = within(notes).getByRole("button", { name: "What's new in 0.1.0-rc.20" });
  expect(older.getAttribute("aria-expanded")).toBe("false");
});

it("says what failed in one sentence over the steps, instead of pointing at a log", () => {
  show({
    phase: "idle",
    error: "localDot 0.1.0-rc.21 couldn't be downloaded, so nothing has changed.",
    progress: { step: "images", value: 0.3, detail: null },
  });
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getAllByText(/couldn't be downloaded/)).toHaveLength(1);
  const steps = within(screen.getByRole("list", { name: "Update steps" })).getAllByRole("listitem");
  expect(steps.map((step) => [step.textContent, step.getAttribute("data-state")])).toEqual([
    ["Check for updates", "done"],
    ["Download", "done"],
    ["Verify the download", "done"],
    ["Prepare the computer", "failed"],
    ["Install", "todo"],
    ["Restart", "todo"],
    ["Reconnect", "todo"],
  ]);
  expect(screen.queryByText(/log/)).toBeNull();
});

const stepNow = () => document.querySelector('[aria-current="step"]')?.textContent;

it("names the stage it is really at, not Restarting while it is still installing", () => {
  show({
    phase: "installing",
    progress: { step: "install", value: 0.96, detail: "Checking the download once more" },
  });
  expect(screen.getByRole("status").textContent).toContain("Installing localDot 0.1.0-rc.21…");
  expect(stepNow()).toBe("Install");
  expect(screen.getByText("Checking the download once more")).toBeTruthy();
  cleanup();
  show({
    phase: "installing",
    progress: { step: "restart", value: 0.97, detail: "Restarting localDot" },
  });
  expect(screen.getByRole("status").textContent).toContain("Restarting localDot…");
  expect(stepNow()).toBe("Restart");
  cleanup();
  show({ phase: "installing" }, { restarting: true });
  expect(screen.getByText("Starting localDot 0.1.0-rc.21")).toBeTruthy();
  expect(stepNow()).toBe("Restart");
  cleanup();
  show({ phase: "installing", currentVersion: "0.1.0-rc.21" }, { reconnecting: true });
  expect(screen.getByRole("status").textContent).toContain("Reconnecting to localDot…");
  expect(stepNow()).toBe("Reconnect");
});

it("shows every stage it goes through, with the percentage while it downloads", () => {
  show({ phase: "checking", progress: null, availableVersion: null });
  expect(screen.getByRole("status").textContent).toContain("Checking for updates…");
  expect(stepNow()).toBe("Check for updates");
  cleanup();
  show({ progress: { step: "download", value: 0.03, detail: "Downloading · 42% · 8 of 19 MB" } });
  expect(screen.getByText("Downloading · 42% · 8 of 19 MB")).toBeTruthy();
  expect(stepNow()).toBe("Download");
  cleanup();
  show({ progress: { step: "verify", value: 0.1, detail: "Checking the download" } });
  expect(stepNow()).toBe("Verify the download");
  cleanup();
  show({ progress: { step: "images", value: 0.5, detail: "Preparing the computer" } });
  expect(stepNow()).toBe("Prepare the computer");
});

it("says so as soon as Update now is pressed", () => {
  show({ phase: "ready", progress: null }, { starting: true, busy: true });
  expect(screen.getByRole("status").textContent).toContain("Checking for updates…");
  expect(stepNow()).toBe("Check for updates");
});

it("confirms once, then Update now carries the whole update", () => {
  const update = vi.fn();
  show({ phase: "idle", progress: null }, { update });
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole("alertdialog", { name: "Update localDot now?" })).getByRole("button", {
      name: "Update now",
    }),
  );
  expect(update).toHaveBeenCalledTimes(1);
});

it("offers Retry after a failure, without asking again", () => {
  const update = vi.fn();
  show(
    {
      phase: "ready",
      error: "localDot 0.1.0-rc.21 couldn't be installed, so nothing has changed.",
      progress: { step: "install", value: null, detail: null },
    },
    { update },
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(update).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toContain("The update didn't finish");
});

it("says the truth when the restart runs long or hasn't come back", () => {
  show({ phase: "installing" }, { restarting: true, wait: "slow" });
  expect(
    screen.getByText("This is taking longer than usual. This page keeps trying."),
  ).toBeTruthy();
  cleanup();
  show({ phase: "installing" }, { restarting: true, wait: "lost" });
  expect(
    screen.getByText(
      "localDot hasn't come back. On the computer running it, run localdot up. This page keeps trying.",
    ),
  ).toBeTruthy();
});

it("shows why a task holds the update back in place of a failure", () => {
  show(
    { phase: "ready", progress: null },
    { error: "Finish or stop the task before updating localDot." },
  );
  expect(screen.getByText("Finish or stop the task before updating localDot.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Update steps" })).toBeNull();
  expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
});

it("tells a copy running from source what is true of it, with nothing to press", () => {
  show({
    supported: false,
    unsupported: "source-checkout",
    phase: "idle",
    progress: null,
    availableVersion: null,
    notes: [],
  });
  expect(screen.getByRole("status").textContent).toBe("This copy runs from source");
  expect(screen.getByText(/pull, rebuild, then restart localDot/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  show({
    supported: false,
    unsupported: "install-record",
    phase: "idle",
    progress: null,
    availableVersion: null,
    notes: [],
  });
  expect(screen.getByRole("status").textContent).toBe("Update localDot manually");
  expect(screen.getByText(/Run localdot update in Terminal/)).toBeTruthy();
});

describe("while it installs and restarts", () => {
  it("says so over everything, can be put aside, and comes back for the next update", () => {
    const update: AppUpdateControl = {
      status: {
        ...base,
        phase: "installing",
        updating: true,
        progress: { step: "install", value: 0.96, detail: "Checking the download once more" },
      },
      error: null,
      busy: false,
      starting: false,
      restarting: false,
      reconnecting: false,
      wait: "normal",
      check: vi.fn(),
      update: vi.fn(),
      preferences: vi.fn(),
    };
    const { rerender } = render(<AppUpdateOverlay update={update} />);
    const dialog = screen.getByRole("alertdialog", { name: "Updating localDot to 0.1.0-rc.21" });
    expect(within(dialog).getByText("Checking the download once more")).toBeTruthy();
    rerender(<AppUpdateOverlay update={{ ...update, restarting: true }} />);
    expect(within(dialog).getByText("Starting localDot 0.1.0-rc.21")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide" }));
    rerender(
      <AppUpdateOverlay
        update={{ ...update, status: { ...base, phase: "ready", progress: null } }}
      />,
    );
    rerender(<AppUpdateOverlay update={update} />);
    expect(
      screen.getByRole("alertdialog", { name: "Updating localDot to 0.1.0-rc.21" }),
    ).toBeTruthy();
  });
});
