import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  assertOwnedCodexDirectory,
  assertOwnedCodexRoots,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  persistOwnedCodexProfile,
} from "./roots.ts";

const integer = z.string().regex(/^(?:0|[1-9][0-9]{0,24})$/);
const identity = z.object({ dev: integer, ino: integer, birthtimeNs: integer }).strict();
const ownedName = z.string().regex(/^\.owned-[A-Za-z0-9]{6}$/);
const named = z.object({ name: ownedName, identity }).strict();

/** A private daemon-written receipt, never an assertion supplied by a native task. Names are
 * bounded locators within fixed areas; all directory identities must still match during recovery.
 * The protected receipt lives outside the work/run paths which native code can use.
 */
export const NativeRetirementRecord = z
  .object({
    v: z.literal(1),
    phase: z.literal("retired"),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    parents: z
      .object({ home: identity, root: identity, profiles: identity, work: identity, run: identity })
      .strict(),
    profile: named,
    work: named,
    bridge: z
      .object({ name: z.string().regex(/^[a-f0-9]{32}$/), identity })
      .strict()
      .nullable(),
  })
  .strict();
export type NativeRetirementRecord = z.infer<typeof NativeRetirementRecord>;

export class NativeRetirementRecordError extends Error {
  constructor() {
    super("Native retirement evidence could not be persisted.");
    this.name = "NativeRetirementRecordError";
  }
}

async function directoryIdentity(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(process.getuid?.() ?? -1) ||
    (stat.mode & 0o7777n) !== 0o700n
  )
    throw new NativeRetirementRecordError();
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

type Resources = Readonly<{
  profile: OwnedCodexDirectory;
  work: OwnedCodexDirectory;
  bridge?: OwnedCodexDirectory;
}>;

export interface NativeRetirementReceipt {
  readonly name: string;
  readonly record: NativeRetirementRecord;
  finish(): Promise<void>;
}
export interface PreparedNativeRetirement {
  readonly supervision?: NativeSupervision;
  persist(retirement: Promise<void>): Promise<NativeRetirementReceipt>;
}
export interface NativeSupervision {
  readonly home: string;
  readonly record: NativeRetirementRecord;
  /** Shared directory lease; retained by this owner until normal resource cleanup finishes. */
  readonly descriptor: number;
}

/** Convenience for already-retired resources which are still owned and present. Production
 * launchers prepare before spawning because the separate bridge owner may clean up earlier. */
export async function persistNativeRetirement(
  roots: OwnedCodexRoots,
  resourcesInput: Resources,
  retirement: Promise<void>,
): Promise<NativeRetirementReceipt> {
  const resources = Object.freeze({ ...resourcesInput });
  try {
    await retirement;
    return await (await prepareNativeRetirement(roots, resources)).persist(retirement);
  } catch {
    throw new NativeRetirementRecordError();
  }
}

/** Capture exact resources before spawn. No receipt is written until actual combined startup,
 * process-group and pipe retirement resolves. The bridge may then be absent because its separate
 * owner closed it; a replacement is never accepted. The returned receipt outlives both cleanup
 * owners and may be removed only when all recorded resources are absent. No process is signalled.
 */
