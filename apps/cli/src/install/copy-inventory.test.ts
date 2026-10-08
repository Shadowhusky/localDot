import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyInventory } from "./copy-inventory.ts";

const roots: string[] = [],
  bytes = Buffer.from("verified content");
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-copy-inventory-")));
  roots.push(root);
  const source = join(root, "source"),
    destination = join(root, "destination");
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, "file"), bytes, { mode: 0o600 });
  return {
    root,
    source,
    destination,
    files: {
      file: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        mode: 0o600,
      },
    },
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("copies only the authenticated inventory with exact bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "unrelated"), "not copied");
  await copyInventory(f.source, f.destination, f.files, signal());
  expect(await readdir(f.destination)).toEqual(["file"]);
  expect(await readFile(join(f.destination, "file"))).toEqual(bytes);
});
it.each(["hash", "size", "mode", "symlink", "hardlink", "parent-link"])(
  "rejects a changed source %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "hash") await writeFile(join(f.source, "file"), Buffer.alloc(bytes.length));
    if (kind === "size") await writeFile(join(f.source, "file"), "different length");
    if (kind === "mode") await chmod(join(f.source, "file"), 0o666);
    if (kind === "symlink") {
      await rm(join(f.source, "file"));
      await writeFile(join(f.root, "outside"), bytes);
      await symlink(join(f.root, "outside"), join(f.source, "file"));
    }
    if (kind === "hardlink") await link(join(f.source, "file"), join(f.root, "alias"));
    if (kind === "parent-link") {
      await symlink(f.source, join(f.root, "alias"));
      f.source = join(f.root, "alias");
    }
    await expect(copyInventory(f.source, f.destination, f.files, signal())).rejects.toThrow();
  },
);
it.each(["../escape", "/absolute", "a//b", "a/../b"])(
  "rejects unsafe declared path %s before creating output",
  async (path) => {
    const f = await fixture();
    await expect(
      copyInventory(f.source, f.destination, { [path]: f.files.file }, signal()),
    ).rejects.toThrow();
    expect(await readdir(f.root)).toEqual(["source"]);
  },
);
it("never overwrites an existing destination", async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await writeFile(join(f.destination, "keep"), "preserved");
  await expect(copyInventory(f.source, f.destination, f.files, signal())).rejects.toThrow();
  expect(await readFile(join(f.destination, "keep"), "utf8")).toBe("preserved");
});
it("snapshots metadata before asynchronous checks", async () => {
  const f = await fixture(),
    pending = copyInventory(f.source, f.destination, f.files, signal());
  f.files.file.sha256 = "0".repeat(64);
  await pending;
  expect(await readFile(join(f.destination, "file"))).toEqual(bytes);
});
it("preserves caller cancellation", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("stop");
  controller.abort(reason);
  await expect(copyInventory(f.source, f.destination, f.files, controller.signal)).rejects.toBe(
    reason,
  );
  expect(await readdir(f.root)).toEqual(["source"]);
});
