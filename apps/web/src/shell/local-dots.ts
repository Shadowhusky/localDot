import { LocalDotLink } from "@localdot/protocol";
import { DEVICE, HOST_SUFFIX } from "@localdot/protocol/remote";

// What people type or paste for another localDot, such as "office-pc.example.ts.net:4750" or a
// link to it; https unless it says otherwise.
function typedUrl(typed: string): URL | null {
  const text = typed.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname)
      return null;
    return url;
  } catch {
    return null;
  }
}

// The origin the switcher opens.
export const localDotOrigin = (typed: string): string | null => typedUrl(typed)?.origin ?? null;

// A link that signs this browser in to that localDot: Remote access's pairing link
// (#remote=…&code=…) or an app sign-in link (#code=… or #token=…). Only its origin is saved.
export function signInLink(typed: string): string | null {
  const url = typedUrl(typed);
  const params = new URLSearchParams(url?.hash.slice(1));
  return url && (params.has("code") || params.has("token")) ? url.href : null;
}

// Why an address can't be saved, or null when it can. `editing` is the entry it replaces.
export function localDotProblem(
  typed: string,
  others: readonly LocalDotLink[],
  here: string,
  editing?: string,
): string | null {
  const origin = localDotOrigin(typed);
  if (!origin) return "Enter its address, such as office-pc.example.ts.net:4750.";
  if (origin === here) return "That's this localDot.";
  if (others.some((link) => link.url === origin && link.url !== editing))
    return "That localDot is already in the list.";
  return null;
}

// Why a name can't be saved, or null when it can. An empty name is made from the address.
export function localDotNameProblem(name: string): string | null {
  return !name.trim() || LocalDotLink.shape.name.safeParse(name).success
    ? null
    : "Use up to 40 letters, numbers and punctuation.";
}

// The entry for a name and an address, named after the computer when no name is given.
export function localDotLink(name: string, typed: string): LocalDotLink | null {
  const url = typedUrl(typed);
  if (!url) return null;
  const machine = url.hostname.split(".")[0] ?? url.hostname;
  const fallback =
    machine.endsWith(HOST_SUFFIX) && DEVICE.test(machine.slice(0, -HOST_SUFFIX.length))
      ? "Remote localDot"
      : /^[\d.]+$|^\[/.test(url.hostname)
        ? url.host
        : machine;
  return { name: name.trim() || fallback.slice(0, 40), url: url.origin };
}

// An address that means whichever device opens it: localhost and its subdomains, 127.0.0.0/8 and
// [::1]. Right for this browser, but on another device it is that device's own computer.
export function deviceOnly(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname.replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

export const localDotHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
