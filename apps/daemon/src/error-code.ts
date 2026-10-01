// Logs name an error by its code, or its class when it has none, and never by its message: a
// message can quote a file path or the request, and requests carry tickets and tokens.
export function errorCode(err: unknown): string {
  const { code, name } = (err ?? {}) as { code?: unknown; name?: unknown };
  if (typeof code === "string") return code;
  return typeof name === "string" ? name : "no error code";
}
