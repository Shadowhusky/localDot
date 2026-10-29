import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventDraft } from "@localdot/protocol";
import { afterEach, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { resumable, SubagentLedger, unfinishedIn } from "./subagents.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const run = (id: string, state: string, reason?: string) => ({
  id,
  runId: `run-${id}`,
  label: `Part ${id}`,
  state,
  ...(reason ? { reason } : {}),
});
const ids = (runs: { id: string; reason?: string }[]) => runs.map((r) => `${r.id} ${r.reason}`);

it("resumes what a limit, an error, a restart or the user's takeover stopped, nothing else", () => {
  const ledger = new SubagentLedger();
  for (const [id, state, reason] of [
    ["a", "interrupted", "limit"],
    ["b", "interrupted", "error"],
    ["c", "interrupted", "restarted"],
    ["d", "interrupted", "control"],
    ["e", "interrupted", "stopped"],
    ["f", "interrupted", "cancelled"],
    ["g", "completed"],
    ["h", "failed"],
    ["i", "interrupted"],
  ] as const)
    ledger.fold("subagent.state", run(id, state, reason));
  ledger.fold("session.end", { reason: "stopped" });
  expect(ids(ledger.unfinished())).toEqual(["a limit", "b error", "c restarted", "d control"]);
});

it("follows each agent's latest run, and a completed task settles what was left", () => {
  const ledger = new SubagentLedger();
  ledger.fold("subagent.state", run("a", "interrupted", "limit"));
  ledger.fold("subagent.state", run("b", "interrupted", "limit"));
  ledger.fold("subagent.state", run("a", "running"));
  ledger.fold("subagent.state", run("a", "completed"));
  ledger.fold("task.result", { summary: "Blocked", files: [], outcome: "blocked" });
  ledger.fold("session.end", { reason: "stopped" });
  expect(ids(ledger.unfinished())).toEqual(["b limit"]);
  ledger.fold("task.result", { summary: "Done", files: [] });
  expect(ledger.unfinished()).toEqual([]);
  expect(ledger.has("b")).toBe(false);
});

it("reads an earlier task's log, counting agents a daemon crash left running", () => {
  const home = mkdtempSync(join(tmpdir(), "ld-subagents-"));
  homes.push(home);
  const log = new EventLog(home);
  try {
    const crashed = log.createSession("Crashed");
    const ended = log.createSession("Ended");
    const add = (id: string, type: string, data: unknown) =>
      log.append(id, { type, agent: "main", data } as unknown as EventDraft);
    add(crashed, "subagent.state", run("a", "running"));
    add(crashed, "subagent.state", run("b", "interrupted", "limit"));
    add(crashed, "message.assistant", { messageId: "01M5MSG0000000000000000000", text: "Hi" });
    add(ended, "subagent.state", run("c", "running"));
    add(ended, "session.end", { reason: "stopped" });
    expect(ids(unfinishedIn(log.logFile(crashed)))).toEqual(["b limit", "a restarted"]);
    expect(unfinishedIn(log.logFile(ended))).toEqual([]);
    expect(unfinishedIn(join(home, "missing.jsonl"))).toEqual([]);
  } finally {
    log.close();
  }
});

it("hands on only agents whose brief was kept", () => {
  const brief = { id: "a", label: "Old label", instructions: "Write it", progress: "Half" };
  expect(
    resumable(
      [
        { ...run("a", "interrupted", "error"), state: "interrupted", reason: "error" },
        { ...run("b", "interrupted", "error"), state: "interrupted", reason: "error" },
      ],
      [brief],
    ),
  ).toEqual([{ ...brief, label: "Part a", runId: "run-a", reason: "error" }]);
});
