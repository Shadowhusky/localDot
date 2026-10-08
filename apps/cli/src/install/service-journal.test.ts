import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ServiceConfiguration,
  ServiceJournal,
} from "../../../../packages/protocol/src/install-services.ts";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { serviceConfigurationId } from "./service-definition.ts";
import {
  checkedServiceConfiguration,
  prepareServiceConfiguration,
  serviceJournalStore,
  verifyServiceConfiguration,
  verifyServiceOwner,
} from "./service-journal.ts";
import type { InstallServiceSettings } from "./service-store.ts";

const hooks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./promote-release.ts", () => ({ readInstalledRelease: hooks.read }));
const roots: string[] = [];
afterEach(async () => {
  hooks.read.mockReset();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-journal-")));
  roots.push(root);
  const state = join(root, "state"),
    home = join(root, "home");
  await mkdir(state, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const settings: InstallServiceSettings = {
    state,
    home,
    userHome: root,
    node: await realpath(process.execPath),
    dockerSocket: join(root, "docker.sock"),
    uid: process.getuid?.() ?? -1,
    port: 4750,
  };
  const manifest = ReleaseManifest.parse(sampleManifest());
  manifest.files["dist/daemon.mjs"] = "c".repeat(64);
  hooks.read.mockResolvedValue({ manifest });
  const release = {
    version: manifest.version,
    packageSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  const config = await prepareServiceConfiguration(settings, release, signal());
  const store = serviceJournalStore(settings);
  const record: ServiceJournal = {
    v: 1,
    id: randomUUID(),
    configuration: config,
    previous: null,
    phase: "stopped",
    jobs: { keyd: { phase: "absent" }, daemon: { phase: "absent" } },
  };
  return {
    root,
    settings,
    config,
    release,
    store,
    record,
    file: join(state, "service-journal.json"),
  };
}
it("reopens the exact private configuration without using current environment settings", async () => {
  const f = await fixture();
  expect(await f.store.read()).toBeNull();
  await f.store.save(f.record);
  f.settings.port = 9000;
  f.settings.dockerSocket = "/different/docker.sock";
  const reopened = await serviceJournalStore(f.settings).read();
  expect(reopened?.configuration.settings.port).toBe(4750);
  expect(reopened?.configuration.settings.dockerSocket).toBe(f.config.settings.dockerSocket);
  const definitions = await verifyServiceConfiguration(f.config, signal());
  expect(definitions.daemon.configuration).toBe(f.config.configuration);
  expect(definitions.daemon.arguments).toContain("LOCALDOT_PORT=4750");
});
it.each(["owner", "state", "home", "uid", "digest", "path", "previous-owner"])(
  "refuses a %s mismatch before replacing the record",
  async (kind) => {
    const f = await fixture();
    await f.store.save(f.record);
    const changed = structuredClone(f.record),
      config = changed.configuration;
    if (kind === "owner") config.settings.ownerId = "f".repeat(32);
    if (kind === "state") config.settings.state = f.root;
    if (kind === "home") config.settings.home = f.root;
    if (kind === "uid") config.settings.uid++;
    if (kind === "digest") config.configuration = "f".repeat(64);
    if (kind === "path") config.settings.node = "/usr/bin/../bin/node";
    if (kind === "previous-owner") {
      changed.previous = structuredClone(config);
      changed.previous.settings.ownerId = "f".repeat(32);
    }
    if (["owner", "state", "home", "uid"].includes(kind))
      config.configuration = serviceConfigurationId(config.settings, config.release);
    await expect(f.store.save(changed)).rejects.toThrow();
    expect(await f.store.read()).toEqual(f.record);
  },
);
it.each(["corrupt", "permissions", "unknown-field", "wrong-owner"])(
  "does not overwrite or recover silently from %s storage",
  async (kind) => {
    const f = await fixture();
    await f.store.save(f.record);
    if (kind === "corrupt") await writeFile(f.file, "{");
    if (kind === "permissions") await chmod(f.file, 0o644);
    if (kind === "unknown-field")
      await writeFile(f.file, JSON.stringify({ ...f.record, password: "synthetic" }));
    if (kind === "wrong-owner") {
      const data = JSON.parse(await readFile(join(f.settings.state, "service-owner.json"), "utf8"));
      await writeFile(
        join(f.settings.state, "service-owner.json"),
        JSON.stringify({ ...data, id: "f".repeat(32) }),
      );
    }
    const before = await readFile(f.file);
    await expect(f.store.read()).rejects.toThrow();
    await expect(f.store.save(f.record)).rejects.toThrow();
    expect(await readFile(f.file)).toEqual(before);
  },
);
it("refuses preparing another configuration while startup or shutdown remains pending", async () => {
  const f = await fixture();
  for (const phase of ["starting", "stopping"] as const) {
    await f.store.save({ ...f.record, phase });
    hooks.read.mockClear();
    await expect(
      prepareServiceConfiguration({ ...f.settings, port: 4850 }, f.release, signal()),
    ).rejects.toThrow();
    expect(hooks.read).not.toHaveBeenCalled();
  }
});
it("can stage immutable update definitions while preserving the currently running journal", async () => {
  const f = await fixture();
  const running: ServiceJournal = {
    ...f.record,
    phase: "running",
    jobs: {
      keyd: { phase: "running", pid: 41 },
      daemon: { phase: "running", pid: 42 },
    },
  };
  await f.store.save(running);
  const next = await prepareServiceConfiguration(
    { ...f.settings, port: 4850 },
    f.release,
    signal(),
  );
  expect(next.configuration).not.toBe(f.config.configuration);
  expect(await f.store.read()).toEqual(running);
  expect((await verifyServiceConfiguration(f.config, signal())).keyd.configuration).toBe(
    f.config.configuration,
  );
});
it("retains the original identity when caller inputs change during verification", async () => {
  const f = await fixture(),
    input = structuredClone(f.config);
  const barrier = Promise.withResolvers<void>();
  const manifest = hooks.read.getMockImplementation();
  hooks.read.mockImplementationOnce(async () => {
    await barrier.promise;
    return manifest?.();
  });
  const work = verifyServiceConfiguration(input, signal());
  input.settings.port = 1234;
  input.release.packageSha256 = "f".repeat(64);
  barrier.resolve();
  expect((await work).keyd.configuration).toBe(f.config.configuration);
});
it("returns independent parsed configuration snapshots", async () => {
  const f = await fixture();
  const result: ServiceConfiguration = checkedServiceConfiguration(f.config);
  result.settings.port++;
  expect(f.config.settings.port).toBe(4750);
});
it("retirement ownership survives a damaged release but not a changed private owner", async () => {
  const f = await fixture();
  hooks.read.mockRejectedValue(new Error("damaged executable"));
  await expect(verifyServiceConfiguration(f.config, signal())).rejects.toThrow();
  expect(await verifyServiceOwner(f.config)).toEqual(f.config);
  const path = join(f.settings.state, "service-owner.json");
  const owner = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...owner, id: "f".repeat(32) }));
  await expect(verifyServiceOwner(f.config)).rejects.toThrow();
});
