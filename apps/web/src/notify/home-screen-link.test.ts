// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { codeFromPasted, copyHomeScreenLink } from "./home-screen-link.ts";

const ORIGIN = "https://mac.example.ts.net";
const CODE = "C".repeat(43);

describe("Home Screen sign-in link", () => {
  it("copies a fresh one-use link for this address", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) =>
      Response.json({ code: CODE, expiresAt: 61_000 }),
    );
    const api = createApi("t".repeat(43), {
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const clipboard = { writeText: vi.fn(async () => {}) };
    await expect(copyHomeScreenLink(api, clipboard, ORIGIN)).resolves.toEqual({
      expiresAt: 61_000,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${ORIGIN}/api/install-code`);
    expect(clipboard.writeText).toHaveBeenCalledWith(`${ORIGIN}/#code=${CODE}`);
  });

  it("copies nothing when the reply is not a code", async () => {
    const api = createApi("t".repeat(43), {
      origin: ORIGIN,
      fetchImpl: (async () => Response.json({ code: "short" })) as unknown as typeof fetch,
    });
    const clipboard = { writeText: vi.fn(async () => {}) };
    await expect(copyHomeScreenLink(api, clipboard, ORIGIN)).rejects.toThrow();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("takes the code from a pasted link to this address, or a bare code, and nothing else", () => {
    expect(codeFromPasted(` ${ORIGIN}/#code=${CODE} `, ORIGIN)).toBe(CODE);
    expect(codeFromPasted(CODE, ORIGIN)).toBe(CODE);
    expect(codeFromPasted(`https://evil.example/#code=${CODE}`, ORIGIN)).toBeNull();
    expect(codeFromPasted(`${ORIGIN}/#token=${CODE}`, ORIGIN)).toBeNull();
    expect(codeFromPasted(`${ORIGIN}/#code=${CODE}&token=${CODE}`, ORIGIN)).toBeNull();
    expect(codeFromPasted("hello", ORIGIN)).toBeNull();
  });
});
