import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import {
  type ManagedServiceIdentity,
  ServiceJournal,
  ServiceOwner,
  sameManagedService,
} from "../../../packages/protocol/src/install-services.ts";

const failure = () => new Error("Managed daemon lifetime lease is missing or not admitted.");
const uid = () => BigInt(process.getuid?.() ?? -1);
function privateDirectory(path: string) {
  if (!isAbsolute(path) || path === "/" || normalize(path) !== path || realpathSync(path) !== path)
    throw failure();
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== uid() || (stat.mode & 0o7777n) !== 0o700n)
    throw failure();
  return stat;
}
function privateRecord(directory: string, name: string): unknown {
  const parent = privateDirectory(directory),
    path = join(directory, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== uid() ||
      before.nlink !== 1n ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.size < 1n ||
      before.size > 16384n
    )
      throw failure();
    const bytes = Buffer.alloc(16385);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, count);
      if (!n) break;
      count += n;
    }
    const after = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true }),
      currentParent = privateDirectory(directory);
    if (
      BigInt(count) !== before.size ||
      currentParent.dev !== parent.dev ||
      currentParent.ino !== parent.ino ||
      [after, named].some(
        (s) =>
          s.dev !== before.dev ||
          s.ino !== before.ino ||
          s.mode !== before.mode ||
          s.nlink !== 1n ||
          s.size !== before.size ||
          s.mtimeNs !== before.mtimeNs ||
          s.ctimeNs !== before.ctimeNs,
      )
    )
      throw failure();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally {
    closeSync(fd);
  }
}

/** The signed launcher holds this descriptor across exec. A raw inherited descriptor has no JS
 * finalizer; leave it open until process.exit, including throughout asynchronous shutdown. Node
 * child_process does not inherit extra descriptors unless explicitly passed in stdio.
 */
export function retainManagedDaemonLease(
  env: NodeJS.ProcessEnv,
  identity: ManagedServiceIdentity,
  runtime = { pid: process.pid, node: realpathSync(process.execPath), entry: process.argv[1] },
) {
  try {
    if (
      env.LOCALDOT_SERVICE_ROLE !== "daemon" ||
      !/^[1-9][0-9]*$/.test(env.LOCALDOT_SERVICE_LEASE_FD ?? "")
    )
      throw failure();
    const fd = Number(env.LOCALDOT_SERVICE_LEASE_FD);
    if (!Number.isInteger(fd) || fd < 3 || fd > 1_048_576) throw failure();
    const state = env.LOCALDOT_SERVICE_STATE ?? "",
      home = env.LOCALDOT_HOME ?? "";
    privateDirectory(state);
    privateDirectory(home);
    const owner = ServiceOwner.parse(privateRecord(state, "service-owner.json"));
    if (
      owner.id !== identity.ownerId ||
      owner.state !== state ||
      owner.home !== home ||
      BigInt(owner.uid) !== uid()
    )
      throw failure();
    const journal = ServiceJournal.parse(privateRecord(state, "service-journal.json")),
      config = journal.configuration,
      s = config.settings;
    const configuration = createHash("sha256")
      .update(
        JSON.stringify({
          identity: config.release,
          home: s.home,
          userHome: s.userHome,
          node: s.node,
          dockerSocket: s.dockerSocket,
          uid: s.uid,
          port: s.port,
        }),
      )
      .digest("hex");
    if (
      s.state !== state ||
      s.home !== home ||
      s.ownerId !== owner.id ||
      BigInt(s.uid) !== uid() ||
      configuration !== config.configuration ||
      configuration !== env.LOCALDOT_SERVICE_CONFIGURATION ||
      journal.id !== env.LOCALDOT_SERVICE_ATTEMPT ||
      !["starting", "validating", "running"].includes(journal.phase) ||
      !sameManagedService(identity, { ownerId: s.ownerId, release: config.release }) ||
      s.node !== runtime.node
    )
      throw failure();
    const job = journal.jobs.daemon;
    if (job.phase !== "starting" && job.phase !== "running") throw failure();
    if (job.phase === "running" && job.pid !== runtime.pid) throw failure();
    const entry = join(
      state,
      "releases",
      `${config.release.packageSha256}-${config.release.manifestSha256}`,
      "app",
      "dist",
      "daemon.mjs",
    );
    if (!runtime.entry || realpathSync(runtime.entry) !== entry) throw failure();
    const opened = fstatSync(fd, { bigint: true });
    const path = join(state, `service-${owner.id}-daemon.lock`),
      named = lstatSync(path, { bigint: true });
    if (
      [opened, named].some(
        (stat) =>
          !stat.isFile() ||
          stat.uid !== uid() ||
          stat.nlink !== 1n ||
          stat.size !== 0n ||
          (stat.mode & 0o7777n) !== 0o600n,
      ) ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    )
      throw failure();
    return fd;
  } catch {
    throw failure();
  }
}
