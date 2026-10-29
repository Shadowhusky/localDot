import { type PreviewTarget, previewTarget } from "@localdot/protocol";

export interface LocalUrl {
  // The address as dot's computer printed it.
  href: string;
  // How a chip names it: its host, and its path when that says more than "/".
  label: string;
  target: PreviewTarget;
}

// A server prints its address as it starts, so the head of a long output is enough to search.
const SCAN_CHARS = 32_768;
const FOUND = 6;
const CANDIDATE = /https?:\/\/[\w\-.~:/?#[\]@!$&()*+,;=%]+/gi;
const PRIVATE_IPV4 = /^(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;

export function localUrl(href: string, addresses: readonly string[] = []): LocalUrl | undefined {
  const target = previewTarget(href, addresses);
  if (!target) return undefined;
  const url = new URL(href);
  return { href: url.href, label: `${url.host}${target.path === "/" ? "" : target.path}`, target };
}

// A private network address may be the computer's own, which only its status can tell.
export function mayBeComputer(href: string): boolean {
  return URL.canParse(href) && PRIVATE_IPV4.test(new URL(href).hostname);
}

// Punctuation that ends a sentence around an address, and a bracket the address never opened.
function trimmed(raw: string): string {
  let href = raw.replace(/[.,:;!?*_~]+$/, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    while (href.endsWith(close) && href.split(close).length > href.split(open).length)
      href = href.slice(0, -1).replace(/[.,:;!?*_~]+$/, "");
  }
  return href;
}

// Every loopback name and the computer's own address reach one server on a port; each *.localhost
// name is a site of its own.
function serverKey({ scheme, dial, port }: PreviewTarget): string {
  const name = dial.slice(0, dial.lastIndexOf(":"));
  return `${scheme}://${name.endsWith(".localhost") ? name : "loopback"}:${port}`;
}

export function localUrlsIn(
  text: string,
  addresses: readonly string[] = [],
  limit = FOUND,
): LocalUrl[] {
  const found = new Map<string, LocalUrl>();
  for (const [raw] of text.slice(0, SCAN_CHARS).matchAll(CANDIDATE)) {
    const local = localUrl(trimmed(raw), addresses);
    if (!local) continue;
    const key = serverKey(local.target);
    if (!found.has(key)) found.set(key, local);
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

// Whether text names an address that is the computer's own only if its status says so.
export function mentionsPrivateAddress(text: string): boolean {
  for (const [raw] of text.slice(0, SCAN_CHARS).matchAll(CANDIDATE))
    if (mayBeComputer(trimmed(raw))) return true;
  return false;
}
