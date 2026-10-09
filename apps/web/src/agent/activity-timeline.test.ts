import { describe, expect, it } from "vitest";
import { keyUseRow, type TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import {
  type ActivityEntry,
  type ActivityStep,
  changeView,
  diffStat,
  type EntryView,
  entryView,
  foldKeyUses,
  withNextMoves,
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
      meta: "Exit code 1.",
      time: "0:02",
      state: "failed",
      failed: true,
    });
    expect(entryView(open, [], true)).toMatchObject({
      state: "todo",
      stateLabel: "Not confirmed",
      meta: "The task ended before this step finished.",
    });
    expect(entryView(files, [change], false)).toMatchObject({
      title: "Created dog.md",
      meta: "Files · +2",
    });
    expect(changeView(change)).toMatchObject({
      title: "dog.md",
      meta: "Created · +2",
      icon: "file",
    });
  });

  it("names a daily note apart from the facts dot always reads", () => {
    const memory = (path: string, undoes?: string) =>
      ({
        id: "m",
        type: "memory",
        path,
        patch: "+- Gate code noted\n",
        truncated: false,
        changeId: "01JXYZ0000000000000000CHNG",
        ...(undoes ? { undoes } : {}),
      }) as const;
    expect(changeView(memory("notes/2026-10-08.md")).meta).toMatch(/^Added to today's notes/);
    expect(changeView(memory("notes/2026-10-08.md", "01JXYZ0000000000000000PREV")).meta).toMatch(
      /^Daily note undone/,
    );
    expect(changeView(memory("MEMORY.md")).meta).toMatch(/^Memory updated/);
  });

  it("says where a screen step happened and how, or why its input never reached the computer", () => {
    const row = (extra: Partial<StepRowView>): ActivityEntry => ({
      key: "s",
      keys: [],
      row: {
        kind: "step",
        id: "s",
        startT: 0,
        computer: {
          id: "s",
          label: "Selecting February's net total",
          startT: 0,
          status: "doing",
          durationMs: null,
          ...extra,
        },
      },
    });
    expect(entryView(row({ app: "Calc", gesture: "click F3" }), [], false)).toMatchObject({
      testId: "step-row",
      meta: "Calc · click F3",
      time: "",
      state: "doing",
    });
    expect(
      entryView(
        row({
          status: "failed",
          durationMs: 200,
          delivery: "proposed",
          reason: "The target changed before input.",
        }),
        [],
        false,
      ),
    ).toMatchObject({ meta: "The target changed before input.", time: "0:01", failed: true });
  });

  it("leads a call's first row with dot's line for it, and keeps what it did in the meta line", () => {
    const screen: ActivityEntry = {
      key: "s",
      keys: [],
      row: {
        kind: "step",
        id: "s",
        startT: 0,
        computer: {
          id: "s",
          label: "Clicked “Search”",
          startT: 0,
          status: "ok",
          durationMs: 400,
          app: "Telegram",
          gesture: "click Search",
          intent: "Finding your chat with Mum",
        },
      },
    };
    expect(entryView(screen, [], false)).toMatchObject({
      title: "Finding your chat with Mum",
      meta: "Telegram · Clicked “Search”",
    });
    const command: ActivityEntry = {
      key: "c",
      keys: [],
      row: stepRow("c", 0, undefined, {
        intent: "Checking which paint apps are installed",
        tool: { name: "shell", title: "command -v gimp krita" },
        status: "ok",
      }),
    };
    expect(entryView(command, [], false)).toMatchObject({
      title: "Checking which paint apps are installed",
      meta: "Terminal · command -v gimp krita",
    });
  });

  it("shows dot's line for a call as plain words, as the band does", () => {
    const entry: ActivityEntry = {
      key: "c",
      keys: [],
      row: stepRow("c", 0, undefined, {
        intent: "Saving **report.ods** to `~/Documents`",
        tool: { name: "shell", title: "cp report.ods ~/Documents" },
        status: "ok",
      }),
    };
    expect(entryView(entry, [], false).title).toBe("Saving report.ods to ~/Documents");
  });

  it("says in a failed row what dot did next: tried again, made room and tried again, or moved on", () => {
    const view = (title: string, state: EntryView["state"] = "done", meta = ""): EntryView => ({
      testId: "step-row",
      title,
      meta,
      time: "",
      state,
      stateLabel: state,
      startT: 0,
      endT: null,
    });
    const failed = view("Click Save", "failed", "The target changed before input.");
    const metas = (views: EntryView[]) => withNextMoves(views).map((row) => row.meta);
    expect(metas([failed, view("Clicked Save")])).toEqual([
      "The target changed before input. Tried again.",
      "",
    ]);
    expect(metas([failed, view("Scrolled down"), view("Clicked Save")])[0]).toBe(
      "The target changed before input. Scrolled down, then tried again.",
    );
    expect(metas([failed, view("Opened the File menu")])[0]).toBe(
      "The target changed before input. Then opened the File menu.",
    );
    expect(metas([view("Export", "failed", "Exit code 1")])).toEqual(["Exit code 1"]);
  });

  it("counts added and removed lines, not file headers", () => {
    expect(diffStat(["--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more"])).toBe("+2 −1");
    expect(diffStat([undefined, ""])).toBe("");
  });
});
