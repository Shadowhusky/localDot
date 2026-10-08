import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { verifyStagedRelease } from "./staged-release.ts";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  // realpath canonicalization on macOS is deliberately part of the installation contract.
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-stage-")));
  roots.push(root);
  const manifest = sampleManifest();
  const payload = {
    "dist/cli.mjs": 'throw new Error("verification must never execute payload");\n',
    "web/index.html": "<!doctype html><title>localDot</title>",
    "npm-shrinkwrap.json": '{"lockfileVersion":3}',
  };
  manifest.files = Object.fromEntries(
    Object.entries(payload).map(([path, body]) => [path, hash(body)]),
  );
  for (const [path, body] of Object.entries(payload)) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), body, { mode: 0o600 });
  }
  const pkg: Record<string, unknown> = {
    name: "localdot",
    version: manifest.version,
    type: "module",
  };
  async function seal() {
    const packageJson = JSON.stringify(pkg),
      releaseJson = JSON.stringify(manifest);
    await writeFile(join(root, "package.json"), packageJson, { mode: 0o600 });
    await writeFile(join(root, "release.json"), releaseJson, { mode: 0o600 });
    return { packageJson: hash(packageJson), releaseJson: hash(releaseJson) };
  }
  return { root, manifest, pkg, seal, expected: await seal() };
}

describe("staged release inventory (not provenance authorization)", () => {
  it("verifies every byte without executing the payload or altering staged files", async () => {
    const f = await fixture();
    const before = await readFile(join(f.root, "dist/cli.mjs"));
    const result = await verifyStagedRelease(f.root, f.expected, signal());
    expect(result.files).toBe(5);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.manifest).toEqual(f.manifest);
    expect(result.metadataDigests).toEqual(f.expected);
    expect(await readFile(join(f.root, "dist/cli.mjs"))).toEqual(before);
    expect(result).not.toHaveProperty("trusted");
  });

  it.each(["package.json", "release.json", "dist/cli.mjs", "npm-shrinkwrap.json"])(
    "refuses altered %s, including unhashed manifest metadata",
    async (path) => {
      const f = await fixture();
      await writeFile(join(f.root, path), "{}");
      await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
    },
  );
  it("refuses missing and undeclared files even when their contents are harmless", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "unexpected.txt"), "extra");
    await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
    await rm(join(f.root, "unexpected.txt"));
    await rm(join(f.root, "web/index.html"));
    await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
  });
  it("refuses preinstalled dependency trees and empty foreign directories", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "node_modules"));
    await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
    await writeFile(join(f.root, "node_modules/extra.js"), "export default 1");
    await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
  });
  it.each(["file", "directory", "root", "hardlink"])("refuses a %s link", async (kind) => {
    const f = await fixture();
    let root = f.root;
    if (kind === "root") {
      const parent = await fixture();
      root = join(parent.root, "linked");
      await symlink(f.root, root);
    } else if (kind === "directory") {
      await symlink(join(f.root, "web"), join(f.root, "alias"));
    } else {
      await rm(join(f.root, "web/index.html"));
      await (kind === "hardlink" ? link : symlink)(
        join(f.root, "dist/cli.mjs"),
        join(f.root, "web/index.html"),
      );
    }
    await expect(verifyStagedRelease(root, f.expected, signal())).rejects.toThrow();
  });
  it.each(["root", "directory", "file", "special"])("refuses unsafe %s modes", async (kind) => {
    const f = await fixture();
    const path =
      kind === "root" ? f.root : join(f.root, kind === "directory" ? "web" : "dist/cli.mjs");
    // This host strips setuid/setgid on chmod. Sticky survives and exercises the special-bit guard.
    await chmod(path, kind === "special" ? 0o1755 : 0o777);
    await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
    await chmod(path, 0o700);
  });
  it("rejects case collisions on case-sensitive filesystems and mismatched spelling elsewhere", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "WEB"), "collision").catch(() => undefined);
    // A manifest cannot declare an alternate case of an existing path on either filesystem.
    f.manifest.files["DIST/CLI.mjs"] = "a".repeat(64);
    await expect(verifyStagedRelease(f.root, await f.seal(), signal())).rejects.toThrow();
  });
  it.each(["version", "name", "scripts", "manifest-path", "manifest-image"])(
    "rejects invalid %s even when metadata hashes match",
    async (kind) => {
      const f = await fixture();
      if (kind === "version") f.pkg.version = "99.0.0";
      if (kind === "name") f.pkg.name = "another-package";
      if (kind === "scripts") f.pkg.scripts = { postinstall: "arbitrary command" };
      if (kind === "manifest-path") f.manifest.files["../escape"] = "a".repeat(64);
      if (kind === "manifest-image") f.manifest.images.brain.digest = "latest";
      await expect(verifyStagedRelease(f.root, await f.seal(), signal())).rejects.toThrow();
    },
  );
  it("bounds individual file and metadata allocations", async () => {
    const f = await fixture();
    await truncate(join(f.root, "dist/cli.mjs"), 16 * 1024 * 1024 + 1);
    await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
    await truncate(join(f.root, "dist/cli.mjs"), 1);
    await truncate(join(f.root, "package.json"), 1024 * 1024 + 1);
    await expect(verifyStagedRelease(f.root, f.expected, signal())).rejects.toThrow();
  });
  it("rejects invalid expectations and noncanonical roots", async () => {
    const f = await fixture();
    for (const root of [".", "/", `${f.root}/../${f.root.split("/").at(-1)}`, `${f.root}/`])
      await expect(verifyStagedRelease(root, f.expected, signal())).rejects.toThrow();
    await expect(
      verifyStagedRelease(f.root, { ...f.expected, releaseJson: "not-a-digest" }, signal()),
    ).rejects.toThrow();
  });
  it("preserves pre-cancellation and never starts an inventory", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(
      verifyStagedRelease(
        "/does-not-exist",
        { packageJson: "", releaseJson: "" },
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });
});
