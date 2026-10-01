// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapToken, forgetToken, TOKEN_KEY } from "./token.ts";

const GOOD = "a".repeat(43);

describe("bootstrapToken", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("stores a token from the fragment and removes the fragment from the address bar", () => {
    window.location.hash = `#token=${GOOD}`;
    expect(bootstrapToken()).toBe(GOOD);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(GOOD);
    expect(window.location.hash).toBe("");
    expect(window.location.href.endsWith("/")).toBe(true);
  });

  it("ignores a malformed fragment token but still clears the fragment", () => {
    window.location.hash = "#token=abc";
    expect(bootstrapToken()).toBeNull();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("returns the stored token when there is no fragment, and nothing when the stored one is malformed", () => {
    window.localStorage.setItem(TOKEN_KEY, GOOD);
    expect(bootstrapToken()).toBe(GOOD);
    window.localStorage.setItem(TOKEN_KEY, "short");
    expect(bootstrapToken()).toBeNull();
  });

  it("forgets the token", () => {
    window.localStorage.setItem(TOKEN_KEY, GOOD);
    forgetToken();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
