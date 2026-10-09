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
  it("lists skills as files in the task computer, with no host paths", () => {
    const text = codexInstructions({
      memory: { user: "", memory: "" },
      today: new Date("2026-10-03T12:00:00Z"),
      skills: [{ name: "office", path: "~/skills/office", description: "Create documents" }],
    });
    expect(text).toContain("~/skills/office");
    expect(text).toContain("SKILL.md");
  });
  it("never works around the network rules, and says when a connection waits or was refused", () => {
    const text = codexInstructions({
      memory: { user: "", memory: "" },
      skills: [],
      today: new Date("2026-10-09T12:00:00Z"),
    });
    for (const rule of [
      "Never build tunnels, proxies, relays or port forwards to get around these rules.",
      "If a connection is waiting for the user's approval or was refused, say so plainly",
      "waits until the user allows it on a card",
    ])
      expect(text).toContain(rule);
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
      "Use request_takeover only for a login, 2FA, a CAPTCHA or payment card entry, or after you have tried at least two different approaches and cannot continue; say in the note what you tried.",
    ])
      expect(text).toContain(rule);
    expect(text).not.toContain("rather than guess");
    expect(text).not.toContain("decisions you cannot infer");
    expect(CODEX_TOOL_DESCRIPTIONS.ask_user).toContain(
      "Only when you cannot continue without the user's information or a choice that would change the result",
    );
    expect(CODEX_TOOL_DESCRIPTIONS.ask_user).toContain("Never ask for permission");
    expect(CODEX_TOOL_DESCRIPTIONS.request_takeover).toContain(
      "Only for a login, 2FA, a CAPTCHA or payment card entry, or after you have tried at least two different approaches and cannot continue; say in the note what you tried.",
    );
  });
});
