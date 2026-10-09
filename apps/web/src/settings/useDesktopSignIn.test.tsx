// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { DESKTOP_SIGN_IN_EVERY_MS, useDesktopSignIn } from "./useDesktopSignIn.ts";

const toasts = vi.hoisted(() => ({ show: vi.fn(), dismiss: vi.fn() }));
vi.mock("../ui/Toast.tsx", () => ({ showToast: toasts.show, dismissToast: toasts.dismiss }));

const ORIGIN = "https://owned.invalid";
const CELL = "01J00000000000000000000001";

beforeEach(() => {
  vi.useFakeTimers();
  toasts.show.mockClear();
  toasts.dismiss.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(sites: (string | null)[], offer?: (site: string) => void, watching = true) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ site: sites.shift() ?? null }));
  const api = createApi("fixture", { origin: ORIGIN, fetchImpl });
  const hook = renderHook(
    (props: { watching: boolean }) =>
      useDesktopSignIn({ api, cellId: CELL, watching: props.watching, offer }),
    { initialProps: { watching } },
  );
  return { fetchImpl, hook };
}

it("offers a sign-in page's site in the web browser while the user holds the desktop", async () => {
  const offer = vi.fn();
  const f = setup([null, "google.com"], offer);
  await act(async () => {});
  expect(toasts.show).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DESKTOP_SIGN_IN_EVERY_MS);
  });
  expect(String(f.fetchImpl.mock.calls[1]?.[0])).toBe(
    `${ORIGIN}/api/cells/${CELL}/desktop-sign-in`,
  );
  expect(toasts.show).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "desktop-sign-in",
      title: "Sign-ins here aren't kept",
      description: "Open google.com in localDot's web browser to stay signed in.",
      action: expect.objectContaining({ label: "Open in web browser" }),
    }),
  );
  toasts.show.mock.calls.at(-1)?.[0].action.onAction();
  expect(offer).toHaveBeenCalledWith("google.com");
});

it("leaves the asking to dot during a task, and goes quiet once the user stops watching", async () => {
  const f = setup(["github.com"]);
  await act(async () => {});
  const shown = toasts.show.mock.calls.at(-1)?.[0];
  expect(shown.action).toBeUndefined();
  expect(shown.description).toBe(
    "When you hand back, ask dot to sign in to github.com in the web browser.",
  );
  f.hook.rerender({ watching: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DESKTOP_SIGN_IN_EVERY_MS * 3);
  });
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(toasts.dismiss).toHaveBeenCalledWith("desktop-sign-in");
});

it("asks nothing while the user isn't on the desktop", async () => {
  const f = setup(["google.com"], undefined, false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DESKTOP_SIGN_IN_EVERY_MS * 2);
  });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(toasts.show).not.toHaveBeenCalled();
});
