// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { useBrowserRelaunching } from "../stage/browser-relaunch.ts";
import { BrowserSignIn } from "./BrowserSignIn.tsx";
import { controlRequest } from "./control-api.ts";

vi.mock("./control-api.ts", () => ({ controlRequest: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const props = {
  api: createApi("fixture"),
  sessionId: "01J00000000000000000000002",
  requestId: "01J00000000000000000000003",
};
it("starts only on a user click, and reports actual mode after a lost reply", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({ available: true, mode: "standard", changing: false })
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce({ available: true, mode: "signin", changing: false });
  render(<BrowserSignIn {...props} />);
  const button = await screen.findByRole("button", { name: "Sign in without agent control" });
  expect(controlRequest).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  await screen.findByText(/Sign-in mode is on/);
  expect(
    vi.mocked(controlRequest).mock.calls.map((call) => (call[2] as { action: string }).action),
  ).toEqual(["status", "start", "status"]);
});
it("does not offer the operation for an old browser image", async () => {
  vi.mocked(controlRequest).mockResolvedValue({ available: false });
  render(<BrowserSignIn {...props} />);
  await waitFor(() => expect(controlRequest).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button")).toBeNull();
});

it("observes an unfinished transition without restarting it after a reload", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({ available: true, mode: "standard", changing: true })
    .mockResolvedValueOnce({ available: true, mode: "signin", changing: false });
  const seen: boolean[] = [];
  function Stage() {
    seen.push(useBrowserRelaunching());
    return null;
  }
  render(
    <>
      <BrowserSignIn {...props} />
      <Stage />
    </>,
  );
  await screen.findByText(/Restarting the browser without dot's connection/);
  // The screen covers the restart while it lasts, and lets go once the browser is back.
  expect(seen).toContain(true);
  await screen.findByText(/Sign-in mode is on/);
  await waitFor(() => expect(seen.at(-1)).toBe(false));
  expect(
    vi.mocked(controlRequest).mock.calls.map((call) => (call[2] as { action: string }).action),
  ).toEqual(["status", "status"]);
});

const standard = { available: true, mode: "standard", changing: false } as const;
const actions = () =>
  vi.mocked(controlRequest).mock.calls.map((call) => (call[2] as { action: string }).action);

it("goes straight to sign-in mode on Google's sign-in page, and says why in one line", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({ ...standard, page: { ownBrowser: true } })
    .mockResolvedValueOnce({ available: true, mode: "signin", changing: false });
  render(<BrowserSignIn {...props} />);
  await screen.findByText(/Sign-in mode is on/);
  expect(actions()).toEqual(["status", "start"]);
  expect(screen.getByText(/Google blocks browsers under agent control/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in without agent control" })).toBeNull();
});

it("leaves the choice in view when that start fails, without trying again by itself", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({ ...standard, page: { ownBrowser: true } })
    .mockRejectedValueOnce(new Error("lost"))
    .mockResolvedValueOnce({ ...standard, page: { ownBrowser: true } });
  render(<BrowserSignIn {...props} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't confirm sign-in mode");
  expect(screen.getByRole("button", { name: "Sign in without agent control" })).toBeTruthy();
  expect(actions()).toEqual(["status", "start", "status"]);
});

it("doesn't restart the browser for any other page", async () => {
  vi.mocked(controlRequest).mockResolvedValue({ ...standard });
  render(<BrowserSignIn {...props} />);
  await screen.findByRole("button", { name: "Sign in without agent control" });
  expect(actions()).toEqual(["status"]);
});

it("offers a saved login with one tap, and shows no password anywhere", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({
      ...standard,
      page: { saved: { site: "github.com", username: "octo@example.com" } },
    })
    .mockResolvedValueOnce({ ...standard, fill: "submitted" });
  const view = render(<BrowserSignIn {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in as octo@example.com" }));
  await waitFor(() => expect(actions()).toEqual(["status", "fill"]));
  expect(view.container.innerHTML).not.toMatch(/password"/);
});

it("carries one tap across a page that asks for the account first", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({
      ...standard,
      page: { saved: { site: "github.com", username: "octo" } },
    })
    .mockResolvedValueOnce({ ...standard, fill: "account" })
    .mockResolvedValueOnce({ ...standard, fill: "no-field" })
    .mockResolvedValueOnce({ ...standard, fill: "submitted" });
  render(<BrowserSignIn {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in as octo" }));
  await waitFor(
    () => expect(actions()).toEqual(["status", "fill", "fill-password", "fill-password"]),
    { timeout: 4000 },
  );
  expect(screen.queryByText(/no sign-in box/)).toBeNull();
});

it("says plainly when nothing was filled", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({
      ...standard,
      page: { saved: { site: "github.com", username: "octo" } },
    })
    .mockResolvedValueOnce({ ...standard, fill: "form" });
  render(<BrowserSignIn {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in as octo" }));
  await screen.findByText(/couldn't be verified, so nothing was filled/);
});

it("is honest about passkeys, and that sign-in mode can't fill", async () => {
  vi.mocked(controlRequest)
    .mockResolvedValueOnce({ ...standard })
    .mockResolvedValueOnce({ available: true, mode: "signin", changing: false });
  render(<BrowserSignIn {...props} />);
  await screen.findByText(/Passkeys and security keys can't work in this browser/);
  fireEvent.click(screen.getByRole("button", { name: "Sign in without agent control" }));
  await screen.findByText(/Saved logins can't be filled here/);
});
