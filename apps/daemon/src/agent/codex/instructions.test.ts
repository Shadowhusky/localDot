import { describe, expect, it } from "vitest";
import { codexInstructions } from "./instructions.ts";

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
  it("lists skills as files in the task computer, with no host paths", () => {
    const text = codexInstructions({
      memory: { user: "", memory: "" },
      today: new Date("2026-10-03T12:00:00Z"),
      skills: [{ name: "office", path: "~/skills/office", description: "Create documents" }],
    });
    expect(text).toContain("~/skills/office");
    expect(text).toContain("SKILL.md");
  });
});
