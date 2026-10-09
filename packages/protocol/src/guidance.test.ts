import { describe, expect, it } from "vitest";
import { workingRules } from "./guidance.ts";

const MODES = ["batch", "calls", "none"] as const;

describe("dot's working rules", () => {
  it("act first and fast: a brief plan, the most direct route, a new approach after two failures", () => {
    for (const rules of MODES.map(workingRules))
      for (const rule of [
        "Plan briefly",
        "keep going until the task is done",
        "the shell for data, files, installs and anything scriptable",
        "keyboard shortcuts, the address bar and search boxes over menus",
        "browser_read, then browser_act by ref on web pages",
        "If something fails twice, change approach",
        "search the web in the browser",
      ])
        expect(rules, rule).toContain(rule);
  });

  it("send predictable inputs together in the way the model's tools allow", () => {
    expect(workingRules("batch")).toContain("into one computer call");
    expect(workingRules("calls")).toContain("computer calls of a predictable sequence in one turn");
    for (const mode of ["batch", "calls"] as const) {
      const rules = workingRules(mode);
      expect(rules).toContain("drawing (drag along a path)");
      expect(rules).toContain("don't screenshot to check");
      expect(rules).toContain("find for a desktop control by its name");
    }
    const blind = workingRules("none");
    for (const absent of ["computer call", "zoom", "find for", "pixel", "Super+Space"])
      expect(blind, absent).not.toContain(absent);
  });

  it("leave consequential steps to the safety system and ask the user only when blocked", () => {
    const rules = workingRules("batch");
    for (const rule of [
      "do whatever the task needs without asking",
      "so never ask the user for permission yourself",
      "Use ask_user only when you cannot continue",
      "a secret field whose target is the password box",
      "Prefer a password or code to a QR code",
      "Use request_takeover only for a CAPTCHA, a device approval",
      "never get around it with tunnels, proxies or port forwards",
      "never name tools or localDot's internal parts",
    ])
      expect(rules, rule).toContain(rule);
  });

  it("stay short and never name localDot's own parts", () => {
    for (const rules of MODES.map(workingRules)) {
      expect(rules.length).toBeLessThan(3000);
      expect(rules).not.toMatch(/signed-in browser|\bcells?\b|surrogate|\bkeyd\b/i);
    }
  });
});
