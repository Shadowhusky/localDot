import {
  chmod,
  link,
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
import { afterEach, expect, it } from "vitest";
import { createAssemblyScratch, recoverAssemblyScratch } from "./assembly-scratch.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-assembly-recovery-")));
  roots.push(root);
  const parent = join(root, "state");
  await mkdir(parent, { mode: 0o700 });
  let active = true;
  // Filesystem unit seam only. A separate parent-crash case proves the real kernel lease.
  const lifetime = {
    directory: parent,
    inheritDescriptor() {
      if (!active) throw new Error("expired");
      return 42;
    },
  };
  const scratch = await createAssemblyScratch(parent, signal(), lifetime);
  await mkdir(join(scratch.directory, "app"), { mode: 0o700 });
  await writeFile(join(scratch.directory, "app/partial"), "unfinished", { mode: 0o600 });
  const record = join(parent, "assembly-scratch.json");
  return {
    root,
    parent,
    lifetime,
    scratch,
    record,
    expire() {
      active = false;
    },
  };
}
it("records ownership before returning and clears it only after owned removal", async () => {
  const f = await fixture(),
    record = JSON.parse(await readFile(f.record, "utf8"));
  const directory = await lstat(f.scratch.directory, { bigint: true });
  expect(record.directory).toEqual({
    dev: String(directory.dev),
    ino: String(directory.ino),
    birthtimeNs: String(directory.birthtimeNs),
  });
  expect((await lstat(f.record)).mode & 0o7777).toBe(0o600);
  await f.scratch.assertOwned();
  await Promise.all([f.scratch.dispose(), f.scratch.dispose()]);
  expect(await readdir(f.parent)).toEqual(["assembly-scratch.json"]);
  expect(await readFile(f.record, "utf8")).toBe("null\n");
});
it.each(["partial", "absent"])(
  "repeats %s interrupted cleanup without touching unrelated trees",
  async (kind) => {
    const f = await fixture();
    for (const name of [
      "installed-release",
      "user-home",
      `.assembly-${"f".repeat(32)}`,
      ".bootstrap-other",
    ]) {
      await mkdir(join(f.parent, name), { mode: 0o700 });
      await writeFile(join(f.parent, name, "keep"), name);
    }
    await rm(kind === "absent" ? f.scratch.directory : join(f.scratch.directory, "app"), {
      recursive: true,
    });
    await recoverAssemblyScratch(f.parent, signal(), f.lifetime);
    await recoverAssemblyScratch(f.parent, signal(), f.lifetime);
    expect(await readFile(join(f.parent, "user-home/keep"), "utf8")).toBe("user-home");
    expect((await readdir(f.parent)).sort()).toEqual(
      [
        `.assembly-${"f".repeat(32)}`,
        ".bootstrap-other",
        "assembly-scratch.json",
        "installed-release",
        "user-home",
      ].sort(),
    );
    const next = await createAssemblyScratch(f.parent, signal(), f.lifetime);
    await next.dispose();
  },
);
it.each(["path", "directory", "birthtime", "parent", "version", "extra"])(
  "refuses corrupt %s ownership before deleting",
  async (kind) => {
    const f = await fixture(),
      record = JSON.parse(await readFile(f.record, "utf8"));
    if (kind === "path") record.name = "../user-home";
    if (kind === "directory") record.directory.ino = "0";
    if (kind === "birthtime")
      record.directory.birthtimeNs = String(BigInt(record.directory.birthtimeNs) + 1n);
    if (kind === "parent") record.parent.ino = "0";
    if (kind === "version") record.v = 2;
    if (kind === "extra") record.extra = true;
    await writeFile(f.record, JSON.stringify(record));
    await expect(recoverAssemblyScratch(f.parent, signal(), f.lifetime)).rejects.toThrow();
    expect(await readFile(join(f.scratch.directory, "app/partial"), "utf8")).toBe("unfinished");
  },
);
it.each(["replacement", "symlink", "mode", "file"])(
  "refuses a %s at the recorded directory path",
  async (kind) => {
    const f = await fixture(),
      retained = join(f.root, "retained"),
      before = await readFile(f.record);
    if (kind === "mode") await chmod(f.scratch.directory, 0o755);
    else {
      await rename(f.scratch.directory, retained);
      if (kind === "replacement") await mkdir(f.scratch.directory, { mode: 0o700 });
      if (kind === "symlink") await symlink(retained, f.scratch.directory);
      if (kind === "file") await writeFile(f.scratch.directory, "replacement");
    }
    await expect(recoverAssemblyScratch(f.parent, signal(), f.lifetime)).rejects.toThrow();
    expect(await readFile(f.record)).toEqual(before);
    expect(
      await readFile(join(kind === "mode" ? f.scratch.directory : retained, "app/partial"), "utf8"),
    ).toBe("unfinished");
  },
);
it.each(["symlink", "hardlink", "oversized", "mode"])(
  "refuses an unsafe %s journal",
  async (kind) => {
    const f = await fixture(),
      retained = join(f.root, "record");
    if (kind === "symlink" || kind === "hardlink") {
      await rename(f.record, retained);
      await (kind === "symlink" ? symlink : link)(retained, f.record);
    }
    if (kind === "oversized") await writeFile(f.record, "x".repeat(17000));
    if (kind === "mode") await chmod(f.record, 0o644);
    await expect(recoverAssemblyScratch(f.parent, signal(), f.lifetime)).rejects.toThrow();
    expect(await readFile(join(f.scratch.directory, "app/partial"), "utf8")).toBe("unfinished");
  },
);
it("does not follow nested links or clear a newer record using an old disposal capability", async () => {
  const f = await fixture(),
    outside = join(f.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "keep"), "safe");
  await symlink(outside, join(f.scratch.directory, "linked"));
  await recoverAssemblyScratch(f.parent, signal(), f.lifetime);
  const next = await createAssemblyScratch(f.parent, signal(), f.lifetime);
  await expect(f.scratch.dispose()).rejects.toThrow();
  await next.assertOwned();
  await next.dispose();
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("safe");
});
it("requires a live matching scope and refuses cancellation without changing pending work", async () => {
  const f = await fixture(),
    before = await readFile(f.record);
  const wrong = { ...f.lifetime, directory: f.root };
  await expect(recoverAssemblyScratch(f.parent, signal(), wrong)).rejects.toThrow();
  await expect(createAssemblyScratch(f.parent, signal(), wrong)).rejects.toThrow();
  await expect(createAssemblyScratch(f.parent, signal(), f.lifetime)).rejects.toThrow();
  await expect(
    recoverAssemblyScratch(f.parent, AbortSignal.abort(new Error("stop")), f.lifetime),
  ).rejects.toThrow("stop");
  f.expire();
  await expect(recoverAssemblyScratch(f.parent, signal(), f.lifetime)).rejects.toThrow("expired");
  await expect(createAssemblyScratch(f.parent, signal(), f.lifetime)).rejects.toThrow("expired");
  expect(() => f.scratch.dispose()).toThrow("expired");
  expect(await readFile(f.record)).toEqual(before);
});
it("refuses a replaced parent even when the old record and directory move with it", async () => {
  const f = await fixture(),
    retained = join(f.root, "old-state");
  await rename(f.parent, retained);
  await mkdir(f.parent, { mode: 0o700 });
  for (const name of await readdir(retained))
    await rename(join(retained, name), join(f.parent, name));
  await expect(recoverAssemblyScratch(f.parent, signal(), f.lifetime)).rejects.toThrow();
  expect(await readFile(join(f.scratch.directory, "app/partial"), "utf8")).toBe("unfinished");
});
