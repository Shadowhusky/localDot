import { describe, expect, it } from "vitest";
import { keyUseRow, type TimelineRow } from "../session/key-uses.ts";
import {
  type ActivityEntry,
  type ActivityStep,
  diffStat,
  entryView,
  foldKeyUses,
  groupEntries,
  groupMeta,
} from "./activity.ts";
import type { AgentStep } from "./model.ts";

const key = (t: number, decision: "allow" | "deny" = "allow") =>
  keyUseRow({
    id: `k${t}`,
    t,
    secretId: "main",
    host: "api.example.test",
    method: "POST",
    path: "/v1",
    decision,
  });
const agent = (id: string, planItem?: string, extra: Partial<AgentStep> = {}): AgentStep => ({
  id,
  kind: "shell",
  ...(planItem ? { planItem } : {}),
  output: [],
  outputTruncated: false,
  ...extra,
});
const stepRow = (
  id: string,
  startT: number,
  planItem?: string,
  extra: Partial<AgentStep> = {},
): TimelineRow<ActivityStep> => ({ kind: "step", id, startT, agent: agent(id, planItem, extra) });
const keys = (entries: ActivityEntry[]) =>
  entries.map((entry) => `${entry.key}:${entry.keys.map((use) => use.id).join(",")}`);

describe("the activity timeline", () => {
  it("folds allowed key uses into the step before them, or the first step when none came before", () => {
    const entries = foldKeyUses([
      key(1),
      stepRow("a", 2),
      key(3),
      key(4, "deny"),
      key(5),
      stepRow("b", 6),
    ]);
    expect(keys(entries)).toEqual(["step-a:k1,k3,k5", "key-k4:", "step-b:"]);
  });

  it("keeps allowed key uses as rows when there is no step to hold them", () => {
    expect(keys(foldKeyUses([key(1), key(2)]))).toEqual(["key-k1:", "key-k2:"]);
  });

  it("groups consecutive runs by plan item, keeping unplanned rows in time order", () => {
    const groups = groupEntries(
      foldKeyUses([
        stepRow("lead", 1),
        stepRow("a", 2, "open"),
        stepRow("loose", 3),
        stepRow("b", 4, "draw"),
        stepRow("c", 5, "open"),
      ]),
    );
    expect(groups.map((group) => [group.id, group.entries.map((entry) => entry.row.id)])).toEqual([
      ["open#0", ["lead", "a", "loose"]],
      ["draw#0", ["b"]],
      ["open#1", ["c"]],
    ]);
    expect(groupEntries(foldKeyUses([stepRow("x", 1)])).map((group) => group.id)).toEqual([
      "none#0",
    ]);
  });

  it("describes a failed command, an unfinished step after a crash, and a step's file changes", () => {
    const [failed, open, files] = foldKeyUses([
      stepRow("f", 1, undefined, {
        status: "failed",
        tool: { name: "shell", title: "Export", ok: false, exitCode: 1 },
        startedAt: 1_000_000,
        endedAt: 2_600_000,
      }),
      stepRow("o", 2),
      stepRow("w", 3, undefined, { kind: "file" }),
    ]) as [ActivityEntry, ActivityEntry, ActivityEntry];
    const change = {
      id: "c",
      step: "w",
      type: "file" as const,
      path: "notes/dog.md",
      op: "create" as const,
      patch: "@@ -0,0 +1,2 @@\n+a\n+b",
      truncated: false,
    };
    expect(entryView(failed, [], false)).toMatchObject({
      title: "Export",
      metric: "1.6 s",
      state: "failed",
      reason: "Exit code 1",
    });
    expect(entryView(open, [], true)).toMatchObject({
      state: "todo",
      stateLabel: "Not confirmed",
      reason: "The task ended before this step finished.",
    });
    expect(entryView(files, [change], false)).toMatchObject({
      title: "Created dog.md",
      metric: "+2",
      icon: "file-diff",
    });
  });

  it("says when a screen step's input never reached the computer", () => {
    const row: TimelineRow<ActivityStep> = {
      kind: "step",
      id: "s",
      startT: 0,
      computer: {
        id: "s",
        label: "Click Save",
        verb: "click",
        startT: 0,
        status: "failed",
        durationMs: 200,
        delivery: "proposed",
        reason: "The target changed before input.",
      },
    };
    expect(entryView({ key: "s", row, keys: [] }, [], false)).toMatchObject({
      testId: "step-row",
      notSent: true,
      reason: "The target changed before input.",
    });
  });

  it("counts a run's steps, failures and span, leaving key uses out", () => {
    const views = foldKeyUses([
      stepRow("a", 1000, "x", { status: "ok" }),
      key(1500, "deny"),
      stepRow("b", 2000, "x", { status: "failed" }),
    ]).map((entry) => entryView(entry, [], false));
    expect(groupMeta(views)).toEqual({ steps: 2, failed: 1, durationMs: 1000 });
  });

  it("counts added and removed lines, not file headers", () => {
    expect(diffStat(["--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more"])).toBe("+2 −1");
    expect(diffStat([undefined, ""])).toBe("");
  });
});
