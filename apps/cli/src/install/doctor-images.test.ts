import { expect, it, vi } from "vitest";
import {
  IMAGE_ROLES,
  imageRef,
  ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { inspectDoctorImages } from "./doctor-images.ts";
import type { InstallImageClient } from "./image-client.ts";

function fixture() {
  const manifest = ReleaseManifest.parse(sampleManifest()),
    controller = new AbortController();
  const engine = {
    id: "engine-1",
    operatingSystem: "linux" as const,
    architecture: "arm64" as const,
  };
  const images = new Map(
    IMAGE_ROLES.map((role) => [
      imageRef(manifest.images[role]),
      {
        Id: `sha256:${"b".repeat(64)}`,
        Os: "linux",
        Architecture: "arm64",
        RepoDigests: [imageRef(manifest.images[role])],
      },
    ]),
  );
  const client = {
    engine: vi.fn(async () => ({ ...engine })),
    inspect: vi.fn<InstallImageClient["inspect"]>(async (pin) =>
      structuredClone(images.get(imageRef(pin)) ?? null),
    ),
  };
  return {
    manifest,
    images,
    engine,
    client,
    controller,
    run: () => inspectDoctorImages(manifest, client, controller.signal),
  };
}
it("inspects all four roles twice and rechecks the same engine without a pull capability", async () => {
  const f = fixture(),
    result = await f.run();
  expect(result.checks.map((c) => c.name)).toEqual(IMAGE_ROLES.map((r) => `image-${r}`));
  expect(result.checks.every((c) => c.ok)).toBe(true);
  expect(Object.keys(result.images)).toEqual([...IMAGE_ROLES]);
  expect(f.client.inspect).toHaveBeenCalledTimes(8);
  expect(f.client.engine).toHaveBeenCalledTimes(2);
});
it.each(["missing", "wrong-digest", "wrong-platform", "invalid-id", "unreadable"])(
  "reports %s and continues through the other images",
  async (fault) => {
    const f = fixture(),
      ref = imageRef(f.manifest.images.brain),
      entry = f.images.get(ref);
    if (!entry) throw new Error("fixture");
    if (fault === "missing") f.images.delete(ref);
    if (fault === "wrong-digest") entry.RepoDigests = [];
    if (fault === "wrong-platform") entry.Architecture = "amd64";
    if (fault === "invalid-id") entry.Id = "private-image-data";
    if (fault === "unreadable")
      f.client.inspect.mockImplementation(async (pin) => {
        if (imageRef(pin) === ref) throw new Error("private-image-data");
        return f.images.get(imageRef(pin)) ?? null;
      });
    const result = await f.run();
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["image-brain"]);
    expect(JSON.stringify(result)).not.toContain("private-image-data");
  },
);
it("refuses a changed image during final reinspection", async () => {
  const f = fixture(),
    original = f.client.inspect.getMockImplementation();
  f.client.inspect.mockImplementation(async (pin, signal) => {
    const raw = await original?.(pin, signal);
    if (f.client.inspect.mock.calls.length === 5 && raw && typeof raw === "object")
      return { ...raw, Id: `sha256:${"c".repeat(64)}` };
    return raw;
  });
  const result = await f.run();
  expect(result.checks[0]?.ok).toBe(false);
});
it("rejects an engine switch even when every individual image matches", async () => {
  const f = fixture();
  f.client.engine.mockResolvedValueOnce(f.engine).mockResolvedValue({ ...f.engine, id: "other" });
  await expect(f.run()).rejects.toThrow("Docker changed");
});
it("stops after a cancelled inspection without further requests", async () => {
  const f = fixture();
  f.client.inspect.mockImplementation(async () => {
    f.controller.abort();
    throw new Error("cancelled");
  });
  await expect(f.run()).rejects.toThrow();
  expect(f.client.inspect).toHaveBeenCalledTimes(1);
});
