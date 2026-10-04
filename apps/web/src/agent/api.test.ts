import { expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import { AgentResponseError, loadAgentSnapshot, parseAgentSnapshot } from "./api.ts";

const sessionId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
  cellId = "01JXYZ0000000000000000ABCD";
const valid = { sessionId, cellId, status: "running", toolCalls: 3 };
it("accepts only the exact task identity and current strict status document", () => {
  const data = { ...valid, brainCellId: cellId, pendingAsk: sessionId, pendingTakeover: cellId };
  const snapshot = parseAgentSnapshot(data, sessionId, cellId);
  expect(snapshot).toEqual(data);
  expect(Object.isFrozen(snapshot)).toBe(true);
  data.status = "ended";
  expect(snapshot.status).toBe("running");
});
for (const [label, value] of [
  ["null", null],
  ["array", []],
  ["old session", { ...valid, sessionId: cellId }],
  ["other cell", { ...valid, cellId: sessionId }],
  ["unknown status", { ...valid, status: "done" }],
  ["missing count", { sessionId, cellId, status: "running" }],
  ["negative count", { ...valid, toolCalls: -1 }],
  ["fractional count", { ...valid, toolCalls: 1.5 }],
  ["unsafe count", { ...valid, toolCalls: Number.MAX_SAFE_INTEGER + 1 }],
  ["string count", { ...valid, toolCalls: "3" }],
  ["null pending", { ...valid, pendingAsk: null }],
  ["invalid pending", { ...valid, pendingTakeover: "not-a-request" }],
  ["invalid brain", { ...valid, brainCellId: "unsafe" }],
  ["manual state without ownership", { ...valid, manualControl: "ready" }],
  ["unknown manual state", { ...valid, pendingTakeover: cellId, manualControl: "safe" }],
  ["unknown fields", { ...valid, credential: "inert-do-not-echo" }],
  ["inherited fields", Object.create(valid)],
] as const) {
  it(`refuses ${label} without echoing the payload`, () => {
    expect(() => parseAgentSnapshot(value, sessionId, cellId)).toThrow(AgentResponseError);
    expect(() => parseAgentSnapshot(value, sessionId, cellId)).not.toThrow("inert-do-not-echo");
  });
}
it("binds the read to the session and propagates owner cancellation without bypassing the deadline", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  const api = createApi("inert", {
    origin: "http://fixture",
    fetchImpl: async (url, init) => {
      expect(String(url)).toBe(`http://fixture/api/agent/sessions/${sessionId}`);
      signal = init?.signal;
      return new Response(JSON.stringify(valid));
    },
  });
  expect(await loadAgentSnapshot(api, sessionId, cellId, controller.signal)).toEqual(valid);
  expect(signal?.aborted).toBe(false);
  controller.abort();
  expect(signal?.aborted).toBe(true);
});
it("refuses malformed identity before any network request", async () => {
  let calls = 0;
  const api = createApi("inert", {
    origin: "http://fixture",
    fetchImpl: async () => {
      calls++;
      return new Response("{}");
    },
  });
  await expect(loadAgentSnapshot(api, "../unsafe", cellId)).rejects.toBeInstanceOf(
    AgentResponseError,
  );
  expect(calls).toBe(0);
});
