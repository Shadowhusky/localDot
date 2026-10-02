// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { forgetToken, keepToken, storedToken, TOKEN_KEY, takeFragmentToken } from "./token.ts";

const GOOD = "a".repeat(43);
const NEWER = "b".repeat(43);

describe("install token", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("reads a token from the fragment and removes the fragment, without storing the token", () => {
    window.location.hash = `#token=${GOOD}`;
    expect(takeFragmentToken()).toBe(GOOD);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.location.hash).toBe("");
    expect(window.location.href.endsWith("/")).toBe(true);
    expect(takeFragmentToken()).toBeNull();
  });

  it("ignores a malformed fragment token but still clears the fragment", () => {
    for (const given of ["abc", "a".repeat(42), "a".repeat(44), "a".repeat(9000)]) {
      window.location.hash = `#token=${given}`;
      expect(takeFragmentToken(), given).toBeNull();
      expect(window.location.hash).toBe("");
    }
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("keeps a token and reads it back, and reads nothing when the stored one is malformed", () => {
    expect(storedToken()).toBeNull();
    keepToken(GOOD);
    expect(storedToken()).toBe(GOOD);
    window.localStorage.setItem(TOKEN_KEY, "short");
    expect(storedToken()).toBeNull();
    // An oversized token would only earn the UI a 431 on every request.
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(44));
    expect(storedToken()).toBeNull();
  });

  it("forgets only the token the daemon rejected", () => {
    keepToken(NEWER);
    forgetToken(GOOD);
    expect(storedToken()).toBe(NEWER);
    forgetToken(NEWER);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
