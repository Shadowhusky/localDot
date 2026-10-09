import { describe, expect, it, vi } from "vitest";
import { syncDayLimit } from "./spending.ts";

const keyd = (perTaskUSD: number, perDayUSD: number) => {
  const day = { date: "2026-10-09", spentUSD: 0 };
  return {
    budget: vi.fn(async () => ({ perTaskUSD, perDayUSD, day })),
    setBudget: vi.fn(async (task: number, dayUSD: number) => ({
      perTaskUSD: task,
      perDayUSD: dayUSD,
      day,
    })),
  };
};

describe("the daily spending limit keyd keeps", () => {
  it("is none until the user sets one, clearing what keyd once set for everyone", async () => {
    const k = keyd(5, 20);
    await syncDayLimit(k, undefined);
    expect(k.setBudget).toHaveBeenCalledWith(0, 0);
  });
  it("follows the user's limit", async () => {
    const k = keyd(0, 0);
    await syncDayLimit(k, 12.5);
    expect(k.setBudget).toHaveBeenCalledWith(0, 12.5);
  });
  it("is left alone when it already matches, so no model call in flight is cut", async () => {
    const k = keyd(0, 12.5);
    await syncDayLimit(k, 12.5);
    expect(k.setBudget).not.toHaveBeenCalled();
  });
});
