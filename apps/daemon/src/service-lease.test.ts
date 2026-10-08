import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  ManagedServiceIdentity,
  ServiceJournal,
} from "../../../packages/protocol/src/install-services.ts";
import { retainManagedDaemonLease } from "./service-lease.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "localdot-service-lease-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"),
    home = join(root, "home");
  for (const path of [state, home]) mkdirSync(path, { mode: 0o700 });
  const owner = { v: 1, id: "a".repeat(32), state, home, uid: process.getuid?.() ?? -1 };
  const identity: ManagedServiceIdentity = {
    ownerId: owner.id,
    release: { version: "1.2.3", packageSha256: "b".repeat(64), manifestSha256: "c".repeat(64) },
  };
  const settings = {
    state,
    home,
    userHome: root,
    node: realpathSync(process.execPath),
    dockerSocket: join(root, "docker.sock"),
    uid: owner.uid,
    port: 4750,
    ownerId: owner.id,
  };
  const configuration = createHash("sha256")
    .update(
      JSON.stringify({
        identity: identity.release,
        home,
        userHome: root,
        node: settings.node,
        dockerSocket: settings.dockerSocket,
        uid: owner.uid,
        port: 4750,
      }),
    )
    .digest("hex");
  const journal: ServiceJournal = {
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    configuration: { settings, release: identity.release, configuration },
    previous: null,
    phase: "starting",
    jobs: { keyd: { phase: "running", pid: 41 }, daemon: { phase: "starting" } },
  };
  const entry = join(
    state,
    "releases",
    `${identity.release.packageSha256}-${identity.release.manifestSha256}`,
    "app",
    "dist",
    "daemon.mjs",
  );
  mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
  writeFileSync(entry, "// fixture", { mode: 0o600 });
  const lock = join(state, `service-${owner.id}-daemon.lock`),
    fd = openSync(lock, "wx+", 0o600);
  cleanups.push(() => closeSync(fd));
  const env: NodeJS.ProcessEnv = {
    LOCALDOT_SERVICE_ROLE: "daemon",
    LOCALDOT_SERVICE_LEASE_FD: String(fd),
    LOCALDOT_SERVICE_STATE: state,
    LOCALDOT_HOME: home,
    LOCALDOT_SERVICE_CONFIGURATION: configuration,
    LOCALDOT_SERVICE_ATTEMPT: journal.id,
  };
  const save = () => {
    writeFileSync(join(state, "service-owner.json"), JSON.stringify(owner), { mode: 0o600 });
    writeFileSync(join(state, "service-journal.json"), JSON.stringify(journal), { mode: 0o600 });
  };
  save();
  return {
    root,
    state,
    home,
    owner,
    identity,
    journal,
    entry,
    lock,
    fd,
    env,
    save,
    runtime: { pid: process.pid, node: settings.node, entry },
  };
}

it("retains the inherited descriptor during startup and after the running observation", () => {
  const f = fixture();
  expect(retainManagedDaemonLease(f.env, f.identity, f.runtime)).toBe(f.fd);
  f.journal.phase = "running";
  f.journal.jobs.daemon = { phase: "running", pid: process.pid };
  f.save();
  expect(retainManagedDaemonLease(f.env, f.identity, f.runtime)).toBe(f.fd);
  expect(fstatSync(f.fd).isFile()).toBe(true);
});

it.each([
  "role",
  "fd",
  "owner",
  "attempt",
  "configuration",
  "settings",
  "release",
  "stopping",
  "pid",
  "node",
  "entry",
  "home-mode",
  "record-mode",
  "record-link",
  "record-size",
  "lock-mode",
  "lock-link",
  "lock-hardlink",
  "lock-replaced",
  "lock-data",
])("refuses %s mismatch before daemon startup", (kind) => {
  const f = fixture();
  switch (kind) {
    case "role":
      f.env.LOCALDOT_SERVICE_ROLE = "keyd";
      break;
    case "fd":
      f.env.LOCALDOT_SERVICE_LEASE_FD = `0${f.fd}`;
      break;
    case "owner":
      f.owner.id = "d".repeat(32);
      break;
    case "attempt":
      f.env.LOCALDOT_SERVICE_ATTEMPT = "11234567-89ab-4cde-8fab-0123456789ab";
      break;
    case "configuration":
      f.env.LOCALDOT_SERVICE_CONFIGURATION = "d".repeat(64);
      break;
    case "settings":
      f.journal.configuration.settings.port++;
      break;
    case "release":
      f.identity = { ...f.identity, release: { ...f.identity.release, version: "1.2.4" } };
      break;
    case "stopping":
      f.journal.phase = "stopping";
      break;
    case "pid":
      f.journal.jobs.daemon = { phase: "running", pid: process.pid + 1 };
      break;
    case "node":
      f.runtime.node = "/wrong/node";
      break;
    case "entry":
      f.runtime.entry = join(f.root, "other.mjs");
      writeFileSync(f.runtime.entry, "");
      break;
    case "home-mode":
      chmodSync(f.home, 0o755);
      break;
    case "lock-mode":
      chmodSync(f.lock, 0o644);
      break;
    case "lock-hardlink":
      linkSync(f.lock, `${f.lock}.other`);
      break;
    case "lock-link":
      renameSync(f.lock, `${f.lock}.real`);
      symlinkSync(`${f.lock}.real`, f.lock);
      break;
    case "lock-replaced":
      renameSync(f.lock, `${f.lock}.old`);
      writeFileSync(f.lock, "", { mode: 0o600 });
      break;
    case "lock-data":
      writeFileSync(f.lock, "x");
      break;
  }
  f.save();
  const record = join(f.state, "service-journal.json");
  if (kind === "record-mode") chmodSync(record, 0o644);
  if (kind === "record-link") {
    renameSync(record, `${record}.real`);
    symlinkSync(`${record}.real`, record);
  }
  if (kind === "record-size") writeFileSync(record, "x".repeat(16385));
  expect(() => retainManagedDaemonLease(f.env, f.identity, f.runtime)).toThrow(
    "Managed daemon lifetime lease is missing or not admitted.",
  );
});
