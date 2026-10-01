export const TOKEN_KEY = "localdot.token";
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

export interface TokenHost {
  location: { hash: string; pathname: string; search: string };
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  history: { replaceState(data: unknown, unused: string, url?: string): void };
}

// The daemon opens http://127.0.0.1:4750/#token=<t>. The fragment never reaches the daemon and is
// removed from the address bar once stored, so history and bookmarks never keep the token.
export function bootstrapToken(host: TokenHost = window): string | null {
  const given = new URLSearchParams(host.location.hash.replace(/^#/, "")).get("token");
  if (given !== null) {
    if (TOKEN_PATTERN.test(given)) safely(() => host.localStorage.setItem(TOKEN_KEY, given));
    host.history.replaceState(null, "", `${host.location.pathname}${host.location.search}`);
  }
  const stored = safely(() => host.localStorage.getItem(TOKEN_KEY)) ?? null;
  return stored !== null && TOKEN_PATTERN.test(stored) ? stored : null;
}

export function forgetToken(host: Pick<TokenHost, "localStorage"> = window): void {
  safely(() => host.localStorage.removeItem(TOKEN_KEY));
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
