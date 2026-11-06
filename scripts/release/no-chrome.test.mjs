import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forbiddenPath, scanSavedImage, unprovenImages } from "./no-chrome.mjs";

const folders = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function saved(layers, compress = []) {
  const directory = await mkdtemp(join(tmpdir(), "no-chrome-"));
  folders.push(directory);
  const names = [];
  for (const [index, files] of layers.entries()) {
    const root = join(directory, `root-${index}`);
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "x");
    }
    const name = `layer-${index}.tar`;
    execFileSync("tar", [
      compress.includes(index) ? "-czf" : "-cf",
      join(directory, name),
      "-C",
      root,
      ".",
    ]);
    names.push(name);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify([{ Layers: names }]));
  return directory;
}

// What `docker image save` writes for that image.
function save(directory, ...members) {
  return spawn("tar", ["-cf", "-", "-C", directory, ...members], {
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout;
}
const layers = (count) => Array.from({ length: count }, (_, index) => `layer-${index}.tar`);

describe("the check that released images contain no Chrome", () => {
  it("knows Chrome's files from Chromium's", () => {
    for (const path of [
      "opt/google/chrome/chrome",
      "./opt/google/",
      "usr/bin/google-chrome-stable",
      "etc/apt/sources.list.d/google-chrome.sources",
      "usr/share/keyrings/google-chrome.gpg",
      "var/lib/dpkg/info/google-chrome-stable.list",
      "usr/share/doc/google-chrome-stable/copyright",
      "tmp/google-chrome-stable_157.0.8103.38-1_arm64.deb",
      "usr/lib/chromium/WidevineCdm/manifest.json",
      "somewhere/libwidevinecdm.so",
    ])
      expect(forbiddenPath(path), path).toBe(true);
    for (const path of [
      "usr/lib/chromium/chromium",
      "usr/bin/chromium",
      "opt/localdot/install-chrome.sh",
      "opt/.wh.google",
      "usr/share/doc/chromium/copyright",
    ])
      expect(forbiddenPath(path), path).toBe(false);
  });

  it("passes an image without Chrome, compressed or not", async () => {
    const result = await scanSavedImage(
      save(
        await saved(
          [["usr/lib/chromium/chromium"], ["opt/localdot/install-chrome.sh", "etc/hostname"]],
          [1],
        ),
        ...layers(2),
        "manifest.json",
      ),
    );
    expect(result.found).toEqual([]);
    expect(result.layers).toBe(2);
    expect(result.entries).toBeGreaterThan(2);
  });

  it("finds Chrome in any layer, even one a later layer deletes", async () => {
    const result = await scanSavedImage(
      save(
        await saved([["opt/google/chrome/chrome"], ["opt/.wh.google"]], [0]),
        "manifest.json",
        ...layers(2),
      ),
    );
    expect(result.found).toEqual(expect.arrayContaining(["./opt/google/chrome/chrome"]));
  });

  it("refuses what it can't read rather than calling it clean", async () => {
    const directory = await saved([["a"]]);
    await writeFile(join(directory, "layer-0.tar"), "not a layer of any kind".repeat(100));
    await expect(scanSavedImage(save(directory, "layer-0.tar", "manifest.json"))).rejects.toThrow(
      /format/,
    );
    await expect(scanSavedImage(save(directory, "manifest.json"))).rejects.toThrow(/format/);
    await writeFile(join(directory, "manifest.json"), "[]");
    await expect(scanSavedImage(save(directory, "manifest.json"))).rejects.toThrow(/no layers/);
  });

  it("holds a release back unless every pinned image has a clean scan", () => {
    const a = "ghcr.io/o/localdot-browser@sha256:a";
    const b = "ghcr.io/o/localdot-gate@sha256:b";
    const pins = { arm64: { browser: a }, x64: { gate: b } };
    const clean = { clean: true, layers: 3, entries: 10 };
    expect(unprovenImages(pins, { v: 1, images: { [a]: clean, [b]: clean } })).toEqual([]);
    expect(unprovenImages(pins, { v: 1, images: { [a]: clean } })).toEqual([b]);
    expect(
      unprovenImages(pins, { v: 1, images: { [a]: clean, [b]: { ...clean, clean: false } } }),
    ).toEqual([b]);
    expect(
      unprovenImages(pins, { v: 1, images: { [a]: clean, [b]: { ...clean, layers: 0 } } }),
    ).toEqual([b]);
    expect(unprovenImages(pins, undefined)).toEqual([a, b]);
  });
});
