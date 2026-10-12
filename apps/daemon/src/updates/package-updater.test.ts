import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { packageAppUpdater } from "./package-updater.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(platform: NodeJS.Platform = "linux") {
  const prefix = await realpath(await mkdtemp(join(tmpdir(), "dot-package-update-")));
  roots.push(prefix);
  const home = join(prefix, "home"),
    app = join(prefix, "app");
  await mkdir(home, { mode: 0o700 });
  await mkdir(app);
  await writeFile(
    join(app, "package-release.json"),
    JSON.stringify({
      version: "0.1.0-rc.1",
      channel: "https://downloads.localdot.dev/channels/testing.json",
    }),
    { mode: 0o600 },
  );
  const exec = vi.fn(async (_command: string, args: string[]) => {
    if (args[1] === "check") return { stdout: "0.1.0-rc.2", stderr: "" };
    const destination = args[5];
    if (!destination) throw new Error("Missing staging destination");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "package-release.json"), "{}", { mode: 0o600 });
    return { stdout: "", stderr: "" };
  });
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawn = vi.fn(() => child),
    settled = vi.fn(),
    installWait = vi.fn((): string | null => null);
  const deps = { exec, spawn, platform } as unknown as NonNullable<
    Parameters<typeof packageAppUpdater>[4]
  >;
  return {
    prefix,
    home,
    exec,
    spawn,
    child,
    settled,
    installWait,
    create: () => packageAppUpdater(home, prefix, installWait, settled, deps),
  };
}
it("keeps a verified download ready after the app restarts", async () => {
  const f = await fixture(),
    first = await f.create();
  await first.check();
  expect(await first.status()).toMatchObject({ phase: "ready", availableVersion: "0.1.0-rc.2" });
  expect(await (await f.create()).status()).toMatchObject({
    phase: "ready",
    availableVersion: "0.1.0-rc.2",
  });
  expect(f.spawn).not.toHaveBeenCalled();
});
it.each(["darwin", "linux"] as const)(
  "keeps the %s update lock until installation exits",
  async (platform) => {
    const f = await fixture(platform),
      updater = await f.create();
    await updater.check();
    await updater.install();
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    expect(f.settled).not.toHaveBeenCalled();
    const [executable, args, options] = f.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean },
    ];
    expect(executable).toBe(platform === "linux" ? "/usr/bin/systemd-run" : "/bin/bash");
    expect(args).toContain("--package-version");
    expect(args).toContain("0.1.0-rc.2");
    expect(options.detached).toBe(true);
    if (platform === "linux") expect(args).toContain("--wait");
    f.child.emit("close", 1);
    await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
    expect(await updater.status()).toMatchObject({
      error: expect.stringContaining("Installation didn't complete"),
    });
  },
);
it("leaves a working task alone when the update is ready", async () => {
  const f = await fixture(),
    updater = await f.create();
  await updater.check();
  f.installWait.mockReturnValue("Finish or stop the task before updating localDot.");
  await expect(updater.install()).rejects.toThrow("Finish or stop");
  expect(f.spawn).not.toHaveBeenCalled();
});
it("does not adopt a writable installed-package record", async () => {
  const f = await fixture();
  await chmod(join(f.prefix, "app", "package-release.json"), 0o666);
  expect((await (await f.create()).status()).supported).toBe(false);
  expect(f.exec).not.toHaveBeenCalled();
});

it("checks and installs through the bundled verifier and new channel after a legacy upgrade", async () => {
  const f = await fixture();
  const updater = await f.create();
  await updater.check();
  expect(f.exec.mock.calls[0]?.[1].slice(0, 3)).toEqual([
    join(f.prefix, "app", "dist", "package-bootstrap.mjs"),
    "check",
    "https://downloads.localdot.dev/channels/releases.json",
  ]);
  expect(f.exec.mock.calls[1]?.[1].slice(0, 3)).toEqual([
    join(f.prefix, "app", "dist", "package-bootstrap.mjs"),
    "prepare",
    "https://downloads.localdot.dev/channels/releases.json",
  ]);
  await updater.install();
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
  const args = (f.spawn.mock.calls[0] as unknown as [string, string[]])[1];
  expect(args[args.indexOf("--package-channel") + 1]).toBe(
    "https://downloads.localdot.dev/channels/releases.json",
  );
  f.child.emit("close", 0);
});
