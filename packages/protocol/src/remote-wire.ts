// This wire contract is also consumed by the installed daemon. All payloads are bounded;
// HTTP bodies are pulled in chunks rather than buffered or encoded as base64.
export const HEARTBEAT = "localdot.remote.heartbeat.v1";
export const HEARTBEAT_ACK = "localdot.remote.alive.v1";
export const HOST_SUFFIX = "--dot";
export const CHUNK = 64 * 1024;
export const MAX_FRAME = 4 * 1024 * 1024;
export const MAX_CHANNELS = 48;
export const MAX_UPLOAD = 100 * 1024 * 1024;
export const SECRET = /^[a-f0-9]{64}$/;
export const DEVICE = /^[a-f0-9]{32}$/;
export type Open = {
  id: string;
  kind: "http" | "ws";
  path: string;
  method: string;
  headers: [string, string][];
};
export function validOpen(value: unknown): value is Open {
  if (!value || typeof value !== "object") return false;
  const v = value as Open;
  return (
    /^[a-f0-9-]{36}$/.test(v.id) &&
    (v.kind === "http" || v.kind === "ws") &&
    typeof v.path === "string" &&
    v.path.length <= 8192 &&
    v.path.startsWith("/") &&
    !v.path.startsWith("//") &&
    !/[\r\n\\]/.test(v.path) &&
    /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(v.method) &&
    Array.isArray(v.headers) &&
    v.headers.length <= 64 &&
    v.headers.every(
      (h) =>
        Array.isArray(h) &&
        h.length === 2 &&
        h.every((s) => typeof s === "string" && s.length <= 8192 && !/[\r\n]/.test(s)),
    )
  );
}
export function cleanHeaders(headers: Iterable<[string, string]>): [string, string][] {
  const list = Array.from(headers);
  const connection =
    list
      .find(([k]) => k.toLowerCase() === "connection")?.[1]
      .toLowerCase()
      .split(/\s*,\s*/) ?? [];
  return list.filter(
    ([k]) =>
      ![
        "host",
        "connection",
        "upgrade",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "proxy-authorization",
        "proxy-authenticate",
        "cookie",
        "set-cookie",
        "content-length",
        "accept-encoding",
        ...connection,
      ].includes(k.toLowerCase()) && !/^(sec-websocket-|x-forwarded-|cf-|x-localdot-)/i.test(k),
  );
}
