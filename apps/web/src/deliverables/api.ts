import {
  CompareReply,
  FileVersionsReply,
  JsonPreview,
  OpenOnMacReply,
  PREVIEW_LIMITS,
  PreviewLinkReply,
  ProofReply,
  TableFileReply,
  TextFileReply,
  ULID_PATTERN,
  VIEWER_LIMITS,
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
export type LoadedPages =
  | { kind: "pdf"; data: ArrayBuffer }
  | Extract<JsonPreview, { kind: "none" }>;
// An office document's every page as a PDF, made on dot's computer: a minute or more the first time
// for a long deck, then kept for that version.
export async function loadPages(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number | null,
  signal: AbortSignal,
): Promise<LoadedPages> {
  const query = version === null ? "" : `?v=${version}`;
  const response = await request(api, `${fileBase(sessionId, name)}/pages${query}`, {
    signal,
    timeoutMs: 150_000,
  });
  const type = response.headers.get("content-type");
  if (type === "application/pdf")
    return { kind: "pdf", data: await bounded(response, VIEWER_LIMITS.pdfBytes) };
  if (type?.split(";", 1)[0] !== "application/json")
    throw new DeliverableError(415, "unexpected pages");
  const reply = JsonPreview.parse(
    JSON.parse(new TextDecoder().decode(await bounded(response, PREVIEW_LIMITS.jsonBytes))),
  );
  if (reply.kind !== "none") throw new DeliverableError(415, "unexpected pages");
  return reply;
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
// Each task's preview link, kept so the next preview starts before the daemon answers, until near
// its idle lapse (the daemon's is 30 minutes). The daemon holds links in memory only, so a kept one
// is asked for again each time: after a restart the answer is a new link.
const LINK_REUSE_MS = 20 * 60 * 1000;
const previewLinks = new WeakMap<ApiClient, Map<string, { base: string; at: number }>>();
export function keptPreviewBase(api: ApiClient, sessionId: string): string | undefined {
  const kept = previewLinks.get(api)?.get(sessionId);
  return kept && Date.now() - kept.at < LINK_REUSE_MS ? kept.base : undefined;
}
export async function previewBase(
  api: ApiClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!ULID_PATTERN.test(sessionId)) throw new DeliverableError(400, "invalid task");
  const response = await request(api, `/api/agent/sessions/${sessionId}/preview-link`, {
    method: "POST",
    signal,
  });
  const { base } = PreviewLinkReply.parse(await response.json());
  const known = previewLinks.get(api) ?? new Map<string, { base: string; at: number }>();
  previewLinks.set(api, known);
  known.set(sessionId, { base, at: Date.now() });
  return base;
}
// Where the full preview loads a file the browser draws itself: a picture, a page, a PDF or media.
export function previewUrl(
  api: ApiClient,
  base: string,
  name: string,
  version: number | null,
): string {
  if (!safeTransferName(name)) throw new DeliverableError(400, "invalid file");
  return `${origin(api)}${base}${encodeURIComponent(name)}${version === null ? "" : `?v=${version}`}`;
}
// A PDF's bytes for the renderer, never more than `max`.
export async function loadPreviewBytes(
  api: ApiClient,
  url: string,
  max: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await api.fetch(url, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(60_000), signal]),
  });
  if (!response.ok) throw new DeliverableError(response.status, "preview unavailable");
  return bounded(response, max);
}
const TEXT_REPLY_BYTES = 8 * 1024 * 1024;
export async function loadText(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number | null,
  from: "start" | "end",
  signal: AbortSignal,
): Promise<TextFileReply> {
  const query = new URLSearchParams(version === null ? {} : { v: String(version) });
  if (from === "end") query.set("from", "end");
  const tail = query.size ? `?${query}` : "";
  const response = await request(api, `${fileBase(sessionId, name)}/text${tail}`, { signal });
  const body = await bounded(response, TEXT_REPLY_BYTES);
  return TextFileReply.parse(JSON.parse(new TextDecoder().decode(body)));
}
export async function loadTable(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number | null,
  sheet: number,
  signal: AbortSignal,
): Promise<TableFileReply> {
  const query = new URLSearchParams({ sheet: String(sheet) });
  if (version !== null) query.set("v", String(version));
  const response = await request(api, `${fileBase(sessionId, name)}/table?${query}`, {
    signal,
    timeoutMs: 45_000,
  });
  const body = await bounded(response, TEXT_REPLY_BYTES);
  return TableFileReply.parse(JSON.parse(new TextDecoder().decode(body)));
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
