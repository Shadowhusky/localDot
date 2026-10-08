import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hasInstallState, initializeInstallHome } from "./initialize-home.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-initialize-")));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
it("discovers without writes, then creates durable private descendants and reuses them", async () => {
  const root = await fixture(),
    home = join(root, "nested/home");
  expect(await hasInstallState(home)).toBe(false);
  expect(await readdir(root)).toEqual([]);
  const prepared = await initializeInstallHome(home, signal());
  expect(prepared).toEqual({ home, state: join(home, "install") });
  for (const path of [join(root, "nested"), home, prepared.state])
    expect((await stat(path)).mode & 0o7777).toBe(0o700);
  const inode = (await stat(home)).ino;
  await writeFile(join(home, "keep"), "user data", { mode: 0o600 });
  expect(await hasInstallState(home)).toBe(true);
  await initializeInstallHome(home, signal());
  expect((await stat(home)).ino).toBe(inode);
  expect(await readFile(join(home, "keep"), "utf8")).toBe("user data");
});
it("allows concurrent directory initialization without replacing either tree", async () => {
  const root = await fixture(),
    home = join(root, "home");
  const results = await Promise.all([
    initializeInstallHome(home, signal()),
    initializeInstallHome(home, signal()),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await readdir(home)).toEqual(["install"]);
});
it.each(["home-link", "state-link", "ancestor-link", "file", "permissions", "parent-writable"])(
  "rejects unsafe %s without repairing or deleting it",
  async (kind) => {
    const root = await fixture(),
      home = join(root, "home"),
      target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    if (kind === "home-link") await symlink(target, home);
    if (kind === "file") await writeFile(home, "keep");
    if (kind === "permissions") await mkdir(home, { mode: 0o755 });
    if (kind === "state-link") {
      await mkdir(home, { mode: 0o700 });
      await symlink(target, join(home, "install"));
    }
    if (kind === "ancestor-link") {
      await symlink(target, home);
      await expect(initializeInstallHome(join(home, "child"), signal())).rejects.toThrow();
    } else {
      if (kind === "parent-writable") await chmod(root, 0o770);
      await expect(initializeInstallHome(home, signal())).rejects.toThrow();
      if (kind !== "parent-writable") await expect(hasInstallState(home)).rejects.toThrow();
    }
    expect(await readdir(target)).toEqual([]);
    if (kind === "permissions") expect((await stat(home)).mode & 0o777).toBe(0o755);
    if (kind === "file") expect(await readFile(home, "utf8")).toBe("keep");
  },
);
it.each(["relative", "/", "/private/tmp/../tmp/home", "/private/tmp/line\nbreak"])(
  "rejects invalid home %j",
  async (home) => {
    await expect(initializeInstallHome(home, signal())).rejects.toThrow();
    await expect(hasInstallState(home)).rejects.toThrow();
  },
);
it("does not create directories after cancellation", async () => {
  const root = await fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(initializeInstallHome(join(root, "home"), controller.signal)).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});
