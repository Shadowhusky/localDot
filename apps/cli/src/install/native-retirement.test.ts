import * as fs from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertNativeRetired } from "./native-retirement.ts";

const owned: string[] = [];
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(create = true) {
  const home = await realpath(await mkdtemp("/private/tmp/localdot-native-retired-"));
  owned.push(home);
  await chmod(home, 0o700);
  const root = join(home, "codex"),
    controller = new AbortController();
  if (create) {
    await mkdir(root, { mode: 0o700 });
    for (const name of ["profiles", "work", "run", "home", "bin"])
      await mkdir(join(root, name), { mode: 0o700 });
    await writeFile(join(root, "home/auth.json"), "private inert fixture", { mode: 0o600 });
  }
  return { home, root, controller, check: () => assertNativeRetired(home, controller.signal) };
}
it("does not create a missing managed harness namespace", async () => {
  const f = await fixture(false);
  await f.check();
  expect(await readdir(f.home)).toEqual([]);
});
it("accepts empty activity roots without reading or changing account credentials", async () => {
  const f = await fixture();
  await chmod(join(f.root, "home"), 0o000);
  await f.check();
  expect((await lstat(join(f.root, "home"))).mode & 0o777).toBe(0);
  await chmod(join(f.root, "home"), 0o700);
  expect(await readFile(join(f.root, "home/auth.json"), "utf8")).toBe("private inert fixture");
});
it.each(["profiles", "work", "run"])("retains and refuses %s leftovers", async (area) => {
  const f = await fixture(),
    path = join(f.root, area, ".owned-fixture");
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "retained"), "keep");
  await expect(f.check()).rejects.toThrow("Native task retirement could not be confirmed.");
  expect(await readFile(join(path, "retained"), "utf8")).toBe("keep");
});
it.each(["missing", "symlink", "file", "public", "special-mode", "root-link", "home-mode"])(
  "refuses %s activity authority without repairs",
  async (fault) => {
    const f = await fixture(),
      path = join(f.root, "profiles");
    if (["missing", "symlink", "file"].includes(fault)) await rm(path, { recursive: true });
    if (fault === "symlink") await symlink(join(f.root, "work"), path);
    if (fault === "file") await writeFile(path, "not a directory", { mode: 0o700 });
    if (fault === "public") await chmod(path, 0o755);
    if (fault === "special-mode") await chmod(path, 0o1700);
    if (fault === "root-link") {
      await rm(f.root, { recursive: true });
      await symlink(f.home, f.root);
    }
    if (fault === "home-mode") await chmod(f.home, 0o755);
    await expect(f.check()).rejects.toThrow("Native task retirement could not be confirmed.");
    if (fault === "missing") await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    if (fault === "public") expect((await lstat(path)).mode & 0o777).toBe(0o755);
  },
);
it("refuses a directory replaced after its empty observation", async () => {
  const f = await fixture(),
    original = fs.opendir;
  let changed = false;
  vi.spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
    const dir = await original(...args);
    if (!changed) {
      changed = true;
      await fs.rename(join(f.root, "profiles"), join(f.root, "previous"));
      await mkdir(join(f.root, "profiles"), { mode: 0o700 });
    }
    return dir;
  });
  await expect(f.check()).rejects.toThrow("Native task retirement could not be confirmed.");
});
it("observes cancellation during inventory and closes the directory", async () => {
  const f = await fixture(),
    original = fs.opendir;
  const close = vi.fn();
  vi.spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
    const dir = await original(...args),
      originalClose = dir.close.bind(dir);
    dir.close = async () => {
      close();
      await originalClose();
    };
    f.controller.abort();
    return dir;
  });
  await expect(f.check()).rejects.toThrow("Native task retirement could not be confirmed.");
  expect(close).toHaveBeenCalledOnce();
});
it("refuses an already cancelled check", async () => {
  const f = await fixture();
  f.controller.abort();
  await expect(f.check()).rejects.toThrow("Native task retirement could not be confirmed.");
});
