import { describe, expect, it } from "vitest";
import {
  AccountRead,
  ErrorNotification,
  LoginStarted,
  RateLimitsRead,
  TurnCompleted,
  threadStartParams,
  turnOutcome,
} from "./protocol.ts";

// Saved 0.154.0 fixtures from the source plan; this implementation revalidates the pin in Task13.
const failedTurn = {
  threadId: "01a0fce2-b619",
  turn: {
    id: "01a0fce2-b622",
    items: [],
    itemsView: "notLoaded",
    status: "failed",
    error: {
      message:
        "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      codexErrorInfo: "unauthorized",
      additionalDetails: null,
      misalignment: null,
    },
    startedAt: 1790949111,
    completedAt: 1790949113,
    durationMs: 2000,
  },
};

describe("Codex's protocol, as localDot reads it", () => {
  it("Review Focus 5: reads a refresh failure as signed out, whatever the turn was doing", () => {
    const { turn } = TurnCompleted.parse(failedTurn);
    expect(turnOutcome(turn)).toEqual({
      kind: "signed_out",
      message: "Sign in to ChatGPT again.",
    });
    expect(AccountRead.parse({ account: null, requiresOpenaiAuth: true }).account).toBeNull();
  });

  it("tells a plan limit, a transient failure and anything else apart", () => {
    const t = (codexErrorInfo: unknown) =>
      turnOutcome({ id: "t", status: "failed", error: { message: "m", codexErrorInfo } });
    expect(t("usageLimitExceeded").kind).toBe("plan_limit");
    expect(t("serverOverloaded").kind).toBe("retry");
    expect(t({ responseStreamDisconnected: { httpStatusCode: 502 } }).kind).toBe("retry");
    expect(t({ httpConnectionFailed: { httpStatusCode: null } }).kind).toBe("retry");
    expect(t("contextWindowExceeded").kind).toBe("failed");
    expect(t("cyberPolicy").kind).toBe("failed");
    expect(t(undefined).kind).toBe("failed");
    expect(turnOutcome({ id: "t", status: "interrupted" }).kind).toBe("interrupted");
    expect(turnOutcome({ id: "t", status: "completed", error: null }).kind).toBe("completed");
  });

  it("parses the error, rate-limit, account and sign-in shapes 0.154 sends", () => {
    expect(
      ErrorNotification.parse({
        error: {
          message: "Reconnecting... 2/5",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 404 } },
        },
        willRetry: true,
        threadId: "a",
        turnId: "b",
      }).willRetry,
    ).toBe(true);
    const limits = RateLimitsRead.parse({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1790900000 },
        secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1791400000 },
        planType: "plus",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {},
    });
    expect(limits.rateLimits.primary?.usedPercent).toBe(7);
    expect(
      AccountRead.parse({
        account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
        requiresOpenaiAuth: true,
      }).account,
    ).toMatchObject({ type: "chatgpt", planType: "plus" });
    expect(
      LoginStarted.parse({
        type: "chatgpt",
        loginId: "c841df34-d1ec-4dcd-acc8-c1b7cd918c63",
        authUrl:
          "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      }).type,
    ).toBe("chatgpt");
  });

  it("starts every thread read-only, ephemeral, with approvals routed to localDot", () => {
    expect(
      threadStartParams({ cwd: "/w", model: "gpt-6-astra", developerInstructions: "x" }),
    ).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ephemeral: true,
      cwd: "/w",
      model: "gpt-6-astra",
      developerInstructions: "x",
    });
  });
});

it("does not treat a running turn as completed or expose raw error details", () => {
  expect(turnOutcome({ id: "t", status: "inProgress" })).toEqual({ kind: "in_progress" });
  for (const info of ["unauthorized", "usageLimitExceeded", "serverOverloaded", "unknown"]) {
    const out = turnOutcome({
      id: "t",
      status: "failed",
      error: { message: "FAKE-AUTH-AND-SOCKET-CAPABILITY", codexErrorInfo: info },
    });
    expect(JSON.stringify(out)).not.toContain("FAKE-");
  }
});
it("rejects impossible subscription windows and malformed chatgpt account shapes", () => {
  for (const usedPercent of [-1, 101, NaN, Infinity])
    expect(() => RateLimitsRead.parse({ rateLimits: { primary: { usedPercent } } })).toThrow();
  expect(() =>
    AccountRead.parse({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }),
  ).toThrow();
});
