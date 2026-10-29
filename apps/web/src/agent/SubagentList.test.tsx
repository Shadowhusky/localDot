// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import { SubagentList } from "./SubagentList.tsx";

afterEach(cleanup);
const ev = (seq: number, data: Record<string, unknown>) =>
  ({
    v: 1,
    id: `e${seq}`,
    seq,
    t: seq * 1000,
    agent: "main",
    type: "subagent.state",
    data,
  }) as never;

it("says why a child stopped, and keeps that run when it resumes", () => {
  const child = { id: "child-a", label: "Research sources" };
  const other = { id: "child-b", label: "Check the figures" };
  const model = [
    ev(0, { ...child, runId: "run-1", state: "running" }),
    ev(1, { ...other, runId: "run-2", state: "running" }),
    ev(2, { ...child, runId: "run-1", state: "interrupted", reason: "limit" }),
    ev(3, { ...other, runId: "run-2", state: "interrupted", reason: "error" }),
    ev(4, { ...child, runId: "run-3", state: "running", resumed: true }),
  ].reduce(projectAgentEvent, emptyAgentModel());
  render(<SubagentList agents={model.subagents} />);
  expect(screen.getByText("Resumed")).toBeTruthy();
  expect(screen.getByText("Interrupted")).toBeTruthy();
  expect(screen.getByText("Stopped by an error")).toBeTruthy();
  fireEvent.click(screen.getByText("Earlier runs"));
  expect(screen.getByText("Interrupted · Usage limit reached")).toBeTruthy();
});
