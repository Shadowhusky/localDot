import { describe, expect, it } from "vitest";
import {
  type ApprovalContext,
  type ApprovalIdentity,
  type CodexTurnEpoch,
  decideServerRequest,
  explicitDefaults,
  isApprovalCurrent,
} from "./approvals.ts";

const MAIN = "01a0f526-8d5b-79e2-92ad-14a131d7297f";
function fixture() {
  const brain = new AbortController(),
    turnAbort = new AbortController();
  const generation = Object.freeze({ id: 1, signal: brain.signal });
  const turn: CodexTurnEpoch = Object.freeze({
    id: 1,
    signal: turnAbort.signal,
    basisFrameId: "owned-full-frame-A",
  });
  const captured: ApprovalIdentity = Object.freeze({
    mainThreadId: MAIN,
    turnId: "01a0f526-8e3a-7352-bd13-021d795d6007",
    generation,
    authGeneration: 0,
    turn,
    controlHeld: false,
  });
  let current: ApprovalIdentity | undefined = captured;
  const ctx: ApprovalContext = { captured, current: () => current };
  return {
    ctx,
    brain,
    turnAbort,
    replace: (value: ApprovalIdentity | undefined) => {
      current = value;
    },
  };
}
const ctx = fixture().ctx;
// Codex 0.154's approval prompt for localDot's `click`, as S7 run A and Task 13's probe saw it.
const prompt = {
  threadId: MAIN,
  turnId: "01a0f526-8e3a-7352-bd13-021d795d6007",
  serverName: "localdot",
  mode: "form",
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
    tool_description: "Left-click at screen pixel coordinates.",
    tool_params: { x: 990, y: 642 },
  },
  message: 'Allow the localdot MCP server to run tool "click"?',
  requestedSchema: { type: "object", properties: {} },
};
const elicit = (over: Record<string, unknown>) =>
  decideServerRequest("mcpServer/elicitation/request", { ...prompt, ...over }, ctx);

