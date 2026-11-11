import { describe, expect, it } from "vitest";
import { sameRunningModel } from "./model-options.ts";

describe("one model under two names", () => {
  const on = (route: string, model: string) => ({ route, model });
  it("takes the chosen name and the provider's own name for it as one model", () => {
    for (const [chosen, served] of [
      ["opus", "claude-opus-5-5"],
      ["opus", "claude-opus-5-5-20261001"],
      ["claude-opus-5-5", "claude-opus-5-5[1m]"],
      ["default", "claude-sonnet-5-5"],
      ["gpt-6.1-sol", "gpt-6.1-sol-2026-09-01"],
      ["sonnet", "sonnet"],
    ] as const) {
      expect(sameRunningModel(on("r", chosen), on("r", served)), `${chosen} / ${served}`).toBe(
        true,
      );
      expect(sameRunningModel(on("r", served), on("r", chosen)), `${served} / ${chosen}`).toBe(
        true,
      );
    }
  });
  it("tells another model, version or route apart", () => {
    for (const [a, b] of [
      ["opus", "claude-sonnet-5-5"],
      ["claude-opus-4-1", "claude-opus-5-5"],
      ["gpt-6", "gpt-6-mini"],
      ["gpt-6.1", "gpt-6.1-sol"],
      ["o4", "o4-mini"],
    ] as const)
      expect(sameRunningModel(on("r", a), on("r", b)), `${a} / ${b}`).toBe(false);
    expect(sameRunningModel(on("anthropic", "opus"), on("claude-code", "opus"))).toBe(false);
  });
});
