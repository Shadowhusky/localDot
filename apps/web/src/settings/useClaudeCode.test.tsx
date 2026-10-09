// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ClaudeCodePanel } from "./ClaudeCodePanel.tsx";
import { useClaudeCode } from "./useClaudeCode.ts";

const signedOut = {
  state: "signed_out",
  version: "2.1.290",
  reason: "Sign in to Claude Code, then check again.",
  command: "claude auth login",
  models: [],
  checkedAt: 1,
};
const signedIn = {
  state: "signed_in",
  version: "2.1.290",
  plan: "max",
  models: [{ id: "sonnet", name: "Sonnet" }],
  checkedAt: 2,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function fixture(first: unknown) {
  let status = first;
  const calls: string[] = [];
  const api = createApi("fixture", {
    origin: "https://fixture.test",
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return Response.json(status);
    },
  });
  function Harness({ active }: { active: boolean }) {
    const claude = useClaudeCode(api, active);
    return (
      <>
        <ClaudeCodePanel claude={claude} />
        <output data-testid="ready">{String(claude.canStart)}</output>
      </>
    );
  }
  return {
    calls,
    Harness,
    set(next: unknown) {
      status = next;
    },
  };
}

describe("Claude Code in Settings", () => {
  it("reads nothing until Claude Code is chosen", async () => {
    const f = fixture(signedOut);
    render(<f.Harness active={false} />);
    await act(async () => {});
    expect(f.calls).toEqual([]);
  });
  it("says what to run in Terminal, and looks again when the person comes back", async () => {
    const f = fixture(signedOut);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    render(<f.Harness active />);
    await screen.findByText("claude auth login");
    expect(screen.getByText("Sign in to Claude Code, then check again.")).toBeTruthy();
    expect(screen.getByTestId("ready").textContent).toBe("false");
    f.set(signedIn);
    // Too soon after the last look: nothing is asked.
    fireEvent.focus(window);
    expect(f.calls).toEqual(["GET /api/agent/claude-code"]);
    now.mockReturnValue(10_000);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));
    expect(f.calls).toEqual(["GET /api/agent/claude-code", "POST /api/agent/claude-code/check"]);
    expect(screen.getByText("Signed in · Max plan")).toBeTruthy();
    expect(screen.queryByText("claude auth login")).toBeNull();
    expect(
      screen.getByText("Uses your plan's limits. localDot never sees your Claude sign-in."),
    ).toBeTruthy();
    // Ready: coming back no longer asks.
    now.mockReturnValue(20_000);
    fireEvent.focus(window);
    expect(f.calls).toHaveLength(2);
  });
  it("checks again on request", async () => {
    const f = fixture(signedIn);
    render(<f.Harness active />);
    await screen.findByText("Signed in · Max plan");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(f.calls).toContain("POST /api/agent/claude-code/check"));
  });
});
