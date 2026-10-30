// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Action,
  argumentRows,
  commandText,
  fillComposer,
  fit,
  matchActions,
  matchCommands,
  onComposerFill,
  recentActions,
  rememberAction,
  rowInput,
  slashRows,
} from "./actions.ts";

afterEach(() => localStorage.clear());

const action = (over: Partial<Action> & Pick<Action, "id">): Action => ({
  title: over.id,
  description: "",
  group: "Task",
  run: vi.fn(),
  ...over,
});
const ACTIONS: Action[] = [
  action({
    id: "btw",
    command: "btw",
    title: "Ask a side question",
    input: "required",
    hint: "<question>",
    keywords: "aside",
  }),
  action({
    id: "resume",
    command: "resume",
    title: "Switch conversation",
    keywords: "continue history",
  }),
  action({
    id: "rename",
    command: "rename",
    title: "Rename this conversation",
    input: "optional",
    choices: [{ value: "auto", label: "Use the automatic title" }],
  }),
  action({
    id: "remember",
    command: "remember",
    title: "Remember something",
    input: "required",
    hint: "<fact>",
  }),
  action({
    id: "model",
    command: "model",
    title: "Switch model",
    choices: [
      { value: "a", label: "GPT-6" },
      { value: "b", label: "Claude Opus", current: true },
    ],
  }),
  action({
    id: "stop",
    command: "stop",
    title: "Stop the task",
    unavailable: "Nothing is running",
  }),
  action({ id: "settings", title: "Open Settings", keywords: "preferences" }),
];

describe("commandText", () => {
  it("reads a command name and what follows it, and leaves anything else a message", () => {
    expect(commandText("/")).toEqual({ name: "", spaced: false, arg: "" });
    expect(commandText("/Re")).toEqual({ name: "re", spaced: false, arg: "" });
    expect(commandText("/btw why so slow?\nreally")).toEqual({
      name: "btw",
      spaced: true,
      arg: "why so slow?\nreally",
    });
    expect(commandText("/rename ")).toEqual({ name: "rename", spaced: true, arg: "" });
    for (const message of [
      "/usr/bin is a path",
      "/ hello",
      "//comment",
      "hi /btw",
      " /btw x",
      "/9am",
    ])
      expect(commandText(message)).toBeNull();
  });
});

describe("matching", () => {
  it("ranks commands the typed name starts first, then those it is in, then their words", () => {
    expect(matchCommands(ACTIONS, "re").map((each) => each.command)).toEqual([
      "resume",
      "rename",
      "remember",
    ]);
    expect(matchCommands(ACTIONS, "side").map((each) => each.command)).toEqual(["btw"]);
    expect(matchCommands(ACTIONS, "").map((each) => each.id)).not.toContain("settings");
  });
  it("finds actions by any word of the title, command, keywords and group, best fits first", () => {
    expect(matchActions(ACTIONS, "settings").map((each) => each.id)[0]).toBe("settings");
    expect(matchActions(ACTIONS, "prefs").map((each) => each.id)).toEqual(["settings"]);
    expect(matchActions(ACTIONS, "/btw").map((each) => each.id)).toEqual(["btw"]);
    expect(fit("Switch conversation", "conv sw")).toBeGreaterThan(
      fit("Switch conversation", "cnv"),
    );
    expect(fit("Stop the task", "zz")).toBe(0);
  });
});

describe("rows", () => {
  it("lists the commands while the name is typed, then the chosen one's words and choices", () => {
    expect(slashRows(ACTIONS, commandText("/re") as never).map((row) => row.key)).toEqual([
      "resume",
      "rename",
      "remember",
    ]);
    expect(slashRows(ACTIONS, commandText("/rename Trip") as never)).toMatchObject([
      { kind: "text", text: "Trip" },
    ]);
    expect(slashRows(ACTIONS, commandText("/rename ") as never)).toMatchObject([
      { kind: "choice", choice: { value: "auto" } },
    ]);
    expect(slashRows(ACTIONS, commandText("/model opus") as never)).toMatchObject([
      { kind: "choice", choice: { value: "b" } },
    ]);
    expect(slashRows(ACTIONS, commandText("/btw ") as never)).toMatchObject([
      { kind: "action", key: "btw" },
    ]);
    expect(slashRows(ACTIONS, commandText("/nope x") as never)).toEqual([]);
    expect(argumentRows(ACTIONS[4] as Action, "", [])).toHaveLength(2);
    expect(argumentRows(ACTIONS[1] as Action, "", [{ value: "x", label: "Trip" }])).toHaveLength(1);
  });
  it("says why a row can't run, or what the action is given", () => {
    const [btw, , rename, , model, stop] = ACTIONS as [
      Action,
      Action,
      Action,
      Action,
      Action,
      Action,
    ];
    expect(rowInput({ kind: "action", key: "stop", action: stop })).toEqual({
      problem: "Nothing is running",
    });
    expect(
      rowInput({ kind: "action", key: "btw", action: btw }, commandText("/btw ") ?? undefined),
    ).toEqual({ problem: "Write the question after /btw." });
    expect(
      rowInput({ kind: "action", key: "btw", action: btw }, commandText("/btw hi") ?? undefined),
    ).toEqual({ text: "hi" });
    expect(
      rowInput(
        { kind: "action", key: "model", action: model },
        commandText("/model zz") ?? undefined,
      ),
    ).toEqual({ problem: "Nothing matches “zz”." });
    expect(rowInput({ kind: "text", key: "t", action: rename, text: "Trip" })).toEqual({
      text: "Trip",
    });
    expect(
      rowInput({
        kind: "choice",
        key: "c",
        action: model,
        choice: { value: "a", label: "GPT-6", unavailable: "Sign in first" },
      }),
    ).toEqual({ problem: "Sign in first" });
  });
});

describe("recent and composer requests", () => {
  it("keeps the latest actions run, newest first, without repeats", () => {
    for (const id of ["a", "b", "a", "c", "d", "e", "f", "g"]) rememberAction(id);
    expect(recentActions()).toEqual(["g", "f", "e", "d", "c", "a"]);
    localStorage.setItem("localdot.recent-actions.v1", "{not json");
    expect(recentActions()).toEqual([]);
  });
  it("hands words to the composer that listens", () => {
    const fill = vi.fn();
    const stop = onComposerFill(fill);
    fillComposer("/");
    stop();
    fillComposer("/x");
    expect(fill.mock.calls).toEqual([["/"]]);
  });
});
