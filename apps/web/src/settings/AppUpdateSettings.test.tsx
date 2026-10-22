// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type AppUpdateStatus,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import { AppUpdateSettings } from "./AppUpdateSettings.tsx";
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
};
function show(status: Partial<AppUpdateStatus>, control: Partial<AppUpdateControl> = {}) {
  const update: AppUpdateControl = {
    status: { ...base, ...status },
    error: null,
    busy: false,
    restarting: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
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
    ["Download", "done"],
    ["Check the download", "done"],
    ["Prepare the computer", "failed"],
    ["Install", "todo"],
    ["Restart", "todo"],
  ]);
  expect(screen.queryByText(/log/)).toBeNull();
});

it("says Restarting localDot while the new version starts", () => {
  show({ phase: "installing", progress: { step: "install", value: null, detail: "Installing" } });
  expect(screen.getByRole("status").textContent).toContain("Restarting localDot…");
  cleanup();
  show({ phase: "installing" }, { restarting: true });
  const bar = screen.getByRole("progressbar", { name: "Update progress" });
  expect(bar.hasAttribute("data-indeterminate")).toBe(true);
  expect(screen.getByText("Starting localDot 0.1.0-rc.21")).toBeTruthy();
});
