import type { ApiClient } from "../lib/api.ts";
import { TOKEN_PATTERN } from "../lib/token.ts";

// The link was made but the clipboard refused it: it can still be copied by hand.
export class LinkNotCopied extends Error {
  constructor(
    readonly link: string,
    readonly expiresAt: number,
  ) {
    super("The sign-in link couldn't be copied.");
    this.name = "LinkNotCopied";
  }
}

export type LinkClipboard = Pick<Clipboard, "writeText"> & Partial<Pick<Clipboard, "write">>;

// A Home Screen app on iPhone keeps its own storage, so it starts signed out. A signed-in browser
// copies a one-minute, one-use sign-in link; the Home Screen app takes it from a paste.
// Call straight from the click: Safari copies only within the tap, so the copy starts at once and
// the link fills it when the daemon has made it.
export async function copyHomeScreenLink(
  api: ApiClient,
  clipboard: LinkClipboard,
  origin: string = window.location.origin,
  Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
): Promise<{ expiresAt: number }> {
  const issued = api.post("/api/install-code").then((reply) => {
    const { code, expiresAt } = reply as { code?: unknown; expiresAt?: unknown };
    if (typeof code !== "string" || !TOKEN_PATTERN.test(code))
      throw new Error("The sign-in link could not be made.");
    return { link: `${origin}/#code=${code}`, expiresAt: Number(expiresAt) };
  });
  return copyIssuedLink(issued, clipboard, Item);
}

// Shared by local Home Screen pairing and the optional relay. Start the clipboard operation
// during the tap, before awaiting the server, to preserve Safari's user activation.
export async function copyIssuedLink(
  issued: Promise<{ link: string; expiresAt: number }>,
  clipboard: LinkClipboard | undefined,
  Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
): Promise<{ expiresAt: number }> {
  const copyText = async () => {
    const value = await issued;
    if (!clipboard) throw new LinkNotCopied(value.link, value.expiresAt);
    return clipboard.writeText(value.link);
  };
  try {
    if (Item && clipboard?.write) {
      const text = issued.then(({ link }) => new Blob([link], { type: "text/plain" }));
      await clipboard.write([new Item({ "text/plain": text })]).catch(copyText);
    } else await copyText();
  } catch {
    const { link, expiresAt } = await issued;
    throw new LinkNotCopied(link, expiresAt);
  }
  return { expiresAt: (await issued).expiresAt };
}

// The one-use code in what the user pasted: a link to this same address, or the bare code.
export function codeFromPasted(
  text: string,
  origin: string = window.location.origin,
): string | null {
  const value = text.trim();
  if (TOKEN_PATTERN.test(value)) return value;
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.origin !== origin) return null;
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = params.get("code");
  return code && [...params.keys()].length === 1 && TOKEN_PATTERN.test(code) ? code : null;
}
