// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { AccountsSection } from "./AccountsSection.tsx";
import type { AccountsView } from "./useAccounts.ts";
import { SIGN_IN_WAIT_MS, type SignInView, useSignIn } from "./useSignIn.ts";

afterEach(() => {
  cleanup();
});

const ORIGIN = "https://owned.invalid";
const CELL = "01J00000000000000000000001";
const SESSION = "01J00000000000000000000002";
const REQUEST = "01J00000000000000000000003";

function setup(
  reply: (signal?: AbortSignal | null) => Promise<Response>,
  cell: string | null = CELL,
) {
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => reply(init?.signal));
  const api = createApi("fixture", { origin: ORIGIN, fetchImpl });
  const opened = vi.fn();
  const hook = renderHook(() => useSignIn(api, cell, opened));
  const sent = () =>
    fetchImpl.mock.calls.map(([url, init]) => [
      String(url).replace(ORIGIN, ""),
      init?.method,
      init?.body,
    ]);
  return { hook, opened, sent };
}

it("asks the computer to open the site the person typed, then lets the page show it", async () => {
  const f = setup(async () =>
    Response.json({ sessionId: SESSION, requestId: REQUEST }, { status: 202 }),
  );
  let started = false;
  await act(async () => {
    started = await f.hook.result.current.start(" https://www.Google.com/mail ");
  });
  expect(started).toBe(true);
  expect(f.sent()).toEqual([
    [`/api/cells/${CELL}/accounts/sign-in`, "POST", JSON.stringify({ site: "google.com" })],
  ]);
  expect(f.opened).toHaveBeenCalledWith("google.com");
  expect(f.hook.result.current.pending).toBeNull();
  expect(f.hook.result.current.failure).toBeNull();
});

it("says plainly why nothing opened", async () => {
  for (const [status, message] of [
    [409, "dot is using your computer. Sign in when it's done, or ask dot to open the site."],
    [503, "The web browser couldn't open. Try again in a moment."],
    [400, "That isn't a site the web browser can open."],
  ] as const) {
    const f = setup(async () => new Response("refused", { status }));
    await act(async () => {
      expect(await f.hook.result.current.start("google.com")).toBe(false);
    });
    expect(f.hook.result.current.failure).toBe(message);
    expect(f.opened).not.toHaveBeenCalled();
    cleanup();
  }
});

it("asks nothing for what isn't a site, or with the computer off", async () => {
  const f = setup(async () => new Response(null, { status: 500 }));
  await act(async () => {
    expect(await f.hook.result.current.start("localhost")).toBe(false);
  });
  expect(f.hook.result.current.failure).toBe(
    "The web browser opens public sites only, like google.com.",
  );
  await act(async () => {
    expect(await f.hook.result.current.start("  ")).toBe(false);
  });
  expect(f.hook.result.current.failure).toBe("Enter a site, like google.com.");
  expect(f.sent()).toEqual([]);
  cleanup();
  const off = setup(async () => new Response(null, { status: 500 }), null);
  await act(async () => {
    expect(await off.hook.result.current.start("google.com")).toBe(false);
  });
  expect(off.hook.result.current.failure).toBe("Turn on your computer first.");
});

it("lets the page look for the web browser when the reply doesn't come in time", async () => {
  vi.useFakeTimers();
  try {
    const f = setup(
      (signal) =>
        new Promise<Response>((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    let started: Promise<boolean> | undefined;
    act(() => {
      started = f.hook.result.current.start("github.com");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_WAIT_MS);
    });
    expect(await started).toBe(true);
    expect(f.opened).toHaveBeenCalledWith("github.com");
    expect(f.hook.result.current.failure).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("says nothing opened when the daemon can't be reached", async () => {
  const f = setup(async () => {
    throw new TypeError("network went away");
  });
  await act(async () => {
    expect(await f.hook.result.current.start("github.com")).toBe(false);
  });
  expect(f.opened).not.toHaveBeenCalled();
  expect(f.hook.result.current.failure).toBe("Couldn't open the site. Try again.");
});

it("hands a failure to the caller that asked for it, not to the form", async () => {
  const f = setup(async () => new Response("refused", { status: 503 }));
  const failed = vi.fn();
  await act(async () => {
    expect(await f.hook.result.current.start("google.com", failed)).toBe(false);
  });
  expect(failed).toHaveBeenCalledWith("The web browser couldn't open. Try again in a moment.");
  expect(f.hook.result.current.failure).toBeNull();
});

const ready: AccountsView = {
  phase: "ready",
  sites: [],
  pending: null,
  failure: null,
  reload: () => {},
  signOut: () => {},
  clearAll: async () => true,
};

function signInView(patch: Partial<SignInView> = {}): SignInView {
  return {
    pending: null,
    failure: null,
    start: vi.fn(async () => true),
    clear: vi.fn(),
    ...patch,
  };
}

it("says where sign-ins are kept and offers to sign in to a typed or common site", async () => {
  const signIn = signInView();
  render(<AccountsSection accounts={ready} signIn={signIn} />);
  expect(
    screen.getByText(/localDot keeps website sign-ins between tasks.*its sign-in may have expired/),
  ).toBeTruthy();
  expect(screen.getByText("Sign in to a site")).toBeTruthy();
  const field = screen.getByRole("textbox", { name: "Site" });
  await act(async () => {
    field.focus();
  });
  await act(async () => {
    const input = field as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "notion.so");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    screen.getByRole("button", { name: "Sign in" }).click();
  });
  expect(signIn.start).toHaveBeenCalledWith("notion.so");
  await act(async () => {
    screen.getByRole("button", { name: "GitHub" }).click();
  });
  expect(signIn.start).toHaveBeenLastCalledWith("github.com");
  expect(
    screen
      .getAllByRole("button")
      .filter((button) => button.closest(".settings-signin-sites"))
      .map((button) => button.textContent),
  ).toEqual(["Google", "Microsoft", "Apple", "GitHub"]);
});

it("holds sign-in while the computer is off and shows why one failed", async () => {
  const signIn = signInView({ failure: "The web browser couldn't open. Try again in a moment." });
  render(<AccountsSection accounts={{ ...ready, phase: "off" }} signIn={signIn} />);
  await act(async () => {
    screen.getByRole("button", { name: "Sign in" }).click();
    screen.getByRole("button", { name: "Google" }).click();
  });
  expect(signIn.start).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("The web browser couldn't open.");
});
