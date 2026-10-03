import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { ULID_PATTERN } from "@localdot/protocol";
import { PrivateFiles } from "./private-files.ts";

export const TRANSFER_BYTES = 100 * 1024 * 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in user filenames and response headers.
export const DOWNLOAD_NAME = /^[^/\\\0\x01-\x1f\x7f]{1,200}$/;
export class DownloadError extends Error {
  constructor(readonly status: 404 | 413) {
    super(status === 404 ? "not found" : "file too large");
  }
}

// Application-owned storage: reject static links and changed file identity before serving from
// the opened descriptor. Like PrivateFiles, this is not openat confinement against a malicious
// same-UID process that concurrently replaces application-owned ancestor directories.
export function downloadFile(
  home: string,
  sessionId: string,
  name: string,
  signal: AbortSignal,
  head = false,
): Response {
  if (
    !ULID_PATTERN.test(sessionId) ||
    !DOWNLOAD_NAME.test(name) ||
    name.startsWith(".") ||
    !name.isWellFormed()
  )
    throw new DownloadError(404);
  signal.throwIfAborted();
  let fd: number | undefined;
  try {
    const files = new PrivateFiles(home);
    const relative = `sessions/${sessionId}/out/${name}`;
    const path = files.path(relative);
    const before = lstatSync(path);
    if (!before.isFile()) throw new DownloadError(404);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev)
      throw new DownloadError(404);
    files.path(relative); // Recheck every application-owned ancestor after the no-follow open.
    if (opened.size > TRANSFER_BYTES) throw new DownloadError(413);
    signal.throwIfAborted();
    const headers = {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", "%27").replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("*", "%2A")}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    };
    // Hono dispatches HEAD through GET and discards the body without cancelling it.
    // Finish descriptor ownership here; no stream or abort listener is created for HEAD.
    if (head) {
      closeSync(fd);
      fd = undefined;
      return new Response(null, { status: 200, headers });
    }
    const owned = fd;
    fd = undefined;
    let closed = false;
    let sent = 0;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", abort);
      closeSync(owned);
    };
    const abort = () => {
      close();
      controller.error(new Error("download cancelled"));
    };
    const body = new ReadableStream<Uint8Array>({
      start(output) {
        controller = output;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      pull(output) {
        if (closed) return;
        try {
          signal.throwIfAborted();
          if (fstatSync(owned).size > TRANSFER_BYTES) throw new DownloadError(413);
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, TRANSFER_BYTES + 1 - sent));
          const bytes = readSync(owned, buffer, 0, buffer.length, null);
          sent += bytes;
          if (sent > TRANSFER_BYTES) throw new DownloadError(413);
          if (bytes === 0) {
            close();
            output.close();
          } else output.enqueue(buffer.subarray(0, bytes));
        } catch {
          close();
          output.error(new Error("download interrupted"));
        }
      },
      cancel() {
        close();
      },
    });
    return new Response(body, {
      status: 200,
      headers,
    });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof DownloadError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new DownloadError(404);
  }
}
