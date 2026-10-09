import { describe, expect, it } from "vitest";
import {
  DESKTOP_BROWSER_NOTICE,
  desktopSignIn,
  KNOWN_SIGN_INS,
  SignInRequest,
  signInSite,
  signInUrl,
} from "./accounts.ts";

describe("the site a person names", () => {
  it("reads a name or an address as its host, without www", () => {
    expect(signInSite("google.com")).toBe("google.com");
    expect(signInSite("  Google.COM ")).toBe("google.com");
    expect(signInSite("www.github.com")).toBe("github.com");
    expect(signInSite("https://mail.google.com/mail/u/0/#inbox")).toBe("mail.google.com");
    expect(signInSite("http://example.co.uk/login?next=/")).toBe("example.co.uk");
  });

  it("refuses what the web browser can't open or isn't a site", () => {
    for (const value of [
      "",
      "google",
      "localhost",
      "printer.local",
      "nas.lan",
      "10.0.0.1",
      "router.home.arpa",
      "intranet.internal",
      "site.test",
      "ftp://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.com",
      "https://example.com:8443",
      "exa mple.com",
    ])
      expect(signInSite(value), value).toBeUndefined();
  });

  it("names only well-formed sites in a request", () => {
    expect(SignInRequest.safeParse({ site: "google.com" }).success).toBe(true);
    expect(SignInRequest.safeParse({ site: "https://google.com" }).success).toBe(false);
    expect(SignInRequest.safeParse({ site: "google.com", url: "x" }).success).toBe(false);
  });
});

describe("the page that opens", () => {
  it("is a known site's own sign-in page, for the site or any of its hosts", () => {
    expect(signInUrl("google.com")).toBe("https://accounts.google.com/");
    expect(signInUrl("mail.google.com")).toBe("https://accounts.google.com/");
    expect(signInUrl("github.com")).toBe("https://github.com/login");
  });

  it("is the home page of any other site", () => {
    expect(signInUrl("jev-games.com")).toBe("https://jev-games.com/");
  });

  it("is always a public https page", () => {
    for (const known of KNOWN_SIGN_INS) {
      const url = new URL(signInUrl(known.site));
      expect(url.protocol, known.site).toBe("https:");
      expect(signInSite(url.href), known.site).toBeDefined();
    }
  });
});

describe("a sign-in in the desktop's own browser", () => {
  it("offers the site of a known sign-in page", () => {
    expect(desktopSignIn("https://accounts.google.com/v3/signin/identifier?flowName=x")).toBe(
      "google.com",
    );
    expect(desktopSignIn("https://login.microsoftonline.com/common/oauth2")).toBe("microsoft.com");
    expect(desktopSignIn("https://github.com/login")).toBe("github.com");
  });

  it("offers the host of a page that looks like a sign-in", () => {
    expect(desktopSignIn("https://www.example.com/users/sign_in")).toBe("example.com");
    expect(desktopSignIn("https://login.example.org/")).toBe("login.example.org");
    expect(desktopSignIn("https://shop.example.com/account/login?next=/")).toBe("shop.example.com");
  });

  it("stays quiet on ordinary and local pages", () => {
    for (const url of [
      "https://www.google.com/search?q=login",
      "https://news.example.com/sessions-recap",
      "http://localhost:3000/login",
      "about:blank",
      "chrome://newtab/",
      "not a url",
    ])
      expect(desktopSignIn(url), url).toBeUndefined();
  });

  it("offers the site typed into localDot's notice page, and only there", () => {
    expect(desktopSignIn(`${DESKTOP_BROWSER_NOTICE}?site=Google.com`)).toBe("google.com");
    expect(desktopSignIn(`${DESKTOP_BROWSER_NOTICE}?site=localhost`)).toBeUndefined();
    expect(desktopSignIn(DESKTOP_BROWSER_NOTICE)).toBeUndefined();
    expect(desktopSignIn("file:///config/Downloads/page.html?site=google.com")).toBeUndefined();
  });
});
