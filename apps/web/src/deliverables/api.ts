import {
  CompareReply,
  FileVersionsReply,
  JsonPreview,
  OpenOnMacReply,
  PREVIEW_LIMITS,
  ProofReply,
  ULID_PATTERN,
} from "@localdot/protocol";
import {
  disposition,
  FILE_LIMITS,
  FileTransferFailure,
  safeTransferName,
} from "../agent/file-transfer.ts";
import type { ApiClient } from "../lib/api.ts";

export type LoadedPreview =
  | { kind: "image"; blob: Blob; madeBy: "daemon" | "computer" }
  | JsonPreview;
export class DeliverableError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeliverableError";
  }
}
const origin = (api: ApiClient) => api.socketUrl("").replace(/^ws/, "http");
const fileBase = (sessionId: string, name: string) => {
  if (!ULID_PATTERN.test(sessionId) || !safeTransferName(name))
    throw new DeliverableError(400, "invalid file");
  return `/api/agent/sessions/${sessionId}/files/${encodeURIComponent(name)}`;
};
async function request(
  api: ApiClient,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, signal, ...rest } = init;
  const response = await api.fetch(`${origin(api)}${path}`, {
    ...rest,
    headers: { authorization: api.authorization(), ...(rest.headers ?? {}) },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok)
    throw new DeliverableError(response.status, (await response.text()).slice(0, 200));
  return response;
}
async function bounded(response: Response, max: number): Promise<ArrayBuffer> {
  if (Number(response.headers.get("content-length") ?? "0") > max)
    throw new DeliverableError(413, "preview too large");
  const body = await response.arrayBuffer();
  if (body.byteLength > max) throw new DeliverableError(413, "preview too large");
  return body;
}
// Office previews are made on dot's computer and can take most of a minute the first time.
export async function loadPreview(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number | null,
  signal: AbortSignal,
): Promise<LoadedPreview> {
  const query = version === null ? "" : `?v=${version}`;
  const response = await request(api, `${fileBase(sessionId, name)}/preview${query}`, {
    signal,
    timeoutMs: 75_000,
  });
  const type = response.headers.get("content-type");
  if (type === "image/png") {
    const body = await bounded(response, PREVIEW_LIMITS.pngBytes);
    return {
      kind: "image",
      blob: new Blob([body], { type: "image/png" }),
      madeBy: response.headers.get("x-localdot-preview") === "computer" ? "computer" : "daemon",
    };
  }
  if (type?.split(";", 1)[0] !== "application/json")
    throw new DeliverableError(415, "unexpected preview");
  const body = await bounded(response, PREVIEW_LIMITS.jsonBytes);
  return JsonPreview.parse(JSON.parse(new TextDecoder().decode(body)));
}
export async function loadVersions(
  api: ApiClient,
  sessionId: string,
  name: string,
  signal?: AbortSignal,
) {
  const response = await request(api, `${fileBase(sessionId, name)}/versions`, { signal });
  return FileVersionsReply.parse(await response.json());
}
export async function loadCompare(
  api: ApiClient,
  sessionId: string,
  name: string,
  from: { sessionId: string; version: number },
  to: { sessionId: string; version: number },
  signal?: AbortSignal,
) {
  const query = `from=${from.sessionId}.${from.version}&to=${to.sessionId}.${to.version}`;
  const response = await request(api, `${fileBase(sessionId, name)}/compare?${query}`, { signal });
  return CompareReply.parse(await response.json());
}
export async function loadProof(api: ApiClient, sessionId: string, signal?: AbortSignal) {
  if (!ULID_PATTERN.test(sessionId)) throw new DeliverableError(400, "invalid task");
  const response = await request(api, `/api/agent/sessions/${sessionId}/proof`, { signal });
  return ProofReply.parse(await response.json());
}
export async function openOnMac(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number | null,
) {
  const response = await request(api, `${fileBase(sessionId, name)}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
    timeoutMs: 30_000,
  });
  return OpenOnMacReply.parse(await response.json());
}
// One stored version, checked the way result downloads are (agent/file-transfer.ts).
export async function downloadVersion(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await request(api, `${fileBase(sessionId, name)}/versions/${version}`, {
    signal,
    timeoutMs: FILE_LIMITS.deadlineMs,
  });
  if (
    response.headers.get("content-disposition") !== disposition(name) ||
    response.headers.get("content-type") !== "application/octet-stream" ||
    response.headers.get("x-content-type-options") !== "nosniff"
  ) {
    void response.body?.cancel().catch(() => {});
    throw new FileTransferFailure(false, response.status);
  }
  return new Blob([await bounded(response, FILE_LIMITS.bytes)], {
    type: "application/octet-stream",
  });
}
// Open on Mac is offered only where the daemon allows it: the page itself is on loopback.
export function isLoopbackPage(
  location: Pick<Location, "protocol" | "hostname"> = window.location,
): boolean {
  return (
    location.protocol === "http:" &&
    (location.hostname === "127.0.0.1" || location.hostname === "localhost")
  );
}
