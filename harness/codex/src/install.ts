import { createHash } from "node:crypto";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { CodexInstallFailure, CodexInstallState } from "@localdot/protocol";
import {
  CodexMemberIntegrityError,
  extractCodexArchive,
  UnsafeCodexArchiveError,
  writeFully,
} from "./archive.ts";
import {
  assertOwnedCodexRoots,
  codexInstallDirectory,
  createOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  PRIVATE_CREATE_FLAGS,
  PRIVATE_READ_FLAGS,
  persistCodexInstallation,
  publishOwnedCodexDirectory,
  removeOwnedCodexDirectory,
} from "./roots.ts";
import {
  CODEX_VERSION,
  type CodexReleaseManifest,
  codexRelease,
  MAX_COMPRESSED_BYTES,
  releaseInstallKey,
  validateReleaseManifest,
} from "./version.ts";

export class CodexInstallError extends Error {
  constructor(readonly code: CodexInstallFailure) {
    super(`Codex installation failed (${code}).`);
    this.name = "CodexInstallError";
  }
}
export interface InstalledCodex {
  readonly version: typeof CODEX_VERSION;
  readonly platform: CodexReleaseManifest["platform"];
  readonly binDir: string;
  readonly codexBin: string;
  readonly codeModeHostBin: string;
}
export interface CodexInstaller {
  status(): CodexInstallState;
  ensureInstalled(signal: AbortSignal): Promise<InstalledCodex>;
  verifiedInstallation(signal: AbortSignal): Promise<InstalledCodex | undefined>;
  cancel(): void;
}
export interface CodexDownload {
  readonly status: number;
  readonly contentLength?: number;
  readonly body: Readable;
}
export type CodexDownloadTransport = (url: string, signal: AbortSignal) => Promise<CodexDownload>;

