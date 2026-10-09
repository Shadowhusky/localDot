// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { modelNames } from "../settings/model-names.ts";
import { providerFixture } from "../settings/testing.ts";
import { metaLine, TurnMeta } from "./TurnMeta.tsx";
import type { ThreadItem, TurnModel } from "./thread.ts";

type MetaItem = Extract<ThreadItem, { kind: "meta" }>;

afterEach(cleanup);

const names = modelNames(providerFixture(), {
  chatgpt: [],
  claudeCode: [{ id: "sonnet", name: "Claude Sonnet" }],
});
const sonnet: TurnModel = {
  role: "main",
  route: "anthropic",
  model: "claude-sonnet-5-5",
  calls: 2,
  inputTokens: 18_420,
  outputTokens: 2_210,
  reasoningTokens: 640,
};
const luna: TurnModel = {
  role: "fast",
  route: "openai",
  model: "gpt-6-luna",
  calls: 1,
  inputTokens: 4_100,
  outputTokens: 380,
};
const item = (over: Partial<MetaItem> = {}): MetaItem => ({
  kind: "meta",
  key: "meta-turn",
  speaker: "dot",
  turn: "turn",
  models: [sonnet],
  durationMs: 72_000,
  usd: 0.04,
  work: false,
  ...over,
});

describe("a turn's meta line", () => {
  it("says the model, how long the turn took, its tokens and what was billed", () => {
    expect(metaLine(item(), names)).toBe("Claude Sonnet 5.5 · 1:12 · 20.6K tokens · $0.04");
  });

  it("leaves time and cost to the work line above, and says nothing it wasn't told", () => {
    expect(metaLine(item({ work: true, models: [sonnet, luna] }), names)).toBe(
      "Claude Sonnet 5.5 · 25.1K tokens",
    );
    expect(
      metaLine(item({ durationMs: undefined, usd: undefined, models: [], main: sonnet }), names),
    ).toBe("Claude Sonnet 5.5");
  });

  it("names a plan's app, where the plan paid rather than a key", () => {
    const plan = { ...sonnet, route: "claude-code", model: "sonnet", reasoningTokens: undefined };
    expect(metaLine(item({ models: [plan], usd: undefined }), names)).toBe(
      "Claude Sonnet · Claude Code · 1:12 · 20.6K tokens",
    );
  });

  it("opens on each model's reported tokens, and is plain text when calls reported none", () => {
    render(<TurnMeta item={item({ models: [sonnet, luna] })} names={names} />);
    fireEvent.click(screen.getByRole("button", { name: /^This turn: Claude Sonnet 5\.5/ }));
    const details = screen.getByRole("dialog", { name: "Models this turn used" });
    expect(details.textContent).toContain("Anthropic · 18,420 in · 2,210 out · 640 reasoning");
    expect(details.textContent).toContain("GPT-6 LunaFast");
    cleanup();
    render(<TurnMeta item={item({ models: [], main: sonnet })} names={names} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/^Claude Sonnet 5\.5 · 1:12/)).toBeTruthy();
  });
});
