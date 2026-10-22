import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_APP_UPDATES } from "../../../../packages/protocol/src/app-update.ts";
import { installedAppUpdater } from "./installed-updater.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
const release = (version: string, id: string) => ({
  version,
  packageSha256: id.repeat(64),
  manifestSha256: id.repeat(64),
});

it("prepares through the installed CLI with a progress channel, then shows the download's notes", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dot-installed-update-")));
  roots.push(home);
  const state = join(home, "install");
  await mkdir(state, { mode: 0o700 });
  const current = release("1.0.0", "a"),
    candidate = release("1.1.0", "b");
  await writeFile(
    join(state, "app-update.json"),
    JSON.stringify({
      v: 1,
      installedVersion: "1.0.0",
      preferences: DEFAULT_APP_UPDATES,
      checkedAt: 1,
      nextCheckAt: 1,
      failures: 0,
      availableVersion: "1.1.0",
      dismissedVersion: null,
    }),
    { mode: 0o600 },
  );
  let seen: unknown;
  const spawnMock = vi.fn((_command: string, _args: string[]) => {
    const progress = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, progress],
      kill: vi.fn(),
    });
    void (async () => {
      const notes = join(
        state,
        "releases",
        `${"b".repeat(64)}-${"b".repeat(64)}`,
        "app/release-notes",
      );
      await mkdir(notes, { recursive: true });
      await writeFile(join(notes, "1.1.0.md"), "## What's new\n\n- Quicker updates.\n");
      await writeFile(join(notes, "1.0.0.md"), "## Fixes\n\n- An older fix.\n");
      await writeFile(
        join(state, "prepared-app-update.json"),
        JSON.stringify({ v: 1, previous: current, candidate }),
        { mode: 0o600 },
      );
      progress.write('{"step":"images","share":0.5,"done":1000000,"total":2000000}\n');
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen = (await updater.status()).progress;
      progress.end();
      child.emit("exit", 0);
    })();
    return child;
  });
  const updater = installedAppUpdater(
    home,
    { ownerId: "c".repeat(32), release: current },
    () => null,
    () => {},
    { spawn: spawnMock as unknown as typeof spawn },
  );
  await updater.download();
  const [, args, options] = spawnMock.mock.calls[0] as unknown as [
    string,
    string[],
    { env: Record<string, string>; stdio: unknown[] },
  ];
  expect(args.slice(1)).toEqual(["update", "--prepare", "1.1.0"]);
  expect(options.env).toMatchObject({ LOCALDOT_HOME: home, LOCALDOT_PROGRESS_FD: "3" });
  expect(options.stdio).toEqual(["ignore", "ignore", "ignore", "pipe"]);
  expect(seen).toEqual({
    step: "images",
    value: 0.55,
    detail: "Preparing the computer · 1 of 2 MB",
  });
  expect(await updater.status()).toMatchObject({
    phase: "ready",
    notes: [{ version: "1.1.0", markdown: "## What's new\n\n- Quicker updates." }],
  });
});
