import { isDeepStrictEqual as equal } from "node:util";
import {
  IMAGE_DIGEST,
  IMAGE_ROLES,
  imageRef,
  ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import type { DoctorCheck } from "../../../daemon/src/doctor.ts";
import { imageVerdict } from "../../../daemon/src/doctor-image.ts";
import type { InstallImageClient } from "./image-client.ts";

/** Read all authenticated release pins, including missing ones. This adapter has no pull method.
 * Repeat inspections and engine identity before trusting results collected over multiple reads. */
export async function inspectDoctorImages(
  input: ReleaseManifest,
  client: Pick<InstallImageClient, "engine" | "inspect">,
  signal: AbortSignal,
) {
  const manifest = ReleaseManifest.parse(input);
  signal.throwIfAborted();
  const engine = { ...(await client.engine(signal)) };
  if (!engine.id || engine.operatingSystem !== "linux" || engine.architecture !== "arm64")
    throw new Error("The installed Docker engine is unavailable or unsupported.");
  const checks: DoctorCheck[] = [];
  const identities = new Map<string, string>();
  const valid = (role: (typeof IMAGE_ROLES)[number], raw: unknown): string | undefined => {
    if (
      !imageVerdict(
        imageRef(manifest.images[role]),
        { Os: engine.operatingSystem, Arch: engine.architecture },
        raw,
      ).ok ||
      !raw ||
      typeof raw !== "object" ||
      !("Id" in raw) ||
      typeof raw.Id !== "string" ||
      !IMAGE_DIGEST.test(raw.Id)
    )
      return undefined;
    return raw.Id;
  };
  for (const role of IMAGE_ROLES) {
    signal.throwIfAborted();
    let id: string | undefined;
    try {
      id = valid(role, await client.inspect(manifest.images[role], signal));
    } catch {
      signal.throwIfAborted();
    }
    if (id) identities.set(role, id);
    checks.push({
      name: `image-${role}`,
      ok: id !== undefined,
      detail: id
        ? "The installed image matches its release digest and linux/arm64 platform."
        : "The release image is missing, changed or unreadable. Repair the installed release before starting computers.",
    });
  }
  for (const role of IMAGE_ROLES) {
    signal.throwIfAborted();
    const expected = identities.get(role);
    if (!expected) continue;
    let current: string | undefined;
    try {
      current = valid(role, await client.inspect(manifest.images[role], signal));
    } catch {
      signal.throwIfAborted();
    }
    if (current !== expected) {
      const check = checks.find((item) => item.name === `image-${role}`);
      if (check) {
        check.ok = false;
        check.detail = "The image changed during diagnostics. Retry after Docker is stable.";
      }
    }
  }
  if (!equal(await client.engine(signal), engine))
    throw new Error("Docker changed during diagnostics.");
  signal.throwIfAborted();
  return { engineId: engine.id, images: Object.fromEntries(identities), checks };
}
