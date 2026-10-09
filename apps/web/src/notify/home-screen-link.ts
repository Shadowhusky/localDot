import type { ApiClient } from "../lib/api.ts";
import { TOKEN_PATTERN } from "../lib/token.ts";

// A Home Screen app on iPhone keeps its own storage, so it starts signed out. Safari (signed in)
// copies a one-minute, one-use sign-in link; the Home Screen app takes it from a paste.
export async function copyHomeScreenLink(
  api: ApiClient,
  clipboard: Pick<Clipboard, "writeText">,
  origin: string = window.location.origin,
): Promise<{ expiresAt: number }> {
  const issued = (await api.post("/api/install-code")) as { code?: unknown; expiresAt?: unknown };
  if (typeof issued.code !== "string" || !TOKEN_PATTERN.test(issued.code))
    throw new Error("The sign-in link could not be made.");
  await clipboard.writeText(`${origin}/#code=${issued.code}`);
  return { expiresAt: Number(issued.expiresAt) };
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
