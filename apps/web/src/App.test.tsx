// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { TOKEN_KEY } from "./lib/token.ts";

const ok = async () =>
  new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
const unauthorized = async () => new Response("unauthorized", { status: 401 });

describe("App token states", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  // Vitest runs without globals, so Testing Library's automatic cleanup never registers.
  afterEach(cleanup);

  it("asks for the token when none is stored", () => {
    render(<App fetchImpl={ok as typeof fetch} />);
    expect(screen.getByRole("alert").textContent).toContain("No access token");
  });

  it("connects with a stored token", async () => {
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(43));
    render(<App fetchImpl={ok as typeof fetch} />);
    expect(await screen.findByText("Connected to the daemon.")).toBeTruthy();
  });

  it("forgets a rejected token and says so, without asking the daemon again", async () => {
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(43));
    const fetchImpl = vi.fn(unauthorized);
    render(<App fetchImpl={fetchImpl} />);
    expect(await screen.findByText(/rejected the stored token/)).toBeTruthy();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("takes a token link opened in the tab that already shows the page", async () => {
    render(<App fetchImpl={ok as typeof fetch} />);
    expect(screen.getByRole("alert").textContent).toContain("No access token");
    window.location.hash = `#token=${"a".repeat(43)}`;
    expect(await screen.findByText("Connected to the daemon.")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("a".repeat(43));
  });
});
