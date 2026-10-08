import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import type { Fetcher } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";

export const SIGSTORE_TUF_MIRROR = "https://tuf-repo-cdn.sigstore.dev";
export const MAX_TUF_BYTES = 2 * 1024 * 1024;
export type TufDownload = (url: string, maxBytes: number, signal: AbortSignal) => Promise<Buffer>;
const fail = () => new Error("Signing trust metadata could not be downloaded.");

export function checkedTufURL(value: string): URL {
  const url = new URL(value);
  if (
    url.origin !== SIGSTORE_TUF_MIRROR ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value ||
    !/^\/(?:[1-9][0-9]*\.root\.json|timestamp\.json|(?:[1-9][0-9]*\.)?(?:snapshot|targets)\.json|targets\/(?:[0-9a-f]{64,128}\.)?trusted_root\.json)$/.test(
      url.pathname,
    )
  )
    throw fail();
  return url;
}

/** No proxy environment, credentials, redirects, decompression or retries. HTTPS requests have
 * both a byte cap and a whole-request deadline. The parent worker supplies the total deadline.
 */
export const downloadTufBytes: TufDownload = async (value, maxBytes, signal) => {
  signal.throwIfAborted();
  const url = checkedTufURL(value);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TUF_BYTES) throw fail();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(fail()), 5000);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          signal: controller.signal,
          minVersion: "TLSv1.2",
          headers: { accept: "application/json", "accept-encoding": "identity" },
        },
        async (res) => {
          try {
            if (res.statusCode !== 200)
              throw new DownloadHTTPError("TUF HTTP response refused", res.statusCode ?? 0);
            if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
              throw fail();
            const length = res.headers["content-length"];
            if (length && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) throw fail();
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of res) {
              bytes += chunk.length;
              if (bytes > maxBytes) throw fail();
              chunks.push(Buffer.from(chunk));
            }
            resolve(Buffer.concat(chunks, bytes));
          } catch (error) {
            reject(error);
          } finally {
            res.destroy();
            req.destroy();
          }
        },
      );
      req.once("error", reject);
      req.end();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};

/** The directory is a fresh, private worker-owned directory. Downloaded files never use server
 * filenames. Temporary files are removed after TUF has checked their declared hash/length.
 */
export function tufFetcher(
  directory: string,
  signal: AbortSignal,
  download: TufDownload = downloadTufBytes,
): Fetcher {
  async function bytes(url: string, limit: number) {
    checkedTufURL(url);
    signal.throwIfAborted();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TUF_BYTES) throw fail();
    const result = await download(url, limit, signal);
    signal.throwIfAborted();
    if (!Buffer.isBuffer(result) || result.length > limit) throw fail();
    return result;
  }
  return {
    downloadBytes: bytes,
    async downloadFile(url, limit, handler) {
      const data = await bytes(url, limit);
      const file = join(directory, `download-${randomUUID()}`);
      await writeFile(file, data, { flag: "wx", mode: 0o600 });
      try {
        return await handler(file);
      } finally {
        await unlink(file);
      }
    },
  };
}
