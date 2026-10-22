import { describe, expect, it } from "vitest";
import { AccountError, accountFor, loginFor, modelsFor } from "./account.ts";

describe("safe ChatGPT account metadata", () => {
  it("formats only ChatGPT account fields and known plans", () => {
    expect(
      accountFor({
        type: "chatgpt",
        email: "user@example.invalid",
        planType: "plus",
        token: "private",
      }),
    ).toEqual({ email: "user@example.invalid", plan: "plus" });
    expect(
      accountFor({ type: "chatgpt", email: "secret\nvalue", planType: "private-token" }),
    ).toEqual({ email: null, plan: "unknown" });
    expect(accountFor({ type: "apiKey", secret: "private" })).toBeUndefined();
    expect(accountFor(null)).toBeUndefined();
  });
  it("bounds and deduplicates visible model metadata", () => {
    const item = {
      id: "gpt-6-astra",
      displayName: "GPT 6",
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: "medium",
    };
    expect(
      modelsFor({
        data: [
          item,
          item,
          { ...item, id: "hidden", hidden: true },
          { ...item, id: "../../secret" },
        ],
      }),
    ).toEqual([{ id: "gpt-6-astra", name: "GPT 6", isDefault: true }]);
  });
  it("limits model count and display names", () => {
    const data = Array.from({ length: 129 }, (_, i) => ({
      id: `model-${i}`,
      displayName: "x".repeat(200),
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: "low",
    }));
    const models = modelsFor({ data });
    expect(models).toHaveLength(128);
    expect(models.every((m) => m.name.length === 128)).toBe(true);
  });
  it("accepts the pinned device-code URL and bounded code", () => {
    expect(
      loginFor(
        {
          type: "chatgptDeviceCode",
          loginId: "attempt-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        },
        "code",
        10,
      ),
    ).toEqual({
      loginId: "attempt-1",
      method: "code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      startedAt: 10,
    });
  });
  it.each([
    "http://auth.openai.com/codex/device",
    "https://auth.openai.com.evil.invalid/codex/device",
    "https://user@auth.openai.com/codex/device",
    "https://auth.openai.com:444/codex/device",
    "https://auth.openai.com/oauth/authorize",
    "https://auth.openai.com/codex/device?token=private",
    "https://auth.openai.com/codex/device#private",
  ])("rejects a device URL outside the exact pinned endpoint: %s", (verificationUrl) => {
    expect(() =>
      loginFor(
        { type: "chatgptDeviceCode", loginId: "attempt-1", verificationUrl, userCode: "ABCD-EFGH" },
        "code",
        0,
      ),
    ).toThrow(AccountError);
  });
  it("accepts only the browser authorize origin and exact callback port", () => {
    const authUrl =
      "https://auth.openai.com/oauth/authorize?state=owned&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
    expect(loginFor({ type: "chatgpt", loginId: "attempt-2", authUrl }, "browser", 0).authUrl).toBe(
      authUrl,
    );
    expect(() =>
      loginFor(
        { type: "chatgpt", loginId: "attempt-2", authUrl: authUrl.replace("1455", "1457") },
        "browser",
        0,
      ),
    ).toThrow(AccountError);
    expect(() => loginFor({ type: "chatgpt", loginId: "attempt-2", authUrl }, "code", 0)).toThrow(
      AccountError,
    );
  });
});

it("retains actual account effort and speed capabilities without unknown provider values", () => {
  const item = {
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "high" },
      { reasoningEffort: "max" },
      { reasoningEffort: "ultra" },
      { reasoningEffort: "unsupported" },
    ],
    serviceTiers: [{ id: "default" }, { id: "fast" }],
  };
  expect(modelsFor({ data: [item] })[0]).toMatchObject({
    efforts: ["high", "max", "ultra"],
    tiers: { fast: "fast" },
  });
  expect(modelsFor({ data: [{ ...item, serviceTiers: [] }] })[0]?.tiers).toEqual({});
  expect(modelsFor({ data: [{ ...item, serviceTiers: undefined }] })[0]).not.toHaveProperty(
    "tiers",
  );
});

it("keeps the account's own name for each premium tier it lists", () => {
  const item = {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: "medium",
    serviceTiers: [{ id: "default" }, { id: "priority" }, { id: "ultrafast" }, { id: "flex" }],
  };
  expect(modelsFor({ data: [item] })[0]?.tiers).toEqual({
    fast: "priority",
    ultrafast: "ultrafast",
  });
  expect(
    modelsFor({ data: [{ ...item, serviceTiers: undefined, additionalSpeedTiers: ["fast"] }] })[0]
      ?.tiers,
  ).toEqual({ fast: "fast" });
  // Passed through to the account's own app as listed, so only a plain tier name is kept.
  expect(modelsFor({ data: [{ ...item, serviceTiers: [{ id: "PRIORITY" }] }] })[0]?.tiers).toEqual(
    {},
  );
});
