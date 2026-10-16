import { keyLikePresent, ULID_PATTERN } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export const FILE_LIMITS = Object.freeze({
  bytes: 100 * 1024 * 1024,
  count: 16,
  name: 200,
  deadlineMs: 120_000,
});
export function safeTransferName(name: string): boolean {
  if (
    !name ||
    name.length > FILE_LIMITS.name ||
    name.startsWith(".") ||
    !name.isWellFormed() ||
    keyLikePresent(name)
  )
    return false;
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (char === "/" || char === "\\" || char === "%" || code < 32 || (code >= 127 && code <= 159))
      return false;
  }
  return new TextEncoder().encode(name).byteLength <= 255;
}
export function disposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", "%27").replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("*", "%2A")}`;
}
export class FileTransferFailure extends Error {
  constructor(
    readonly uncertain: boolean,
    readonly status?: number,
    message?: string,
  ) {
    super(
      message ??
        (uncertain
          ? "The upload may have finished. Check Downloads before selecting it again."
          : "The file transfer was refused or could not be verified."),
    );
  }
}
export function transferScope(owner: AbortSignal) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), FILE_LIMITS.deadlineMs);
  const signal = AbortSignal.any([owner, abort.signal]);
  return {
    signal,
    close() {
      clearTimeout(timeout);
      abort.abort();
    },
  };
}
export async function responseFor(work: Promise<Response>, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work
      .then((response) => {
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          reject(signal.reason);
        } else resolve(response);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function read(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error("invalid length");
  }
  const reader = response.body?.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    if (reader)
      for (;;) {
        const part = await read(reader, signal);
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error("transfer limit");
        parts.push(part.value.slice());
      }
    signal.throwIfAborted();
    if (length !== null && Number(length) !== size) throw new Error("incomplete transfer");
    return parts;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
export function transferEndpoint(api: ApiClient, path: string) {
  return `${api.socketUrl("").replace(/^ws/, "http")}${path}`;
}
export async function uploadFile(
  api: ApiClient,
  cellId: string,
  file: File,
  owner: AbortSignal,
): Promise<string> {
  if (
    !ULID_PATTERN.test(cellId) ||
    !safeTransferName(file.name) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > FILE_LIMITS.bytes ||
    owner.aborted
  )
    throw new FileTransferFailure(false);
  const lifetime = transferScope(owner);
  try {
    const response = await responseFor(
      api.fetch(
        transferEndpoint(api, `/api/cells/${cellId}/upload?name=${encodeURIComponent(file.name)}`),
        {
          method: "POST",
          headers: {
            authorization: api.authorization(),
            "content-type": "application/octet-stream",
          },
          body: file,
          signal: lifetime.signal,
          redirect: "error",
          credentials: "same-origin",
          cache: "no-store",
        },
      ),
      lifetime.signal,
    );
    if (response.status === 401) api.rejectUnauthorized?.();
    if (response.status !== 201) {
      void response.body?.cancel().catch(() => {});
      throw new FileTransferFailure(
        ![400, 401, 403, 404, 409, 413, 422].includes(response.status),
        response.status,
      );
    }
    const parts = await boundedBody(response, 4096, lifetime.signal);
    const bytes = new Uint8Array(parts.reduce((total, p) => total + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const expected = `~/Downloads/${file.name}`;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("path" in value) ||
      value.path !== expected
    )
      throw new FileTransferFailure(true);
    return expected;
  } catch (error) {
    if (error instanceof FileTransferFailure) throw error;
    throw new FileTransferFailure(true);
  } finally {
    lifetime.close();
  }
}
export async function downloadResult(
  api: ApiClient,
  sessionId: string,
  name: string,
  owner: AbortSignal,
): Promise<Blob> {
  if (!ULID_PATTERN.test(sessionId) || !safeTransferName(name) || owner.aborted)
    throw new FileTransferFailure(false);
  const lifetime = transferScope(owner);
  try {
    const response = await responseFor(
      api.fetch(
        transferEndpoint(api, `/api/agent/sessions/${sessionId}/files/${encodeURIComponent(name)}`),
        {
          method: "GET",
          headers: { authorization: api.authorization() },
          signal: lifetime.signal,
          redirect: "error",
          credentials: "same-origin",
          cache: "no-store",
        },
      ),
      lifetime.signal,
    );
    if (response.status === 401) api.rejectUnauthorized?.();
    if (
      response.status !== 200 ||
      response.headers.get("content-disposition") !== disposition(name) ||
      response.headers.get("content-type") !== "application/octet-stream" ||
      response.headers.get("x-content-type-options") !== "nosniff"
    ) {
      void response.body?.cancel().catch(() => {});
      throw new FileTransferFailure(false, response.status);
    }
    const parts = await boundedBody(response, FILE_LIMITS.bytes, lifetime.signal);
    return new Blob(parts, { type: "application/octet-stream" });
  } catch (error) {
    if (error instanceof FileTransferFailure) throw error;
    throw new FileTransferFailure(false);
  } finally {
    lifetime.close();
  }
}
