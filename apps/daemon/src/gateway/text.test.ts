import { describe, expect, it } from "vitest";
import { clickLabel, clipTarget, keyLabel, scrollLabel, typeLabel } from "./text.ts";

describe("gateway labels", () => {
  it("names clicks by their target, else by coordinates, and clips to 80", () => {
    expect(
      clickLabel(
        { point: { x: 1, y: 2 }, source: "ax", role: "button", name: "Search" },
        { x: 1, y: 2 },
      ),
    ).toBe('Click "Search"');
    expect(clickLabel(null, { x: 10, y: 20 })).toBe("Click at (10, 20)");
    expect(
      clickLabel({ point: { x: 1, y: 2 }, source: "ax", name: "x".repeat(200) }, { x: 1, y: 2 })
        .length,
    ).toBe(80);
  });

  it("never puts masked text in a label", () => {
    expect(typeLabel("hunter2", true)).toBe("Type 7 characters");
    expect(typeLabel("hello", false)).toBe('Type "hello"');
    expect(typeLabel("a\nb\tc", false)).toBe('Type "a b c"');
  });

  it("writes key combos and scrolls for people", () => {
    expect(keyLabel(["ctrl", "l"])).toBe("Press Ctrl+L");
    expect(keyLabel(["Return"])).toBe("Press Return");
    expect(scrollLabel(0, 3)).toBe("Scroll down 3");
    expect(scrollLabel(-2, 0)).toBe("Scroll left 2");
  });

  it("clips every target string to its schema limit", () => {
    const t = clipTarget({
      point: { x: 0, y: 0 },
      source: "ax",
      role: "r".repeat(100),
      name: "n".repeat(100),
      app: "a".repeat(200),
      window: "w".repeat(300),
      url: `https://example.test/${"u".repeat(3000)}?private=secret#private`,
    });
    expect([
      t.role?.length,
      t.name?.length,
      t.app?.length,
      t.window?.length,
      t.url?.length,
    ]).toEqual([64, 64, 128, 256, 2048]);
  });

  it("removes user info, query and fragments from public target URLs", () => {
    const target = { point: { x: 0, y: 0 }, source: "ax" as const };
    expect(
      clipTarget({ ...target, url: "https://user:secret@example.test/path?token=secret#private" })
        .url,
    ).toBe("https://example.test/path");
    expect(clipTarget({ ...target, url: "not a URL" }).url).toBe("");
    expect(clipTarget({ ...target, url: "file:///private/secret" }).url).toBe("");
  });
});
