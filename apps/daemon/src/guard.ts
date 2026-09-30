export const SESSION_COOKIE = "localdot_session";

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
  cookie?: string | undefined;
}): string | undefined {
  const bearer = headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return bearer;
  const prefix = `${SESSION_COOKIE}=`;
  return headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}
