// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const meter = screen.getByRole("meter", { name: "Plan window" });
  expect(meter.getAttribute("aria-valuenow")).toBe("99");
  expect(meter.getAttribute("aria-valuetext")).toBe("99% used, almost at limit");
  expect(screen.getAllByRole("meter")).toHaveLength(1);
  expect(document.body.textContent).toContain("Almost at limit · 99% used");
  expect(document.body.textContent?.match(/Plan window/g)).toHaveLength(1);
  expect(document.body.textContent?.match(/Almost at limit/g)).toHaveLength(1);
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
  expect(recoveryMessage("keyd unavailable", false)).toContain("can't reach your keys");
  expect(recoveryMessage("chatgpt sign-in expired", false)).toContain("then continue this task");
  expect(recoveryMessage("chatgpt plan limit reached", false)).toContain(
    "no spending limit of its own",
  );
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
it("shows a Claude Code task's usage as the Claude plan's, never as money", () => {
  const model = projectAgentEvent(
    projectAgentEvent(
      emptyAgentModel(),
      event(0, "subscription.usage", {
        provider: "claude-code",
        plan: "max",
        windows: [{ window: "primary", usedPercent: 40, windowMinutes: 300 }],
        limitReached: false,
      }),
    ),
    event(1, "model.usage", {
      role: "main",
      route: "claude-code",
      model: "claude-sonnet-5-5",
      inputTokens: 1200,
      outputTokens: 300,
    }),
  );
  const selection = { kind: "claude-code" as const, model: "sonnet" };
  render(<UsageDetails model={model} selection={selection} />);
  expect(screen.getByRole("heading", { name: "Claude plan · max" })).toBeTruthy();
  expect(screen.getByRole("meter", { name: "5 hours window" })).toBeTruthy();
  expect(document.body.textContent).toContain("Claude Code · 1 call");
  expect(document.body.textContent).not.toContain("$");
  expect(usageSummary(model, selection)).toBe("sonnet · 1.5K tokens");
  expect(recoveryMessage("claude code sign-in expired", false)).toContain("claude auth login");
});
it("says a task that runs on a plan uses the plan's limits", () => {
  const roles = [{ role: "main" as const, provider: "minimax-coding-plan", model: "MiniMax-M3" }];
  const view = render(
    <UsageDetails model={emptyAgentModel()} selection={{ kind: "api", roles, plan: true }} />,
  );
  expect(screen.getByText("Included in your plan. Uses your plan's limits.")).toBeTruthy();
  view.rerender(<UsageDetails model={emptyAgentModel()} selection={{ kind: "api", roles }} />);
  expect(screen.queryByText(/Uses your plan's limits/)).toBeNull();
});

describe("what a task cost, shown quietly", () => {
  const roles = [{ role: "main" as const, provider: "openrouter", model: "glm-5.3" }];
  const spent = (basis: "billed" | "estimated", extra = {}) =>
    [
      event(0, "model.usage", {
        role: "main",
        route: "openrouter",
        model: "glm-5.3",
        inputTokens: 24_000,
        outputTokens: 1_100,
      }),
      event(1, "model.spend", {
        route: "openrouter",
        model: "glm-5.3",
        costUSD: 0.21,
        basis,
        taskSpentUSD: 0.21,
        daySpentUSD: 0.21,
        ...extra,
      }),
    ].reduce(projectAgentEvent, emptyAgentModel());
  it("says what the provider billed plainly, and marks an estimate with ≈", () => {
    expect(usageSummary(spent("billed"), { kind: "api", roles })).toBe(
      "glm-5.3 · 25.1K tokens · $0.21",
    );
    expect(usageSummary(spent("estimated"), { kind: "api", roles })).toBe(
      "glm-5.3 · 25.1K tokens · ≈\u00a0$0.21",
    );
    expect(usageSummary(spent("billed"), { kind: "api", roles, plan: true })).toBe(
      "glm-5.3 · 25.1K tokens",
    );
  });
  it("shows this task and today, says there is no limit, and offers to set one", () => {
    const onSpending = vi.fn();
    render(
      <UsageDetails
        model={spent("estimated", { daySpentUSD: 1.4 })}
        selection={{ kind: "api", roles }}
        onSpending={onSpending}
      />,
    );
    const text = screen.getByRole("region", { name: "Task usage" }).textContent;
    expect(text).toContain("This task≈\u00a0$0.21");
    expect(text).toContain("TodayAll tasks≈\u00a0$1.40");
    expect(text).toContain("OpenRouter · 1 call · ≈\u00a0$0.21");
    expect(text).toContain("≈ is an estimate from token counts and list prices.");
    expect(text).toContain("No spending limit");
    fireEvent.click(screen.getByRole("button", { name: "Set a limit…" }));
    expect(onSpending).toHaveBeenCalledOnce();
  });
  it("names the limits the user set, and leaves out the estimate note when all was billed", () => {
    render(
      <UsageDetails
        model={spent("billed", { taskLimitUSD: 5, dayLimitUSD: 20 })}
        selection={{ kind: "api", roles }}
        onSpending={vi.fn()}
      />,
    );
    const text = screen.getByRole("region", { name: "Task usage" }).textContent;
    expect(text).toContain("Limit $5 per task · $20 a day");
    expect(text).not.toContain("≈");
    expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy();
  });
});
it("names each provider as the registry does", () => {
  const model = projectAgentEvent(
    emptyAgentModel(),
    event(0, "model.usage", {
      role: "main",
      route: "minimax-coding-plan",
      model: "MiniMax-M3",
      inputTokens: 10,
      outputTokens: 2,
    }),
  );
  const roles = [
    { role: "main" as const, provider: "minimax-coding-plan", model: "MiniMax-M3" },
    { role: "fast" as const, provider: "moonshotai", model: "kimi-fixture" },
  ];
  render(<UsageDetails model={model} selection={{ kind: "api", roles, plan: true }} />);
  const text = screen.getByRole("region", { name: "Task usage" }).textContent;
  expect(text).toContain("MiniMax Token Plan · 1 call");
  expect(text).toContain("Moonshot (Kimi) · No calls yet");
  expect(text).not.toContain("Minimax-coding-plan");
});
