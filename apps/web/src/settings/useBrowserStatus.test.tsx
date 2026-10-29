// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserStatus } from "../../../../packages/protocol/src/browser-control.ts";
import { createApi } from "../lib/api.ts";
import { AccountsSection } from "./AccountsSection.tsx";
import type { AccountsView } from "./useAccounts.ts";
import { useBrowserStatus } from "./useBrowserStatus.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ORIGIN = "https://owned.invalid";
const CELL = "01J00000000000000000000001";

function setup(replies: { status: number; body: unknown }[], cell: string | null = CELL) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    return new Response(JSON.stringify(reply?.body ?? {}), { status: reply?.status ?? 500 });
  });
  const api = createApi("fixture", { origin: ORIGIN, fetchImpl });
  const hook = renderHook((visible: boolean) => useBrowserStatus(api, cell, visible), {
    initialProps: true,
  });
  const calls = () =>
    fetchImpl.mock.calls.map(([url, init]) => [
      String(url).replace(ORIGIN, ""),
      init?.method ?? "GET",
    ]);
  return { fetchImpl, hook, calls };
}

it("reads the web browser's state only while Settings is open and the computer is on", async () => {
  const off = setup([{ status: 200, body: { state: "ready" } }], null);
  expect(off.hook.result.current.status).toBeNull();
  expect(off.fetchImpl).not.toHaveBeenCalled();
  const { hook, calls } = setup([{ status: 200, body: { state: "ready", restarts: 0 } }]);
  await waitFor(() => expect(hook.result.current.status).toEqual({ state: "ready", restarts: 0 }));
  expect(calls()[0]).toEqual([`/api/cells/${CELL}/browser`, "GET"]);
});

it("restarts the browser and shows what the daemon says", async () => {
  const { hook, calls } = setup([
    { status: 200, body: { state: "ready" } },
    { status: 202, body: { state: "restarting" } },
    { status: 200, body: { state: "restarting" } },
  ]);
  await waitFor(() => expect(hook.result.current.status?.state).toBe("ready"));
  act(() => hook.result.current.restart());
  expect(hook.result.current.requesting).toBe(true);
  await waitFor(() => expect(hook.result.current.requesting).toBe(false));
  expect(hook.result.current.status?.state).toBe("restarting");
  expect(calls()).toContainEqual([`/api/cells/${CELL}/browser/restart`, "POST"]);
});

it("offers Restart web browser in Settings and says what went wrong", () => {
  const accounts: AccountsView = {
    phase: "ready",
    sites: [],
    pending: null,
    failure: null,
    reload: vi.fn(),
    signOut: vi.fn(),
    clearAll: vi.fn(async () => true),
  };
  const restart = vi.fn();
  render(
    <AccountsSection
      accounts={accounts}
      browser={{
        status: {
          state: "ready",
          problem: "The browser process ended (exited on SIGKILL) and was restarted.",
          problemAt: new Date().toISOString(),
        },
        requesting: false,
        failure: null,
        restart,
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "The browser process ended (exited on SIGKILL) and was restarted.",
  );
  act(() => screen.getByRole("button", { name: "Restart web browser" }).click());
  expect(restart).toHaveBeenCalledOnce();
});

it("says why the web browser is off or limited, and what clears it", () => {
  const accounts: AccountsView = {
    phase: "ready",
    sites: [],
    pending: null,
    failure: null,
    reload: vi.fn(),
    signOut: vi.fn(),
    clearAll: vi.fn(async () => true),
  };
  const view = (status: BrowserStatus) => {
    cleanup();
    render(
      <AccountsSection
        accounts={accounts}
        browser={{ status, requesting: false, failure: null, restart: vi.fn() }}
      />,
    );
    return screen.getByRole("status").textContent;
  };
  expect(
    view({
      state: "off",
      reason: "key-service-offline",
      problem: "localDot's key service isn't answering.",
      clears: "The web browser then starts by itself.",
    }),
  ).toBe("localDot's key service isn't answering. The web browser then starts by itself.");
  expect(
    screen.getByRole("button", { name: "Restart web browser" }).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(
    view({
      state: "ready",
      reason: "keys-locked",
      problem: "Saved keys are locked.",
      clears: "Unlock saved keys in localDot (Keys).",
    }),
  ).toBe("Saved keys are locked. Unlock saved keys in localDot (Keys).");
  expect(
    view({
      state: "failed",
      reason: "failed",
      problem: "The web browser couldn't start: Docker busy.",
      clears: "Restart the web browser.",
    }),
  ).toBe("The web browser couldn't start: Docker busy. Restart the web browser.");
  expect(
    view({ state: "off", reason: "computer-stopped", problem: "The computer is not running." }),
  ).toBe("");
});
