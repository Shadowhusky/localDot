// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeInstallCode, takeInstallLink } from "./install-link.ts";
import { TOKEN_KEY } from "./token.ts";

const CODE = "c".repeat(43),
  TOKEN = "t".repeat(43);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("install link capture", () => {
  it("erases the code immediately and preserves the page path without storing it", () => {
    window.history.replaceState(null, "", `/tasks?view=all#code=${CODE}`);
    expect(takeInstallLink()).toEqual({ kind: "code", value: CODE });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/tasks?view=all",
    );
    expect(window.localStorage.length).toBe(0);
    expect(takeInstallLink()).toBeNull();
  });
  it.each([
    `code=${CODE}&token=${TOKEN}`,
    `code=${CODE}&code=${CODE}`,
    `token=${TOKEN}&token=${TOKEN}`,
    `code=${CODE}&other=x`,
    "code=short",
    "code=",
    `code=${"c".repeat(44)}`,
  ])("erases and refuses ambiguous or malformed credentials %#", (fragment) => {
    window.location.hash = fragment;
    expect(takeInstallLink()).toEqual({ kind: "invalid" });
    expect(window.location.hash).toBe("");
    expect(window.localStorage.length).toBe(0);
  });
  it("preserves an unrelated fragment and accepts a single legacy development token", () => {
    window.location.hash = "about";
    expect(takeInstallLink()).toBeNull();
    expect(window.location.hash).toBe("#about");
    window.location.hash = `token=${TOKEN}`;
    expect(takeInstallLink()).toEqual({ kind: "token", value: TOKEN });
    expect(window.location.hash).toBe("");
  });
});

describe("one-use exchange transport", () => {
  it("sends only JSON to the same origin, without ambient credentials or redirects", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ token: TOKEN }));
    expect(await exchangeInstallCode(CODE, request)).toBe(TOKEN);
    const [url, options] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${window.location.origin}/auth/exchange-code`);
    expect(options).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({ code: CODE }),
    });
    expect(new Headers(options?.headers).get("authorization")).toBeNull();
    expect(new Headers(options?.headers).get("content-type")).toBe("application/json");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
  it.each([{}, [], { token: "short" }, { token: TOKEN, extra: true }, null])(
    "refuses malformed success replies %#",
    async (value) => {
      await expect(
        exchangeInstallCode(CODE, vi.fn<typeof fetch>().mockResolvedValue(json(value))),
      ).rejects.toThrow("fresh sign-in link");
    },
  );
  it("does not repeat an exchange after a lost reply or expose the thrown credential", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(`lost ${CODE} ${TOKEN}`));
    await expect(exchangeInstallCode(CODE, request)).rejects.toThrow(
      /^Open a fresh sign-in link\.$/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("aborts a stalled exchange and settles even if a fetch implementation ignores abort", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const failed = expect(exchangeInstallCode(CODE, request)).rejects.toThrow("fresh sign-in link");
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
