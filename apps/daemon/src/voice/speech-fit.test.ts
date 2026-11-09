import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain release script, which has no types.
import { catalogProblems } from "../../../../scripts/release/speech-assets.mjs";
import { catalogTarget, SPEECH_CATALOG } from "./speech-catalog.ts";
import { speechThreads, tierFit, tierSpeed } from "./speech-fit.ts";

const GB = 1024 ** 3;
const tiers = SPEECH_CATALOG.tiers;
const mac8 = { platform: "darwin", arch: "arm64", memoryBytes: 8 * GB, cpus: 8 };
const macBig = { platform: "darwin", arch: "arm64", memoryBytes: 32 * GB, cpus: 12 };
const oldIntel = {
  platform: "darwin",
  arch: "x64",
  memoryBytes: 8 * GB,
  cpus: 4,
};
const linuxBox = { platform: "linux", arch: "x64", memoryBytes: 16 * GB, cpus: 8 };
const tiny = { platform: "linux", arch: "x64", memoryBytes: 2 * GB, cpus: 2 };

describe("what suits this computer", () => {
  it("recommends Balanced to an 8 GB Mac, and warns about the heaviest", () => {
    const fit = tierFit(mac8, tiers);
    expect(fit.recommended).toBe("balanced");
    expect(fit.warnings.light).toBeUndefined();
    expect(fit.warnings.balanced).toBeUndefined();
    expect(fit.warnings.languages).toMatch(/8 GB/);
  });

  it("doesn't push the heaviest on a strong computer, since it isn't better for Chinese", () => {
    const fit = tierFit(macBig, tiers);
    expect(fit.recommended).toBe("balanced");
    expect(fit.warnings.languages).toBeUndefined();
  });

  it("recommends Light to an older Intel computer and says Balanced will be slower", () => {
    const fit = tierFit(oldIntel, tiers);
    expect(fit.recommended).toBe("light");
    expect(fit.warnings.balanced).toMatch(/slow/i);
    expect(fit.warnings.languages).toBeDefined();
  });

  it("gives a Linux computer with no GPU the same honest answer", () => {
    expect(tierFit(linuxBox, tiers).recommended).toBe("balanced");
    expect(tierFit(tiny, tiers).recommended).toBe("light");
    expect(tierFit(tiny, tiers).warnings.light).toMatch(/2 GB/);
  });

  it("always lets the person choose: every tier stays on offer", () => {
    for (const host of [mac8, macBig, oldIntel, linuxBox, tiny]) {
      const fit = tierFit(host, tiers);
      expect(tiers.some((tier) => tier.id === fit.recommended)).toBe(true);
    }
  });

  it("says how long a short message takes, in plain words", () => {
    const [light, balanced, languages] = tiers;
    if (!light || !balanced || !languages) throw new Error("three tiers");
    expect(tierSpeed(macBig, light)).toMatch(/second/);
    expect(tierSpeed(oldIntel, languages)).toMatch(/Tens of seconds/);
  });

  it("uses half the cores, at most four", () => {
    expect(speechThreads({ cpus: 2 })).toBe(1);
    expect(speechThreads({ cpus: 4 })).toBe(2);
    expect(speechThreads({ cpus: 8 })).toBe(4);
    expect(speechThreads({ cpus: 28 })).toBe(4);
  });
});

describe("the speech catalog", () => {
  it("is fully pinned: https, SHA-256 and sizes on every source and file", () => {
    expect(catalogProblems(SPEECH_CATALOG)).toEqual([]);
  });

  it("has a program for every system localDot runs on", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "x64"],
      ["linux", "arm64"],
    ] as const)
      expect(catalogTarget(SPEECH_CATALOG, { platform, arch })?.files).toHaveProperty(
        "bin/sherpa-onnx-offline",
      );
    expect(catalogTarget(SPEECH_CATALOG, { platform: "win32", arch: "x64" })).toBeUndefined();
  });

  it("never asks for an English-only default, and credits every model", () => {
    for (const tier of tiers) {
      expect(tier.languages === null || tier.languages.includes("zh")).toBe(true);
      expect(tier.credit).toMatch(/sherpa-onnx \(Apache-2\.0\)/);
    }
  });

  it("names only files it pins, in every flag", () => {
    for (const tier of tiers)
      for (const file of Object.values(tier.flags))
        expect(
          Object.keys(tier.files).some((path) => path === file || path.startsWith(`${file}/`)),
        ).toBe(true);
  });
});
