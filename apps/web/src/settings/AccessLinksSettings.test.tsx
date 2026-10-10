// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { AccessLinksSettings } from "./AccessLinksSettings.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const origin = "https://host.tail123.ts.net:4750";
function fixture() {
  const api = {
    get: vi.fn(async () => ({
      links: [
        {
          origin: "http://localhost:4750",
          label: "This computer",
          description: "Only on the host computer.",
        },
        { origin, label: "Tailscale", description: "Connect to Tailscale." },
      ],
    })),
    post: vi.fn(async () => ({ code: "a".repeat(43), expiresAt: Date.now() + 60000 })),
  };
  render(<AccessLinksSettings api={api as unknown as ApiClient} />);
  return api;
}
it("lists the addresses without creating links, and copies the chosen address on request", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const api = fixture();
  const button = await screen.findByRole("button", { name: "Copy tailscale link" });
  expect(screen.getByRole("button", { name: "Copy this computer link" })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${origin}/#code=${"a".repeat(43)}`));
  expect(api.post).toHaveBeenCalledWith("/api/install-code");
  expect(await screen.findByRole("button", { name: "Tailscale link copied" })).toBeTruthy();
});
it("provides a selectable link when clipboard access is unavailable", async () => {
  vi.stubGlobal("navigator", { clipboard: undefined });
  fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Copy tailscale link" }));
  expect(
    ((await screen.findByRole("textbox", { name: "App sign-in link" })) as HTMLInputElement).value,
  ).toBe(`${origin}/#code=${"a".repeat(43)}`);
});

it("explains when the running backend still needs the update", async () => {
  const api = {
    get: vi.fn(async () => {
      throw new ApiError(404, "Not found");
    }),
    post: vi.fn(),
  };
  render(<AccessLinksSettings api={api as unknown as ApiClient} />);
  expect((await screen.findByRole("alert")).textContent).toContain("updated and restarted");
  expect(api.post).not.toHaveBeenCalled();
});
