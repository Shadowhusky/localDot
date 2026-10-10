// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { RemoteAccessSettings } from "./RemoteAccessSettings.tsx";

afterEach(cleanup);
const off = {
  supported: true,
  enabled: false,
  state: "off",
  url: null as string | null,
  detail: "",
};
const online = { ...off, enabled: true, state: "online", url: "https://device--dot.example.com" };
function fixture(status = off) {
  const api = {
    get: vi.fn(async () => status),
    put: vi.fn(async () => online as typeof off),
    post: vi.fn(async () => ({
      url: `${online.url}/_remote/pair#remote=secret&code=code`,
      expiresAt: Date.now() + 60_000,
    })),
  };
  render(<RemoteAccessSettings api={api as unknown as ApiClient} />);
  return api;
}
it("shows privacy before opt-in, and only enables the relay on an explicit user action", async () => {
  const api = fixture();
  const toggle = await screen.findByRole("switch", { name: "Allow remote access" });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText(/which can process your traffic/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Privacy details" }));
  expect(screen.getByText(/not end-to-end encrypted against the relay/)).toBeTruthy();
  expect(api.put).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Copy sign-in link" })).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith("/api/remote-access", { enabled: true }),
  );
  expect(await screen.findByRole("button", { name: "Copy sign-in link" })).toBeTruthy();
});
it("creates links only on request and clears them when access is disabled", async () => {
  const api = fixture(online);
  const create = await screen.findByRole("button", { name: "Copy sign-in link" });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(create);
  expect(await screen.findByRole("textbox", { name: "Remote sign-in link" })).toBeTruthy();
  api.put.mockResolvedValueOnce(off);
  fireEvent.click(screen.getByRole("switch", { name: "Allow remote access" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith("/api/remote-access", { enabled: false }),
  );
  expect(screen.queryByRole("textbox", { name: "Remote sign-in link" })).toBeNull();
});

it("copies in one action and hides the long URL when copying succeeds", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const api = fixture(online);
    fireEvent.click(await screen.findByRole("button", { name: "Copy sign-in link" }));
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledOnce();
    expect(api.post).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "Remote sign-in link" })).toBeNull();
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  }
});
