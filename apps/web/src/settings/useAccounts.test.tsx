// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { STARTING_RETRY_MS, useAccounts } from "./useAccounts.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ORIGIN = "https://owned.invalid";
const CELL = "01J00000000000000000000001";
const GOOGLE = { site: "google.com", hosts: ["accounts.google.com"], cookies: 3 };
const TELEGRAM = { site: "telegram.org", hosts: ["web.telegram.org"], cookies: 1 };
type Reply = { status: number; body?: unknown };

function setup(replies: Reply[], cell: string | null = CELL, open = true) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const reply = replies.shift() ?? { status: 500 };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  });
  const api = createApi("fixture", { origin: ORIGIN, fetchImpl });
  const hook = renderHook((visible: boolean) => useAccounts(api, cell, visible), {
    initialProps: open,
  });
  const call = (n: number) => {
    const [url, init] = fetchImpl.mock.calls[n] ?? [];
    return [String(url).replace(ORIGIN, ""), init?.method ?? "GET", init?.body];
  };
  return { fetchImpl, hook, call };
}

it("reads the sites only while Settings is open and the computer is on", async () => {
  const off = setup([], null);
  expect(off.hook.result.current.phase).toBe("off");
  expect(off.fetchImpl).not.toHaveBeenCalled();
  const { fetchImpl, hook, call } = setup(
    [{ status: 200, body: { sites: [GOOGLE] } }],
    CELL,
    false,
  );
  expect(fetchImpl).not.toHaveBeenCalled();
  hook.rerender(true);
  await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
  expect(call(0)).toEqual([`/api/cells/${CELL}/accounts`, "GET", undefined]);
  expect(hook.result.current.sites).toEqual([GOOGLE]);
});

it("waits for a starting browser and asks again, then shows the sites", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { fetchImpl, hook } = setup([
    { status: 503, body: "starting" },
    { status: 200, body: { sites: [] } },
  ]);
  await waitFor(() => expect(hook.result.current.phase).toBe("starting"));
  await act(() => vi.advanceTimersByTimeAsync(STARTING_RETRY_MS));
  await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(hook.result.current.sites).toEqual([]);
});

it("treats a stopped computer and a malformed reply apart", async () => {
  const stopped = setup([{ status: 409, body: "the computer is off" }]);
  await waitFor(() => expect(stopped.hook.result.current.phase).toBe("off"));
  const broken = setup([{ status: 200, body: { sites: [{ site: "x", cookies: 1 }] } }]);
  await waitFor(() => expect(broken.hook.result.current.phase).toBe("error"));
});

it("signs out of one site and shows what is left; a failure is said, not hidden", async () => {
  const { hook, call } = setup([
    { status: 200, body: { sites: [GOOGLE, TELEGRAM] } },
    { status: 200, body: { sites: [TELEGRAM] } },
    { status: 503, body: "not ready" },
  ]);
  await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
  act(() => hook.result.current.signOut("google.com"));
  expect(hook.result.current.pending).toBe("google.com");
  await waitFor(() => expect(hook.result.current.pending).toBeNull());
  expect(call(1)).toEqual([
    `/api/cells/${CELL}/accounts/sign-out`,
    "POST",
    JSON.stringify({ site: "google.com" }),
  ]);
  expect(hook.result.current.sites).toEqual([TELEGRAM]);
  act(() => hook.result.current.signOut("telegram.org"));
  await waitFor(() => expect(hook.result.current.pending).toBeNull());
  expect(hook.result.current.failure).toBe("Couldn't sign out of telegram.org. Try again.");
  expect(hook.result.current.sites).toEqual([TELEGRAM]);
});

it("clears every sign-in", async () => {
  const { hook, call } = setup([
    { status: 200, body: { sites: [GOOGLE] } },
    { status: 200, body: { sites: [] } },
  ]);
  await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
  let cleared = false;
  await act(async () => {
    cleared = await hook.result.current.clearAll();
  });
  expect(cleared).toBe(true);
  expect(call(1)).toEqual(["/api/accounts/clear", "POST", undefined]);
  expect(hook.result.current.sites).toEqual([]);
});
