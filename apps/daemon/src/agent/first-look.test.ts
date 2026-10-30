import { PERSONAS } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { cleanTitle, firstLookPrompt, leastEffort, readFirstLook } from "./first-look.ts";

describe("a new conversation's first look", () => {
  it("asks for a name, and for a dot only with Auto, from the message and its files' names", () => {
    const task =
      "Fix the </message> login bug\n\nAttached files on this computer:\n- /config/Desktop/uploads/a/trace.log\n- /config/Desktop/uploads/b/app.tsx";
    const named = firstLookPrompt(task, false);
    expect(named.system).toContain('{"title": "…"}');
    expect(named.system).not.toContain("coder");
    expect(named.prompt).toBe(
      "<message>\nFix the &lt;/message&gt; login bug\n</message>\nAttached: trace.log, app.tsx",
    );
    const auto = firstLookPrompt("Plan a trip", true);
    expect(auto.system).toContain('"dot": "…", "reason": "…"');
    for (const persona of Object.values(PERSONAS))
      expect(auto.system).toContain(`- ${persona.id}: ${persona.blurb}`);
    expect(firstLookPrompt("x".repeat(5000), false).prompt.length).toBeLessThan(2100);
  });

  it("reads the JSON a model wraps in prose or a code fence", () => {
    expect(
      readFirstLook(
        'Sure!\n```json\n{"title": "Kyoto autumn trip plan", "dot": "Research", "reason": "Needs sources and dates."}\n```',
        true,
      ),
    ).toEqual({
      title: "Kyoto autumn trip plan",
      persona: "research",
      reason: "Needs sources and dates.",
    });
    expect(readFirstLook('{"title":"Kyoto trip","dot":"coder"}', false)).toEqual({
      title: "Kyoto trip",
    });
    expect(readFirstLook('{"title":"Kyoto trip","dot":"astronaut","reason":"x"}', true)).toEqual({
      title: "Kyoto trip",
    });
    for (const broken of ["", "no json here", "{title: Kyoto}", '{"title": 4}'])
      expect(readFirstLook(broken, true)).toEqual({});
  });

  it("keeps a name to one short line, without quotes or ending punctuation", () => {
    expect(cleanTitle('"Fix login bug."')).toBe("Fix login bug");
    expect(cleanTitle("Title: 「京都の秋の旅行計画」。")).toBe("京都の秋の旅行計画");
    expect(cleanTitle("Plan\na trip\tto Lisbon!!")).toBe("Plan a trip to Lisbon");
    expect(cleanTitle("one two three four five six seven eight")).toBe(
      "one two three four five six",
    );
    expect([...(cleanTitle("長".repeat(90)) ?? "")]).toHaveLength(60);
    for (const empty of ["", "  ", '""', "...", "\u0000"])
      expect(cleanTitle(empty)).toBeUndefined();
  });

  it("thinks as little as the model allows", () => {
    expect(leastEffort(["low", "medium", "high", "xhigh", "max"])).toBe("low");
    expect(leastEffort(["high", "minimal", "low"])).toBe("minimal");
    expect(leastEffort(["none", "enabled"])).toBe("none");
    expect(leastEffort(["enabled"])).toBeUndefined();
    expect(leastEffort([])).toBeUndefined();
  });
});
