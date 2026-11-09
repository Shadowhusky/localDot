import { describe, expect, it } from "vitest";
import {
  BLOCKER_KINDS,
  Blocker,
  blockerSubject,
  MODEL_BLOCKS,
  modelBlock,
  RequestFixInput,
  STALL,
} from "./blockers.ts";
import { LocalDotEvent, parseEvent } from "./events.ts";
import {
  blockerNote,
  HUMAN_INPUT_GUIDANCE,
  KEYS_LOCKED_NOTE,
  KEYS_UNLOCKED_NOTE,
  REQUEST_FIX_DESCRIPTION,
  workingRules,
} from "./guidance.ts";
import { TOOL_INPUTS, ToolName } from "./tools.ts";

const ID = "01M6R97SHHND5784EZZXSYSBGD";
const envelope = { v: 1, id: ID, seq: 3, t: 10, agent: "main" };

const EVERY: readonly Blocker[] = [
  { kind: "keys_locked" },
  { kind: "key", id: "openai", problem: "rejected" },
  { kind: "app", connector: "github", name: "GitHub", host: "api.githubcopilot.com" },
  { kind: "model", reason: STALL.modelRefused, detail: "400: Bad request" },
  { kind: "computer", state: "paused" },
  { kind: "runtime" },
];

describe("blocker kinds", () => {
  it("covers every kind the conversation has a card for", () => {
    expect([...BLOCKER_KINDS].sort()).toEqual(
      ["app", "computer", "key", "keys_locked", "model", "runtime"].sort(),
    );
    expect(new Set(EVERY.map((blocker) => blocker.kind)).size).toBe(BLOCKER_KINDS.length);
  });

  it("gives one card per thing, however often the failure repeats", () => {
    expect(blockerSubject({ kind: "keys_locked" })).toBe("keys_locked");
    expect(blockerSubject({ kind: "key", id: "a", problem: "rejected" })).toBe(
      blockerSubject({ kind: "key", id: "a", problem: "reenter" }),
    );
    expect(blockerSubject({ kind: "key", id: "a", problem: "rejected" })).not.toBe(
      blockerSubject({ kind: "key", id: "b", problem: "rejected" }),
    );
    expect(blockerSubject({ kind: "computer", state: "paused" })).toBe(
      blockerSubject({ kind: "computer", state: "stopped" }),
    );
  });

  it("has nowhere to carry a secret or dot's words", () => {
    for (const blocker of EVERY) {
      expect(Blocker.parse(blocker)).toEqual(blocker);
      for (const extra of ["passphrase", "value", "secret", "message", "question", "note"])
        expect(Blocker.safeParse({ ...blocker, [extra]: "hunter2" }).success, extra).toBe(false);
    }
    expect(
      Blocker.safeParse({ kind: "key", id: "Not A Key Name!", problem: "rejected" }).success,
    ).toBe(false);
    expect(Blocker.safeParse({ kind: "model", reason: "Type your passphrase here" }).success).toBe(
      false,
    );
  });

  it("knows which of a model's stalls the user fixes by choosing another", () => {
    for (const reason of MODEL_BLOCKS) expect(modelBlock(reason)).toBe(true);
    for (const reason of [STALL.modelBusy, STALL.budget, STALL.keyReenter, undefined])
      expect(modelBlock(reason)).toBe(false);
  });
});

