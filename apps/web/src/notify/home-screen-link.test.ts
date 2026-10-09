// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { codeFromPasted, copyHomeScreenLink, LinkNotCopied } from "./home-screen-link.ts";

const ORIGIN = "https://mac.example.ts.net";

class FakeItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}
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

  it("starts the copy within the tap and fills it with the link once it is made", async () => {
    let reply = (_value: Response) => {};
    const api = createApi("t".repeat(43), {
      origin: ORIGIN,
      fetchImpl: (() =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        })) as unknown as typeof fetch,
    });
    const items: FakeItem[] = [];
    const clipboard = {
      writeText: vi.fn(async () => {}),
      write: vi.fn(async (next: readonly unknown[]) => {
        items.push(...(next as FakeItem[]));
      }),
    };
    const copied = copyHomeScreenLink(api, clipboard, ORIGIN, FakeItem as never);
    expect(clipboard.write).toHaveBeenCalledOnce();
    reply(Response.json({ code: CODE, expiresAt: 61_000 }));
    await expect(copied).resolves.toEqual({ expiresAt: 61_000 });
    const blob = await items[0]?.data["text/plain"];
    expect(await blob?.text()).toBe(`${ORIGIN}/#code=${CODE}`);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("hands back a link the clipboard refused, to copy by hand", async () => {
    const api = createApi("t".repeat(43), {
      origin: ORIGIN,
      fetchImpl: (async () =>
        Response.json({ code: CODE, expiresAt: 61_000 })) as unknown as typeof fetch,
    });
    const refused = async () => {
      throw new DOMException("Not allowed", "NotAllowedError");
    };
    const clipboard = { writeText: vi.fn(refused), write: vi.fn(refused) };
    const failure = await copyHomeScreenLink(api, clipboard, ORIGIN, FakeItem as never).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LinkNotCopied);
    expect(failure).toMatchObject({ link: `${ORIGIN}/#code=${CODE}`, expiresAt: 61_000 });
    expect(clipboard.writeText).toHaveBeenCalledOnce();
  });

  it("says the link could not be made, not that copying failed, when the daemon refuses", async () => {
    const api = createApi("t".repeat(43), {
      origin: ORIGIN,
      fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    });
    const clipboard = {
      writeText: vi.fn(async () => {}),
      write: vi.fn(async (next: readonly unknown[]) => {
        await (next[0] as FakeItem | undefined)?.data["text/plain"];
      }),
    };
    const failure = await copyHomeScreenLink(api, clipboard, ORIGIN, FakeItem as never).catch(
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(LinkNotCopied);
    expect(failure).toBeInstanceOf(Error);
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
