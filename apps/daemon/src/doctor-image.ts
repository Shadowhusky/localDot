import type { DockerVersion } from "./cells/docker.ts";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ARCHITECTURES = new Set(["arm64", "amd64"]);

export function imageVerdict(
  reference: string,
  engine: Pick<DockerVersion, "Os" | "Arch">,
  inspection: unknown,
): { ok: boolean; detail: string } {
  if (engine.Os !== "linux" || !ARCHITECTURES.has(engine.Arch)) {
    return {
      ok: false,
      detail: "Docker must report a supported Linux arm64 or amd64 engine platform.",
    };
  }
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    return { ok: false, detail: `${reference}: Docker returned no verifiable image metadata.` };
  }
  const image = inspection as Record<string, unknown>;
  if (
    typeof image.Os !== "string" ||
    typeof image.Architecture !== "string" ||
    !ARCHITECTURES.has(image.Architecture)
  ) {
    return { ok: false, detail: `${reference}: Docker did not report a supported image platform.` };
  }
  const expected = `${engine.Os}/${engine.Arch}`,
    actual = `${image.Os}/${image.Architecture}`;
  if (actual !== expected) {
    return {
      ok: false,
      detail: `${reference} is ${actual}; Docker is ${expected}. Pull the ${expected} image.`,
    };
  }
  if (reference.includes("@")) {
    const at = reference.indexOf("@");
    if (
      !/^[a-z0-9][a-z0-9._:/-]*$/.test(reference.slice(0, at)) ||
      !DIGEST.test(reference.slice(at + 1))
    ) {
      return { ok: false, detail: `${reference}: the pinned image reference is malformed.` };
    }
    if (
      !Array.isArray(image.RepoDigests) ||
      !image.RepoDigests.every((value) => typeof value === "string") ||
      !image.RepoDigests.includes(reference)
    ) {
      return {
        ok: false,
        detail: `${reference}: Docker did not confirm this repository digest. Pull the pinned image again.`,
      };
    }
    return { ok: true, detail: `${reference} (${actual}; repository digest verified)` };
  }
  if (reference.startsWith("sha256:")) {
    if (!DIGEST.test(reference) || image.Id !== reference) {
      return { ok: false, detail: `${reference}: Docker did not confirm this image ID.` };
    }
    return { ok: true, detail: `${reference} (${actual}; image ID verified)` };
  }
  return { ok: true, detail: `${reference} (${actual}; unpinned development reference)` };
}
