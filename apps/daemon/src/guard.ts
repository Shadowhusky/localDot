export const WS_TOKEN_PREFIX = "localdot.token.";

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return (
    origin === undefined ||
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
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
