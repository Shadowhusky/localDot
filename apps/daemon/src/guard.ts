export const WS_TOKEN_PREFIX = "localdot.token.";

// HTTPS fronts such as Tailscale Serve, each named exactly, so another device can reach the daemon
// without loosening the DNS-rebinding guard for any other name.
let publicOrigins: URL[] = [];
const remoteOrigins = new Set<string>();

export function registerPublicOrigin(value: string): () => void {
  const origin = parseOrigin(value).origin;
  remoteOrigins.add(origin);
  return () => {
    remoteOrigins.delete(origin);
  };
}

export function setPublicOrigin(value: string | undefined): void {
  publicOrigins = parsePublicOrigins(value);
}

export function parsePublicOrigins(value: string | undefined): URL[] {
  if (value === undefined) return [];
  return value.split(",").map((entry) => parseOrigin(entry.trim()));
}

function parseOrigin(value: string): URL {
  const refuse = new Error("LOCALDOT_PUBLIC_ORIGIN must list bare https:// origins");
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
  return url;
}

// Only explicitly configured HTTPS fronts. Relay pairing has its own access-link route.
export function configuredAccessOrigins(): string[] {
  return [...new Set(publicOrigins.map((url) => url.origin))];
}

export function isPublicOrigin(origin: string | undefined): boolean {
  return (
    publicOrigins.some((url) => origin === url.origin) ||
    (origin !== undefined && remoteOrigins.has(origin))
  );
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    publicOrigins.some((url) => host === url.host) ||
    remoteOrigins.has(`https://${host}`)
  );
}

// The origin a request reached this daemon at, named by its (already allowed) Host: a loopback
// address or one of the HTTPS fronts.
export function requestOrigin(host: string | undefined, port: number): string | undefined {
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return `http://${host}`;
  return (
    publicOrigins.find((url) => host === url.host)?.origin ??
    (remoteOrigins.has(`https://${host}`) ? `https://${host}` : undefined)
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
