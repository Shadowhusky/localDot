import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { KEYD_PACKAGE, RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";
import { nativeArchiveURL } from "./native-plan.ts";

export interface RegistryPackage {
  name: "localdot" | typeof KEYD_PACKAGE;
  version: string;
}
export interface RegistryResource extends RegistryPackage {
  kind: "metadata" | "archive" | "attestation";
}
export type RegistryDownload = (
  resource: RegistryResource,
  signal: AbortSignal,
) => AsyncIterable<Buffer>;
export const MAX_RELEASE_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const registryFailure = () => new Error("Release package download failed.");

/** All resource URLs are derived from an exact compiled package name and release version.
 * No registry configuration, credentials, dist URL, proxy environment or candidate URL is used.
 */
export function registryResourceURL({ name, version, kind }: RegistryResource): URL {
  if (
    !["localdot", KEYD_PACKAGE].includes(name) ||
    typeof version !== "string" ||
    version.length > 64 ||
    !RELEASE_VERSION.test(version)
  )
    throw registryFailure();
  const base = "https://registry.npmjs.org";
  const encoded = encodeURIComponent(name);
  if (kind === "metadata") return new URL(`${base}/${encoded}/${version}`);
  if (kind === "attestation") return new URL(`${base}/-/npm/v1/attestations/${encoded}@${version}`);
  if (kind === "archive") {
    const leaf = name.split("/").at(-1);
    return new URL(`${base}/${name}/-/${leaf}-${version}.tgz`);
  }
  throw registryFailure();
}

/** A request is drained/closed when its iterator finishes, fails or is returned early by the
 * consumer. The consumer also enforces its own stream/file cap; response headers are not trusted.
 */
export const downloadRegistryResource: RegistryDownload = async function* (resource, signal) {
  const url = registryResourceURL(resource);
  const maxBytes = resource.kind === "archive" ? MAX_RELEASE_ARCHIVE_BYTES : 2 * 1024 * 1024;
  yield* downloadURL(url, resource.kind === "archive", maxBytes, signal);
};

/** A discovery hint only. The returned exact version must still pass the full immutable package,
 * provenance, TUF and Apple-signature preparation path before it can be activated. */
export async function latestReleaseVersion(signal: AbortSignal): Promise<string> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of downloadURL(
      new URL("https://registry.npmjs.org/localdot/latest"),
      false,
      2 * 1024 * 1024,
      signal,
    ))
      chunks.push(chunk);
    signal.throwIfAborted();
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !("name" in raw) ||
      raw.name !== "localdot" ||
      !("version" in raw) ||
      typeof raw.version !== "string" ||
      raw.version.length > 64 ||
      !RELEASE_VERSION.test(raw.version) ||
      raw.version.includes("-")
    )
      throw registryFailure();
    return raw.version;
  } catch {
    throw registryFailure();
  }
}

export const MAX_NATIVE_ARCHIVE_BYTES = 64 * 1024 * 1024;
export type NativeArchiveDownload = (
  pkg: Readonly<{ name: string; version: string }>,
  signal: AbortSignal,
) => AsyncIterable<Buffer>;
export const downloadNativeArchive: NativeArchiveDownload = async function* (pkg, signal) {
  const url = nativeArchiveURL(pkg.name, pkg.version);
  yield* downloadURL(url, true, MAX_NATIVE_ARCHIVE_BYTES, signal);
};

async function* downloadURL(url: URL, archive: boolean, maxBytes: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(registryFailure()), 30_000);
  let req: ReturnType<typeof request> | undefined;
  let response: IncomingMessage | undefined;
  let closed: Promise<void> | undefined;
  try {
    const ready = new Promise<IncomingMessage>((resolve, reject) => {
      req = request(
        url,
        {
          method: "GET",
          agent: false,
          signal: controller.signal,
          minVersion: "TLSv1.2",
          headers: {
            accept: archive ? "application/octet-stream" : "application/json",
            "accept-encoding": "identity",
          },
        },
        resolve,
      );
      closed = new Promise<void>((done) => req?.once("close", done));
      req.once("error", reject);
      req.end();
    });
    response = await ready;
    if (
      response.statusCode !== 200 ||
      (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
    )
      throw registryFailure();
    const length = response.headers["content-length"];
    if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes))
      throw registryFailure();
    let received = 0;
    for await (const chunk of response) {
      controller.signal.throwIfAborted();
      received += chunk.length;
      if (received > maxBytes) throw registryFailure();
      yield Buffer.from(chunk);
    }
    controller.signal.throwIfAborted();
    if (!response.complete || (length !== undefined && received !== Number(length)))
      throw registryFailure();
  } catch {
    signal.throwIfAborted();
    throw registryFailure();
  } finally {
    response?.destroy();
    req?.destroy();
    if (closed) await closed;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
