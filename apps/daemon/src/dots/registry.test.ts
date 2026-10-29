import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DotsRegistry, RegistryError, registryPath } from "./registry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const registry = () => {
  const dir = mkdtempSync(join(tmpdir(), "dots-registry-"));
  dirs.push(dir);
  return new DotsRegistry(registryPath({ XDG_CONFIG_HOME: dir }), "/Users/a/.localdot");
};

describe("the per-user list of dots", () => {
  it("lives beside install-location", () => {
    expect(registryPath({ XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config/localdot/dots.json");
  });

  it("is the first dot alone until another is added, then keeps every home privately", () => {
    const dots = registry();
    expect(dots.read()).toEqual([{ id: "main", home: "/Users/a/.localdot" }]);
    dots.update((entries) => [...entries, { id: "work", home: "/Users/a/.localdot-work" }]);
    expect(dots.read().map((dot) => dot.id)).toEqual(["main", "work"]);
    expect(statSync(dots.path).mode & 0o777).toBe(0o600);
    dots.update((entries) => entries.filter((entry) => entry.id !== "work"));
    expect(dots.read()).toEqual([{ id: "main", home: "/Users/a/.localdot" }]);
  });

  it.each([
    ["damaged", "{"],
    ["without the first dot first", JSON.stringify({ v: 1, dots: [{ id: "work", home: "/w" }] })],
    [
      "with a dot twice",
      JSON.stringify({
        v: 1,
        dots: [
          { id: "main", home: "/m" },
          { id: "main", home: "/n" },
        ],
      }),
    ],
    [
      "with a relative home",
      JSON.stringify({
        v: 1,
        dots: [
          { id: "main", home: "/m" },
          { id: "work", home: "w" },
        ],
      }),
    ],
  ])("refuses a list that is %s", (_, text) => {
    const dots = registry();
    mkdirSync(join(dots.path, ".."), { recursive: true });
    writeFileSync(dots.path, text, { mode: 0o600 });
    expect(() => dots.read()).toThrow(RegistryError);
    expect(() => dots.update((entries) => entries)).toThrow(RegistryError);
  });

  it("takes over a lock its process left behind, and waits for a live one", () => {
    const dots = registry();
    mkdirSync(join(dots.path, ".."), { recursive: true });
    writeFileSync(`${dots.path}.lock`, "999999999");
    dots.update((entries) => [...entries, { id: "work", home: "/w" }]);
    expect(dots.read()).toHaveLength(2);
  });
});
