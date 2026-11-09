import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { SetupFailure } from "../../../cli/src/install/setup-failure.ts";
import { IMAGE_ROOM, packageAppUpdater } from "./package-updater.ts";
import { UpdateFailure } from "./progress.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
const pin = (role: string) => `ghcr.io/shadowhusky/localdot-${role}@sha256:${"a".repeat(64)}`;
const NOTE = "## Fixes\n\n- Updates restart faster.";
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
  const exec = vi.fn(async (_command: string, _args: string[]) => ({
    stdout: JSON.stringify({
      version: "0.1.0-rc.2",
      notes: [{ version: "0.1.0-rc.2", markdown: NOTE }],
    }),
    stderr: "",
  }));
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  // The verifier: stages the app with its pins and notes, and reports on descriptor 3.
  const spawn = vi.fn((_command: string, args: string[]) => {
    if (args[1] !== "prepare") return child;
    const progress = new PassThrough();
    const verifier = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, progress],
      kill: vi.fn(),
    });
    void (async () => {
      const destination = args[5] ?? "";
      await mkdir(join(destination, "release-notes"), { recursive: true });
      await writeFile(
        join(destination, "package-release.json"),
        JSON.stringify({
          images: Object.fromEntries(
            ["desktop", "gate", "brain", "browser"].map((role) => [role, pin(role)]),
          ),
        }),
        { mode: 0o600 },
      );
      await writeFile(join(destination, "release-notes", "0.1.0-rc.2.md"), NOTE);
      progress.end('{"step":"download","done":5,"total":10}\n');
      verifier.emit("exit", 0);
    })();
    return verifier;
  });
  const images = vi.fn(
    async (_pins: unknown, _signal: AbortSignal, report: (progress: unknown) => void) => {
      report({
        role: "desktop",
        phase: "downloading",
        layer: "l1",
        currentBytes: 1,
        totalBytes: 2,
      });
    },
  );
  const freeBytes = vi.fn(() => IMAGE_ROOM);
  const settled = vi.fn(),
    installWait = vi.fn((): string | null => null);
  const deps = { exec, spawn, platform, freeBytes, images } as unknown as NonNullable<
    Parameters<typeof packageAppUpdater>[4]
  >;
  return {
    prefix,
    home,
    exec,
    spawn,
    child,
    images,
    freeBytes,
    settled,
    installWait,
    installs: () => spawn.mock.calls.filter(([, args]) => args[1] !== "prepare"),
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
  expect(f.installs()).toEqual([]);
});
it("streams the verifier's progress, fetches the pinned images and keeps the archive for install", async () => {
  const f = await fixture(),
    updater = await f.create();
  await updater.check();
  const [, prepareArgs, options] = f.spawn.mock.calls.find(
    ([, args]) => args[1] === "prepare",
  ) as unknown as [string, string[], { env: Record<string, string>; stdio: unknown[] }];
  expect(options.env.LOCALDOT_PROGRESS_FD).toBe("3");
  expect(options.stdio[3]).toBe("pipe");
  expect(f.images).toHaveBeenCalledOnce();
  expect(f.images.mock.calls[0]?.[0]).toMatchObject({
    desktop: {
      repository: "ghcr.io/shadowhusky/localdot-desktop",
      digest: `sha256:${"a".repeat(64)}`,
    },
  });
  expect(await updater.status()).toMatchObject({
    phase: "ready",
    progress: { step: "install", value: 0.95, detail: "Ready to install" },
    notes: [{ version: "0.1.0-rc.2", markdown: NOTE }],
  });
  await updater.install();
  await vi.waitFor(() => expect(f.installs()).toHaveLength(1));
  const [, , install] = f.installs()[0] as unknown as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  expect(install.env.LOCALDOT_PACKAGE_ARCHIVE).toBe(join(prepareArgs[4] ?? "", "app.tgz"));
  f.child.emit("close", 0);
});
it.each(["low disk", "full Docker storage"])(
  "leaves the images for the installer on %s and says so",
  async (kind) => {
    const f = await fixture();
    if (kind === "low disk") f.freeBytes.mockReturnValue(IMAGE_ROOM - 1);
    else f.images.mockRejectedValue(new SetupFailure("storage-full"));
    const updater = await f.create();
    await updater.check();
    expect(await updater.status()).toMatchObject({
      phase: "ready",
      progress: { detail: expect.stringContaining("low on disk space") },
    });
    if (kind === "low disk") expect(f.images).not.toHaveBeenCalled();
  },
);
it("fails the download, keeping its step, when an image can't be fetched", async () => {
  const f = await fixture();
  f.images.mockRejectedValue(new Error("network"));
  const updater = await f.create();
  await updater.check();
  expect(await updater.status()).toMatchObject({
    phase: "idle",
    error: expect.stringContaining("couldn't be downloaded"),
    progress: { step: "images" },
  });
});
it.each(["darwin", "linux"] as const)(
  "keeps the %s update lock until installation exits",
  async (platform) => {
    const f = await fixture(platform),
      updater = await f.create();
    await updater.check();
    await updater.install();
    await vi.waitFor(() => expect(f.installs()).toHaveLength(1));
    expect(f.settled).not.toHaveBeenCalled();
    const [executable, args, options] = f.installs()[0] as unknown as [
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
    await vi.waitFor(async () =>
      expect(await updater.status()).toMatchObject({
        error: expect.stringContaining("couldn't be installed"),
        progress: { step: "install" },
      }),
    );
  },
);
it("leaves a working task alone when the update is ready", async () => {
  const f = await fixture(),
    updater = await f.create();
  await updater.check();
  f.installWait.mockReturnValue("Finish or stop the task before updating localDot.");
  await expect(updater.install()).rejects.toThrow("Finish or stop");
  await updater.close();
  expect(f.installs()).toEqual([]);
});
it("does not adopt a writable installed-package record", async () => {
  const f = await fixture();
  await chmod(join(f.prefix, "app", "package-release.json"), 0o666);
  expect((await (await f.create()).status()).supported).toBe(false);
  expect(f.exec).not.toHaveBeenCalled();
});
it("reads a version-only answer from a verifier that predates notes", async () => {
  const f = await fixture();
  f.exec.mockResolvedValue({ stdout: "0.1.0-rc.2\n", stderr: "" });
  const updater = await f.create();
  await updater.check();
  expect((await updater.status()).availableVersion).toBe("0.1.0-rc.2");
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
  expect(f.spawn.mock.calls[0]?.[1].slice(0, 3)).toEqual([
    join(f.prefix, "app", "dist", "package-bootstrap.mjs"),
    "prepare",
    "https://downloads.localdot.dev/channels/releases.json",
  ]);
  await updater.install();
  await vi.waitFor(() => expect(f.installs()).toHaveLength(1));
  const args = (f.installs()[0] as unknown as [string, string[]])[1];
  expect(args[args.indexOf("--package-channel") + 1]).toBe(
    "https://downloads.localdot.dev/channels/releases.json",
  );
  f.child.emit("close", 0);
});

it("removes only the recorded staging download after that version has started", async () => {
  const f = await fixture();
  await (await f.create()).check();
  const record = JSON.parse(await readFile(join(f.home, "prepared-package-update.json"), "utf8"));
  const downloads = join(f.prefix, "runtime/package-updates");
  await mkdir(join(downloads, ".prepare-unrelated"));
  await writeFile(
    join(f.prefix, "app/package-release.json"),
    JSON.stringify({
      version: record.version,
      channel: "https://downloads.localdot.dev/channels/releases.json",
    }),
    { mode: 0o600 },
  );
  await f.create();
  await expect(stat(join(downloads, record.directory))).rejects.toThrow();
  expect((await stat(join(downloads, ".prepare-unrelated"))).isDirectory()).toBe(true);
  expect(JSON.parse(await readFile(join(f.home, "prepared-package-update.json"), "utf8"))).toBe(
    null,
  );
});
it("does not follow a replaced staging directory during post-update cleanup", async () => {
  const f = await fixture();
  await (await f.create()).check();
  const record = JSON.parse(await readFile(join(f.home, "prepared-package-update.json"), "utf8"));
  const staging = join(f.prefix, "runtime/package-updates", record.directory);
  await rm(staging, { recursive: true });
  await symlink(f.home, staging);
  await writeFile(
    join(f.prefix, "app/package-release.json"),
    JSON.stringify({
      version: record.version,
      channel: "https://downloads.localdot.dev/channels/releases.json",
    }),
    { mode: 0o600 },
  );
  await f.create();
  expect((await stat(f.home)).isDirectory()).toBe(true);
  expect(JSON.parse(await readFile(join(f.home, "prepared-package-update.json"), "utf8"))).toEqual(
    record,
  );
});

it("looks for Docker where the app itself does, not only at the default socket", async () => {
  const { imageSocket } = await import("./package-updater.ts");
  const elsewhere = "/Users/me/.docker/run/docker.sock";
  expect(imageSocket({ DOCKER_HOST: `unix://${elsewhere}` })).toBe(elsewhere);
  expect(
    imageSocket(
      { HOME: "/Users/me" },
      {
        exists: (path: string) => path === elsewhere,
        context: () => undefined,
      },
      "darwin",
    ),
  ).toBe(elsewhere);
});
it.each([
  ["network-unavailable", "network"],
  ["storage-read-only", "disk"],
  ["permission-denied", "docker"],
  ["docker-unavailable", "docker"],
] as const)("names what stopped the images: %s", async (code, problem) => {
  const f = await fixture();
  f.images.mockRejectedValue(new SetupFailure(code));
  const updater = await f.create();
  await updater.check();
  expect((await updater.status()).error).toContain(new UpdateFailure(problem).reason);
});
it("hands the installer a status file, and reads back what it recorded", async () => {
  const f = await fixture("darwin");
  const updater = await f.create();
  await updater.check();
  await updater.install();
  await vi.waitFor(() => expect(f.installs()).toHaveLength(1));
  const [, , options] = f.installs()[0] as unknown as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  const file = options.env.LOCALDOT_UPDATE_STATUS ?? "";
  expect(file.startsWith(f.home)).toBe(true);
  await writeFile(
    file,
    JSON.stringify({ v: 1, pid: process.pid, stage: "verify", restored: false }),
  );
  await vi.waitFor(
    async () =>
      expect((await updater.status()).progress?.detail).toBe("Checking the download once more"),
    { timeout: 3000 },
  );
  await writeFile(
    file,
    JSON.stringify({ v: 1, pid: process.pid, stage: "failed", problem: "docker", restored: false }),
  );
  f.child.emit("close", 1);
  await vi.waitFor(async () =>
    expect((await updater.status()).error).toContain("Docker isn't running."),
  );
});
it("downloads into a place of this dot's own, so dots sharing an installation can't mix a partial file", async () => {
  const f = await fixture();
  const updater = await f.create();
  await updater.check();
  const [, , options] = f.spawn.mock.calls.find(([, args]) => args[1] === "prepare") as unknown as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  expect(options.env.LOCALDOT_DOWNLOAD_DIR?.startsWith(f.home)).toBe(true);
});
it("clears downloads a crash left behind, but never another dot's fresh one", async () => {
  const f = await fixture();
  const downloads = join(f.prefix, "runtime/package-updates");
  await mkdir(join(downloads, ".prepare-crashed"), { recursive: true });
  await mkdir(join(downloads, ".prepare-other-dot"), { recursive: true });
  const old = new Date(Date.now() - 2 * 24 * 3_600_000);
  await utimes(join(downloads, ".prepare-crashed"), old, old);
  await f.create();
  await expect(stat(join(downloads, ".prepare-crashed"))).rejects.toThrow();
  expect((await stat(join(downloads, ".prepare-other-dot"))).isDirectory()).toBe(true);
});
it("keeps a downloaded update while the installer's checks could still roll back", async () => {
  const f = await fixture();
  await (await f.create()).check();
  const record = JSON.parse(await readFile(join(f.home, "prepared-package-update.json"), "utf8"));
  await writeFile(
    join(f.prefix, "app/package-release.json"),
    JSON.stringify({
      version: record.version,
      channel: "https://downloads.localdot.dev/channels/releases.json",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(f.home, "app-update-attempt.json"),
    JSON.stringify({ v: 1, version: record.version }),
    { mode: 0o600 },
  );
  await writeFile(
    join(f.home, "app-update-install.json"),
    JSON.stringify({ v: 1, pid: process.pid, stage: "check", restored: false }),
  );
  const staging = join(f.prefix, "runtime/package-updates", record.directory);
  const updated = await f.create();
  expect(await updated.status()).toMatchObject({ phase: "installing" });
  expect((await stat(staging)).isDirectory()).toBe(true);
  await writeFile(
    join(f.home, "app-update-install.json"),
    JSON.stringify({ v: 1, pid: process.pid, stage: "done", restored: false }),
  );
  await vi.waitFor(async () => expect((await updated.status()).phase).toBe("idle"), {
    timeout: 3000,
  });
  await vi.waitFor(() => expect(stat(staging)).rejects.toThrow());
  await updated.close();
});
it("forgets a swap the installer can no longer finish once a daemon runs", async () => {
  const f = await fixture();
  await writeFile(join(f.prefix, ".package-swap"), "/gone\n");
  await f.create();
  await expect(stat(join(f.prefix, ".package-swap"))).rejects.toThrow();
});
it("holds its verdict while a killed installer's swap is still being undone", async () => {
  const f = await fixture();
  await (await f.create()).check();
  const record = JSON.parse(await readFile(join(f.home, "prepared-package-update.json"), "utf8"));
  await writeFile(
    join(f.prefix, "app/package-release.json"),
    JSON.stringify({
      version: record.version,
      channel: "https://downloads.localdot.dev/channels/releases.json",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(f.home, "app-update-attempt.json"),
    JSON.stringify({ v: 1, version: record.version }),
    { mode: 0o600 },
  );
  const dead = 2 ** 22 + 1;
  await writeFile(
    join(f.home, "app-update-install.json"),
    JSON.stringify({ v: 1, pid: dead, stage: "start", restored: false }),
  );
  await writeFile(join(f.prefix, ".package-swap"), `/rollback\n${process.pid}\n`);
  const updated = await f.create();
  expect(await updated.status()).toMatchObject({ phase: "installing" });
  expect((await stat(join(f.prefix, ".package-swap"))).isFile()).toBe(true);
  await updated.close();
  await writeFile(join(f.prefix, ".package-swap"), `/rollback\n${dead}\n`);
  const after = await f.create();
  expect((await after.status()).phase).not.toBe("installing");
  await expect(stat(join(f.prefix, ".package-swap"))).rejects.toThrow();
});
