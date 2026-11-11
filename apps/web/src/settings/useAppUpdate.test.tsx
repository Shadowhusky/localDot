// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type AppUpdateStatus,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import type { ApiClient } from "../lib/api.ts";
import { ApiError } from "../lib/api.ts";
import { useAppUpdate } from "./useAppUpdate.ts";

const toasts = vi.hoisted(() => ({ show: vi.fn(), dismiss: vi.fn() }));
vi.mock("../ui/Toast.tsx", () => ({ showToast: toasts.show, dismissToast: toasts.dismiss }));

const base: AppUpdateStatus = {
  supported: true,
  installOnLaunchSupported: false,
  currentVersion: "0.1.0-rc.90",
  phase: "ready",
  preferences: { ...DEFAULT_APP_UPDATES },
  checkedAt: 1,
  availableVersion: "0.1.0-rc.91",
  dismissedVersion: "0.1.0-rc.91",
  error: null,
  progress: { step: "install", value: 0.95, detail: "Ready to install" },
  notes: [{ version: "0.1.0-rc.91", markdown: "## Fixes\n\n- Better." }],
  updating: false,
  unsupported: null,
  waiting: null,
  holders: [],
};
let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload, origin: "http://x" });
  vi.stubGlobal("navigator", { ...navigator, serviceWorker: { register: vi.fn(async () => {}) } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  toasts.show.mockReset();
  toasts.dismiss.mockReset();
});
function fixture(initial: Partial<AppUpdateStatus> = {}) {
  const state = {
    status: { ...base, ...initial } as AppUpdateStatus,
    down: false as boolean | number,
    gets: [] as string[],
    refuse: null as ApiError | null,
  };
  const api = {
    get: vi.fn(async (path: string) => {
      state.gets.push(path);
      if (state.down === true) throw new TypeError("refused");
      if (typeof state.down === "number") throw new ApiError(state.down, "bad gateway");
      return structuredClone(state.status);
    }),
    post: vi.fn(async (_path: string, _body?: unknown) => {
      if (state.refuse) throw state.refuse;
      if (state.down) throw new TypeError("refused");
      return { accepted: true };
    }),
    put: vi.fn(async () => ({})),
  } as unknown as ApiClient;
  const hook = renderHook(() => useAppUpdate(api, true, () => {}));
  return { state, api, hook };
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it("says something the moment Update now is pressed, before the daemon answers", async () => {
  const f = fixture();
  await settle();
  vi.mocked(f.api.post).mockImplementation(() => new Promise(() => {}));
  act(() => f.hook.result.current.update());
  expect(f.hook.result.current.starting).toBe(true);
  expect(f.hook.result.current.busy).toBe(true);
  expect(f.api.post).toHaveBeenCalledWith("/api/app-update/update", { confirmShutdown: true });
});
it("presses once however many clicks there are", async () => {
  const f = fixture();
  await settle();
  act(() => {
    f.hook.result.current.update();
    f.hook.result.current.update();
  });
  expect(f.api.post).toHaveBeenCalledTimes(1);
});
it("shows the daemon's own reason a task holds the update back", async () => {
  const f = fixture();
  await settle();
  f.state.refuse = new ApiError(409, "Finish or stop the task before updating localDot.");
  act(() => f.hook.result.current.update());
  await settle();
  expect(f.hook.result.current.error).toBe("Finish or stop the task before updating localDot.");
  expect(f.hook.result.current.starting).toBe(false);
  expect(f.hook.result.current.restarting).toBe(false);
});
it("polls closely through an update, and rarely otherwise", async () => {
  const f = fixture({ phase: "idle", availableVersion: null, progress: null });
  await settle();
  const idle = f.state.gets.length;
  await pass(19_000);
  expect(f.state.gets.length).toBe(idle);
  f.state.status = { ...base, phase: "downloading", updating: true };
  await pass(1_100);
  await pass(4_000);
  expect(f.state.gets.length).toBeGreaterThanOrEqual(idle + 3);
  expect(f.state.gets.at(-1)).toContain("notes=0");
  expect(f.hook.result.current.status?.notes).toHaveLength(1);
});
it("keeps polling closely in the moment between the download and the install", async () => {
  const f = fixture({ phase: "ready", updating: true });
  await settle();
  const asked = f.state.gets.length;
  await pass(4_100);
  expect(f.state.gets.length).toBeGreaterThanOrEqual(asked + 2);
});
it("takes a lost daemon during an install as the restart, not a failure", async () => {
  const f = fixture({ phase: "installing", updating: true });
  await settle();
  f.state.down = true;
  await pass(2_100);
  expect(f.hook.result.current).toMatchObject({ restarting: true, wait: "normal", error: null });
  f.state.down = 502;
  await pass(2_100);
  expect(f.hook.result.current).toMatchObject({ restarting: true, error: null });
});
it("says so plainly when a restart runs long, and never stops trying", async () => {
  const f = fixture({ phase: "installing", updating: true });
  await settle();
  f.state.down = true;
  await pass(95_000);
  expect(f.hook.result.current.wait).toBe("slow");
  await pass(5 * 60_000);
  expect(f.hook.result.current.wait).toBe("lost");
  const asked = f.state.gets.length;
  await pass(10_000);
  expect(f.state.gets.length).toBeGreaterThan(asked);
  f.state.down = false;
  f.state.status = { ...base, phase: "ready", error: "localDot 0.1.0-rc.91 didn't start." };
  await pass(2_100);
  expect(f.hook.result.current).toMatchObject({ restarting: false, wait: "normal" });
});
it("a 404 from something answering for a stopped daemon doesn't end the wait", async () => {
  const f = fixture({ phase: "installing", updating: true });
  await settle();
  f.state.down = 404;
  await pass(2_100);
  expect(f.hook.result.current.restarting).toBe(true);
  f.state.down = false;
  f.state.status = {
    ...base,
    currentVersion: "0.1.0-rc.91",
    phase: "idle",
    availableVersion: null,
  };
  await pass(2_100);
  expect(reload).toHaveBeenCalled();
});
it("a Update now whose answer never came reads as the restart, not as a failure", async () => {
  const f = fixture();
  await settle();
  f.state.down = true;
  act(() => f.hook.result.current.update());
  await settle();
  expect(f.hook.result.current).toMatchObject({ restarting: true, error: null });
});
it("waits for the new version's checks before it reloads", async () => {
  const f = fixture({ phase: "installing", updating: true });
  await settle();
  f.state.status = {
    ...base,
    currentVersion: "0.1.0-rc.91",
    phase: "installing",
    updating: true,
    availableVersion: null,
    progress: { step: "restart", value: 0.99, detail: "Checking localDot 0.1.0-rc.91" },
  };
  await pass(2_100);
  expect(reload).not.toHaveBeenCalled();
  expect(f.hook.result.current.reconnecting).toBe(true);
  f.state.status = { ...f.state.status, phase: "idle", updating: false, progress: null };
  await pass(2_100);
  expect(reload).toHaveBeenCalledTimes(1);
});
it("doesn't claim an update that rolled back: it says what the daemon says, with Retry", async () => {
  localStorage.setItem("localdot.app-version", "0.1.0-rc.91");
  localStorage.setItem("localdot.app-update", "0.1.0-rc.91");
  const failure =
    "localDot 0.1.0-rc.91 started but failed its checks, so your previous version was restored.";
  fixture({ error: failure, progress: { step: "restart", value: null, detail: null } });
  await settle();
  const titles = toasts.show.mock.calls.map(([options]) => options.title);
  expect(titles).not.toContain("Updated to 0.1.0-rc.90");
  expect(toasts.show.mock.calls.map(([options]) => options)).toContainEqual(
    expect.objectContaining({
      title: "The update didn't finish",
      description: failure,
      tone: "danger",
      action: expect.objectContaining({ label: "Retry" }),
    }),
  );
});
it("stays quiet about a background download that failed unasked", async () => {
  fixture({
    phase: "idle",
    error: "localDot 0.1.0-rc.91 couldn't be downloaded, so nothing has changed.",
    progress: { step: "download", value: 0.02, detail: null },
  });
  await settle();
  expect(toasts.show.mock.calls.map(([options]) => options.title)).not.toContain(
    "The update didn't finish",
  );
});
it("says Updated once the new version is really running", async () => {
  localStorage.setItem("localdot.app-version", "0.1.0-rc.90");
  const f = fixture({
    currentVersion: "0.1.0-rc.91",
    phase: "installing",
    updating: true,
    availableVersion: null,
  });
  await settle();
  expect(toasts.show).not.toHaveBeenCalledWith(
    expect.objectContaining({ title: "Updated to 0.1.0-rc.91" }),
  );
  f.state.status = { ...f.state.status, phase: "idle", updating: false, progress: null };
  await pass(2_100);
  expect(toasts.show).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Updated to 0.1.0-rc.91" }),
  );
});
it("every device shows an asked-for download wherever it is looking, and offers the detail", async () => {
  const f = fixture({
    phase: "downloading",
    updating: true,
    progress: { step: "download", value: 0.03, detail: "Downloading · 42% · 8 of 19 MB" },
  });
  await settle();
  const going = toasts.show.mock.calls
    .map(([options]) => options)
    .find((o) => o.id === "app-update-going");
  expect(going).toMatchObject({ title: "Updating localDot", action: { label: "Details" } });
  const live = render(going.live);
  expect(live.container.textContent).toBe("Updating localDot · Downloading · 42% · 8 of 19 MB");
  f.state.status = {
    ...f.state.status,
    progress: { step: "download", value: 0.05, detail: "Downloading · 80% · 15 of 19 MB" },
  };
  await pass(2_100);
  expect(live.container.textContent).toBe("Updating localDot · Downloading · 80% · 15 of 19 MB");
  f.state.status = { ...f.state.status, phase: "ready", updating: false };
  await pass(2_100);
  expect(toasts.dismiss).toHaveBeenCalledWith("app-update-going");
});
it("keeps a background download out of the way", async () => {
  fixture({
    phase: "downloading",
    updating: false,
    progress: { step: "download", value: 0.03, detail: "Downloading · 42% · 8 of 19 MB" },
  });
  await settle();
  expect(
    toasts.show.mock.calls.map(([options]) => options).find((o) => o.id === "app-update-going"),
  ).toBeUndefined();
});
it("leaves a page ready for a reload during the restart", async () => {
  const f = fixture({ phase: "installing", updating: true });
  await settle();
  expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  expect(localStorage.getItem("localdot.app-update")).toBe("0.1.0-rc.91");
  f.state.status = { ...base };
  await pass(2_100);
  expect(localStorage.getItem("localdot.app-update")).toBeNull();
});
it("says a daemon that went away unasked is only unreachable, in calm words", async () => {
  const f = fixture({ phase: "idle", availableVersion: null, progress: null });
  await settle();
  f.state.down = true;
  await pass(20_100);
  expect(f.hook.result.current.restarting).toBe(false);
  expect(f.hook.result.current.error).toBe(
    "localDot isn't answering right now. This page reconnects by itself.",
  );
});
