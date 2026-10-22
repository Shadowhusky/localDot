// @vitest-environment jsdom
import type { AccessLinksStatus, TailscaleAccess } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { AccessLinksSettings } from "./AccessLinksSettings.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const origin = "https://host.tail123.ts.net:4750";
const page = "https://login.tailscale.com/f/serve?node=n1";
const status = (tailscale: TailscaleAccess): AccessLinksStatus => ({
  links: [{ origin: "http://localhost:4750", label: "This computer" }],
  tailscale,
});
const served = status({
  state: "served",
  origin,
  message: "Copy a link and open it on any device signed in to your Tailscale network.",
});
function fixture(first: AccessLinksStatus = served) {
  const api = {
    get: vi.fn(async (_path: string): Promise<unknown> => first),
    post: vi.fn(
      async (_path: string): Promise<unknown> => ({
        code: "a".repeat(43),
        expiresAt: Date.now() + 60000,
      }),
    ),
  };
  render(<AccessLinksSettings api={api as unknown as ApiClient} />);
  return api;
}
const tailscaleRow = () =>
  screen.getByText("Tailscale", { selector: ".ui-group-row-label" }).closest(".ui-group-row");

it("lists the addresses without creating links, and copies the chosen address on request", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const api = fixture();
  const button = await screen.findByRole("button", { name: "Copy Tailscale link" });
  expect(screen.getByRole("button", { name: "Copy this computer link" })).toBeTruthy();
  expect(tailscaleRow()?.textContent).toContain("host.tail123.ts.net:4750");
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${origin}/#code=${"a".repeat(43)}`));
  expect(api.post).toHaveBeenCalledWith("/api/install-code");
  expect(await screen.findByRole("button", { name: "Tailscale link copied" })).toBeTruthy();
});

it("provides a selectable link when clipboard access is unavailable", async () => {
  vi.stubGlobal("navigator", { clipboard: undefined });
  fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Copy Tailscale link" }));
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

it.each([
  ["not-installed", "Not installed", "Get Tailscale"],
  ["not-running", "Not running", "Check again"],
  ["needs-login", "Signed out", "Check again"],
  ["ready-to-enable", "Off", "Turn on"],
] as const)("always shows Tailscale: %s with its one next step", async (state, standing, step) => {
  const message = `Tailscale says ${state}.`;
  fixture(status({ state, message }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(tailscaleRow()?.textContent).toContain(standing);
  expect(screen.getByRole("button", { name: step })).toBeTruthy();
  expect(screen.queryByText(/LAN|Local network/)).toBeNull();
});

it("opens Tailscale's download page in a new tab when it isn't installed", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  fixture(status({ state: "not-installed", message: "Tailscale isn't installed on this Mac." }));
  fireEvent.click(await screen.findByRole("button", { name: "Get Tailscale" }));
  expect(open).toHaveBeenCalledWith(
    "https://tailscale.com/download",
    "_blank",
    "noopener,noreferrer",
  );
});

it("checks again on request, past the cached answer", async () => {
  const api = fixture(
    status({ state: "not-running", message: "Tailscale is installed but not running." }),
  );
  api.get.mockResolvedValueOnce(served);
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("button", { name: "Copy Tailscale link" })).toBeTruthy();
  expect(api.get).toHaveBeenLastCalledWith("/api/access-links?fresh=1");
});

it("turns Tailscale on, offers its approval page, and shows the address once allowed", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const api = fixture(status({ state: "ready-to-enable", origin, message: "Turn on." }));
  api.post.mockResolvedValueOnce(
    status({ state: "needs-approval", origin, approvalUrl: page, message: "Allow HTTPS." }),
  );
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
  expect(api.post).toHaveBeenCalledWith("/api/access-links/tailscale");
  fireEvent.click(await screen.findByRole("button", { name: "Allow HTTPS" }));
  expect(open).toHaveBeenCalledWith(page, "_blank", "noopener,noreferrer");
  expect(tailscaleRow()?.textContent).toContain("Waiting for you to allow HTTPS");
  api.get.mockResolvedValue(served);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(await screen.findByRole("button", { name: "Copy Tailscale link" })).toBeTruthy();
  expect(screen.getByText(served.tailscale.message).getAttribute("role")).toBe("status");
});

it("shows the operator command on Linux and lets the user turn on again", async () => {
  const api = fixture(
    status({
      state: "unavailable",
      reason: "permission",
      message: "Tailscale needs your permission.",
      operatorHint: "sudo tailscale set --operator=$USER",
    }),
  );
  expect(await screen.findByText("sudo tailscale set --operator=$USER")).toBeTruthy();
  expect(tailscaleRow()?.textContent).toContain("Needs your permission");
  api.post.mockResolvedValueOnce(served);
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  expect(await screen.findByRole("button", { name: "Copy Tailscale link" })).toBeTruthy();
});

it("names a problem it can't fix and keeps Check again", async () => {
  fixture(
    status({
      state: "unavailable",
      reason: "port-taken",
      message: "Tailscale already shares something else on port 4750.",
    }),
  );
  expect(await screen.findByText(/already shares something else/)).toBeTruthy();
  expect(tailscaleRow()?.textContent).toContain("Port in use");
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
});

it("asks for a restart when the running localDot predates Tailscale's state", async () => {
  fixture({ links: served.links } as AccessLinksStatus);
  expect(
    await screen.findByText("Restart localDot on this computer to set up Tailscale here."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
});
