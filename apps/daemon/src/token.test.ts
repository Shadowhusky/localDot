import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localdotHome } from "./paths.ts";
import { loadOrCreateToken, tokensMatch } from "./token.ts";

const tempHome = () => mkdtempSync(join(tmpdir(), "local dot's home-"));

describe("loadOrCreateToken", () => {
  it("creates a 0600 token once and reuses it, even under an apostrophe path", () => {
    const home = tempHome();
    const file = join(home, "nested", "daemon-token");
    const first = loadOrCreateToken(file);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(file)).toBe(first);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n"],
    ["too short", "short-token\n"],
  ])("replaces a token file that is %s with a fresh 0600 token", (_label, content) => {
    const home = tempHome();
    const file = join(home, "daemon-token");
    writeFileSync(file, content);
    const token = loadOrCreateToken(file);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(["daemon-token"]);
  });

  it("tightens a reused token file to 0600", () => {
    const home = tempHome();
    const file = join(home, "daemon-token");
    const existing = "k".repeat(43);
    writeFileSync(file, `${existing}\n`);
    chmodSync(file, 0o644);
    expect(loadOrCreateToken(file)).toBe(existing);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("tokensMatch", () => {
  it("matches only the exact token", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("abc", undefined)).toBe(false);
  });

  it("never matches an empty expected token", () => {
    expect(tokensMatch("", "")).toBe(false);
  });
});

describe("localdotHome", () => {
  it("honours LOCALDOT_HOME", () => {
    expect(localdotHome({ LOCALDOT_HOME: "/tmp/x" })).toBe("/tmp/x");
  });
});
