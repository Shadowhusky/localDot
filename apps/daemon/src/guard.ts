export const WS_TOKEN_PREFIX = "localdot.token.";

// An HTTPS front such as Tailscale Serve, named exactly, so another device can reach the daemon
// without loosening the DNS-rebinding guard for any other name.
let publicOrigin: URL | undefined;

export function setPublicOrigin(value: string | undefined): void {
  if (value === undefined) {
    publicOrigin = undefined;
    return;
  }
  const refuse = new Error("LOCALDOT_PUBLIC_ORIGIN must be a bare https:// origin");
  if (!URL.canParse(value)) throw refuse;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname.includes("*") ||
    url.origin !== value.replace(/\/$/, "") ||
    url.href !== `${url.origin}/`
  ) {
    throw refuse;
  }
  publicOrigin = url;
}

export function isPublicOrigin(origin: string | undefined): boolean {
  return publicOrigin !== undefined && origin === publicOrigin.origin;
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    (publicOrigin !== undefined && host === publicOrigin.host)
  );
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return (
    origin === undefined ||
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    isPublicOrigin(origin)
  );
}

export function tokenFromHeaders(headers: {
  authorization?: string | undefined;
  "sec-websocket-protocol"?: string | undefined;
}): string | undefined {
  const bearer = headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return bearer;
  return headers["sec-websocket-protocol"]
    ?.split(",")
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith(WS_TOKEN_PREFIX))
    ?.slice(WS_TOKEN_PREFIX.length);
}
