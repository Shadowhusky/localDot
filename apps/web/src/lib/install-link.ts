import { TOKEN_PATTERN, type TokenHost } from "./token.ts";

export type InstallLink = { kind: "code" | "token"; value: string } | { kind: "invalid" };

// Whether the address carries a sign-in link, without taking it: safe to call during render.
export function linkArrived(host: Pick<TokenHost, "location"> = window): boolean {
  const params = new URLSearchParams(host.location.hash.replace(/^#/, ""));
  return params.has("code") || params.has("token");
}

/** Read in an effect/event, never during render. Remove even invalid credential fragments. */
export function takeInstallLink(host: TokenHost = window): InstallLink | null {
  const params = new URLSearchParams(host.location.hash.replace(/^#/, ""));
  if (!params.has("code") && !params.has("token")) return null;
  host.history.replaceState(null, "", `${host.location.pathname}${host.location.search}`);
  const entries = [...params];
  const entry = entries[0];
  if (entries.length !== 1 || !entry || !TOKEN_PATTERN.test(entry[1])) return { kind: "invalid" };
  if (entry[0] !== "code" && entry[0] !== "token") return { kind: "invalid" };
  return { kind: entry[0], value: entry[1] };
}

/** Never retry: a missing reply may follow successful consumption by the daemon. */
export async function exchangeInstallCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!TOKEN_PATTERN.test(code)) throw new Error("Open a fresh sign-in link.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Open a fresh sign-in link."));
    }, 10_000);
  });
  try {
    return await Promise.race([
      expired,
      (async () => {
        const reply = await fetchImpl(new URL("/auth/exchange-code", window.location.origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (!reply.ok || reply.redirected) throw new Error("Open a fresh sign-in link.");
        const value: unknown = await reply.json();
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== 1 ||
          !("token" in value) ||
          typeof value.token !== "string" ||
          !TOKEN_PATTERN.test(value.token)
        ) {
          throw new Error("Open a fresh sign-in link.");
        }
        return value.token;
      })(),
    ]);
  } catch {
    // No response text, URL, thrown provider message or credential reaches the UI.
    throw new Error("Open a fresh sign-in link.");
  } finally {
    clearTimeout(timer);
  }
}
