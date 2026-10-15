import { describe, expect, it } from "vitest";
import { AgentSettingsDocument } from "./agent-settings.ts";
import { outfit, PERSONAS } from "./personas.ts";

describe("what a dot wears", () => {
  it("is its role's outfit, with this localDot's accessory", () => {
    expect(outfit(undefined)).toEqual([]);
    expect(outfit("research")).toEqual(PERSONAS.research.wearables);
    expect(outfit("finance", "star-pin")).toEqual(["suit", "star-pin"]);
    expect(outfit("research", "sunglasses")).toEqual(["mortarboard", "sunglasses"]);
  });

  it("puts a cap in the place of a hat, and sunglasses in the place of glasses", () => {
    expect(outfit("design", "cap")).toEqual(["scarf", "cap"]);
    expect(outfit("video", "cap")).toEqual(["mustache", "cap"]);
    expect(outfit("coder", "cap")).toEqual(["hoodie", "cap"]);
  });
});

describe("this localDot in settings", () => {
  const base = { main: { provider: "anthropic", model: "claude-sonnet-5-5" } };

  it("keeps a short plain name, an accessory and the user's other localDots", () => {
    const parsed = AgentSettingsDocument.parse({
      ...base,
      name: "  Studio Mac ",
      accessory: "bow",
      localDots: [{ name: "Office PC", url: "https://office.example.ts.net:4750" }],
    });
    expect(parsed.name).toBe("Studio Mac");
    expect(parsed.accessory).toBe("bow");
    expect(parsed.localDots).toHaveLength(1);
  });

  it("refuses markup in a name and addresses that aren't plain web addresses", () => {
    for (const name of ["<b>Mac</b>", "a".repeat(41), "line\nbreak"])
      expect(AgentSettingsDocument.safeParse({ ...base, name }).success, name).toBe(false);
    for (const url of ["javascript:alert(1)", "ftp://box", "https://user:pw@box", "not a url"])
      expect(
        AgentSettingsDocument.safeParse({ ...base, localDots: [{ name: "Box", url }] }).success,
        url,
      ).toBe(false);
  });
});
