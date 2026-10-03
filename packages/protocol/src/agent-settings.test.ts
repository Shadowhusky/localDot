import { describe, expect, it } from "vitest";
import { AgentModelPrice, AgentRoleChoice, AgentSettingsDocument } from "./agent-settings.ts";

describe("whole agent settings and explicit accounting prices", () => {
  it.each([
    undefined,
    {},
    { inputUSDPerMTok: 1 },
    { outputUSDPerMTok: 1 },
    { inputUSDPerMTok: "0", outputUSDPerMTok: 1 },
    { inputUSDPerMTok: NaN, outputUSDPerMTok: 1 },
    { inputUSDPerMTok: Infinity, outputUSDPerMTok: 1 },
    { inputUSDPerMTok: -1, outputUSDPerMTok: 1 },
    { inputUSDPerMTok: 10_001, outputUSDPerMTok: 1 },
    { inputUSDPerMTok: 0, outputUSDPerMTok: 0 },
    { inputUSDPerMTok: 1, outputUSDPerMTok: 1, extra: 1 },
  ])("refuses invalid or incomplete manual prices (%j)", (price) => {
    expect(AgentModelPrice.safeParse(price).success).toBe(false);
    if (price !== undefined)
      expect(
        AgentRoleChoice.safeParse({ provider: "openai-compatible", model: "custom", price })
          .success,
      ).toBe(false);
  });
  it.each([
    { inputUSDPerMTok: 0, outputUSDPerMTok: 2 },
    { inputUSDPerMTok: 1, outputUSDPerMTok: 0 },
    { inputUSDPerMTok: 10_000, outputUSDPerMTok: 10_000 },
  ])("preserves an explicitly supplied valid pair (%j)", (price) => {
    expect(AgentModelPrice.parse(price)).toEqual(price);
  });
  it("retains unrelated deny paths and refuses schema mismatches rather than dropping them", () => {
    const settings = {
      main: { provider: "ollama", model: "local" },
      codexDenyRead: ["/private/fixture"],
      taskBudgetUSD: 2,
    };
    expect(AgentSettingsDocument.parse(settings)).toEqual(settings);
    expect(AgentSettingsDocument.safeParse({ ...settings, extra: 1 }).success).toBe(false);
    for (const path of ["relative", "/path/*", "/path\nnext", "/bad\ud800"])
      expect(AgentSettingsDocument.safeParse({ codexDenyRead: [path] }).success).toBe(false);
    for (const taskBudgetUSD of [0, -1, Infinity, NaN, 10_001, 0.0000001, "2"])
      expect(AgentSettingsDocument.safeParse({ taskBudgetUSD }).success).toBe(false);
  });
});
