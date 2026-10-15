import type { LocalDotLink } from "@localdot/protocol";

// The address of another localDot as typed, such as "office-pc.example.ts.net:4750" or a link to
// it, as the origin the switcher opens; https unless it says otherwise.
export function localDotOrigin(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname)
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Why an address can't be added, or null when it can.
export function localDotProblem(
  typed: string,
  others: readonly LocalDotLink[],
  here: string,
): string | null {
  const origin = localDotOrigin(typed);
  if (!origin) return "Enter its address, such as office-pc.example.ts.net:4750.";
  if (origin === here) return "That's this localDot.";
  if (others.some((link) => link.url === origin)) return "That localDot is already in the list.";
  return null;
}

export const localDotHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
