// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type AppUpdateStatus,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { useAppUpdate } from "./useAppUpdate.ts";

afterEach(cleanup);
const ready: AppUpdateStatus = {
  supported: true,
  installOnLaunchSupported: false,
  currentVersion: "0.1.0-rc.32",
  phase: "ready",
  preferences: { ...DEFAULT_APP_UPDATES },
  checkedAt: 1,
  availableVersion: "0.1.0-rc.33",
  dismissedVersion: null,
  error: null,
  progress: null,
  notes: [],
};
function hook(post: () => Promise<unknown>) {
  const api = { get: vi.fn(async () => ready), post: vi.fn(post) } as unknown as ApiClient;
  return renderHook(() => useAppUpdate(api, true, () => {}));
}

it("says why the daemon refused to install instead of a generic failure", async () => {
  const reason =
    "dot is still working on a task, or waiting for you to hand back control. Finish or stop it, then update localDot.";
  const { result } = hook(() => Promise.reject(new ApiError(409, reason)));
  await waitFor(() => expect(result.current.status?.phase).toBe("ready"));
  act(() => result.current.install());
  await waitFor(() => expect(result.current.error).toBe(reason));
});

it("keeps the generic message when there is no reason to show", async () => {
  const { result } = hook(() => Promise.reject(new TypeError("Failed to fetch")));
  await waitFor(() => expect(result.current.status?.phase).toBe("ready"));
  act(() => result.current.install());
  await waitFor(() =>
    expect(result.current.error).toBe("That update action couldn't complete. Try again."),
  );
});
