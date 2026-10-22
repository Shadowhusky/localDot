import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sourceAppUpdater } from "./source-updater.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(platform: NodeJS.Platform = "linux") {
  const prefix = await realpath(await mkdtemp(join(tmpdir(), "dot-source-update-")));
  roots.push(prefix);
  const home = join(prefix, "home");
  await mkdir(home, { mode: 0o700 });
  const current = "a".repeat(40),
    newer = "b".repeat(40);
  await writeFile(
    join(prefix, "install.env"),
    `# Managed by localDot's install.sh\nLOCALDOT_HOME="${home}"\nLOCALDOT_COMMIT="${current}"\nLOCALDOT_REF="main"\nLOCALDOT_REPO="https://github.com/Shadowhusky/localdot.git"\n`,
    { mode: 0o600 },
  );
  const command = vi.fn(async (_command: string, args: string[]) => {
    const verb = args[2];
    const stdout =
      verb === "remote"
        ? "https://github.com/Shadowhusky/localdot.git"
        : verb === "ls-remote"
          ? `${newer}\trefs/heads/main`
          : verb === "rev-parse"
            ? args[3] === "HEAD"
              ? current
              : newer
            : verb === "ls-tree"
              ? `docs/releases/0.1.0-rc.19.md\ndocs/releases/README.md${args[4] === newer ? "\ndocs/releases/0.1.0-rc.20.md" : ""}`
              : verb === "cat-file"
                ? `## Fixes\n\n- Fixed in ${args[4]?.split(":")[1]}.\n`
                : "";
    return { stdout, stderr: "" };
  });
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  const settled = vi.fn();
  const deps = { exec: command, spawn, platform } as unknown as NonNullable<
    Parameters<typeof sourceAppUpdater>[4]
  >;
  return {
    prefix,
    home,
    current,
    newer,
    command,
    spawn,
    settled,
    deps,
    create: () => sourceAppUpdater(home, prefix, () => null, settled, deps),
  };
}
it("checks the configured branch and downloads objects without checking out or disturbing FETCH_HEAD", async () => {
  const f = await fixture(),
    updater = await f.create();
  await updater.check();
  expect(await updater.status()).toMatchObject({
    supported: true,
    installOnLaunchSupported: false,
    currentVersion: f.current,
    availableVersion: f.newer,
    phase: "ready",
  });
  expect(f.command.mock.calls.some((call) => call[1].includes("--no-write-fetch-head"))).toBe(true);
  expect(f.command.mock.calls.some((call) => call[1].includes("checkout"))).toBe(false);
  expect(f.spawn).not.toHaveBeenCalled();
  await updater.dismiss();
  expect(await (await f.create()).status()).toMatchObject({
    phase: "ready",
    dismissedVersion: f.newer,
  });
});
it.each(["linux", "darwin"] as const)(
  "dispatches an explicit %s update outside the daemon's lifetime",
  async (platform) => {
    const f = await fixture(platform),
      updater = await f.create();
    await updater.check();
    await updater.install();
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    const [command, args, options] = f.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; detached: boolean },
    ];
    expect(options.detached).toBe(true);
    expect(options.env.LOCALDOT_UPDATE_COMMIT).toBe(f.newer);
    if (platform === "linux") {
      expect(command).toBe("/usr/bin/systemd-run");
      expect(args).toContain("--wait");
    } else expect(command).toBe(join(f.prefix, "bin/localdot"));
  },
);
it("does not adopt a writable install record or an ordinary source checkout", async () => {
  const f = await fixture();
  await chmod(join(f.prefix, "install.env"), 0o666);
  expect((await (await f.create()).status()).supported).toBe(false);
  expect(
    (
      await (
        await sourceAppUpdater(
          f.home,
          undefined,
          () => null,
          () => {},
        )
      ).status()
    ).supported,
  ).toBe(false);
  expect(f.command).not.toHaveBeenCalled();
});
it("shows the release notes the fetched commit adds, never ones the installed commit has", async () => {
  const f = await fixture(),
    updater = await f.create();
  await updater.check();
  expect((await updater.status()).notes).toEqual([
    { version: "0.1.0-rc.20", markdown: "## Fixes\n\n- Fixed in docs/releases/0.1.0-rc.20.md." },
  ]);
  expect(f.command.mock.calls.some(([, args]) => args.includes("checkout"))).toBe(false);
});
