import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ServiceOwner } from "../../../../packages/protocol/src/install-services.ts";
import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { privateRecordStore } from "./private-record.ts";
import { readInstalledRelease } from "./promote-release.ts";
import { runServiceCommand, type ServiceOperation } from "./service-command.ts";
import { defineReleaseServices, type ServiceSettings } from "./service-definition.ts";

export type InstallServiceSettings = Omit<ServiceSettings, "ownerId">;
type Definitions = ReturnType<typeof defineReleaseServices>;
const fail = () => new Error("Installed service definitions are unavailable or unsafe.");
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const existsError = (e: unknown) => e instanceof Error && "code" in e && e.code === "EEXIST";

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
async function syncDirectory(path: string) {
  const before = await privateDirectory(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const after = await fd.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) throw fail();
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function ensureDirectory(path: string) {
  await privateDirectory(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (e) {
    if (!existsError(e)) throw e;
  }
  await privateDirectory(path);
  await syncDirectory(dirname(path));
}

async function owner(settings: InstallServiceSettings, create: boolean) {
  await privateDirectory(settings.state);
  await privateDirectory(settings.home);
  if (settings.uid !== process.getuid?.()) throw fail();
  const store = privateRecordStore(settings.state, "service-owner.json", ServiceOwner);
  const existing = await store.read();
  if (existing) {
    if (
      existing.state !== settings.state ||
      existing.home !== settings.home ||
      existing.uid !== settings.uid
    )
      throw fail();
    return existing;
  }
  if (!create) throw fail();
  // Losing the ownership record cannot authorize new labels while old jobs may remain loaded.
  const services = join(settings.state, "services");
  if (await exists(services)) {
    await privateDirectory(services);
    if ((await readdir(services)).length) throw fail();
  }
  const record = ServiceOwner.parse({
    v: 1,
    id: randomBytes(16).toString("hex"),
    state: settings.state,
    home: settings.home,
    uid: settings.uid,
  });
  await store.save(record);
  return record;
}

async function verifyFile(path: string, expected: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const body = Buffer.from(expected);
  if (body.length > 64 * 1024) throw fail();
  const beforeDirectory = await privateDirectory(dirname(path));
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(body.length) ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o7777n) !== 0o600n
    )
      throw fail();
    const actual = Buffer.alloc(body.length);
    let offset = 0;
    while (offset < actual.length) {
      signal.throwIfAborted();
      const { bytesRead } = await fd.read(actual, offset, actual.length - offset, offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    const after = await fd.stat({ bigint: true }),
      named = await lstat(path, { bigint: true });
    if (
      !actual.equals(body) ||
      [after, named].some(
        (s) =>
          s.dev !== before.dev ||
          s.ino !== before.ino ||
          s.size !== before.size ||
          s.mode !== before.mode ||
          s.nlink !== 1n ||
          s.mtimeNs !== before.mtimeNs ||
          s.ctimeNs !== before.ctimeNs,
      )
    )
      throw fail();
    const afterDirectory = await privateDirectory(dirname(path));
    if (beforeDirectory.dev !== afterDirectory.dev || beforeDirectory.ino !== afterDirectory.ino)
      throw fail();
    signal.throwIfAborted();
  } finally {
    await fd.close();
  }
}

async function verifyDefinitions(definitions: Definitions, signal: AbortSignal) {
  const directory = dirname(definitions.daemon.file);
  await privateDirectory(directory);
  const names = [basename(definitions.daemon.file), basename(definitions.keyd.file)].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)) throw fail();
  for (const role of ["keyd", "daemon"] as const)
    await verifyFile(definitions[role].file, definitions[role].contents, signal);
}

async function runtime(settings: InstallServiceSettings, create: boolean) {
  // Use the current trusted installer runtime, never execute a downloaded or environment-selected
  // Node binary while probing its identity. Preflight establishes the supported Node version.
  if (settings.node !== (await realpath(process.execPath))) throw fail();
  const node = await lstat(settings.node);
  if (
    !node.isFile() ||
    (node.mode & 0o022) !== 0 ||
    (node.mode & 0o111) === 0 ||
    (node.uid !== 0 && node.uid !== settings.uid)
  )
    throw fail();
  for (const name of ["tmp", "logs"]) {
    const directory = join(settings.state, name);
    if (create) await ensureDirectory(directory);
    else await privateDirectory(directory);
  }
  for (const name of ["daemon.log", "daemon.error.log", "keyd.log", "keyd.error.log"]) {
    const file = join(settings.state, "logs", name);
    let created = false;
    if (create) {
      try {
        const fd = await open(
          file,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await fd.sync();
          created = true;
        } finally {
          await fd.close();
        }
      } catch (e) {
        if (!existsError(e)) throw e;
      }
    }
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await fd.stat({ bigint: true }),
        named = await lstat(file, { bigint: true });
      if (
        !st.isFile() ||
        st.nlink !== 1n ||
        st.uid !== BigInt(settings.uid) ||
        (st.mode & 0o7777n) !== 0o600n ||
        st.ino !== named.ino ||
        st.dev !== named.dev
      )
        throw fail();
    } finally {
      await fd.close();
    }
    if (created) await syncDirectory(dirname(file));
  }
}