describe("blocker events", () => {
  it("are raised and cleared in the task's log", () => {
    for (const blocker of EVERY) {
      const raised = parseEvent({
        ...envelope,
        type: "blocker.raise",
        data: { blockerId: ID, blocker, by: "localdot" },
      });
      expect(raised.type).toBe("blocker.raise");
    }
    for (const outcome of ["fixed", "dismissed"] as const)
      expect(
        parseEvent({
          ...envelope,
          type: "blocker.clear",
          data: { blockerId: ID, outcome },
        }).type,
      ).toBe("blocker.clear");
  });

  it("refuse anything beyond their fields", () => {
    const raise = (data: unknown) =>
      LocalDotEvent.safeParse({ ...envelope, type: "blocker.raise", data }).success;
    const clear = (data: unknown) =>
      LocalDotEvent.safeParse({ ...envelope, type: "blocker.clear", data }).success;
    expect(raise({ blockerId: ID, blocker: { kind: "keys_locked" }, by: "dot" })).toBe(true);
    expect(raise({ blockerId: ID, blocker: { kind: "keys_locked" }, by: "dot", note: "x" })).toBe(
      false,
    );
    expect(raise({ blockerId: "nope", blocker: { kind: "keys_locked" }, by: "dot" })).toBe(false);
    expect(clear({ blockerId: ID, outcome: "fixed", passphrase: "hunter2" })).toBe(false);
    expect(clear({ blockerId: ID, outcome: "maybe" })).toBe(false);
  });

  it("an old task's keys.lock still reads", () => {
    for (const locked of [true, false])
      expect(parseEvent({ ...envelope, type: "keys.lock", data: { locked } }).type).toBe(
        "keys.lock",
      );
  });
});

describe("request_fix", () => {
  it("is a tool of its own, offered to every harness", () => {
    expect(ToolName.options).toContain("request_fix");
    expect(TOOL_INPUTS.request_fix).toBe(RequestFixInput);
  });

  it("takes a typed kind and an id, and drops anything dot writes", () => {
    const parsed = RequestFixInput.parse({
      kind: "keys_locked",
      message: "Type your passphrase here",
      question: "Enter your passphrase",
      title: "Security check",
    });
    expect(parsed).toEqual({ kind: "keys_locked" });
    expect(RequestFixInput.safeParse({ kind: "show_any_card" }).success).toBe(false);
    expect(RequestFixInput.safeParse({ kind: "model" }).success).toBe(false);
    expect(RequestFixInput.safeParse({ kind: "key", key_id: "Not A Key!" }).success).toBe(false);
  });
});

describe("what dot is told", () => {
  it("says the fix is on screen, and never where to go", () => {
    expect(KEYS_LOCKED_NOTE).toContain("request_fix");
    for (const blocker of EVERY.filter((one) => one.kind !== "model"))
      for (const moment of ["raised", "fixed", "dismissed"] as const) {
        const note = blockerNote(blocker, moment);
        expect(note.startsWith("(localDot:"), note).toBe(true);
        expect(note, moment).not.toMatch(/go to|open settings|in settings|tap done/i);
      }
    expect(blockerNote({ kind: "keys_locked" }, "raised")).toBe(KEYS_LOCKED_NOTE);
    expect(blockerNote({ kind: "keys_locked" }, "fixed")).toBe(KEYS_UNLOCKED_NOTE);
    expect(blockerNote({ kind: "keys_locked" }, "dismissed")).toMatch(/carry on without/i);
  });

  it("carries nothing from the failure into its words but the names localDot holds", () => {
    const note = blockerNote(
      { kind: "app", connector: "github", name: "GitHub", host: "api.example" },
      "raised",
    );
    expect(note).toContain("GitHub");
    expect(blockerNote({ kind: "model", reason: STALL.modelRefused }, "raised")).toBe("");
  });

  it("rules say to raise the card, within their size", () => {
    for (const hands of ["batch", "calls", "none"] as const) {
      const rules = workingRules(hands);
      expect(rules).toContain("request_fix");
      expect(rules).toMatch(/never directions or a Done to tap/);
      expect(rules.length).toBeLessThan(6200);
    }
  });

  it("the tool's description and the ask guidance agree", () => {
    expect(REQUEST_FIX_DESCRIPTION).toContain("keys_locked");
    expect(REQUEST_FIX_DESCRIPTION).toContain("nothing you write appears on it");
    expect(REQUEST_FIX_DESCRIPTION).toMatch(/never tell the user to go/i);
    expect(HUMAN_INPUT_GUIDANCE).toContain("request_fix");
  });
});
