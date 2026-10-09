import { describe, expect, it } from "vitest";
import { imageRef, PackagePath, ReleaseManifest } from "./release.ts";
import { type SampleManifest, sampleManifest } from "./testing/sample-release.ts";

const hex = (c: string) => c.repeat(64);

describe("release manifest", () => {
  it("accepts a complete manifest and builds digest references", () => {
    const m = ReleaseManifest.parse(sampleManifest());
    expect(imageRef(m.images.desktop)).toBe(
      `ghcr.io/shadowhusky/localdot-desktop@sha256:${hex("a")}`,
    );
  });

  it.each([
    ["a tag instead of a digest", (m: SampleManifest) => (m.images.gate.digest = "latest")],
    ["an image without arm64", (m: SampleManifest) => (m.images.brain.platforms = ["linux/amd64"])],
    [
      "an image outside ghcr.io",
      (m: SampleManifest) => (m.images.desktop.repository = "docker.io/evil/localdot-desktop"),
    ],
    ["a range version", (m: SampleManifest) => (m.version = "^1.0.0")],
    [
      "an unknown field",
      (m: SampleManifest) => ((m as unknown as Record<string, unknown>).postinstall = "x"),
    ],
    ["a short keyd hash", (m: SampleManifest) => (m.keyd.sha256 = "abc")],
    ["another keyd identifier", (m: SampleManifest) => (m.keyd.identifier = "com.evil.keyd")],
    [
      "keyd-native signed as keyd",
      (m: SampleManifest) => (m.keyd.native.identifier = "dev.localdot.keyd"),
    ],
    ["keyd-native elsewhere", (m: SampleManifest) => (m.keyd.native.path = "bin/keyd")],
    ["a short keyd-native hash", (m: SampleManifest) => (m.keyd.native.sha256 = "abc")],
    [
      "no keyd-native",
      (m: SampleManifest) => delete (m.keyd as Partial<SampleManifest["keyd"]>).native,
    ],
    ["an empty file list", (m: SampleManifest) => (m.files = {})],
    [
      "a swapped image role",
      (m: SampleManifest) => (m.images.desktop.repository = m.images.gate.repository),
    ],
    [
      "an unsupported platform",
      (m: SampleManifest) => (m.images.brain.platforms = ["linux/arm64", "windows/amd64"]),
    ],
    ["a self-referential manifest", (m: SampleManifest) => (m.files["release.json"] = hex("a"))],
    ["self-hashed package metadata", (m: SampleManifest) => (m.files["package.json"] = hex("a"))],
    ["case-colliding files", (m: SampleManifest) => (m.files["DIST/CLI.MJS"] = hex("a"))],
    [
      "too many files",
      (m: SampleManifest) =>
        (m.files = Object.fromEntries(
          Array.from({ length: 4097 }, (_, i) => [`dist/a${i}.js`, hex("a")]),
        )),
    ],
  ])("refuses %s", (_label, mutate) => {
    const m = sampleManifest();
    mutate(m);
    expect(ReleaseManifest.safeParse(m).success).toBe(false);
  });

  it.each(["../etc/passwd", "/abs", "a//b", "a/./b", "a/../b", "a\\b", "", ".hidden/x", "dist/"])(
    "refuses the package path %j",
    (p) => {
      expect(PackagePath.safeParse(p).success).toBe(false);
    },
  );

  it.each([
    "dist/cli.mjs",
    "web/assets/index-Ab1.js",
    "web/vendor/selkies/LICENSE",
    "THIRD-PARTY.md",
  ])("accepts the package path %j", (p) => {
    expect(PackagePath.safeParse(p).success).toBe(true);
  });
});
