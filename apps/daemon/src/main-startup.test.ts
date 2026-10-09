import { expect, it, vi } from "vitest";
import { type DaemonStartup, describeStartupError, runDaemonStartup } from "./main-startup.ts";

const cell = "01M4FZ3F217N08J98Y5PNM9308";
function steps(overrides: Partial<DaemonStartup> = {}) {
  const order: string[] = [];
  const step = (name: string) => vi.fn(async () => void order.push(name));
  const s: DaemonStartup = {
    stopping: () => false,
    restorePrepared: step("restorePrepared"),
    recoverBrowsers: step("recoverBrowsers"),
    containFenced: step("containFenced"),
    startAgent: step("startAgent"),
    recoverReplacements: step("recoverReplacements"),
    reconcile: step("reconcile"),
    restoreResets: step("restoreResets"),
    openResets: vi.fn(() => void order.push("openResets")),
    ...overrides,
  };
  return { s, order };
}

it("runs every step in order and opens resets", async () => {
  const { s, order } = steps(),
    log = vi.fn();
  await runDaemonStartup(s, log);
  expect(order).toEqual([
    "restorePrepared",
    "recoverBrowsers",
    "containFenced",
    "startAgent",
    "recoverReplacements",
    "reconcile",
    "restoreResets",
    "openResets",
  ]);
  expect(log).not.toHaveBeenCalled();
});

it.each([
  "restorePrepared",
  "recoverBrowsers",
  "containFenced",
  "startAgent",
  "recoverReplacements",
  "reconcile",
  "restoreResets",
] as const)("continues the remaining steps after %s fails", async (failing) => {
  const { s, order } = steps({
    [failing]: vi.fn(async () => {
      throw new Error(`Computer ${cell} stays held: runtime does not match`);
    }),
  });
  const log = vi.fn();
  await expect(runDaemonStartup(s, log)).rejects.toThrow("startup incomplete");
  expect(order).toHaveLength(7);
  expect(order).not.toContain(failing);
  expect(order.at(-1)).toBe("openResets");
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0]?.[0]).toContain(`Computer ${cell} stays held: runtime does not match`);
});

it("names every failed step in the rejection", async () => {
  const fail = vi.fn(async () => {
    throw new Error("no");
  });
  const { s } = steps({ startAgent: fail, reconcile: fail });
  await expect(runDaemonStartup(s, () => {})).rejects.toThrow(
    "startup incomplete: agent start, computer reconcile",
  );
});

it("stops starting steps once shutdown begins and keeps resets closed", async () => {
  let stopping = false;
  const { s, order } = steps({
    stopping: () => stopping,
    containFenced: vi.fn(async () => {
      stopping = true;
    }),
  });
  await expect(runDaemonStartup(s, () => {})).rejects.toThrow("startup incomplete");
  expect(order).toEqual(["restorePrepared", "recoverBrowsers"]);
  expect(s.openResets).not.toHaveBeenCalled();
});

it("logs the cause without paths or credentials", () => {
  const text = describeStartupError(
    new Error(
      `cell ${cell}: open /Users/someone/.localdot/daemon-token failed with ${"t".repeat(43)} via unix:///var/run/docker.sock`,
    ),
  );
  expect(text).toContain(cell);
  expect(text).not.toMatch(/Users|daemon-token|docker\.sock|t{32}/);
  expect(describeStartupError("plain")).toBe("plain");
});
