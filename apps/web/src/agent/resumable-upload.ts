import {
  ULID_PATTERN,
  USER_UPLOAD,
  UserUploadId,
  UserUploadStatus,
  userUploadPath,
} from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";
import {
  boundedBody,
  FileTransferFailure,
  responseFor,
  safeTransferName,
  transferEndpoint,
  transferScope,
} from "./file-transfer.ts";

export interface UploadProgress {
  offset: number;
  phase: "uploading" | "placing";
}
export interface UploadOptions {
  id?: string;
  progress?(value: UploadProgress): void;
}
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
const message = (status?: number) =>
  status === 507
    ? "Not enough storage. Free some space, then retry."
    : status === 413
      ? "The upload limit is 10 GiB per file and 20 GiB of unfinished uploads."
      : status === 401 || status === 403
        ? "Reconnect to localDot, then retry the upload."
        : status === 404
          ? "This upload is unavailable or expired. Select the file again."
          : "Upload paused. Retry to continue from the last saved chunk.";

// Only a small slice is read into memory. No base64 expansion or whole-file model ingestion.
export async function uploadFile(
  api: ApiClient,
  cellId: string,
  file: File,
  owner: AbortSignal,
  options: UploadOptions = {},
): Promise<string> {
  if (
    !ULID_PATTERN.test(cellId) ||
    !safeTransferName(file.name) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > USER_UPLOAD.bytes ||
    owner.aborted
  )
    throw new FileTransferFailure(
      false,
      undefined,
      "Choose a file with a safe, visible name, at most 10 GiB.",
    );
  const id = options.id ?? crypto.randomUUID();
  if (!UserUploadId.safeParse(id).success) throw new FileTransferFailure(false);
  const root = `/api/cells/${cellId}/uploads`,
    path = `${root}/${id}`;
  const request = async (
    url: string,
    method: string,
    body?: BodyInit,
    headers?: Record<string, string>,
  ) => {
    const lifetime = transferScope(owner);
    try {
      const response = await responseFor(
        api.fetch(transferEndpoint(api, url), {
          method,
          body,
          headers: { authorization: api.authorization(), ...headers },
          signal: lifetime.signal,
          redirect: "error",
          credentials: "same-origin",
          cache: "no-store",
        }),
        lifetime.signal,
      );
      if (response.status === 401) api.rejectUnauthorized?.();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new FileTransferFailure(
          ![400, 401, 403, 404, 413].includes(response.status),
          response.status,
          message(response.status),
        );
      }
      const chunks = await boundedBody(response, 4096, lifetime.signal);
      const bytes = new Uint8Array(chunks.reduce((n, p) => n + p.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const state = UserUploadStatus.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        state.id !== id ||
        state.name !== file.name ||
        state.bytes !== file.size ||
        state.offset > state.bytes ||
        (state.phase === "complete" &&
          (state.offset !== state.bytes ||
            !state.sha256 ||
            state.path !== `~/${userUploadPath(id, file.name)}`))
      )
        throw new Error("upload receipt did not match");
      return state;
    } finally {
      lifetime.close();
    }
  };
  let state: UserUploadStatus | undefined,
    failures = 0,
    placingStarted = 0;
  let chunk: { offset: number; bytes: Uint8Array<ArrayBuffer>; digest: string } | undefined;
  for (;;) {
    try {
      owner.throwIfAborted();
      if (!state)
        state = await request(
          root,
          "POST",
          JSON.stringify({ id, name: file.name, bytes: file.size }),
          { "content-type": "application/json" },
        );
      if (state.phase === "complete") return state.path as string;
      options.progress?.({
        offset: state.offset,
        phase: state.offset === file.size ? "placing" : "uploading",
      });
      if (state.offset < file.size) {
        if (!chunk || chunk.offset !== state.offset) {
          const bytes = new Uint8Array(
            await file.slice(state.offset, state.offset + USER_UPLOAD.chunkBytes).arrayBuffer(),
          );
          owner.throwIfAborted();
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          chunk = { offset: state.offset, bytes, digest };
        }
        state = await request(path, "PATCH", chunk.bytes, {
          "content-type": "application/offset+octet-stream",
          "upload-offset": String(chunk.offset),
          "upload-checksum": chunk.digest,
        });
        failures = 0;
      } else {
        chunk = undefined;
        if (!placingStarted) {
          state = await request(`${path}/complete`, "POST");
          placingStarted = Date.now();
        } else if (state.phase === "paused") {
          throw new FileTransferFailure(
            true,
            undefined,
            state.problem === "storage_full"
              ? message(507)
              : state.problem === "computer_update_required"
                ? "File received. Update your computer, then retry to finish placing it in Downloads."
                : state.problem === "verification_failed"
                  ? "File verification failed. Retry the upload."
                  : "File received. Waiting for the computer to be available; retry to finish placing it in Downloads.",
          );
        } else {
          if (Date.now() - placingStarted > 30 * 60_000)
            throw new FileTransferFailure(
              true,
              undefined,
              "Still placing the file in Downloads. Retry to check its progress.",
            );
          await pause(1000, owner);
          state = await request(path, "GET");
        }
      }
    } catch (error) {
      if (owner.aborted) throw new FileTransferFailure(true, undefined, message());
      if (error instanceof FileTransferFailure && (!error.uncertain || error.status === undefined))
        throw error;
      if (++failures > 3) throw new FileTransferFailure(true, undefined, message());
      await pause(500 * 2 ** (failures - 1), owner);
      // A reply may have been lost after commit. Query the saved offset/receipt before
      // sending anything else; never infer failure from a missing acknowledgement.
      try {
        state = await request(path, "GET");
      } catch (statusError) {
        if (statusError instanceof FileTransferFailure && statusError.status === 404)
          state = undefined;
        else if (statusError instanceof FileTransferFailure && !statusError.uncertain)
          throw statusError;
      }
    }
  }
}

export async function discardUpload(api: ApiClient, cellId: string, id: string): Promise<void> {
  const lifetime = transferScope(new AbortController().signal);
  try {
    const response = await api.fetch(transferEndpoint(api, `/api/cells/${cellId}/uploads/${id}`), {
      method: "DELETE",
      headers: { authorization: api.authorization() },
      signal: lifetime.signal,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    void response.body?.cancel().catch(() => {});
  } catch {
    /* Unfinished staging expires; removing a chip never deletes a completed computer file. */
  } finally {
    lifetime.close();
  }
}
