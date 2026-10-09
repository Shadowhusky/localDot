import { describe, expect, it, vi } from "vitest";
import { KeydError, KeydUnavailableError } from "../keyd/client.ts";
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
  it("is left quietly to an older keyd that refuses none, and synced once keyd is upgraded", async () => {
    const k = keyd(5, 20);
    k.setBudget.mockRejectedValueOnce(
      new KeydError(400, "bad-request", "limits must be finite and positive", "/v1/budget"),
    );
    await expect(syncDayLimit(k, undefined)).resolves.toBeUndefined();
    await syncDayLimit(k, undefined);
    expect(k.setBudget).toHaveBeenCalledTimes(2);
    expect(k.setBudget).toHaveBeenLastCalledWith(0, 0);
  });
  it("is left quietly to a keyd without the budget route", async () => {
    const k = keyd(0, 0);
    k.budget.mockRejectedValueOnce(new KeydError(404, "not-found", "no route", "/v1/budget"));
    await expect(syncDayLimit(k, 12.5)).resolves.toBeUndefined();
    expect(k.setBudget).not.toHaveBeenCalled();
  });
  it("still fails while keyd is unreachable", async () => {
    const k = keyd(0, 0);
    k.budget.mockRejectedValueOnce(new KeydUnavailableError("ENOENT", "/v1/budget"));
    await expect(syncDayLimit(k, 12.5)).rejects.toThrow(KeydUnavailableError);
  });
});
