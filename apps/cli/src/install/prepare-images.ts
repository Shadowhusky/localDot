import { setTimeout as delay } from "node:timers/promises";
import type { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import {
  IMAGE_DIGEST,
  IMAGE_ROLES,
  imageRef,
  type PlatformImagePin,
  ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import { imageVerdict } from "../../../daemon/src/doctor-image.ts";
import { type InstallImageClient, installImageClient } from "./image-client.ts";
import type { ImagePullProgress } from "./image-progress.ts";
import { readInstalledRelease } from "./promote-release.ts";
import { SetupFailure } from "./setup-failure.ts";

export interface ImagePreparationProgress {
  role: (typeof IMAGE_ROLES)[number];
  phase: "checking" | "ready" | ImagePullProgress["phase"];
  layer?: string;
  currentBytes?: number;
  totalBytes?: number;
}
const fail = () =>
  new Error("Release images are unavailable or do not match the pinned platform and digests.");

/** manifest must already be authenticated. This snapshots it before awaits and prepares only
 * its four exact references. A preparation result is not permanent: startup still checks Docker.
 */
export async function prepareReleaseImages(
  input: ReleaseManifest,
  client: InstallImageClient,
  signal: AbortSignal,
  report: (progress: ImagePreparationProgress) => void = () => {},
) {
  signal.throwIfAborted();
  const manifest = ReleaseManifest.parse(input);
  return Object.freeze({
    version: manifest.version,
    ...(await prepareImages(manifest.images, client, signal, report)),
  });
}

/** The four authenticated pins, each inspected and pulled only when Docker lacks it. */
export async function prepareImages(
  pins: Readonly<Record<(typeof IMAGE_ROLES)[number], PlatformImagePin>>,
  client: InstallImageClient,
  signal: AbortSignal,
  report: (progress: ImagePreparationProgress) => void = () => {},
) {
  signal.throwIfAborted();
  const pinned = structuredClone(pins);
  const engine = { ...(await client.engine(signal)) };
  if (
    engine.operatingSystem !== "linux" ||
    !["arm64", "amd64"].includes(engine.architecture) ||
    !engine.id
  )
    throw fail();
  if (IMAGE_ROLES.some((role) => !pinned[role].platforms.includes(`linux/${engine.architecture}`)))
    throw fail();
  const images: Record<string, { reference: string; imageId: string }> = {};
  function verified(reference: string, inspection: unknown): string | undefined {
    if (
      !imageVerdict(
        reference,
        { Os: engine.operatingSystem, Arch: engine.architecture },
        inspection,
      ).ok ||
      !inspection ||
      typeof inspection !== "object" ||
      !("Id" in inspection) ||
      typeof inspection.Id !== "string" ||
      !IMAGE_DIGEST.test(inspection.Id)
    )
      return undefined;
    return inspection.Id;
  }
  for (const role of IMAGE_ROLES) {
    signal.throwIfAborted();
    const pin = pinned[role],
      reference = imageRef(pin);
    report(Object.freeze({ role, phase: "checking" }));
    let id = verified(reference, await client.inspect(pin, signal));
    if (!id) {
      signal.throwIfAborted();
      report(Object.freeze({ role, phase: "pulling" }));
      for (let attempt = 0; ; attempt++) {
        try {
          await client.pull(pin, signal, (progress) =>
            report(Object.freeze({ ...progress, role })),
          );
          break;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof SetupFailure) || !error.retryable || attempt >= 2) throw error;
          await delay(attempt === 0 ? 1000 : 3000, undefined, { signal });
          const current = await client.engine(signal);
          if (
            current.id !== engine.id ||
            current.architecture !== engine.architecture ||
            current.operatingSystem !== engine.operatingSystem
          )
            throw fail();
        }
      }
      signal.throwIfAborted();
      id = verified(reference, await client.inspect(pin, signal));
    }
    if (!id) throw fail();
    images[role] = Object.freeze({ reference, imageId: id });
    report(Object.freeze({ role, phase: "ready" }));
  }
  const current = await client.engine(signal);
  if (
    current.id !== engine.id ||
    current.operatingSystem !== engine.operatingSystem ||
    current.architecture !== engine.architecture
  )
    throw fail();
  // Another operation may have pruned/replaced an earlier image while later images downloaded.
  for (const role of IMAGE_ROLES) {
    signal.throwIfAborted();
    const expected = images[role];
    if (
      !expected ||
      verified(expected.reference, await client.inspect(pinned[role], signal)) !== expected.imageId
    )
      throw fail();
  }
  signal.throwIfAborted();
  return {
    engineId: engine.id,
    platform: `linux/${engine.architecture}` as const,
    images: Object.freeze(images),
  };
}

/** Production entry point: reacquire the manifest through its installed trust anchor before
 * touching Docker. Caller holds the install lock and has passed the local Docker preflight.
 */
export async function prepareInstalledReleaseImages(
  state: string,
  identity: ReleaseIdentity,
  socketPath: string,
  signal: AbortSignal,
  report?: (progress: ImagePreparationProgress) => void,
) {
  const verified = await readInstalledRelease(state, identity, signal);
  return prepareReleaseImages(verified.manifest, installImageClient(socketPath), signal, report);
}
