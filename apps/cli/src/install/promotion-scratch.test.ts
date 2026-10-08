import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createPromotionScratch, recoverPromotionScratch } from "./promotion-scratch.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-copy-recovery-")));
  roots.push(root);
  const parent = join(root, "releases");
  await mkdir(parent, { mode: 0o700 });
  const record = join(parent, "promotion-scratch.json");
  return { root, parent, record };
}
async function pending() {
  const f = await fixture();
  const scratch = await createPromotionScratch(f.parent, signal());
  await mkdir(join(scratch.directory, "app"), { mode: 0o700 });
  await writeFile(join(scratch.directory, "app/partial"), "unfinished release", { mode: 0o600 });
  return { ...f, scratch };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("persists exact parent and directory identities before returning a writable copy", async () => {
  const f = await pending();
  const parent = await lstat(f.parent, { bigint: true });
  const directory = await lstat(f.scratch.directory, { bigint: true });
  const record = JSON.parse(await readFile(f.record, "utf8"));
  expect(record).toEqual({
    v: 1,
    parent: { dev: String(parent.dev), ino: String(parent.ino) },
    name: f.scratch.directory.slice(f.parent.length + 1),
    directory: { dev: String(directory.dev), ino: String(directory.ino) },
  });
  expect((await lstat(f.record)).mode & 0o7777).toBe(0o600);
  await f.scratch.assertOwned();
  await f.scratch.dispose();
  await f.scratch.dispose();
  expect(await readdir(f.parent)).toEqual(["promotion-scratch.json"]);
  expect(await readFile(f.record, "utf8")).toBe("null\n");
});

it("recovers a copy abandoned by a separate process before creating the next copy", async () => {
  const f = await fixture();
  const module = new URL("./promotion-scratch.ts", import.meta.url).href;
  // The child publishes ownership and writes a partial copy, then exits without disposal.
  // Recovery has no surviving in-memory capability or PID to rely on.
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createPromotionScratch } from ${JSON.stringify(module)};
       import { writeFile } from 'node:fs/promises';
       const scratch = await createPromotionScratch(process.argv[1], new AbortController().signal);
       await writeFile(scratch.directory + '/partial', 'incomplete', { mode: 0o600 });`,
      f.parent,
    ],
    { timeout: 10_000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } },
  );
  const old = JSON.parse(await readFile(f.record, "utf8"));
  expect(await readFile(join(f.parent, old.name, "partial"), "utf8")).toBe("incomplete");
  await recoverPromotionScratch(f.parent, signal());
  await expect(lstat(join(f.parent, old.name))).rejects.toMatchObject({ code: "ENOENT" });
  const next = await createPromotionScratch(f.parent, signal());
  expect(next.directory).not.toBe(join(f.parent, old.name));
  await next.dispose();
});

it("retains the promoted inode after interruption between rename and journal retirement", async () => {
  const f = await pending();
  const destination = join(f.parent, "published-release");
  const before = await lstat(f.scratch.directory);
  await rename(f.scratch.directory, destination);
  await recoverPromotionScratch(f.parent, signal());
  expect((await lstat(destination)).ino).toBe(before.ino);
  expect(await readFile(join(destination, "app/partial"), "utf8")).toBe("unfinished release");
  expect(await readFile(f.record, "utf8")).toBe("null\n");
});

it.each(["partial", "absent"])("finishes an interrupted %s removal", async (kind) => {
  const f = await pending();
  await rm(kind === "absent" ? f.scratch.directory : join(f.scratch.directory, "app"), {
    recursive: true,
  });
  await recoverPromotionScratch(f.parent, signal());
  await recoverPromotionScratch(f.parent, signal());
  expect(await readdir(f.parent)).toEqual(["promotion-scratch.json"]);
  expect(await readFile(f.record, "utf8")).toBe("null\n");
});

it("never sweeps unrecorded directories, including old names and empty allocation leftovers", async () => {
  const f = await pending();
  const names = [`.promote-${"f".repeat(32)}`, ".promote-old", "retained-release"];
  for (const name of names) await mkdir(join(f.parent, name), { mode: 0o700 });
  await writeFile(join(f.parent, ".promote-old/keep"), "user data");
  await recoverPromotionScratch(f.parent, signal());
  expect((await readdir(f.parent)).sort()).toEqual([...names, "promotion-scratch.json"].sort());
  expect(await readFile(join(f.parent, ".promote-old/keep"), "utf8")).toBe("user data");
});

it.each(["replacement", "symlink", "mode", "file"])(
  "preserves an unsafe %s at the recorded copy pathname",
  async (kind) => {
    const f = await pending();
    const retained = join(f.root, "retained");
    if (kind === "mode") await chmod(f.scratch.directory, 0o755);
    else {
      await rename(f.scratch.directory, retained);
      if (kind === "replacement") {
        await mkdir(f.scratch.directory, { mode: 0o700 });
        await writeFile(join(f.scratch.directory, "keep"), "replacement");
      }
      if (kind === "symlink") await symlink(retained, f.scratch.directory);
      if (kind === "file") await writeFile(f.scratch.directory, "replacement");
    }
    const record = await readFile(f.record);
    await expect(recoverPromotionScratch(f.parent, signal())).rejects.toThrow();
    expect(await readFile(f.record)).toEqual(record);
    expect(
      await readFile(join(kind === "mode" ? f.scratch.directory : retained, "app/partial"), "utf8"),
    ).toBe("unfinished release");
    if (kind === "replacement")
      expect(await readFile(join(f.scratch.directory, "keep"), "utf8")).toBe("replacement");
    if (kind === "file") expect(await readFile(f.scratch.directory, "utf8")).toBe("replacement");
    if (kind === "symlink") expect((await lstat(f.scratch.directory)).isSymbolicLink()).toBe(true);
  },
);

it("refuses a replacement parent even when the original journal and scratch moved into it", async () => {
  const f = await pending();
  const retained = join(f.root, "original-parent");
  await rename(f.parent, retained);
  await mkdir(f.parent, { mode: 0o700 });
  for (const name of await readdir(retained))
    await rename(join(retained, name), join(f.parent, name));
  await expect(recoverPromotionScratch(f.parent, signal())).rejects.toThrow("ownership changed");
  expect(await readFile(join(f.scratch.directory, "app/partial"), "utf8")).toBe(
    "unfinished release",
  );
});

it.each(["path", "ino", "parent", "version", "extra"])(
  "does not delete after %s record corruption",
  async (kind) => {
    const f = await pending();
    const record = JSON.parse(await readFile(f.record, "utf8"));
    if (kind === "path") record.name = "../outside";
    if (kind === "ino") record.directory.ino = "0";
    if (kind === "parent") record.parent.ino = "0";
    if (kind === "version") record.v = 2;
    if (kind === "extra") record.extra = true;
    await writeFile(f.record, JSON.stringify(record));
    await expect(recoverPromotionScratch(f.parent, signal())).rejects.toThrow();
    expect(await readFile(join(f.scratch.directory, "app/partial"), "utf8")).toBe(
      "unfinished release",
    );
  },
);

it("does not follow a linked journal or overwrite a pending record", async () => {
  const f = await pending();
  await expect(createPromotionScratch(f.parent, signal())).rejects.toThrow();
  const original = await readdir(f.parent);
  await rename(f.record, join(f.root, "record"));
  await symlink(join(f.root, "record"), f.record);
  await expect(recoverPromotionScratch(f.parent, signal())).rejects.toThrow();
  expect(await readdir(f.parent)).toEqual(original);
  expect(await readFile(join(f.scratch.directory, "app/partial"), "utf8")).toBe(
    "unfinished release",
  );
});

it("removes a nested link without traversing or modifying its external target", async () => {
  const f = await pending();
  const outside = join(f.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "keep"), "retained");
  await symlink(outside, join(f.scratch.directory, "linked"));
  await recoverPromotionScratch(f.parent, signal());
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("retained");
});

it("rejects cancellation before recovery or allocation without changing the journal", async () => {
  const f = await pending();
  const before = await readFile(f.record);
  const aborted = AbortSignal.abort(new Error("cancelled"));
  await expect(recoverPromotionScratch(f.parent, aborted)).rejects.toThrow("cancelled");
  await expect(createPromotionScratch(f.parent, aborted)).rejects.toThrow("cancelled");
  expect(await readFile(f.record)).toEqual(before);
  expect(await readFile(join(f.scratch.directory, "app/partial"), "utf8")).toBe(
    "unfinished release",
  );
});

it("does not let an old disposal capability clear a newer copy's journal", async () => {
  const f = await pending();
  await recoverPromotionScratch(f.parent, signal());
  const next = await createPromotionScratch(f.parent, signal());
  const before = await readFile(f.record);
  await expect(f.scratch.dispose()).rejects.toThrow();
  expect(await readFile(f.record)).toEqual(before);
  await next.assertOwned();
  await next.dispose();
});
