import { describe, expect, it } from "vitest";
import { AgentSettingsDocument } from "./agent-settings.ts";
import { ulid } from "./ids.ts";
import {
  AlwaysOption,
  APPROVAL_FIELD_CHARS,
  APPROVAL_VALUE_CHARS,
  ApprovalAnswer,
  ApprovalCard,
  ApprovalRequestDraft,
  AutonomyPolicy,
  AutonomyRule,
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  DEFAULT_AUTONOMY,
  freezeAutonomy,
  ModelAdmissionWrite,
  PauseRequest,
  PauseSnapshot,
  ResumeSafetyRequest,
} from "./safety.ts";

describe("safety protocol authority boundaries", () => {
  it("Balanced is the default: it acts inside the computer and asks for everything that leaves it", () => {
    expect(DEFAULT_AUTONOMY).toBe(BALANCED_AUTONOMY);
    expect(BALANCED_AUTONOMY).toEqual({
      reading: "act",
      browsing: "act",
      computer: "act",
      purchase: "ask",
      send: "ask",
      post: "ask",
      delete: "ask",
      download_execute: "ask",
      system_settings: "ask",
      memory: "ask",
    });
    expect(CAREFUL_AUTONOMY).toEqual({ ...BALANCED_AUTONOMY, computer: "ask" });
    for (const preset of [BALANCED_AUTONOMY, CAREFUL_AUTONOMY]) {
      expect(AutonomyPolicy.parse(preset)).toEqual(preset);
      expect(Object.isFrozen(preset)).toBe(true);
    }
  });
  it("a saved eight-class policy keeps parsing and gains computer at its browsing mode", () => {
    const legacy = {
      reading: "act",
      browsing: "act",
      purchase: "ask",
      send: "act",
      post: "ask",
      delete: "handoff",
      download_execute: "ask",
      system_settings: "ask",
    } as const;
    expect(AutonomyPolicy.parse(legacy)).toEqual({ ...legacy, computer: "act", memory: "ask" });
    expect(AutonomyPolicy.parse({ ...legacy, browsing: "ask" })).toMatchObject({
      computer: "ask",
      memory: "ask",
    });
    expect(Object.isFrozen(freezeAutonomy(legacy))).toBe(true);
    expect(AgentSettingsDocument.parse({ autonomy: legacy }).autonomy).toMatchObject({
      send: "act",
      computer: "act",
    });
    for (const value of [
      { ...legacy, computer: "act" },
      { ...legacy, memory: "ask" },
      { ...legacy, credentials: "act" },
      Object.create(legacy),
    ])
      expect(AutonomyPolicy.safeParse(value).success).toBe(false);
    let getterCalls = 0;
    const accessor = { ...legacy };
    Object.defineProperty(accessor, "browsing", {
      get() {
        getterCalls++;
        return "act";
      },
      enumerable: true,
    });
    expect(AutonomyPolicy.safeParse(accessor).success).toBe(false);
    expect(getterCalls).toBe(0);
  });
  it("unknown, inherited, accessor and credential-floor keys cannot become a policy", () => {
    for (const value of [
      { ...DEFAULT_AUTONOMY, credentials: "act" },
      { ...DEFAULT_AUTONOMY, unknown: "act" },
      { ...DEFAULT_AUTONOMY, upload: "act" },
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
      title: "Send as you",
      fields: [["Recipient", "Synthetic recipient"]],
    };
    expect(ApprovalCard.safeParse(card).success).toBe(true);
    for (const actionClass of ["computer", "memory", "upload"])
      expect(ApprovalCard.safeParse({ ...card, actionClass }).success).toBe(true);
    const long = { ...card, fields: [["Command", "x".repeat(APPROVAL_FIELD_CHARS)]] };
    expect(ApprovalCard.safeParse(long).success).toBe(true);
    expect(
      ApprovalCard.safeParse({ ...long, partial: [{ field: 0, length: APPROVAL_VALUE_CHARS }] })
        .success,
    ).toBe(true);
    for (const changed of [
      { ...card, html: "<script>approve()</script>" },
      { ...card, image: "https://evil.test/" },
      { ...card, title: "x".repeat(201) },
      { ...card, fields: [["key", "x".repeat(APPROVAL_FIELD_CHARS + 1)]] },
      { ...long, partial: [] },
      { ...long, partial: [{ field: 0, length: APPROVAL_FIELD_CHARS }] },
      { ...long, partial: [{ field: 0, length: APPROVAL_VALUE_CHARS + 1 }] },
      { ...long, partial: [{ field: 16, length: APPROVAL_VALUE_CHARS }] },
      { ...card, fields: Array.from({ length: 17 }, () => ["k", "v"]) },
      { ...card, title: "\ud800" },
    ])
      expect(ApprovalCard.safeParse(changed).success).toBe(false);
    const { approvalId: _id, generation: _g, revision: _r, expiresAt: _e, ...draft } = card;
    const whole = { ...draft, fields: [["Content", "x".repeat(APPROVAL_VALUE_CHARS)]] };
    expect(ApprovalRequestDraft.safeParse(whole).success).toBe(true);
    expect(
      ApprovalRequestDraft.safeParse({
        ...draft,
        fields: [["Content", "x".repeat(APPROVAL_VALUE_CHARS + 1)]],
      }).success,
    ).toBe(false);
  });
  it("an answer picks an Always allow scope only when it approves, and names nothing else", () => {
    const body = { approvalId: ulid(), generation: 1, revision: 1, decision: "approve" };
    for (const always of ["task", "site", "app", "always"])
      expect(ApprovalAnswer.safeParse({ ...body, always }).success).toBe(true);
    for (const changed of [
      { ...body, decision: "deny", always: "task" },
      { ...body, decision: "take_control", always: "site" },
      { ...body, always: "forever" },
      { ...body, always: "site", site: "https://evil.example.test" },
      { ...body, always: "app", app: "Terminal" },
      { ...body, always: "task", actionClass: "purchase" },
      { ...body, always: { scope: "site", site: "https://evil.example.test" } },
    ])
      expect(ApprovalAnswer.safeParse(changed).success).toBe(false);
  });
  it("card options name an exact origin or an app only for their own scope", () => {
    const card = {
      approvalId: ulid(),
      generation: 1,
      revision: 1,
      expiresAt: 1000,
      actionClass: "send",
      risk: "high",
      title: "Send as you",
      fields: [],
    };
    const task = { scope: "task", label: "For this task" };
    const site = {
      scope: "site",
      label: "On mail.example.test",
      site: "https://mail.example.test",
    };
    const app = { scope: "app", label: "In Notes", app: "Notes" };
    const always = { scope: "always", label: "Always" };
    expect(ApprovalCard.safeParse({ ...card, always: [task, site, app, always] }).success).toBe(
      true,
    );
    expect(ApprovalCard.safeParse({ ...card, always: [] }).success).toBe(true);
    expect(
      ApprovalCard.safeParse({ ...card, always: [{ ...site, site: "http://127.0.0.1:8080" }] })
        .success,
    ).toBe(true);
    for (const options of [
      [{ ...site, site: "https://mail.example.test/inbox" }],
      [{ ...site, site: "https://mail.example.test/" }],
      [{ ...site, site: "https://MAIL.example.test" }],
      [{ ...site, site: "https://user@mail.example.test" }],
      [{ ...site, site: "javascript:alert(1)" }],
      [{ ...site, site: "file:///etc" }],
      [{ scope: "site", label: "On a site" }],
      [{ ...task, site: "https://mail.example.test" }],
      [{ ...always, app: "Notes" }],
      [{ scope: "app", label: "In an app" }],
      [{ ...task, label: "x".repeat(201) }],
      [{ ...task, extra: true }],
      [task, task],
      [task, site, app, always, { ...task, label: "Again" }],
    ])
      expect(ApprovalCard.safeParse({ ...card, always: options }).success).toBe(false);
  });
  it("saved Always allow rules are strict and never hold a task scope", () => {
    const rule = {
      id: ulid(),
      behavior: "act",
      actionClass: "send",
      scope: "site",
      site: "https://mail.example.test",
      label: "On mail.example.test",
      createdAt: 1,
      createdFrom: ulid(),
    };
    expect(AutonomyRule.safeParse(rule).success).toBe(true);
    for (const changed of [
      { ...rule, scope: "task", site: undefined },
      { ...rule, behavior: "ask" },
      { ...rule, site: "https://mail.example.test/x" },
      { ...rule, scope: "always" },
      { ...rule, extra: 1 },
      { ...rule, id: "1" },
    ])
      expect(AutonomyRule.safeParse(changed).success).toBe(false);
  });
  it("a connection's options and rules name a host and port, and only where they belong", () => {
    const rule = {
      id: ulid(),
      behavior: "act",
      actionClass: "network",
      scope: "destination",
      destination: "chat.example.com:5222",
      label: "Always for chat.example.com:5222",
      createdAt: 1,
      createdFrom: ulid(),
    };
    expect(AutonomyRule.safeParse(rule).success).toBe(true);
    for (const destination of [
      "[2001:db8::7]:8443",
      "203.0.113.9:80",
      "xn--bcher-kva.example:6667",
    ])
      expect(AutonomyRule.safeParse({ ...rule, destination }).success).toBe(true);
    for (const destination of [
      "chat.example.com",
      "chat.example.com:0",
      "chat.example.com:65536",
      "Chat.example.com:5222",
      "chat.example.com:05222",
      "localhost:5222",
      "2001:db8::7:8443",
    ])
      expect(AutonomyRule.safeParse({ ...rule, destination }).success, destination).toBe(false);
    const { destination: _, ...noDestination } = rule;
    expect(AutonomyRule.safeParse(noDestination).success).toBe(false);
    expect(AutonomyRule.safeParse({ ...rule, scope: "app", app: "wechat" }).success).toBe(false);
    const task = { scope: "task", label: "For this task", destination: rule.destination };
    expect(AlwaysOption.safeParse(task).success).toBe(true);
    expect(AlwaysOption.safeParse({ ...task, scope: "always" }).success).toBe(false);
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
