import { TOOL_NAMES } from "@localdot/protocol";
import { workingRules } from "@localdot/protocol/guidance";
import { describe, expect, it } from "vitest";
import { codexInstructions } from "./instructions.ts";
import { CODEX_TOOL_DESCRIPTIONS } from "./mcp-tools.ts";

describe("Codex developer instructions", () => {
  it("keeps tools inside localDot and directs credential entry to takeover", () => {
    const text = codexInstructions({
      memory: { user: "Richard", memory: "Weather" },
      skills: [],
      today: new Date("2026-10-03T12:00:00Z"),
    });
    for (const piece of [
      "2026-10-03",
      "localdot",
      "request_takeover",
      "ask_user",
      "done",
      "never spawn sub-agents",
      "untrusted",
      "Richard",
    ])
      expect(text).toContain(piece);
    expect(text).not.toContain("m.sock");
  });
  it("names every localdot tool and follows dot's rules for batched inputs, briefly", () => {
    const text = codexInstructions({
      memory: { user: "", memory: "" },
      skills: [],
      today: new Date("2026-10-09T12:00:00Z"),
    });
    expect(text).toContain(TOOL_NAMES.join(", "));
    expect(text).toContain("browser_upload");
    expect(text).toContain(workingRules("batch"));
    expect(text.length).toBeLessThan(4200);
    expect(text).not.toMatch(/signed-in browser|\bcells?\b|surrogate|\bkeyd\b/i);
  });
  it("lists skills as files in the task computer, with no host paths", () => {
    const text = codexInstructions({
      memory: { user: "", memory: "" },
      today: new Date("2026-10-03T12:00:00Z"),
      skills: [{ name: "office", path: "~/skills/office", description: "Create documents" }],
    });
    expect(text).toContain("~/skills/office");
    expect(text).toContain("SKILL.md");
  });
  it("works inside the computer without asking, and asks or hands over only when blocked", () => {
    const text = codexInstructions({
      memory: { user: "", memory: "" },
      skills: [],
      today: new Date("2026-10-08T12:00:00Z"),
    });
    for (const rule of [
      "do whatever the task needs without asking: install packages, write and run scripts, open and use apps",
      "The safety system asks the user before consequential steps such as sending, posting, buying, deleting online data, uploading files or changing account settings, so never ask the user for permission yourself.",
      "Use ask_user only when you cannot continue without the user's information or a choice that would change the result.",
      "pick sensible defaults for small details and mention them in your summary",
      "Use request_takeover only for a CAPTCHA, a device approval (such as confirming a sign-in on the user's phone), or when the user prefers to do it themselves",
      "a secret field whose target is the password box",
      "Never ask for passwords, card numbers or other secrets in a plain message or a text field",
    ])
      expect(text).toContain(rule);
    expect(text).not.toContain("rather than guess");
    expect(text).not.toContain("decisions you cannot infer");
    expect(CODEX_TOOL_DESCRIPTIONS.ask_user).toContain(
      "Only when you cannot continue without the user's information or a choice that would change the result",
    );
    expect(CODEX_TOOL_DESCRIPTIONS.ask_user).toContain("Never ask for permission");
    expect(CODEX_TOOL_DESCRIPTIONS.ask_user).toContain("you only learn that it was provided");
    expect(CODEX_TOOL_DESCRIPTIONS.request_takeover).toContain(
      "Only for a CAPTCHA, a device approval (such as confirming a sign-in on the user's phone), or when the user prefers to do it themselves",
    );
  });
});