describe("decideServerRequest", () => {
  it("accepts Codex's prompt for a localdot tool on the task's thread, with no content", () => {
    expect(decideServerRequest("mcpServer/elicitation/request", prompt, ctx)).toEqual({
      verdict: "approved",
      result: { action: "accept", content: {} },
    });
  });

  it("Review Focus 4: declines every prompt that is not localDot's own, on the task's own thread", () => {
    const declined = { verdict: "declined", result: { action: "decline" } };
    for (const over of [
      { serverName: "localdot-x" },
      { serverName: "Localdot" },
      { serverName: "localdot " },
      { serverName: undefined },
      { threadId: "01a0f527-0000-7000-8000-000000000000" }, // a sub-agent's thread
      { threadId: undefined },
      { mode: "url", url: "https://example.com/approve" },
      { mode: "openai/form" },
      { mode: "openaiForm" },
      { _meta: { codex_approval_kind: "mcp_server_auth" } },
      { _meta: {} },
      { _meta: undefined },
    ]) {
      expect(elicit(over)).toEqual(declined);
    }
    expect(
      decideServerRequest("mcpServer/elicitation/request", prompt, {
        ...ctx,
        captured: { ...ctx.captured, mainThreadId: undefined },
      }),
    ).toEqual(declined);
  });

  it("replies with explicit defaults only, and never a boolean defaulted to true", () => {
    expect(
      explicitDefaults({
        type: "object",
        properties: {
          remember: { type: "boolean", default: true },
          dryRun: { type: "boolean", default: false },
          scope: { type: "string", default: "once" },
          count: { type: "number", default: 1 },
          note: { type: "string" },
          approve: { type: "boolean" },
          list: { type: "array", default: ["x"] },
        },
      }),
    ).toEqual({ dryRun: false, scope: "once", count: 1 });
    expect(
      elicit({
        requestedSchema: {
          type: "object",
          properties: { always: { type: "boolean", default: true } },
        },
      }),
    ).toEqual({
      verdict: "approved",
      result: { action: "accept", content: {} },
    });
  });

  it("Review Focus 1: declines Codex's own commands, file edits and permission requests", () => {
    expect(
      decideServerRequest("item/commandExecution/requestApproval", { command: "date" }, ctx),
    ).toMatchObject({
      verdict: "declined",
      result: { decision: "decline" },
      blocked: { kind: "shell" },
    });
    expect(
      decideServerRequest("item/fileChange/requestApproval", { itemId: "x" }, ctx),
    ).toMatchObject({
      verdict: "declined",
      result: { decision: "decline" },
      blocked: { kind: "file" },
    });
    expect(decideServerRequest("item/permissions/requestApproval", {}, ctx)).toMatchObject({
      verdict: "declined",
      result: { permissions: {}, scope: "turn" },
    });
    for (const legacy of ["execCommandApproval", "applyPatchApproval"]) {
      expect(decideServerRequest(legacy, {}, ctx)).toEqual({
        verdict: "declined",
        result: { decision: "denied" },
      });
    }
  });

  it("answers a question through Codex with its exact deny label, or nothing", () => {
    const q = (id: string, labels: string[]) => ({
      id,
      header: "Approve app tool call?",
      question: "Allow the localdot MCP server to run tool?",
      options: labels.map((label) => ({ label, description: "" })),
    });
    const out = decideServerRequest(
      "item/tool/requestUserInput",
      {
        questions: [
          q("a", ["Allow", "Allow for this session", "Cancel"]),
          q("b", ["Allow", "Allow (no further prompts)", "Cancel request"]),
          q("c", ["Always allow", "Deny"]),
          q("d", []),
        ],
      },
      ctx,
    );
    expect(out).toMatchObject({
      verdict: "declined",
      result: {
        answers: {
          a: { answers: ["Cancel"] },
          b: { answers: [] },
          c: { answers: ["Deny"] },
          d: { answers: [] },
        },
      },
    });
  });

  it("refuses dynamic tools, external token refresh, attestation and anything unknown", () => {
    expect(decideServerRequest("item/tool/call", {}, ctx)).toMatchObject({
      verdict: "declined",
      result: { success: false },
    });
    for (const m of [
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
      "item/new/thing",
    ]) {
      expect(decideServerRequest(m, {}, ctx)).toMatchObject({
        verdict: "declined",
        error: { code: -32601 },
      });
    }
  });
});
describe("captured approval authority", () => {
  it.each([
    "auth",
    "brain",
    "brain-clone",
    "turn",
    "turn-clone",
    "wire-turn",
    "wire-thread",
    "takeover",
    "missing",
  ])("declines %s retirement even when server and thread text match", (which) => {
    const f = fixture(),
      live = { ...f.ctx.captured };
    if (which === "auth") live.authGeneration++;
    if (which === "brain" || which === "brain-clone")
      live.generation = { ...live.generation, ...(which === "brain" ? { id: 2 } : {}) };
    if (which === "turn" || which === "turn-clone")
      live.turn = { ...live.turn, ...(which === "turn" ? { id: 2 } : {}) };
    if (which === "wire-turn") live.turnId = "new-wire-turn";
    if (which === "wire-thread") live.mainThreadId = "new-wire-thread";
    if (which === "takeover") live.controlHeld = true;
    f.replace(which === "missing" ? undefined : live);
    expect(decideServerRequest("mcpServer/elicitation/request", prompt, f.ctx)).toEqual({
      verdict: "declined",
      result: { action: "decline" },
    });
  });
  it.each(["brain", "turn"])(
    "declines an aborted %s even with unchanged object identity",
    (which) => {
      const f = fixture();
      (which === "brain" ? f.brain : f.turnAbort).abort();
      expect(decideServerRequest("mcpServer/elicitation/request", prompt, f.ctx).verdict).toBe(
        "declined",
      );
    },
  );
  it.each([undefined, "previous-wire-turn"])(
    "refuses a missing or stale server turn ID %s",
    (turnId) => {
      expect(
        decideServerRequest("mcpServer/elicitation/request", { ...prompt, turnId }, ctx).verdict,
      ).toBe("declined");
    },
  );
  it("rechecks trusted authority immediately before accept and fails closed when it throws", () => {
    const f = fixture();
    let calls = 0;
    const changed = {
      ...f.ctx,
      current: () => (++calls === 1 ? f.ctx.captured : { ...f.ctx.captured, authGeneration: 1 }),
    };
    expect(decideServerRequest("mcpServer/elicitation/request", prompt, changed).verdict).toBe(
      "declined",
    );
    expect(
      decideServerRequest("mcpServer/elicitation/request", prompt, {
        ...f.ctx,
        current: () => {
          throw new Error("FAKE-AUTH-SECRET");
        },
      }),
    ).toEqual({ verdict: "declined", result: { action: "decline" } });
  });
  it("holds a fixed approval snapshot for the final RPC write and refuses cloned decisions", () => {
    const f = fixture(),
      decision = decideServerRequest("mcpServer/elicitation/request", prompt, f.ctx);
    expect(decision.verdict).toBe("approved");
    expect(isApprovalCurrent(decision)).toBe(true);
    expect(isApprovalCurrent({ ...decision })).toBe(false);
    f.replace({ ...f.ctx.captured, authGeneration: 1 });
    expect(isApprovalCurrent(decision)).toBe(false);
  });
  it("a replacement capture cannot rescue an already issued old approval", () => {
    const f = fixture(),
      decision = decideServerRequest("mcpServer/elicitation/request", prompt, f.ctx),
      next = { ...f.ctx.captured, authGeneration: 1 };
    f.replace(next);
    Object.assign(f.ctx, { captured: next });
    expect(isApprovalCurrent(decision)).toBe(false);
  });
  it.each([null, [], {}, "request", { ...prompt, requestedSchema: null }])(
    "does not accept a malformed MCP form",
    (params) => {
      expect(decideServerRequest("mcpServer/elicitation/request", params, ctx).verdict).toBe(
        "declined",
      );
    },
  );
  it("never echoes unknown methods, parameters or secret-like strings into user diagnostics", () => {
    const decision = decideServerRequest(
      "FAKE-AUTH-AND-SOCKET-CAPABILITY",
      { url: "FAKE-LOGIN-URL" },
      ctx,
    );
    expect(decision).toEqual({
      verdict: "declined",
      error: { code: -32601, message: "localDot does not handle this Codex request." },
    });
    expect(JSON.stringify(decision)).not.toContain("FAKE-");
  });
});
describe("safe flat form defaults", () => {
  it("omits inherited, mismatched, nonfinite and true defaults", () => {
    const inherited = Object.create({ default: "inherited" });
    inherited.type = "string";
    expect(
      explicitDefaults({
        type: "object",
        properties: {
          inherited,
          wrong: { type: "boolean", default: "true" },
          nan: { type: "number", default: NaN },
          infinite: { type: "number", default: Infinity },
          fraction: { type: "integer", default: 1.2 },
          yes: { type: "boolean", default: true },
          no: { type: "boolean", default: false },
          integer: { type: "integer", default: 2 },
        },
      }),
    ).toEqual({ no: false, integer: 2 });
  });
  it("preserves explicitly named __proto__ fields without altering prototypes", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string","default":"inert"}}}',
    );
    const defaults = explicitDefaults(schema);
    expect(Object.hasOwn(defaults, "__proto__")).toBe(true);
    expect(JSON.stringify(defaults)).toBe('{"__proto__":"inert"}');
    expect(({} as Record<string, unknown>).inert).toBeUndefined();
  });
  it("matches only complete denial option labels and preserves question IDs safely", () => {
    const questions = [
      { id: "__proto__", options: [{ label: "Allow (No more prompts)" }, { label: " NO " }] },
      { id: "ordinary", options: [{ label: "Do not deny" }, { label: "Cancel request" }] },
    ];
    const decision = decideServerRequest("item/tool/requestUserInput", { questions }, ctx);
    expect(decision).toMatchObject({
      verdict: "declined",
      result: {
        answers: JSON.parse('{"__proto__":{"answers":[" NO "]},"ordinary":{"answers":[]}}'),
      },
    });
  });
});
