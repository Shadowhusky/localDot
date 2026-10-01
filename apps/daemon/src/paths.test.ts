import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localdotHome } from "./paths.ts";

describe("localdotHome", () => {
  it("honours LOCALDOT_HOME", () => {
    expect(localdotHome({ LOCALDOT_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  it("treats an unset or empty LOCALDOT_HOME as ~/.localdot", () => {
    expect(localdotHome({})).toBe(join(homedir(), ".localdot"));
    expect(localdotHome({ LOCALDOT_HOME: "" })).toBe(join(homedir(), ".localdot"));
  });
});
