import { fstatSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withCanaryDirectoryLease } from "./canary-lease.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-canary-lease-")));
  roots.push(root);
  await chmod(root, 0o700);
  const directory = join(root, "operation");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory };
}
const signal = () => new AbortController().signal;

it("passes the same open directory descriptor through acquisition and work without adding files", async () => {
  const { directory } = await fixture();
  let descriptor = -1;
  const value = await withCanaryDirectoryLease(
    directory,
    signal(),
    async (fd, path, nonce) => {
      descriptor = fd;
      expect(fstatSync(fd).isDirectory()).toBe(true);
      expect(path).toBe(directory);
      expect(nonce).toMatch(/^[a-f0-9]{64}$/);
    },
    async (fd) => {
      expect(fd).toBe(descriptor);
      expect(await readdir(directory)).toEqual([]);
      return "done";
    },
  );
  expect(value).toBe("done");
  expect(() => fstatSync(descriptor)).toThrow();
});

it("retains the descriptor while cancelled work drains, then closes even after failure", async () => {
  const { directory } = await fixture(),
    controller = new AbortController();
  let descriptor = -1;
  await expect(
    withCanaryDirectoryLease(
      directory,
      controller.signal,
      async () => {},
      async (fd) => {
        descriptor = fd;
        controller.abort();
        await Promise.resolve();
        expect(fstatSync(fd).isDirectory()).toBe(true);
        throw new Error("drained failure");
      },
    ),
  ).rejects.toThrow("drained failure");
  expect(() => fstatSync(descriptor)).toThrow();
});

it.each(["busy", "cancelled", "replaced", "symlink", "mode"])(
  "refuses %s after acquisition without entering work",
  async (fault) => {
    const { root, directory } = await fixture(),
      controller = new AbortController(),
      work = vi.fn();
    let descriptor = -1;
    await expect(
      withCanaryDirectoryLease(
        directory,
        controller.signal,
        async (fd) => {
          descriptor = fd;
          if (fault === "busy") throw new Error("busy");
          if (fault === "cancelled") controller.abort();
          if (fault === "mode") await chmod(directory, 0o755);
          if (fault === "replaced" || fault === "symlink") {
            const moved = join(root, "original");
            await rename(directory, moved);
            if (fault === "replaced") await mkdir(directory, { mode: 0o700 });
            else await symlink(moved, directory);
          }
        },
        work,
      ),
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(() => fstatSync(descriptor)).toThrow();
  },
);

it.each(["relative", "root", "unclean", "symlink", "public", "file", "cancelled"])(
  "refuses %s before acquiring",
  async (fault) => {
    const f = await fixture(),
      controller = new AbortController(),
      acquire = vi.fn(),
      work = vi.fn();
    let directory = f.directory;
    if (fault === "relative") directory = "relative";
    if (fault === "root") directory = "/";
    if (fault === "unclean") directory += "/.";
    if (fault === "public") await chmod(directory, 0o755);
    if (fault === "file") {
      directory = join(f.root, "file");
      await writeFile(directory, "", { mode: 0o700 });
    }
    if (fault === "symlink") {
      directory = join(f.root, "link");
      await symlink(f.directory, directory);
    }
    if (fault === "cancelled") controller.abort();
    await expect(
      withCanaryDirectoryLease(directory, controller.signal, acquire, work),
    ).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  },
);

it("keeps existing artifacts intact when acquiring for recovery", async () => {
  const { directory } = await fixture();
  await writeFile(join(directory, "audit"), "retained", { mode: 0o600 });
  await withCanaryDirectoryLease(
    directory,
    signal(),
    async () => {},
    async () => {
      expect(await readdir(directory)).toEqual(["audit"]);
    },
  );
});