async function definitionsFor(
  settings: InstallServiceSettings,
  identity: ReleaseIdentity,
  signal: AbortSignal,
  create: boolean,
) {
  signal.throwIfAborted();
  // Reopening validates the release's anchor, full inventory/native dependencies and Apple signature.
  const installed = await readInstalledRelease(settings.state, identity, signal);
  signal.throwIfAborted();
  const record = await owner(settings, create);
  const definitions = defineReleaseServices(
    { ...settings, ownerId: record.id },
    identity,
    installed.manifest,
  );
  await runtime(settings, create);
  signal.throwIfAborted();
  return definitions;
}

/** Caller holds the verified-helper install lock. Publish an immutable, complete two-plist
 * directory by rename, with files and directories fsynced before return. No launchd operations
 * occur here. A pre-existing conflicting directory is never repaired, overwritten or removed.
 */
export async function prepareInstalledServices(
  settingsInput: InstallServiceSettings,
  identityInput: ReleaseIdentity,
  signal: AbortSignal,
) {
  const settings = { ...settingsInput },
    identity = ReleaseIdentity.parse(identityInput);
  const definitions = await definitionsFor(settings, identity, signal, true);
  const directory = dirname(definitions.daemon.file),
    parent = dirname(directory);
  await ensureDirectory(join(settings.state, "services"));
  await ensureDirectory(parent);
  if (await exists(directory)) {
    await verifyDefinitions(definitions, signal);
    await syncDirectory(parent);
    signal.throwIfAborted();
    return definitions;
  }
  const temporary = await mkdtemp(join(parent, ".service-"));
  const original = await privateDirectory(temporary);
  let moved = false;
  try {
    for (const role of ["keyd", "daemon"] as const) {
      signal.throwIfAborted();
      const fd = await open(
        join(temporary, basename(definitions[role].file)),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fd.writeFile(definitions[role].contents, "utf8");
        await fd.sync();
      } finally {
        await fd.close();
      }
      await verifyFile(
        join(temporary, basename(definitions[role].file)),
        definitions[role].contents,
        signal,
      );
    }
    await syncDirectory(temporary);
    signal.throwIfAborted();
    if (await exists(directory)) throw fail();
    await privateDirectory(parent);
    await rename(temporary, directory);
    moved = true;
    await syncDirectory(parent);
    await verifyDefinitions(definitions, signal);
    return definitions;
  } catch (error) {
    if (!moved) {
      try {
        const current = await privateDirectory(temporary);
        if (current.ino !== original.ino || current.dev !== original.dev) throw fail();
        await rm(temporary, { recursive: true });
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Service preparation and cleanup failed.");
      }
    }
    throw error;
  }
}

/** Read-only check immediately before an owned job operation. Re-derive both plists from the
 * anchored release and durable ownership ID, not from arbitrary bytes in the service directory.
 * Same-user malicious filesystem writers are outside the installation isolation boundary.
 */
export async function reopenInstalledServices(
  settingsInput: InstallServiceSettings,
  identityInput: ReleaseIdentity,
  signal: AbortSignal,
) {
  const settings = { ...settingsInput },
    identity = ReleaseIdentity.parse(identityInput);
  const definitions = await definitionsFor(settings, identity, signal, false);
  await privateDirectory(join(settings.state, "services"));
  await privateDirectory(dirname(dirname(definitions.daemon.file)));
  await verifyDefinitions(definitions, signal);
  return definitions;
}

/** Caller holds the verified-helper install lock through the command's actual close.
 * Production authority wrapper. The durable random owner ID authorizes only this installation's
 * labels; a readable, predictable label alone does not. Same-UID hostile launchd clients are outside
 * this boundary. The lifecycle must still interpret exit status and prove physical quiescence or
 * authenticated exact-release readiness; neither a valid definition nor command success does that.
 */
export async function runInstalledServiceCommand(
  settings: InstallServiceSettings,
  identity: ReleaseIdentity,
  role: "keyd" | "daemon",
  operation: ServiceOperation,
  signal: AbortSignal,
) {
  if (
    (role !== "keyd" && role !== "daemon") ||
    !["bootstrap", "bootout", "kickstart", "print"].includes(operation)
  )
    throw fail();
  const definitions = await reopenInstalledServices(settings, identity, signal);
  signal.throwIfAborted();
  return runServiceCommand(definitions[role], operation, signal);
}