export async function prepareNativeRetirement(
  roots: OwnedCodexRoots,
  resourcesInput: Resources,
  supervised = false,
): Promise<PreparedNativeRetirement> {
  const resources = Object.freeze({ ...resourcesInput });
  let resourceLease: FileHandle | undefined;
  try {
    const nonce = randomBytes(16).toString("hex");
    const parents = async () => ({
      home: await directoryIdentity(dirname(roots.root)),
      root: await directoryIdentity(roots.root),
      profiles: await directoryIdentity(roots.profilesRoot),
      work: await directoryIdentity(roots.workRoot),
      run: await directoryIdentity(roots.runRoot),
    });
    async function bridge(expected?: NativeRetirementRecord) {
      if (!resources.bridge) return null;
      // Only initial lstat ENOENT means absence. A dangling link or failed ownership assertion
      // must not be mistaken for an independently completed bridge cleanup.
      try {
        await lstat(resources.bridge.path);
      } catch (error) {
        if (
          expected?.bridge &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return expected.bridge;
        throw error;
      }
      try {
        assertOwnedCodexDirectory(roots, resources.bridge, "runRoot");
        const result = {
          name: basename(resources.bridge.path),
          identity: await directoryIdentity(resources.bridge.path),
        };
        assertOwnedCodexDirectory(roots, resources.bridge, "runRoot");
        return result;
      } catch (error) {
        if (
          expected?.bridge &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          try {
            await lstat(resources.bridge.path);
          } catch (absent) {
            if (absent instanceof Error && "code" in absent && absent.code === "ENOENT")
              return expected.bridge;
          }
        }
        throw error;
      }
    }
    async function snapshot(expected?: NativeRetirementRecord): Promise<NativeRetirementRecord> {
      assertOwnedCodexRoots(roots);
      assertOwnedCodexDirectory(roots, resources.profile, "profilesRoot");
      assertOwnedCodexDirectory(roots, resources.work, "workRoot");
      const record = NativeRetirementRecord.parse({
        v: 1,
        phase: "retired",
        nonce,
        parents: await parents(),
        profile: {
          name: basename(resources.profile.path),
          identity: await directoryIdentity(resources.profile.path),
        },
        work: {
          name: basename(resources.work.path),
          identity: await directoryIdentity(resources.work.path),
        },
        bridge: await bridge(expected),
      });
      assertOwnedCodexRoots(roots);
      assertOwnedCodexDirectory(roots, resources.profile, "profilesRoot");
      assertOwnedCodexDirectory(roots, resources.work, "workRoot");
      if (JSON.stringify(await bridge(expected)) !== JSON.stringify(record.bridge))
        throw new NativeRetirementRecordError();
      return record;
    }
    const record = await snapshot();
    if (supervised) {
      resourceLease = await open(
        roots.profilesRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const st = await resourceLease.stat({ bigint: true });
      if (
        !st.isDirectory() ||
        JSON.stringify({
          dev: String(st.dev),
          ino: String(st.ino),
          birthtimeNs: String(st.birthtimeNs),
        }) !== JSON.stringify(record.parents.profiles)
      )
        throw new NativeRetirementRecordError();
    }
    async function persist(retirement: Promise<void>): Promise<NativeRetirementReceipt> {
      try {
        await retirement;
        if (JSON.stringify(await snapshot(record)) !== JSON.stringify(record))
          throw new NativeRetirementRecordError();
        const name = `.retired-${nonce}.json`,
          path = join(roots.profilesRoot, name),
          temporary = join(roots.profilesRoot, `.retiring-${nonce}.tmp`);
        const body = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(body) > 8192) throw new NativeRetirementRecordError();
        let before: Stats | undefined;
        let present: Stats | undefined;
        try {
          present = await lstat(path);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        if (present) {
          if (
            !supervised ||
            !present.isFile() ||
            present.nlink !== 1 ||
            present.uid !== process.getuid?.() ||
            (present.mode & 0o7777) !== 0o600 ||
            present.size !== Buffer.byteLength(body)
          )
            throw new NativeRetirementRecordError();
          const fd = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const opened = await fd.stat();
            const bytes = Buffer.alloc(8193),
              { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
            const after = await fd.stat();
            if (
              [opened, after].some(
                (s) =>
                  s.dev !== present.dev ||
                  s.ino !== present.ino ||
                  s.size !== present.size ||
                  s.mode !== present.mode ||
                  s.nlink !== 1 ||
                  s.mtimeMs !== present.mtimeMs ||
                  s.ctimeMs !== present.ctimeMs,
              ) ||
              bytesRead !== Buffer.byteLength(body) ||
              !bytes.subarray(0, bytesRead).equals(Buffer.from(body))
            )
              throw new NativeRetirementRecordError();
            before = opened;
          } finally {
            await fd.close();
          }
        }
        if (supervised) {
          // An active record is never promoted by the daemon merely because a pipe went away.
          // The helper must publish it after its kernel retirement proof; otherwise retain it.
          try {
            await lstat(join(roots.profilesRoot, `.active-${nonce}.json`));
            throw new NativeRetirementRecordError();
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
              throw error;
          }
        }
        if (!before) {
          // Confirmed pre-spawn refusal can have no helper record. The established daemon-side
          // retirement path handles that case only after the complete retirement promise resolves.
          const file = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            before = await file.stat();
            await file.writeFile(body);
            await file.sync();
          } finally {
            await file.close();
          }
          const staged = await lstat(temporary);
          if (
            !staged.isFile() ||
            staged.nlink !== 1 ||
            staged.dev !== before.dev ||
            staged.ino !== before.ino ||
            staged.uid !== process.getuid?.() ||
            (staged.mode & 0o7777) !== 0o600 ||
            staged.size !== Buffer.byteLength(body)
          )
            throw new NativeRetirementRecordError();
          if (JSON.stringify(await snapshot(record)) !== JSON.stringify(record))
            throw new NativeRetirementRecordError();
          await rename(temporary, path);
        }
        await persistOwnedCodexProfile(roots, resources.profile);
        if (JSON.stringify(await snapshot(record)) !== JSON.stringify(record))
          throw new NativeRetirementRecordError();
        const published = await lstat(path);
        if (
          !published.isFile() ||
          published.nlink !== 1 ||
          published.dev !== before.dev ||
          published.ino !== before.ino ||
          published.uid !== process.getuid?.() ||
          (published.mode & 0o7777) !== 0o600 ||
          published.size !== Buffer.byteLength(body)
        )
          throw new NativeRetirementRecordError();
        const checkParents = async () => {
          assertOwnedCodexRoots(roots);
          if (JSON.stringify(await parents()) !== JSON.stringify(record.parents))
            throw new NativeRetirementRecordError();
        };
        const absentResources = async () => {
          for (const resource of [
            resources.profile,
            resources.work,
            ...(resources.bridge ? [resources.bridge] : []),
          ]) {
            try {
              await lstat(resource.path);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
              throw error;
            }
            throw new NativeRetirementRecordError();
          }
        };
        const syncParents = async (resourcesToo = false) => {
          for (const parent of [
            ...(resourcesToo ? [roots.workRoot, roots.runRoot] : []),
            roots.profilesRoot,
            roots.root,
            dirname(roots.root),
          ]) {
            await checkParents();
            const expected = await directoryIdentity(parent);
            const fd = await open(
              parent,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            try {
              const stat = await fd.stat({ bigint: true });
              if (
                !stat.isDirectory() ||
                JSON.stringify({
                  dev: String(stat.dev),
                  ino: String(stat.ino),
                  birthtimeNs: String(stat.birthtimeNs),
                }) !== JSON.stringify(expected)
              )
                throw new NativeRetirementRecordError();
              await fd.sync();
              await checkParents();
            } finally {
              await fd.close();
            }
          }
        };
        let finishing: Promise<void> | undefined;
        const finish = async () => {
          try {
            await checkParents();
            await absentResources();
            await syncParents(true);
            await absentResources();
            const now = await lstat(path);
            if (
              !now.isFile() ||
              now.nlink !== 1 ||
              now.uid !== published.uid ||
              now.mode !== published.mode ||
              now.dev !== published.dev ||
              now.ino !== published.ino ||
              now.size !== published.size ||
              now.mtimeMs !== published.mtimeMs ||
              now.ctimeMs !== published.ctimeMs
            )
              throw new NativeRetirementRecordError();
            await checkParents();
            await unlink(path);
            await syncParents();
            await absentResources();
            try {
              await lstat(path);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                await resourceLease?.close();
                resourceLease = undefined;
                return;
              }
              throw error;
            }
            throw new NativeRetirementRecordError();
          } catch {
            throw new NativeRetirementRecordError();
          }
        };
        return Object.freeze({
          name,
          record: structuredClone(record),
          finish: () => (finishing ??= finish()),
        });
      } catch {
        throw new NativeRetirementRecordError();
      }
    }
    let persisted: Promise<NativeRetirementReceipt> | undefined;
    return Object.freeze({
      ...(resourceLease
        ? {
            supervision: Object.freeze({
              home: dirname(roots.root),
              get record() {
                return structuredClone(record);
              },
              get descriptor() {
                if (!resourceLease || resourceLease.fd < 0) throw new NativeRetirementRecordError();
                return resourceLease.fd;
              },
            }),
          }
        : {}),
      persist: (retirement: Promise<void>) => {
        // Consume repeated promise rejection without changing the first retirement decision.
        void retirement.catch(() => {});
        persisted ??= persist(retirement);
        return persisted;
      },
    });
  } catch {
    await resourceLease?.close();
    // Keep uncertain evidence and every resource. Neither a partial file nor a failed fsync may
    // become permission to remove a profile, work directory or bridge.
    throw new NativeRetirementRecordError();
  }
}
