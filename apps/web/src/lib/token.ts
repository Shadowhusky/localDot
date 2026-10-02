export const TOKEN_KEY = "localdot.token";
// The daemon's token is randomBytes(32) in base64url: exactly 43 characters. A longer one could
// only earn every request a 431.
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TokenHost {
  location: { hash: string; pathname: string; search: string };
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  history: { replaceState(data: unknown, unused: string, url?: string): void };
}

// The daemon opens http://127.0.0.1:4750/#token=<t>. The fragment never reaches the daemon, and it
// leaves the address bar as soon as it is read. It does stay in the browser's history: the browser
// records the visit when the navigation commits, before any script can run. That is an accepted
// residual (the spec's risks): the token works only from this machine, so reading it from history
// gives no more than reading the user's token file. The token is returned, not stored: the caller
// keeps it once the daemon has accepted it.
export function takeFragmentToken(host: TokenHost = window): string | null {
  const given = new URLSearchParams(host.location.hash.replace(/^#/, "")).get("token");
  if (given === null) return null;
  host.history.replaceState(null, "", `${host.location.pathname}${host.location.search}`);
  return TOKEN_PATTERN.test(given) ? given : null;
}

export function storedToken(host: Pick<TokenHost, "localStorage"> = window): string | null {
  const stored = safely(() => host.localStorage.getItem(TOKEN_KEY)) ?? null;
  return stored !== null && TOKEN_PATTERN.test(stored) ? stored : null;
}

export function keepToken(token: string, host: Pick<TokenHost, "localStorage"> = window): void {
  safely(() => host.localStorage.setItem(TOKEN_KEY, token));
}

// Removes the stored token only if it is the one the daemon rejected: a late 401 for an older
// token must not erase a newer one.
export function forgetToken(
  rejected: string,
  host: Pick<TokenHost, "localStorage"> = window,
): void {
  if (safely(() => host.localStorage.getItem(TOKEN_KEY)) !== rejected) return;
  safely(() => host.localStorage.removeItem(TOKEN_KEY));
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
