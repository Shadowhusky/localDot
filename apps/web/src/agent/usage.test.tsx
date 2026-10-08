// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import { recoveryMessage } from "./TaskRecovery.tsx";
import { resetTime, UsageDetails, UsageFooter, usageSummary } from "./UsageFooter.tsx";

const id = (n: number) => String(n).padStart(26, "0");
const event = (seq: number, type: string, data: unknown) =>
  LocalDotEvent.parse({
    v: 1,
    id: id(seq),
    seq,
    t: 1_800_000_000_000_000 + seq,
    agent: "main",
    type,
    data,
  });
afterEach(cleanup);
it("keeps role/route/model totals with deduped replay and retains unknown reasoning rather than estimating dollars", () => {
  const first = event(0, "model.usage", {
    role: "main",
    route: "openai",
    model: "fixture",
    inputTokens: 300,
    outputTokens: 40,
  });
  let model = projectAgentEvent(emptyAgentModel(), first);
  model = projectAgentEvent(
    model,
    event(1, "model.usage", {
      role: "main",
      route: "openai",
      model: "fixture",
      inputTokens: 10,
      outputTokens: 8,
      reasoningTokens: 6,
    }),
  );
  model = projectAgentEvent(
    model,
    event(2, "model.usage", {
      role: "fast",
      route: "openai",
      model: "fixture",
      inputTokens: 5,
      outputTokens: 2,
    }),
  );
  expect(projectAgentEvent(model, first)).toBe(model);
  expect(
    model.usage.map((row) => [
      row.role,
      row.inputTokens,
      row.outputTokens,
      row.reasoningTokens,
      row.calls,
    ]),
  ).toEqual([
    ["main", 310, 48, 6, 2],
    ["fast", 5, 2, undefined, 1],
  ]);
  const selection = {
    kind: "api" as const,
    roles: [{ role: "main" as const, provider: "openai", model: "fixture" }],
  };
  expect(usageSummary(model, selection)).toBe("fixture · 365 tokens");
  render(<UsageFooter model={model} selection={selection} />);
  fireEvent.click(screen.getByRole("button", { name: "Usage: fixture · 365 tokens" }));
  const usage = screen.getByRole("region", { name: "Task usage" }).textContent;
  expect(usage).toContain("310 in · 48 out · 6 reasoning (some calls didn't say)");
  expect(usage).toContain("2 calls");
  expect(usage).toContain("5 in · 2 out");
  expect(usage).toContain("1 call");
  expect(usage).not.toContain("1 calls");
  expect(document.body.textContent).not.toContain("$");
});
it("bounds distinct model rows and records saturation as partial, without negative or wrapped totals", () => {
  let model = emptyAgentModel();
  for (let n = 0; n < 18; n++)
    model = projectAgentEvent(
      model,
      event(n, "model.usage", {
        role: "main",
        route: "fixture",
        model: `model-${n}`,
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 2,
      }),
    );
  expect(model.usage).toHaveLength(12);
  expect(model.usagePartial).toBe(true);
  model = projectAgentEvent(
    model,
    event(18, "model.usage", {
      role: "main",
      route: "fixture",
      model: "model-17",
      inputTokens: 20,
      outputTokens: 3,
    }),
  );
  expect(model.usage.at(-1)?.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
});
it("shows reported plan usage with missing windows/reset time unknown and no USD ceiling or refresh call", () => {
  const model = projectAgentEvent(
    emptyAgentModel(),
    event(0, "subscription.usage", {
      provider: "chatgpt",
      windows: [{ window: "primary", usedPercent: 99 }],
      limitReached: true,
    }),
  );
  render(<UsageDetails model={model} selection={{ kind: "chatgpt", model: "fixture" }} />);
  expect(
    screen.getByRole("meter", { name: "Plan window used" }).getAttribute("aria-valuenow"),
  ).toBe("99");
  expect(screen.getAllByRole("meter")).toHaveLength(1);
  expect(document.body.textContent).toContain("99% used · Almost at limit");
  expect(document.body.textContent).toContain("The plan limit is reached.");
  expect(document.body.textContent).not.toContain("0% used");
  expect(document.body.textContent).not.toContain("$");
  expect(resetTime(Number.MAX_SAFE_INTEGER)).toBeNull();
  expect(resetTime(1_800_000_000)).toContain("2027");
});
it("keeps retry events informational and identifies accepted repairs without deriving entitlement from a catalog", () => {
  const model = projectAgentEvent(
    emptyAgentModel(),
    event(0, "model.retry", {
      role: "main",
      attempt: 2,
      waitMs: 4000,
      message: "Provider refused <img src=x>",
      fallback: "fixture-local",
    }),
  );
  render(<UsageDetails model={model} />);
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain(
    "Main model retried (try 2) after 4.0 s: Provider refused <img src=x> Switched to fixture-local.",
  );
  expect(recoveryMessage("model unavailable", true)).toContain("local model");
  expect(recoveryMessage("keyd unavailable", false)).toContain("key layer is offline");
  expect(recoveryMessage("chatgpt sign-in expired", false)).toContain("explicitly resume");
  expect(recoveryMessage("chatgpt plan limit reached", false)).toContain("no localDot USD budget");
});
it("names the model as the catalog does, and keeps the id for a model it does not list", () => {
  const model = projectAgentEvent(
    emptyAgentModel(),
    event(0, "model.usage", {
      role: "main",
      route: "anthropic",
      model: "sample-large-2",
      inputTokens: 1_200,
      outputTokens: 300,
    }),
  );
  const named = (provider: string, id: string) =>
    provider === "anthropic" && id === "sample-large-2" ? "Sample Large 2" : undefined;
  expect(usageSummary(model, undefined, named)).toBe("Sample Large 2 · 1.5K tokens");
  expect(usageSummary(model)).toBe("sample-large-2 · 1.5K tokens");
  render(<UsageFooter model={model} modelName={named} />);
  fireEvent.click(screen.getByRole("button", { name: /^Usage:/ }));
  expect(screen.getByRole("dialog", { name: "Usage" }).textContent).toContain("Sample Large 2");
});
it("keeps the usage details open while a phone's toolbar hides", () => {
  const model = projectAgentEvent(
    emptyAgentModel(),
    event(0, "model.usage", {
      role: "main",
      route: "openai",
      model: "fixture",
      inputTokens: 10,
      outputTokens: 2,
    }),
  );
  render(<UsageFooter model={model} />);
  fireEvent.click(screen.getByRole("button", { name: /^Usage:/ }));
  const height = window.innerHeight;
  act(() => {
    window.innerHeight = height - 60;
    window.dispatchEvent(new Event("resize"));
  });
  window.innerHeight = height;
  expect(screen.getByRole("dialog", { name: "Usage" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Usage:/ }).getAttribute("aria-expanded")).toBe(
    "true",
  );
});
it("says a task that runs on a plan uses the plan's limits", () => {
  const roles = [{ role: "main" as const, provider: "minimax-coding-plan", model: "MiniMax-M3" }];
  const view = render(
    <UsageDetails model={emptyAgentModel()} selection={{ kind: "api", roles, plan: true }} />,
  );
  expect(screen.getByText("Uses your plan's limits.")).toBeTruthy();
  view.rerender(<UsageDetails model={emptyAgentModel()} selection={{ kind: "api", roles }} />);
  expect(screen.queryByText("Uses your plan's limits.")).toBeNull();
});
