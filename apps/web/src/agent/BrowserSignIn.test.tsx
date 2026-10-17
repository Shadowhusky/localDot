// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
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
  render(<BrowserSignIn {...props} />);
  await screen.findByText("Switching browser mode…");
  await screen.findByText(/Sign-in mode is on/);
  expect(
    vi.mocked(controlRequest).mock.calls.map((call) => (call[2] as { action: string }).action),
  ).toEqual(["status", "status"]);
});
