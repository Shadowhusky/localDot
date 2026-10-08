import { afterEach, expect, it, vi } from "vitest";
import {
  IMAGE_ROLES,
  imageRef,
  ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import type { InstallImageClient } from "./image-client.ts";
import { prepareInstalledReleaseImages, prepareReleaseImages } from "./prepare-images.ts";

const readInstalled = vi.hoisted(() => vi.fn());
vi.mock("./promote-release.ts", () => ({ readInstalledRelease: readInstalled }));
afterEach(() => readInstalled.mockReset());
const signal = () => new AbortController().signal;
function fixture() {
  const manifest = ReleaseManifest.parse(sampleManifest()),
    present = new Map<string, unknown>();
  const engine = vi.fn(async () => ({
    id: "engine-1",
    operatingSystem: "linux" as const,
    architecture: "arm64" as const,
  }));
  const inspect = vi.fn<InstallImageClient["inspect"]>(
    async (pin) => present.get(imageRef(pin)) ?? null,
  );
  const valid = (reference: string) => ({
    Id: `sha256:${"b".repeat(64)}`,
    Os: "linux",
    Architecture: "arm64",
    RepoDigests: [reference],
  });
  const pull = vi.fn<InstallImageClient["pull"]>(async (pin, _signal, report) => {
    report({ phase: "downloading", layer: "abc123" });
    present.set(imageRef(pin), valid(imageRef(pin)));
  });
  const client = { engine, inspect, pull },
    report = vi.fn();
  return { manifest, present, valid, client, report };
}
it("pulls only four exact platform pins, verifies each and rechecks all before completion", async () => {
  const f = fixture(),
    result = await prepareReleaseImages(f.manifest, f.client, signal(), f.report);
  expect(f.client.pull.mock.calls.map(([pin]) => imageRef(pin))).toEqual(
    IMAGE_ROLES.map((role) => imageRef(f.manifest.images[role])),
  );
  expect(f.client.inspect).toHaveBeenCalledTimes(12);
  expect(f.client.engine).toHaveBeenCalledTimes(2);
  expect(Object.keys(result.images)).toEqual([...IMAGE_ROLES]);
  expect(result.platform).toBe("linux/arm64");
  expect(f.report.mock.calls.filter(([p]) => p.phase === "ready")).toHaveLength(4);
});
it("reuses matching local images without a registry pull", async () => {
  const f = fixture();
  for (const role of IMAGE_ROLES) {
    const ref = imageRef(f.manifest.images[role]);
    f.present.set(ref, f.valid(ref));
  }
  await prepareReleaseImages(f.manifest, f.client, signal());
  expect(f.client.pull).not.toHaveBeenCalled();
  expect(f.client.inspect).toHaveBeenCalledTimes(8);
});
it.each(["wrong-arch", "wrong-digest", "config-id-only", "missing-after-pull"])(
  "refuses %s after a pull",
  async (kind) => {
    const f = fixture();
    f.client.pull.mockImplementation(async (pin) => {
      const ref = imageRef(pin),
        image = f.valid(ref);
      if (kind === "wrong-arch") image.Architecture = "amd64";
      if (kind === "wrong-digest") image.RepoDigests = [ref.replace(/a/g, "c")];
      if (kind === "config-id-only") {
        image.Id = pin.digest;
        image.RepoDigests = [];
      }
      if (kind !== "missing-after-pull") f.present.set(ref, image);
    });
    await expect(prepareReleaseImages(f.manifest, f.client, signal(), f.report)).rejects.toThrow();
    expect(f.client.pull).toHaveBeenCalledTimes(1);
    expect(f.report.mock.calls.some(([p]) => p.phase === "ready")).toBe(false);
  },
);
it("refuses a switched engine or an image removed during later pulls", async () => {
  const f = fixture();
  f.client.engine
    .mockResolvedValueOnce({ id: "engine-1", operatingSystem: "linux", architecture: "arm64" })
    .mockResolvedValue({ id: "engine-2", operatingSystem: "linux", architecture: "arm64" });
  await expect(prepareReleaseImages(f.manifest, f.client, signal())).rejects.toThrow();
  const g = fixture();
  g.client.engine.mockImplementation(async () => {
    if (g.present.size === 4) g.present.clear();
    return { id: "engine-1", operatingSystem: "linux", architecture: "arm64" };
  });
  await expect(prepareReleaseImages(g.manifest, g.client, signal())).rejects.toThrow();
});
it("snapshots the manifest and stops on cancellation without pulling later roles", async () => {
  const f = fixture(),
    original = imageRef(f.manifest.images.desktop);
  const run = prepareReleaseImages(f.manifest, f.client, signal());
  f.manifest.images.desktop.digest = `sha256:${"d".repeat(64)}`;
  expect((await run).images.desktop?.reference).toBe(original);
  const g = fixture(),
    controller = new AbortController(),
    reason = new Error("stop");
  g.client.pull.mockImplementation(async () => {
    controller.abort(reason);
  });
  await expect(prepareReleaseImages(g.manifest, g.client, controller.signal)).rejects.toBe(reason);
  expect(g.client.pull).toHaveBeenCalledTimes(1);
});
it("rejects malformed manifests before Docker and installed trust failures before socket creation", async () => {
  const f = fixture();
  f.manifest.images.desktop.digest = "latest";
  await expect(prepareReleaseImages(f.manifest, f.client, signal())).rejects.toThrow();
  expect(f.client.engine).not.toHaveBeenCalled();
  readInstalled.mockRejectedValue(new Error("receipt tampered"));
  await expect(
    prepareInstalledReleaseImages(
      "/fixture",
      { version: "1.0.0", packageSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
      "invalid socket",
      signal(),
    ),
  ).rejects.toThrow("receipt tampered");
});
