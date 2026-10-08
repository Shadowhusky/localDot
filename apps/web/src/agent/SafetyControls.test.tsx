// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { SafetyControls } from "./SafetyControls.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { SafetyView } from "./useSafety.ts";

afterEach(cleanup);

const sessionId = "01J00000000000000000000002";
const cellId = "01J00000000000000000000001";
const agent: AgentSessionView = {
  sessionId,
  model: {
    ...emptyAgentModel(),
    state: { state: "acting" },
    lastHeartbeat: { t: 0, everyMs: 500, ongoing: true, receivedAt: performance.now() - 5000 },
  } as AgentSessionView["model"],
  snapshot: { sessionId, cellId, status: "running", toolCalls: 0 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile: vi.fn(),
};
const safety = {
  approval: null,
  pause: null,
  canPause: true,
  canResume: false,
  canReplace: false,
  canNotify: false,
  error: null,
  replacement: null,
  replacing: false,
  requestPause: vi.fn(),
} as unknown as SafetyView;

it("keeps the live task's Pause and Stop guidance out of Replay", () => {
  const view = render(<SafetyControls safety={safety} agent={agent} cell={null} />);
  expect(screen.getByRole("button", { name: "Pause after this step" })).toBeTruthy();
  expect(screen.getByText("Stop: Ctrl/Cmd + Shift + .")).toBeTruthy();
  expect(screen.getByText(/heartbeat is late/).textContent).toContain("use Stop");
  view.rerender(<SafetyControls safety={safety} agent={agent} cell={null} replaying />);
  expect(screen.queryByRole("button", { name: "Pause after this step" })).toBeNull();
  expect(screen.queryByText("Stop: Ctrl/Cmd + Shift + .")).toBeNull();
  expect(screen.getByText(/heartbeat is late/).textContent).toBe(
    "The live task's heartbeat is late. Switch to Watch if you want to stop it.",
  );
});
