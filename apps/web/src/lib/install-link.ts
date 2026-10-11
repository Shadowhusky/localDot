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

export class InstallLinkError extends Error {
  constructor(readonly kind: "expired" | "unconfirmed") {
    super(
      kind === "expired"
        ? "Open a fresh sign-in link."
        : "Sign-in could not be confirmed. Open a fresh sign-in link.",
    );
  }
}

/** Never retry: a missing reply may follow successful consumption by the daemon. */
export async function exchangeInstallCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!TOKEN_PATTERN.test(code)) throw new InstallLinkError("unconfirmed");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new InstallLinkError("unconfirmed"));
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
          // The relay requires its same-origin pairing cookie before the code can reach the daemon.
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (reply.status === 401) throw new InstallLinkError("expired");
        if (!reply.ok || reply.redirected) throw new InstallLinkError("unconfirmed");
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
          throw new InstallLinkError("unconfirmed");
        }
        return value.token;
      })(),
    ]);
  } catch (error) {
    if (error instanceof InstallLinkError) throw error;
    // No response text, URL, thrown provider message or credential reaches the UI.
    throw new InstallLinkError("unconfirmed");
  } finally {
    clearTimeout(timer);
  }
}
