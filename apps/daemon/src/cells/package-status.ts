import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { type Manifest, OPEN_FILE, SystemMigrationConflict } from "./system-migration-plan.ts";

export const PACKAGE_STATUS = "/var/lib/dpkg/status";
export const AUTO_INSTALLED = "/var/lib/apt/extended_states";
export const PACKAGE_DATABASES = [PACKAGE_STATUS, AUTO_INSTALLED] as const;
type PackageDatabase = (typeof PACKAGE_DATABASES)[number];
// The field every record of each database has.
const REQUIRED: Record<PackageDatabase, string> = {
  [PACKAGE_STATUS]: "status",
  [AUTO_INSTALLED]: "auto-installed",
};
const LIMIT = 16 * 1024 * 1024;
type Sides<T> = [T, T, T];
type Records = Map<string, string>;

const conflict = (path: string) => new SystemMigrationConflict([path]);
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");

// Debian's package databases hold deb822 records keyed by package and architecture; neither is
// one app's file.
function parse(path: PackageDatabase, text: string): Records {
  if (Buffer.byteLength(text) > LIMIT || text.includes("\0") || text.includes("\r"))
    throw conflict(path);
  const records: Records = new Map();
  for (const record of text.trimEnd().split(/\n\n+/).filter(Boolean)) {
    const fields = new Map<string, string>();
    let previous = "";
    for (const line of record.split("\n")) {
      if (/^[ \t]/.test(line)) {
        if (!previous) throw conflict(path);
        continue;
      }
      const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
      if (!match) throw conflict(path);
      previous = (match[1] ?? "").toLowerCase();
      if (fields.has(previous)) throw conflict(path);
      fields.set(previous, match[2] ?? "");
    }
    const name = fields.get("package"),
      architecture = fields.get("architecture");
    if (
      !name ||
      !/^[a-z0-9][a-z0-9+.-]+$/.test(name) ||
      !architecture ||
      !/^[a-z0-9][a-z0-9-]*$/.test(architecture) ||
      !fields.has(REQUIRED[path])
    )
      throw conflict(path);
    const key = `${name}:${architecture}`;
    if (records.has(key)) throw conflict(path);
    records.set(key, record);
  }
  return records;
}

// Merge whole records only: mixing fields from two package versions can invent an installation
// that never existed. A record that both sides changed is a conflict unless `both` settles it;
// `packages` also counts a side's change to the package itself as a change to its record.
function merge(
  path: PackageDatabase,
  [before, next, now]: Sides<Records>,
  packages?: Sides<Records>,
  both?: (updated: string | undefined, installed: string | undefined) => string | undefined,
): string {
  const merged = new Map(now);
  for (const key of new Set([...before.keys(), ...next.keys(), ...(packages ? now.keys() : [])])) {
    const old = before.get(key),
      updated = next.get(key),
      installed = now.get(key);
    if (updated === installed) continue;
    const name = key.slice(0, key.indexOf(":"));
    const [was, upstream, local] = packages?.map((side) => side.get(name)) ?? [];
    if (old === updated && was === upstream) continue;
    let result = updated;
    if (old !== installed || was !== local) {
      if (!both) throw conflict(path);
      result = both(updated, installed);
    }
    if (result === undefined) merged.delete(key);
    else merged.set(key, result);
  }
  return [...merged.values()].map((record) => `${record}\n\n`).join("");
}

// Each package's status records for all its architectures, by name: APT keys a package for all
// architectures by the native one, where dpkg says "all".
function byName(records: Records): Records {
  const named: Records = new Map();
  for (const key of [...records.keys()].sort()) {
    const name = key.slice(0, key.indexOf(":"));
    named.set(name, `${named.get(name) ?? ""}${records.get(key)}\n\n`);
  }
  return named;
}

export function mergePackageStatus(...texts: Sides<string>): string {
  return merge(PACKAGE_STATUS, texts.map((text) => parse(PACKAGE_STATUS, text)) as Sides<Records>);
}

// No record, or a 0 mark, means the package was asked for by name.
const manual = (record: string | undefined) =>
  record === undefined || /^auto-installed:[ \t]*0[ \t]*$/im.test(record);

// APT's marks for packages installed only as dependencies, which autoremove may take away. When
// both sides installed or changed a package and disagree on its mark, it keeps the manual one:
// an automatic mark over an app the user asked for could later let autoremove delete it.
export function mergeAutoInstalled(texts: Sides<string>, status: Sides<string>): string {
  return merge(
    AUTO_INSTALLED,
    texts.map((text) => parse(AUTO_INSTALLED, text)) as Sides<Records>,
    status.map((text) => byName(parse(PACKAGE_STATUS, text))) as Sides<Records>,
    (updated, installed) => {
      if (manual(installed)) return installed;
      if (manual(updated)) return updated;
      throw conflict(AUTO_INSTALLED);
    },
  );
}

// The package databases that both the new system and the user changed.
export function changedDatabases(manifests: Sides<Manifest>): PackageDatabase[] {
  return PACKAGE_DATABASES.filter((path) => {
    const [base, target, current] = manifests.map((manifest) => manifest[path]);
    return (
      !!base &&
      !!target &&
      !!current &&
      !equal(base, target) &&
      !equal(base, current) &&
      !equal(target, current)
    );
  });
}

// Every text must be the exact file each scan saw.
export function mergePackageDatabases(
  paths: PackageDatabase[],
  manifests: Sides<Manifest>,
  texts: Record<string, string | null>[],
): Map<string, { entry: Manifest[string]; text: string }> {
  const read = (path: PackageDatabase) =>
    manifests.map((manifest, index) => {
      const entry = manifest[path],
        text = texts[index]?.[path];
      if (entry?.[0] !== "f" || typeof text !== "string" || entry[4] !== contentHash(text))
        throw conflict(path);
      return text;
    }) as Sides<string>;
  const merged = new Map<string, { entry: Manifest[string]; text: string }>();
  for (const path of paths) {
    const sides = read(path);
    const [base, target, current] = manifests.map((manifest) =>
      (manifest[path] as Manifest[string]).slice(0, 4),
    );
    // Keep local metadata when upstream did not change it; otherwise require agreement.
    if (!equal(base, target) && !equal(base, current) && !equal(target, current))
      throw conflict(path);
    const meta = (equal(base, target) ? manifests[2] : manifests[1])[path] as Manifest[string];
    const text =
      path === PACKAGE_STATUS
        ? mergePackageStatus(...sides)
        : mergeAutoInstalled(sides, read(PACKAGE_STATUS));
    merged.set(path, { entry: ["f", meta[1], meta[2], meta[3], contentHash(text)], text });
  }
  return merged;
}

// Anything but a plain readable file within the limit reads as null, and so cannot be merged.
export const READ_PACKAGE_DATABASES = `
import os, json, stat, errno
${OPEN_FILE}
texts = {}
for path in ${JSON.stringify(PACKAGE_DATABASES)}:
    texts[path] = None
    try: fd = open_file(path, os.O_RDONLY)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP, errno.EINVAL): continue
        raise
    with os.fdopen(fd, 'rb') as f: data = f.read(${LIMIT} + 1)
    if len(data) > ${LIMIT}: continue
    try: texts[path] = data.decode('utf-8')
    except UnicodeDecodeError: pass
print(json.dumps(texts))
`;
