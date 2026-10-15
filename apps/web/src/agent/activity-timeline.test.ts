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
  hasDetails,
  stepDetail,
} from "./activity.ts";
import type { AgentStep } from "./model.ts";
import { appendTerminal, emptyTerminal } from "./terminal-text.ts";

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

  it("says what a web search or page read did, placed on the web rather than the browser", () => {
    const [search, read] = foldKeyUses([
      stepRow("s", 1, undefined, {
        kind: "browser",
        status: "ok",
        tool: { name: "web_search", title: "Looked at images of “Zelda”", ok: true },
      }),
      stepRow("r", 2, undefined, {
        kind: "browser",
        status: "failed",
        note: "The site answered 404.",
        tool: { name: "web_fetch", title: "Read example.org", ok: false },
      }),
    ]) as [ActivityEntry, ActivityEntry];
    expect(entryView(search, [], false)).toMatchObject({
      title: "Looked at images of “Zelda”",
      meta: "Web",
      state: "done",
    });
    expect(entryView(read, [], false)).toMatchObject({
      title: "Read example.org",
      meta: "The site answered 404.",
      failed: true,
    });
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

  it("leaves a bare gesture out of the meta line, keeping the app and what it touched", () => {
    const row = (extra: Partial<StepRowView>): ActivityEntry => ({
      key: "s",
      keys: [],
      row: {
        kind: "step",
        id: "s",
        startT: 0,
        computer: {
          id: "s",
          label: "Picked brown from the palette",
          startT: 0,
          status: "ok",
          durationMs: 400,
          ...extra,
        },
      },
    });
    expect(entryView(row({ gesture: "click" }), [], false).meta).toBe("");
    expect(entryView(row({ gesture: "double-click" }), [], false).meta).toBe("");
    expect(entryView(row({ app: "Paint", gesture: "keys" }), [], false).meta).toBe("Paint");
    expect(entryView(row({ app: "Paint", gesture: "click Brown" }), [], false).meta).toBe(
      "Paint · click Brown",
    );
  });

  it("says only what went wrong in a failed row, since the next row says what dot did next", () => {
    const failed: ActivityEntry = {
      key: "f",
      keys: [],
      row: {
        kind: "step",
        id: "f",
        startT: 0,
        computer: {
          id: "f",
          label: "Type 8B5A2B in the hex field",
          startT: 0,
          status: "failed",
          durationMs: 400,
          reason: "The colour dialog didn't take the typed value.",
        },
      },
    };
    expect(entryView(failed, [], false).meta).toBe(
      "The colour dialog didn't take the typed value.",
    );
  });

  it("counts added and removed lines, not file headers", () => {
    expect(diffStat(["--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more"])).toBe("+2 −1");
    expect(diffStat([undefined, ""])).toBe("");
  });
});

describe("what a step shows unfolded", () => {
  const step = (
    id: string,
    extra: Partial<AgentStep>,
    computer?: Partial<StepRowView>,
  ): ActivityEntry => ({
    key: `step-${id}`,
    keys: [],
    row: {
      kind: "step",
      id,
      startT: 0,
      agent: agent(id, undefined, { terminal: emptyTerminal(), ...extra }),
      // As recorded, every step also has a row of its own, named by dot's line for it.
      ...(computer && {
        computer: {
          id,
          stepKind: extra.kind ?? "shell",
          startT: 0,
          label: extra.intent ?? extra.tool?.title ?? "",
          status: "ok" as const,
          durationMs: 400,
          ...computer,
        },
      }),
    },
  });
  const build = (extra: Partial<AgentStep> = {}, computer?: Partial<StepRowView>) =>
    step(
      "c",
      {
        intent: "Checking the build",
        tool: { name: "shell", title: "npm test --workspace web" },
        ...extra,
      },
      computer,
    );

  it("says what a step did when dot's line leads its row and the meta line doesn't", () => {
    const recorded = { stepKind: "shell" as const, intent: "Checking the build" };
    expect(stepDetail(build({ status: "ok" }, recorded), [])?.action).toEqual({
      text: "npm test --workspace web",
      code: true,
    });
    expect(
      stepDetail(build({ status: "failed" }, { ...recorded, status: "failed" }), [])?.action?.text,
    ).toBe("npm test --workspace web");
    // A meta line that names the command keeps it, until what went wrong takes its place.
    expect(stepDetail(build({ status: "ok" }), [])?.action).toBeUndefined();
    expect(
      stepDetail(build({ status: "failed", note: "The command returned exit code 1." }), [])?.action
        ?.text,
    ).toBe("npm test --workspace web");
    // Without dot's line, the title already says what the step did.
    expect(stepDetail(build({ intent: undefined, status: "failed" }), [])?.action).toBeUndefined();
  });

  it("says what a screen step tried when its row only says why it didn't happen", () => {
    const screen = (status: StepRowView["status"], reason?: string): ActivityEntry => ({
      key: "step-s",
      keys: [],
      row: {
        kind: "step",
        id: "s",
        startT: 0,
        computer: {
          id: "s",
          label: "Click Save",
          startT: 0,
          status,
          durationMs: 400,
          intent: "Saving the report",
          ...(reason ? { reason } : {}),
        },
      },
    });
    expect(stepDetail(screen("ok"), [])?.action).toBeUndefined();
    expect(stepDetail(screen("failed", "The target changed before input."), [])?.action).toEqual({
      text: "Click Save",
      code: false,
    });
  });

  it("offers to unfold a step only when unfolding shows more than its row", () => {
    const list = (extra: Partial<AgentStep> = {}) =>
      step(
        "l",
        {
          kind: "file",
          status: "failed",
          note: "The file or folder does not exist.",
          tool: { name: "files", title: "list /config/.agents/skills", ok: false },
          ...extra,
        },
        { stepKind: "file", status: "failed" },
      );
    expect(hasDetails(list(), [])).toBe(false);
    expect(hasDetails({ ...list(), keys: [key(1)] }, [])).toBe(true);
    const listed = appendTerminal(emptyTerminal(), "stdout", "SKILL.md\n");
    expect(
      hasDetails(
        list({
          status: "ok",
          note: undefined,
          output: [{ stream: "stdout", text: "SKILL.md\n" }],
          terminal: listed,
        }),
        [],
      ),
    ).toBe(true);
    // A command that ran and printed nothing says so, with its exit code.
    const quiet = { name: "shell", title: "true", ok: true, exitCode: 0 };
    expect(hasDetails(build({ intent: undefined, status: "ok", tool: quiet }, {}), [])).toBe(true);
    // A command still running has nothing to show until its first output.
    expect(hasDetails(build({ intent: undefined }, { status: "doing" }), [])).toBe(false);
    // A screen step shows its picture or says it has none; another step only a picture it took.
    const screen = { stepKind: "gui" as const };
    expect(hasDetails(build({ kind: "gui", intent: undefined }, screen), [])).toBe(true);
    const page = { stepKind: "browser" as const, frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N" };
    expect(hasDetails(build({ kind: "browser", intent: undefined }, page), [])).toBe(true);
  });
});
