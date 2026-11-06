import { describe, expect, it } from "vitest";
import { loginOrigins, signInNeedsOwnBrowser } from "./accounts.ts";
import { accountProblem, passwordProblem } from "./saved-logins.ts";

describe("loginOrigins", () => {
  it("offers a page its own origin first, then its www twin", () => {
    expect(loginOrigins("https://github.com")).toEqual([
      "https://github.com",
      "https://www.github.com",
    ]);
    expect(loginOrigins("https://www.reddit.com")).toEqual([
      "https://www.reddit.com",
      "https://reddit.com",
    ]);
  });
  it("follows only the sign-in hosts listed for a known site", () => {
    const hosts = loginOrigins("https://login.live.com");
    expect(hosts).toContain("https://microsoft.com");
    expect(hosts).toContain("https://login.microsoftonline.com");
    expect(loginOrigins("https://microsoft.com")).toContain("https://login.live.com");
  });
  it("treats any other subdomain and any lookalike as another site", () => {
    for (const page of [
      "https://evil.github.com",
      "https://github.com.evil.test",
      "https://evil.login.live.com",
      "https://login.live.com.evil.test",
    ]) {
      const hosts = loginOrigins(page);
      expect(hosts).not.toContain("https://github.com");
      expect(hosts).not.toContain("https://login.live.com");
      expect(hosts).not.toContain("https://microsoft.com");
    }
  });
  it("keeps a port's origin to itself", () => {
    expect(loginOrigins("https://github.com:8443")).toEqual(["https://github.com:8443"]);
  });
});

describe("signInNeedsOwnBrowser", () => {
  it("names only Google's own sign-in host, over HTTPS", () => {
    expect(signInNeedsOwnBrowser("https://accounts.google.com/v3/signin/identifier")).toBe(true);
    for (const url of [
      "https://mail.google.com/",
      "https://accounts.google.com.evil.test/",
      "http://accounts.google.com/",
      "not a url",
      "",
    ])
      expect(signInNeedsOwnBrowser(url)).toBe(false);
  });
});

describe("what a saved login can hold", () => {
  it("takes a password as typed, spaces and all, and refuses what can't be typed", () => {
    expect(passwordProblem(" pass wörd 密碼 ")).toBeUndefined();
    expect(passwordProblem("")).toBeDefined();
    expect(passwordProblem("x".repeat(1001))).toBeDefined();
    expect(passwordProblem("a\u0007b")).toBeDefined();
    expect(passwordProblem("a​b")).toBeDefined();
    expect(accountProblem("")).toBeUndefined();
    expect(accountProblem("a\nb")).toBeDefined();
  });
});
