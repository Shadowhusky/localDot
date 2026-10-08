import { describe, expect, it } from "vitest";
import { KeydTaskRequest, TaskPricing } from "./keyd.ts";

const model = {
  id: "vendor/model",
  inputUSDPerMTok: 0,
  outputUSDPerMTok: 2,
  maxOutputTokens: 100,
};
const pricing = { v: 1, routes: [{ route: "provider", models: [model] }] };
describe("task pricing wire", () => {
  it("keeps legacy initialization and accepts explicit zero-sided snapshot prices", () => {
    expect(KeydTaskRequest.parse({ taskId: "session" })).toEqual({
      taskId: "session",
    });
    expect(KeydTaskRequest.parse({ taskId: "session", budgetUSD: 5, pricing }).pricing).toEqual(
      pricing,
    );
  });
  it("refuses missing prices/caps, invalid models and spoofed binding metadata", () => {
    for (const change of [
      { inputUSDPerMTok: undefined },
      { outputUSDPerMTok: undefined },
      { maxOutputTokens: undefined },
      { maxOutputTokens: 0 },
      { id: "bad model" },
      { inputUSDPerMTok: -1 },
      { outputUSDPerMTok: Infinity },
      { inputUSDPerMTok: 10_001 },
      { upstream: "https://evil.example" },
    ])
      expect(
        TaskPricing.safeParse({
          ...pricing,
          routes: [{ route: "provider", models: [{ ...model, ...change }] }],
        }).success,
      ).toBe(false);
    expect(TaskPricing.safeParse({ ...pricing, bindings: {} }).success).toBe(false);
  });
  it("refuses null/unknown wire fields and invalid ceilings", () => {
    for (const value of [null, -1, NaN, Infinity, 10_001, 0.0000001])
      expect(KeydTaskRequest.safeParse({ taskId: "session", budgetUSD: value }).success).toBe(
        false,
      );
    expect(KeydTaskRequest.safeParse({ taskId: "session", pricing: null }).success).toBe(false);
    expect(KeydTaskRequest.safeParse({ taskId: "session", price: pricing }).success).toBe(false);
  });
  it("bounds total model count and rejects duplicate route/model identities", () => {
    expect(
      TaskPricing.safeParse({
        v: 1,
        routes: [...pricing.routes, ...pricing.routes],
      }).success,
    ).toBe(false);
    expect(
      TaskPricing.safeParse({
        v: 1,
        routes: [{ route: "provider", models: [model, model] }],
      }).success,
    ).toBe(false);
    const models = Array.from({ length: 33 }, (_, i) => ({
      ...model,
      id: `m${i}`,
    }));
    expect(
      TaskPricing.safeParse({
        v: 1,
        routes: [
          { route: "a", models },
          { route: "b", models },
        ],
      }).success,
    ).toBe(false);
    expect(
      TaskPricing.safeParse({
        v: 1,
        routes: Array.from({ length: 9 }, (_, i) => ({
          route: `r${i}`,
          models: [model],
        })),
      }).success,
    ).toBe(false);
  });
});
describe("flat task routes", () => {
  const free = { id: "plan-model", inputUSDPerMTok: 0, outputUSDPerMTok: 0, maxOutputTokens: 100 };
  const route = (flat: unknown, models: object[]) => ({
    v: 1,
    routes: [{ route: "plan", ...(flat === undefined ? {} : { flat }), models }],
  });
  it("marks a plan route flat with its models at zero", () => {
    expect(TaskPricing.parse(route(true, [free])).routes[0]?.flat).toBe(true);
    expect(TaskPricing.parse(route(undefined, [free])).routes[0]).not.toHaveProperty("flat");
  });
  it("refuses a flat route that states any price, and any mark but true", () => {
    for (const change of [
      { inputUSDPerMTok: 1 },
      { outputUSDPerMTok: 0.5 },
      { cacheReadUSDPerMTok: 0 },
      { cacheWriteUSDPerMTok: 1 },
    ])
      expect(
        TaskPricing.safeParse(route(true, [free, { ...free, id: "b", ...change }])).success,
      ).toBe(false);
    for (const flat of [false, null, 1, "true"])
      expect(TaskPricing.safeParse(route(flat, [free])).success).toBe(false);
  });
});
