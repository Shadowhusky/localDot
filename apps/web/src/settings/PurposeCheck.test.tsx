// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { PurposeCheck } from "./PurposeCheck.tsx";

afterEach(cleanup);

import { describe, expect, it } from "vitest";
import { purposeDescription, purposeJudge } from "./PurposeCheck.tsx";

describe("the purpose check row", () => {
  const fast = { provider: "anthropic", model: "fast-model" } as const;
  it("names who checks the way the daemon chooses", () => {
    expect(purposeJudge(true, {})).toBe("jev");
    expect(purposeJudge(false, { main: fast, fast })).toBe("fast");
    expect(purposeJudge(false, { main: { provider: "chatgpt", model: "gpt-6-astra" }, fast })).toBe(
      "none",
    );
    const opus = { provider: "claude-code", model: "opus" };
    expect(purposeJudge(false, { main: opus, fast })).toBe("none");
    expect(
      purposeJudge(false, { main: opus, fast: { provider: "claude-code", model: "haiku" } }),
    ).toBe("fast");
    expect(purposeJudge(false, { main: fast })).toBe("none");
  });

  it("says who checks in the switch's own line, and what is missing when nobody can", () => {
    expect(purposeDescription({ on: true, judge: "jev", plan: "chatgpt" })).toMatch(
      /Uses Jev when a judgment is needed\.$/,
    );
    expect(purposeDescription({ on: true, judge: "fast" })).toMatch(
      /Checked by your fast model\.$/,
    );
    expect(purposeDescription({ on: true, judge: "none", plan: "chatgpt" })).toMatch(
      /Needs a Jev key with the ChatGPT plan\.$/,
    );
    expect(purposeDescription({ on: true, judge: "none", plan: "claude-code" })).toMatch(
      /Needs a Jev key or a fast model on Claude Code\.$/,
    );
    expect(purposeDescription({ on: true, judge: "none" })).toMatch(
      /Needs a Jev key or a fast model\.$/,
    );
    expect(purposeDescription({ on: false, judge: "jev" })).toBe(
      "Stops dot sending what it read somewhere unrelated.",
    );
  });
});

it("shows the saved key and bypass, and verifies only on explicit test", async () => {
  const status = {
    mode: "bypassed",
    keyId: "jev",
    host: "api.typesafe.ai",
    model: "jev-latest",
    calls: 0,
    succeeded: 0,
    failed: 0,
  };
  const post = vi.fn(async () => ({
    ...status,
    calls: 1,
    succeeded: 1,
    last: {
      at: new Date().toISOString(),
      kind: "test",
      ok: true,
      model: "jev-1.13.0",
      latencyMs: 250,
    },
  }));
  const api = { get: vi.fn(async () => status), post } as unknown as ApiClient;
  const manage = vi.fn();
  render(
    <PurposeCheck
      control={{
        on: true,
        change: vi.fn(),
        judge: "jev",
        keyId: "jev",
        fullAccess: true,
        api,
        manageJevKey: manage,
      }}
    />,
  );
  expect(await screen.findByText(/0 attempted/)).toBeTruthy();
  expect(screen.getByText(/Bypassed in Full access/)).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  expect(manage).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Test Jev" }));
  expect((await screen.findByText(/Test succeeded/)).textContent).toContain("jev-1.13.0");
  expect(post).toHaveBeenCalledWith("/api/agent/purpose-check/test");
});
it("keeps configured Jev visible while disabled", () => {
  render(<PurposeCheck control={{ on: false, change: vi.fn(), judge: "jev", keyId: "jev" }} />);
  expect(screen.getByText("Off")).toBeTruthy();
  expect(screen.getByText("jev")).toBeTruthy();
});
