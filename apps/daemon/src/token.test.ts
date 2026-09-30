import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localdotHome } from "./paths.ts";
import { loadOrCreateToken, tokensMatch } from "./token.ts";

describe("loadOrCreateToken", () => {
  it("creates a 0600 token once and reuses it, even under an apostrophe path", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's home-"));
    const file = join(home, "nested", "daemon-token");
    const first = loadOrCreateToken(file);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(file)).toBe(first);
  });
});

describe("tokensMatch", () => {
  it("matches only the exact token", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("abc", undefined)).toBe(false);
  });
});

describe("localdotHome", () => {
  it("honours LOCALDOT_HOME", () => {
    expect(localdotHome({ LOCALDOT_HOME: "/tmp/x" })).toBe("/tmp/x");
  });
});
