import { ACTION_CLASS_LABELS, ActionClass } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { bannedWords } from "./banned.ts";
import { decisionWords, defaultScope } from "./decision.ts";

describe("decisionWords", () => {
  it("keeps the action's own words and turns a plain class name into a question", () => {
    expect(decisionWords({ actionClass: "send", title: "Send this email?" }).title).toBe(
      "Send this email?",
    );
    for (const actionClass of ActionClass.options) {
      const { title } = decisionWords({ actionClass, title: ACTION_CLASS_LABELS[actionClass] });
      expect(title, actionClass).toMatch(/\?$/);
    }
  });

  it("answers with the action's verb, never OK and Cancel", () => {
    expect(decisionWords({ actionClass: "send", title: "" })).toMatchObject({
      primary: "Send",
      secondary: "Don't send",
    });
    expect(decisionWords({ actionClass: "purchase", title: "" })).toMatchObject({
      primary: "Buy",
      secondary: "Don't buy",
    });
    expect(decisionWords({ actionClass: "browsing", title: "" })).toMatchObject({
      primary: "Allow",
      secondary: "Don't allow",
    });
  });

  it("says why in one plain sentence that promises no timeout", () => {
    for (const actionClass of ActionClass.options) {
      const words = decisionWords({ actionClass, title: "" });
      expect(words.why, actionClass).toMatch(/nothing times out\.$/);
      expect(bannedWords(Object.values(words).join(" "), true), actionClass).toEqual([]);
    }
    expect(decisionWords({ actionClass: "send", title: "" }).why).toBe(
      "Sending as you always needs your OK. dot waits here; nothing times out.",
    );
  });
});

describe("decisionWords line", () => {
  it("has dot ask in the first person, for the narration while it waits", () => {
    expect(decisionWords({ actionClass: "send", title: "Send this email?" }).line).toBe(
      "Can I send this email?",
    );
    expect(decisionWords({ actionClass: "unknown", title: "" }).line).toBe("Can I take this step?");
    for (const actionClass of ActionClass.options) {
      const { line } = decisionWords({ actionClass, title: ACTION_CLASS_LABELS[actionClass] });
      expect(line, actionClass).toMatch(/^Can I [a-z].*\?$/);
      expect(bannedWords(line, true), actionClass).toEqual([]);
    }
  });

  it("keeps a statement as the daemon said it", () => {
    expect(
      decisionWords({ actionClass: "browsing", title: "WeChat wants to connect to host:8080" })
        .line,
    ).toBe("WeChat wants to connect to host:8080");
  });
});

describe("defaultScope", () => {
  const task = [{ scope: "task" as const, label: "For this task" }];
  it("answers once for anything that acts as you", () => {
    for (const actionClass of ["send", "post", "purchase", "delete", "upload"] as const)
      expect(defaultScope({ actionClass, always: task })).toBe("once");
  });

  it("covers the rest of the task otherwise, when the card offers it", () => {
    expect(defaultScope({ actionClass: "browsing", always: task })).toBe("task");
    expect(defaultScope({ actionClass: "browsing" })).toBe("once");
  });
});
