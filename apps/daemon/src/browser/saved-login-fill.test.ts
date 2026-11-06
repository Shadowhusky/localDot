import { describe, expect, it, vi } from "vitest";
import { VaultLockedError } from "../keyd/client.ts";
import { BrowserClientError } from "./client.ts";
import { fillSavedLogin, type SignInHold, signInPageAsks } from "./saved-login-fill.ts";

const PASSWORD = "saved-password-canary";

function keys(saved: Record<string, { username: string; password: string }>) {
  const asked: string[] = [];
  return {
    asked,
    findLogin: vi.fn(async (origin: string) =>
      saved[origin] ? { origin, username: saved[origin].username, confirm: true } : undefined,
    ),
    login: vi.fn(async (origin: string) => {
      asked.push(origin);
      return saved[origin] ? { ...saved[origin] } : undefined;
    }),
  };
}

function hold(page: Awaited<ReturnType<SignInHold["signInPage"]>>) {
  return {
    signInPage: vi.fn(async () => page),
    fillSecret: vi.fn(async () => ({ filled: true, submitted: true })),
    input: vi.fn(async () => ({})),
    check: vi.fn(),
    secretFilled: vi.fn(),
    selection: { geometry: { scale: 2 as const } },
  };
}

const passwordPage = (origin: string) => ({
  tabId: "tab",
  origin,
  field: { kind: "password" as const, at: { x: 100, y: 200 } },
});

describe("the user's tap on a saved login", () => {
  it("sends the password from keyd to the page it was saved for, and says only how it went", async () => {
    const h = hold(passwordPage("https://github.com"));
    const k = keys({ "https://github.com": { username: "octo", password: PASSWORD } });
    const outcome = await fillSavedLogin(h, k);
    expect(outcome).toBe("submitted");
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
    expect(h.fillSecret).toHaveBeenCalledWith("tab", {
      origin: "https://github.com",
      at: { x: 100, y: 200 },
      username: "octo",
      text: PASSWORD,
    });
    expect(h.secretFilled).toHaveBeenCalledWith(PASSWORD);
  });

  it.each([
    "https://github.com.evil.test",
    "https://login.github.com",
    "https://evil-github.com",
    "http://github.com",
  ])("reads no password for a page on %s", async (origin) => {
    const h = hold(
      origin.startsWith("http:") ? { tabId: "tab", origin: null } : passwordPage(origin),
    );
    const k = keys({ "https://github.com": { username: "octo", password: PASSWORD } });
    expect(await fillSavedLogin(h, k)).toBe("refused");
    expect(k.login).not.toHaveBeenCalled();
    expect(h.fillSecret).not.toHaveBeenCalled();
  });

  it("asks again when a busy browser can't yet say what its window shows", async () => {
    const h = hold(passwordPage("https://github.com"));
    h.signInPage.mockResolvedValueOnce(null as never);
    const k = keys({ "https://github.com": { username: "octo", password: PASSWORD } });
    expect(await fillSavedLogin(h, k)).toBe("submitted");
    expect(h.signInPage).toHaveBeenCalledTimes(2);
  });

  it("fills a www twin's login on the page's own origin", async () => {
    const h = hold(passwordPage("https://www.reddit.com"));
    const k = keys({ "https://reddit.com": { username: "a", password: PASSWORD } });
    expect(await fillSavedLogin(h, k)).toBe("submitted");
    expect(k.asked).toEqual(["https://reddit.com"]);
    expect(h.fillSecret.mock.calls[0]?.at(1)).toMatchObject({ origin: "https://www.reddit.com" });
  });

  it("types the account on a page that asks for it first, with no password in sight", async () => {
    const h = hold({
      tabId: "tab",
      origin: "https://github.com",
      field: { kind: "account", at: { x: 100, y: 200 } },
    });
    const k = keys({ "https://github.com": { username: "octo", password: PASSWORD } });
    expect(await fillSavedLogin(h, k)).toBe("account");
    expect(k.login).not.toHaveBeenCalled();
    expect(h.input.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { kind: "click", at: { x: 200, y: 400 }, button: "left", count: 1 },
      { kind: "key", combo: ["ctrl", "a"] },
      { kind: "text", text: "octo" },
      { kind: "key", combo: ["Return"] },
    ]);
  });

  it("stops before typing when the page moved after the click", async () => {
    const h = hold({
      tabId: "tab",
      origin: "https://github.com",
      field: { kind: "account", at: { x: 100, y: 200 } },
    });
    h.signInPage
      .mockResolvedValueOnce({
        tabId: "tab",
        origin: "https://github.com",
        field: { kind: "account", at: { x: 100, y: 200 } },
      })
      .mockResolvedValueOnce({ tabId: "tab", origin: "https://evil.test" });
    const k = keys({ "https://github.com": { username: "octo", password: PASSWORD } });
    expect(await fillSavedLogin(h, k)).toBe("refused");
    expect(h.input).toHaveBeenCalledTimes(1);
  });

  it("leaves the account alone on the page after it, until the password box shows", async () => {
    const h = hold({
      tabId: "tab",
      origin: "https://github.com",
      field: { kind: "account", at: { x: 100, y: 200 } },
    });
    const k = keys({ "https://github.com": { username: "octo", password: PASSWORD } });
    expect(await fillSavedLogin(h, k, true)).toBe("no-field");
    expect(h.input).not.toHaveBeenCalled();
  });

  it.each([
    [new VaultLockedError(), "locked"],
    [new BrowserClientError("login_form"), "form"],
    [new BrowserClientError("secret_refused"), "refused"],
    [new Error(`quoting ${PASSWORD}`), "refused"],
  ])("says how a failure went and nothing of it: %s", async (error, outcome) => {
    const h = hold(passwordPage("https://github.com"));
    h.fillSecret.mockRejectedValue(error);
    const k = keys({ "https://github.com": { username: "octo", password: PASSWORD } });
    expect(await fillSavedLogin(h, k)).toBe(outcome);
  });

  it("offers Google's sign-in only the browser without agent control, never a saved login", async () => {
    const h = hold(passwordPage("https://accounts.google.com"));
    const k = keys({ "https://accounts.google.com": { username: "a", password: PASSWORD } });
    expect(await fillSavedLogin(h, k)).toBe("refused");
    expect(k.login).not.toHaveBeenCalled();
    expect(await signInPageAsks(h, k)).toEqual({ ownBrowser: true });
  });
});

describe("what the page in front asks", () => {
  it("names a saved login's site and account, never reading its password", async () => {
    const h = hold({ tabId: "tab", origin: "https://www.reddit.com" });
    const k = keys({ "https://reddit.com": { username: "a", password: PASSWORD } });
    expect(await signInPageAsks(h, k)).toEqual({ saved: { site: "reddit.com", username: "a" } });
    expect(k.login).not.toHaveBeenCalled();
  });

  it("asks nothing of a page with no saved login, or one it can't read", async () => {
    const k = keys({});
    expect(await signInPageAsks(hold({ tabId: "t", origin: "https://a.example" }), k)).toBe(
      undefined,
    );
    expect(await signInPageAsks(hold(null), k)).toBe(undefined);
    const failing = hold(null);
    failing.signInPage.mockRejectedValue(new BrowserClientError("refused"));
    expect(await signInPageAsks(failing, k)).toBe(undefined);
  });
});
