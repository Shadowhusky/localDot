import { describe, expect, it } from "vitest";
import { AgentSettingsDocument } from "./agent-settings.ts";
import { ulid } from "./ids.ts";
import {
  ApprovalAnswer,
  ApprovalCard,
  AutonomyPolicy,
  DEFAULT_AUTONOMY,
  freezeAutonomy,
  ModelAdmissionWrite,
  PauseRequest,
  PauseSnapshot,
  ResumeSafetyRequest,
} from "./safety.ts";

describe("safety protocol authority boundaries", () => {
  it("defaults act only on reading/browsing and ask on the six editable consequential classes", () => {
    expect(DEFAULT_AUTONOMY).toEqual({
      reading: "act",
      browsing: "act",
      purchase: "ask",
      send: "ask",
      post: "ask",
      delete: "ask",
      download_execute: "ask",
      system_settings: "ask",
    });
    expect(AutonomyPolicy.parse(DEFAULT_AUTONOMY)).toEqual(DEFAULT_AUTONOMY);
    expect(Object.isFrozen(DEFAULT_AUTONOMY)).toBe(true);
  });
  it("unknown, inherited, accessor and credential-floor keys cannot become a policy", () => {
    for (const value of [
      { ...DEFAULT_AUTONOMY, credentials: "act" },
      { ...DEFAULT_AUTONOMY, unknown: "act" },
      JSON.parse('{"__proto__":{"send":"act"}}'),
      Object.create(DEFAULT_AUTONOMY),
      { ...DEFAULT_AUTONOMY, send: "always" },
    ])
      expect(AutonomyPolicy.safeParse(value).success).toBe(false);
    let getterCalls = 0;
    const value = { ...DEFAULT_AUTONOMY };
    Object.defineProperty(value, "send", {
      get() {
        getterCalls++;
        return "act";
      },
      enumerable: true,
    });
    expect(AutonomyPolicy.safeParse(value).success).toBe(false);
    expect(getterCalls).toBe(0);
  });
  it("freezing detaches source settings and preserves a strict read-only policy", () => {
    const input = { ...DEFAULT_AUTONOMY };
    const frozen = freezeAutonomy(input);
    input.send = "act";
    expect(frozen.send).toBe("ask");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(AgentSettingsDocument.parse({ autonomy: input }).autonomy?.send).toBe("act");
    expect(AgentSettingsDocument.parse({})).toEqual({});
  });
  it("approval answers bind one server card/generation/revision with no extra authority", () => {
    const body = { approvalId: ulid(), generation: 1, revision: 1, decision: "approve" };
    expect(ApprovalAnswer.safeParse(body).success).toBe(true);
    for (const changed of [
      { ...body, expiresAt: 999 },
      { ...body, input: { command: "replace" } },
      { ...body, source: "manual" },
      { ...body, generation: 0 },
      { ...body, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...body, decision: "approve_similar" },
    ])
      expect(ApprovalAnswer.safeParse(changed).success).toBe(false);
  });
  it("structured cards accept only bounded text and fixed decision metadata", () => {
    const card = {
      approvalId: ulid(),
      generation: 1,
      revision: 1,
      expiresAt: 1000,
      actionClass: "send",
      risk: "high",
      title: "Send message",
      fields: [["Recipient", "Synthetic recipient"]],
    };
    expect(ApprovalCard.safeParse(card).success).toBe(true);
    for (const changed of [
      { ...card, html: "<script>approve()</script>" },
      { ...card, image: "https://evil.test/" },
      { ...card, title: "x".repeat(201) },
      { ...card, fields: [["key", "x".repeat(513)]] },
      { ...card, fields: Array.from({ length: 17 }, () => ["k", "v"]) },
      { ...card, title: "\ud800" },
    ])
      expect(ApprovalCard.safeParse(changed).success).toBe(false);
  });
  it("Pause/Resume DTOs and snapshots refuse optimistic or extra grants", () => {
    const requestId = ulid();
    expect(PauseRequest.safeParse({ requestId }).success).toBe(true);
    expect(PauseRequest.safeParse({ requestId, paused: true }).success).toBe(false);
    expect(ResumeSafetyRequest.safeParse({ requestId, revision: 1 }).success).toBe(true);
    expect(ResumeSafetyRequest.safeParse({ requestId, revision: 1, force: true }).success).toBe(
      false,
    );
    expect(
      PauseSnapshot.safeParse({
        requestId,
        revision: 1,
        phase: "paused",
        reason: "user",
        atStepBoundary: true,
        resumeAvailable: true,
      }).success,
    ).toBe(true);
    expect(
      PauseSnapshot.safeParse({
        requestId,
        revision: 1,
        phase: "uncertain",
        reason: "user",
        atStepBoundary: false,
        resumeAvailable: true,
      }).success,
    ).toBe(false);
    expect(
      PauseSnapshot.safeParse({
        requestId,
        revision: 1,
        phase: "pausing",
        reason: "user",
        atStepBoundary: false,
        resumeAvailable: true,
      }).success,
    ).toBe(false);
  });
  it("model admission reopening requires immutable task, cryptographic generation and exact epoch", () => {
    const body = { taskId: ulid(), generationId: "a".repeat(32), state: "open", expectedEpoch: 1 };
    expect(ModelAdmissionWrite.safeParse(body).success).toBe(true);
    for (const changed of [
      { ...body, expectedEpoch: undefined },
      { ...body, generationId: "1" },
      { ...body, expectedEpoch: 0 },
      { ...body, taskId: "old" },
      { ...body, force: true },
    ])
      expect(ModelAdmissionWrite.safeParse(changed).success).toBe(false);
  });
});