// Native HTTPS refuses redirects. Connect includes DNS/TLS; the body stays on a 30s idle timer.
export const downloadCodexArchive: CodexDownloadTransport = (url, signal) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: { "accept-encoding": "identity" } });
    const connect = setTimeout(
      () => request.destroy(new CodexInstallError("download_failed")),
      10000,
    );
    connect.unref();
    request.setTimeout(30000, () => request.destroy(new CodexInstallError("download_failed")));
    request.once("socket", (socket) => {
      if (!socket.connecting) clearTimeout(connect);
      else socket.once("secureConnect", () => clearTimeout(connect));
    });
    request.once("error", (error) => {
      clearTimeout(connect);
      reject(error);
    });
    request.once("response", (response) => {
      clearTimeout(connect);
      const length = response.headers["content-length"];
      if (response.statusCode !== 200 || (length !== undefined && !/^[0-9]+$/.test(length))) {
        response.destroy();
        reject(new CodexInstallError("download_failed"));
        return;
      }
      resolve({
        status: response.statusCode,
        ...(length !== undefined ? { contentLength: Number(length) } : {}),
        body: response,
      });
    });
  });

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const file = await open(path, PRIVATE_READ_FLAGS);
  try {
    if (!(await file.stat()).isFile()) throw new CodexInstallError("integrity_failed");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({
      signal,
      autoClose: false,
      highWaterMark: 64 * 1024,
    }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

function safeFailure(error: unknown, signal: AbortSignal): CodexInstallError {
  if (signal.aborted)
    return signal.reason instanceof CodexInstallError
      ? signal.reason
      : new CodexInstallError("cancelled");
  if (error instanceof CodexInstallError) return error;
  if (error instanceof CodexMemberIntegrityError) return new CodexInstallError("integrity_failed");
  if (error instanceof UnsafeCodexArchiveError) return new CodexInstallError("unsafe_archive");
  return new CodexInstallError("storage_failed");
}
function waitForInstall(
  promise: Promise<InstalledCodex>,
  signal: AbortSignal,
): Promise<InstalledCodex> {
  if (signal.aborted) return Promise.reject(new CodexInstallError("cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CodexInstallError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

// Trusted dependency-injection seam for small offline archives. Application consumers use the
// production factory below, which can select only the committed official release manifest.
export class VerifiedCodexInstaller implements CodexInstaller {
  #state: CodexInstallState = { state: "not_installed" };
  #flight:
    | { controller: AbortController; promise: Promise<InstalledCodex>; owner: AbortSignal }
    | undefined;
  #release: CodexReleaseManifest | undefined;
  constructor(
    private readonly roots: OwnedCodexRoots,
    release: CodexReleaseManifest | undefined,
    private readonly transport: CodexDownloadTransport = downloadCodexArchive,
  ) {
    try {
      this.#release = release ? validateReleaseManifest(release) : undefined;
    } catch {
      this.#state = { state: "failed", code: "integrity_failed" };
      throw new CodexInstallError("integrity_failed");
    }
    if (!release) this.#state = { state: "failed", code: "unsupported_platform" };
  }
  status(): CodexInstallState {
    return structuredClone(this.#state);
  }
  cancel(): void {
    this.#flight?.controller.abort(new CodexInstallError("cancelled"));
  }

  ensureInstalled(signal: AbortSignal): Promise<InstalledCodex> {
    if (signal.aborted) return Promise.reject(new CodexInstallError("cancelled"));
    if (!this.#release) return Promise.reject(new CodexInstallError("unsupported_platform"));
    const current = this.#flight;
    if (current)
      return current.owner === signal ? current.promise : waitForInstall(current.promise, signal);
    const controller = new AbortController();
    const abort = () => controller.abort(new CodexInstallError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const overall = setTimeout(
      () => controller.abort(new CodexInstallError("download_failed")),
      300000,
    );
    overall.unref();
    const flight = {
      controller,
      owner: signal,
      promise: Promise.resolve(undefined as unknown as InstalledCodex),
    };
    // Publish ownership before any await: concurrent callers cannot allocate another staging.
    this.#flight = flight;
    flight.promise = this.#install(this.#release, controller.signal).finally(() => {
      clearTimeout(overall);
      signal.removeEventListener("abort", abort);
      if (this.#flight === flight) this.#flight = undefined;
    });
    return flight.promise;
  }

  async verifiedInstallation(signal: AbortSignal): Promise<InstalledCodex | undefined> {
    try {
      if (!this.#release) return undefined;
      signal.throwIfAborted();
      assertOwnedCodexRoots(this.roots);
      const release = this.#release,
        binDir = codexInstallDirectory(this.roots, releaseInstallKey(release));
      try {
        const dir = await lstat(binDir);
        if (
          !dir.isDirectory() ||
          dir.isSymbolicLink() ||
          dir.uid !== process.getuid?.() ||
          (dir.mode & 0o777) !== 0o700
        )
          throw new CodexInstallError("integrity_failed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      for (const expected of release.binaries) {
        signal.throwIfAborted();
        assertOwnedCodexRoots(this.roots);
        const path = join(binDir, expected.installedName),
          file = await open(path, PRIVATE_READ_FLAGS);
        try {
          const info = await file.stat();
          if (
            !info.isFile() ||
            info.uid !== process.getuid?.() ||
            (info.mode & 0o777) !== 0o555 ||
            info.size !== expected.bytes ||
            info.nlink !== 1
          )
            throw new CodexInstallError("integrity_failed");
          const hash = createHash("sha256");
          for await (const chunk of file.createReadStream({
            signal,
            autoClose: false,
            highWaterMark: 64 * 1024,
          }))
            hash.update(chunk);
          if (hash.digest("hex") !== expected.sha256)
            throw new CodexInstallError("integrity_failed");
        } finally {
          await file.close();
        }
      }
      signal.throwIfAborted();
      assertOwnedCodexRoots(this.roots);
      this.#state = { state: "ready", version: CODEX_VERSION };
      return Object.freeze({
        version: CODEX_VERSION,
        platform: release.platform,
        binDir,
        codexBin: join(binDir, "codex"),
        codeModeHostBin: join(binDir, "codex-code-mode-host"),
      });
    } catch (error) {
      if (signal.aborted) throw new CodexInstallError("cancelled");
      this.#state = { state: "failed", code: "integrity_failed" };
      if (error instanceof CodexInstallError) throw error;
      throw new CodexInstallError("integrity_failed");
    }
  }

  async #install(release: CodexReleaseManifest, signal: AbortSignal): Promise<InstalledCodex> {
    let staging: OwnedCodexDirectory | undefined;
    const perform = async (): Promise<InstalledCodex> => {
      signal.throwIfAborted();
      const old = await this.verifiedInstallation(signal);
      if (old) {
        // A prior rename may have succeeded without a confirmed directory sync. A successful
        // retry revalidates first and completes durability, without replacing the installation.
        for (const binary of release.binaries) {
          signal.throwIfAborted();
          const file = await open(join(old.binDir, binary.installedName), PRIVATE_READ_FLAGS);
          try {
            await file.sync();
          } finally {
            await file.close();
          }
        }
        signal.throwIfAborted();
        await persistCodexInstallation(this.roots, old.binDir);
        return old;
      }
      assertOwnedCodexRoots(this.roots);
      staging = createOwnedCodexDirectory(this.roots, "binRoot");
      const archive = join(staging.path, "archive.tgz");
      await this.#download(release, archive, signal);
      signal.throwIfAborted();
      this.#state = { state: "verifying" };
      await extractCodexArchive(archive, staging.path, release, signal);
      await unlink(archive);
      for (const binary of release.binaries) {
        signal.throwIfAborted();
        const file = await open(join(staging.path, binary.installedName), PRIVATE_READ_FLAGS);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
            throw new CodexInstallError("storage_failed");
          await file.chmod(0o555);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      signal.throwIfAborted();
      assertOwnedCodexRoots(this.roots);
      const binDir = codexInstallDirectory(this.roots, releaseInstallKey(release));
      // Rename is the publication point. A cancellation before it publishes nothing; after
      // successful rename the verified installation remains available. Readiness additionally
      // requires the directory change to be durable; a failed sync never removes that target.
      await publishOwnedCodexDirectory(staging, binDir, signal);
      const installed: InstalledCodex = Object.freeze({
        version: CODEX_VERSION,
        platform: release.platform,
        binDir,
        codexBin: join(binDir, "codex"),
        codeModeHostBin: join(binDir, "codex-code-mode-host"),
      });
      return installed;
    };
    let installed: InstalledCodex | undefined;
    let failure: CodexInstallError | undefined;
    try {
      installed = await perform();
    } catch (error) {
      failure = safeFailure(error, signal);
    }
    if (staging) {
      try {
        await removeOwnedCodexDirectory(staging);
      } catch {
        failure = new CodexInstallError("storage_failed");
      }
    }
    if (failure || !installed) {
      failure ??= new CodexInstallError("storage_failed");
      this.#state = { state: "failed", code: failure.code };
      throw failure;
    }
    this.#state = { state: "ready", version: CODEX_VERSION };
    return installed;
  }

  async #download(
    release: CodexReleaseManifest,
    archive: string,
    signal: AbortSignal,
  ): Promise<void> {
    let response: CodexDownload;
    try {
      response = await this.transport(release.archive.url, signal);
    } catch {
      throw new CodexInstallError(signal.aborted ? "cancelled" : "download_failed");
    }
    const body = response.body;
    const observedError = () => {};
    body.on("error", observedError);
    body.once("close", () => body.removeListener("error", observedError));
    const abort = () => body.destroy(new CodexInstallError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    let file: FileHandle | undefined;
    try {
      signal.throwIfAborted();
      if (response.status !== 200) throw new CodexInstallError("download_failed");
      if (
        response.contentLength !== undefined &&
        response.contentLength !== release.archive.compressedBytes
      )
        throw new CodexInstallError("integrity_failed");
      file = await open(archive, PRIVATE_CREATE_FLAGS, 0o600);
      const hash = createHash("sha512");
      let received = 0;
      this.#state = {
        state: "downloading",
        receivedBytes: 0,
        totalBytes: release.archive.compressedBytes,
      };
      const iterator = body[Symbol.asyncIterator]();
      try {
        while (true) {
          let part: IteratorResult<unknown>;
          try {
            part = await iterator.next();
          } catch {
            throw new CodexInstallError(signal.aborted ? "cancelled" : "download_failed");
          }
          if (part.done) break;
          signal.throwIfAborted();
          if (!(part.value instanceof Uint8Array)) throw new CodexInstallError("download_failed");
          const bytes = Buffer.from(
            part.value.buffer,
            part.value.byteOffset,
            part.value.byteLength,
          );
          received += bytes.length;
          if (received > MAX_COMPRESSED_BYTES || received > release.archive.compressedBytes)
            throw new CodexInstallError("integrity_failed");
          hash.update(bytes);
          await writeFully(file, bytes);
          this.#state = {
            state: "downloading",
            receivedBytes: received,
            totalBytes: release.archive.compressedBytes,
          };
        }
      } finally {
        await iterator.return?.();
      }
      if (
        received !== release.archive.compressedBytes ||
        hash.digest("base64") !== release.archive.sha512
      )
        throw new CodexInstallError("integrity_failed");
      await file.sync();
    } finally {
      signal.removeEventListener("abort", abort);
      body.destroy();
      await file?.close();
    }
  }
}

export function createCodexInstaller(options: {
  roots: OwnedCodexRoots;
  platform?: string;
  arch?: string;
}): CodexInstaller {
  return new VerifiedCodexInstaller(options.roots, codexRelease(options.platform, options.arch));
}
