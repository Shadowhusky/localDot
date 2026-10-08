// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import { recoveryMessage } from "./TaskRecovery.tsx";
import { resetTime, UsageView } from "./UsageView.tsx";

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
  render(
    <UsageView
      model={model}
      selection={{ kind: "api", roles: [{ role: "main", provider: "openai", model: "fixture" }] }}
    />,
  );
  const usage = screen.getByRole("region", { name: "Task usage" }).textContent;
  expect(usage).toContain("310 input · 48 output tokens");
  expect(usage).toContain(
    "6 reported reasoning tokens · some calls did not report reasoning · 2 reported calls",
  );
  expect(usage).toContain("5 input · 2 output tokens");
  expect(usage).toContain("1 reported call");
  expect(usage).not.toContain("1 reported calls");
  expect(screen.getByText("Token counts do not establish an invoice cost.")).toBeTruthy();
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
  render(<UsageView model={model} selection={{ kind: "chatgpt", model: "fixture" }} />);
  expect(screen.getByRole("meter", { name: "primary plan usage" })).toHaveProperty("value", 99);
  expect(screen.queryByRole("meter", { name: "secondary plan usage" })).toBeNull();
  expect(document.body.textContent).toContain("Usage unavailable · Reset time unavailable");
  expect(document.body.textContent).not.toContain("0% used");
  expect(document.body.textContent).not.toContain("$");
  expect(resetTime(Number.MAX_SAFE_INTEGER)).toBe("Reset time unavailable");
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
  render(<UsageView model={model} />);
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("Provider refused <img src=x>");
  expect(document.body.textContent).toContain("browser does not retry model calls");
  expect(recoveryMessage("model unavailable", true)).toContain("local model");
  expect(recoveryMessage("keyd unavailable", false)).toContain("key layer is offline");
  expect(recoveryMessage("chatgpt sign-in expired", false)).toContain("explicitly resume");
  expect(recoveryMessage("chatgpt plan limit reached", false)).toContain("no localDot USD budget");
});
it("says a task that runs on a plan uses the plan's limits", () => {
  const roles = [{ role: "main" as const, provider: "minimax-coding-plan", model: "MiniMax-M3" }];
  const view = render(
    <UsageView model={emptyAgentModel()} selection={{ kind: "api", roles, plan: true }} />,
  );
  expect(screen.getByText("Uses your plan's limits.")).toBeTruthy();
  view.rerender(<UsageView model={emptyAgentModel()} selection={{ kind: "api", roles }} />);
  expect(screen.queryByText("Uses your plan's limits.")).toBeNull();
});
