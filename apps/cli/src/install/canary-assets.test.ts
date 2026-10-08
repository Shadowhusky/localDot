import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { readCanaryAssets } from "./canary-assets.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canary-assets-")));
  roots.push(root);
  for (const directory of [root, join(root, "app"), join(root, "app/dist")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const scanner = await readFile(
      fileURLToPath(new URL("../../../daemon/src/keyd/testing/canary-scan.py", import.meta.url)),
    ),
    worker = await readFile(fileURLToPath(new URL("./canary-worker.py", import.meta.url))),
    manifest = ReleaseManifest.parse(sampleManifest()),
    signal = new AbortController();
  for (const [name, bytes] of [
    ["scan", scanner],
    ["worker", worker],
  ] as const) {
    await writeFile(join(root, `app/dist/canary-${name}.py`), bytes, { mode: 0o600 });
    manifest.files[`dist/canary-${name}.py`] = createHash("sha256").update(bytes).digest("hex");
  }
  return {
    root,
    manifest,
    signal,
    scanner,
    worker,
    read: () => readCanaryAssets(root, manifest, signal.signal),
  };
}

it("reads the exact authenticated installed programs without executing them", async () => {
  const f = await fixture();
  expect(await f.read()).toEqual({ scanner: f.scanner, worker: f.worker });
});
it.each(["scan", "worker"])("refuses changed, absent or unlisted %s bytes", async (name) => {
  const f = await fixture(),
    path = join(f.root, `app/dist/canary-${name}.py`);
  await writeFile(path, "changed private fixture");
  await expect(f.read()).rejects.toThrow("programs failed verification");
  await rm(path);
  await expect(f.read()).rejects.toThrow("programs failed verification");
  delete f.manifest.files[`dist/canary-${name}.py`];
  await expect(f.read()).rejects.toThrow("programs failed verification");
});
it.each(["link", "hardlink", "mode", "parent-link", "parent-mode"])(
  "refuses unsafe %s assets",
  async (kind) => {
    const f = await fixture(),
      path = join(f.root, "app/dist/canary-worker.py");
    if (kind === "link" || kind === "hardlink") {
      await rm(path);
      const target = join(f.root, "other.py");
      await writeFile(target, f.worker, { mode: 0o600 });
      await (kind === "link" ? symlink(target, path) : link(target, path));
    } else if (kind === "mode") await chmod(path, 0o644);
    else if (kind === "parent-mode") await chmod(join(f.root, "app/dist"), 0o755);
    else {
      await rm(join(f.root, "app/dist"), { recursive: true });
      await symlink(f.root, join(f.root, "app/dist"));
    }
    await expect(f.read()).rejects.toThrow("programs failed verification");
  },
);
it.each([
  Buffer.alloc(0),
  Buffer.from([0xff]),
  Buffer.from("x\0y"),
  Buffer.alloc(128 * 1024 + 1, 120),
])("refuses invalid or oversized script bytes even with a matching hash", async (bytes) => {
  const f = await fixture();
  await writeFile(join(f.root, "app/dist/canary-worker.py"), bytes);
  f.manifest.files["dist/canary-worker.py"] = createHash("sha256").update(bytes).digest("hex");
  await expect(f.read()).rejects.toThrow("programs failed verification");
});
it("refuses cancelled reads without exposing caller details", async () => {
  const f = await fixture();
  f.signal.abort(new Error("private fixture"));
  await expect(f.read()).rejects.toThrow("The installed diagnostic programs failed verification.");
});
