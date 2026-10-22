import { describe, expect, it } from "vitest";
import { servedSpeed, speedPremium, speedTiers } from "./speeds.ts";

const tiers = (provider: string, model: string, tiered?: boolean) =>
  speedTiers(provider, model, tiered).map(({ speed, price }) => `${speed} ${price ?? "?"}`);

describe("the speeds each provider offers", () => {
  it.each([
    ["openai", "gpt-6.1-sol", ["fast 2", "ultrafast 6"]],
    ["openai", "gpt-6-astra", ["fast 2", "ultrafast 6"]],
    ["openai", "gpt-6-luna", ["fast 2"]],
    ["openai", "gpt-5.5", ["fast 2.5"]],
    ["openai", "gpt-5.3-codex", ["fast 2"]],
    ["openai", "gpt-5-mini", ["fast 2"]],
    ["openai", "gpt-5-nano", []],
    ["openai", "gpt-5.4-pro", []],
    ["openai", "gpt-5-chat-latest", []],
    ["openai", "o3", []],
    ["anthropic", "claude-opus-5-5", ["fast 2"]],
    ["anthropic", "claude-opus-5", ["fast 2"]],
    ["anthropic", "claude-opus-4-8", ["fast 2"]],
    ["anthropic", "claude-opus-4-7", []],
    ["anthropic", "claude-sonnet-5-5", []],
    ["google", "gemini-3.8-flash", ["fast 1.8"]],
    ["google", "gemini-3.6-flash", ["fast 1.8"]],
    ["google", "gemini-3.1-pro-preview", ["fast 1.8"]],
    ["google", "gemini-3-flash-preview", ["fast 1.8"]],
    ["google", "gemini-2.5-flash-lite", ["fast 1.8"]],
    ["google", "gemini-3.1-flash", []],
    ["google", "gemini-2.5-flash-image", []],
    ["google", "gemini-4-argon", []],
    ["xai", "grok-4.7", ["fast 2"]],
    ["xai", "grok-imagine-image", []],
    ["openrouter", "openai/gpt-6.1-sol", ["fast 2", "ultrafast 6"]],
    ["openrouter", "anthropic/claude-opus-4.8", ["fast 2"]],
    ["openrouter", "google/gemini-3.8-flash", ["fast 1.8"]],
    ["openrouter", "x-ai/grok-4.7", ["fast 2"]],
    ["openrouter", "openai/gpt-6.1-sol:nitro", []],
    ["openrouter", "deepseek/deepseek-v4", []],
    ["groq", "openai/gpt-oss-120b", []],
    ["deepseek", "deepseek-flash", []],
    ["togetherai", "moonshotai/Kimi-K3", []],
    ["azure", "gpt-6.1-sol", []],
    ["chatgpt", "gpt-6.1-sol", []],
    ["claude-code", "opus", ["fast ?"]],
    ["claude-code", "claude-opus-5-5", ["fast ?"]],
    ["claude-code", "sonnet", []],
  ])("%s %s", (provider, model, expected) => {
    expect(tiers(provider, model)).toEqual(expected);
  });

  it("offers a custom endpoint's speeds only when its user says it takes OpenAI's tiers", () => {
    expect(tiers("openai-responses-compatible", "gpt-6.1-sol")).toEqual([]);
    expect(tiers("openai-responses-compatible", "gpt-6.1-sol", true)).toEqual([
      "fast 2",
      "ultrafast 6",
    ]);
    expect(tiers("openai-responses-compatible", "gpt-6-luna", true)).toEqual(["fast 2"]);
    expect(tiers("openai-responses-compatible", "my-model", true)).toEqual([
      "fast ?",
      "ultrafast ?",
    ]);
    // OpenAI offers Ultrafast through its Responses API only.
    expect(tiers("openai-compatible", "gpt-6.1-sol", true)).toEqual(["fast 2"]);
    expect(tiers("openai-compatible", "my-model", true)).toEqual(["fast ?"]);
    expect(tiers("anthropic-compatible", "claude-opus-4-8", true)).toEqual([]);
  });
});

describe("what a premium speed sets aside", () => {
  it("is the vendor's premium, or the highest any vendor charges when it is unknown", () => {
    expect(speedPremium("openai", "gpt-6.1-sol", "ultrafast")).toBe(6);
    expect(speedPremium("openai", "gpt-5.5", "fast")).toBe(2.5);
    expect(speedPremium("google", "gemini-3.8-flash", "fast")).toBe(1.8);
    expect(speedPremium("openai-responses-compatible", "gpt-6-luna", "fast", true)).toBe(2);
    expect(speedPremium("openai-responses-compatible", "my-model", "fast", true)).toBe(2.5);
    expect(speedPremium("openai-responses-compatible", "my-model", "ultrafast", true)).toBe(6);
  });
});

describe("the speed a provider says served a call", () => {
  it.each([
    ["priority", "fast"],
    ["fast", "fast"],
    ["performance", "fast"],
    ["SERVICE_TIER_PRIORITY", "fast"],
    ["ultrafast", "ultrafast"],
    ["default", undefined],
    ["standard", undefined],
    ["auto", undefined],
    ["flex", undefined],
    ["on_demand", undefined],
    [null, undefined],
    [2, undefined],
  ])("%j", (report, speed) => {
    expect(servedSpeed(report)).toBe(speed);
  });
});
