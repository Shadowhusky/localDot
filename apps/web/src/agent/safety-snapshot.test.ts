import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { expect, it } from "vitest";
import { parseAgentSnapshot } from "./api.ts";

const cellId = "01J00000000000000000000001",
  sessionId = "01J00000000000000000000002";
const base = { cellId, sessionId, status: "running", toolCalls: 0 };
const approval = {
  approvalId: "01J00000000000000000000003",
  generation: 1,
  revision: 2,
  expiresAt: Date.now() + 60000,
  actionClass: "send",
  risk: "high",
  title: "<img src=x onerror=alert(1)>",
  fields: [["To", "Synthetic recipient"]],
};
const pause = {
  requestId: "01J00000000000000000000004",
  revision: 1,
  phase: "pausing",
  reason: "user",
  atStepBoundary: false,
  resumeAvailable: false,
};
it("accepts strict daemon safety snapshots including the frozen policy", () => {
  const parsed = parseAgentSnapshot(
    { ...base, autonomy: DEFAULT_AUTONOMY, approval, pause },
    sessionId,
    cellId,
  );
  expect(parsed).toMatchObject({ approval, pause, autonomy: DEFAULT_AUTONOMY });
});
it("does not turn unsafe snapshot fields into authority", () => {
  for (const bad of [
    { ...approval, permit: true },
    { ...approval, generation: 0 },
    { ...approval, revision: NaN },
  ])
    expect(() => parseAgentSnapshot({ ...base, approval: bad }, sessionId, cellId)).toThrow();
  expect(() =>
    parseAgentSnapshot({ ...base, pause: { ...pause, resumeAvailable: true } }, sessionId, cellId),
  ).toThrow();
  expect(() =>
    parseAgentSnapshot(
      { ...base, autonomy: { ...DEFAULT_AUTONOMY, credentials: "act" } },
      sessionId,
      cellId,
    ),
  ).toThrow();
  expect(() =>
    parseAgentSnapshot(
      { ...base, cellId: "01J00000000000000000000009", approval },
      sessionId,
      cellId,
    ),
  ).toThrow();
});
