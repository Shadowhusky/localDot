import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { type Manifest, SystemMigrationConflict } from "./system-migration-plan.ts";

export const PACKAGE_STATUS = "/var/lib/dpkg/status";
const conflict = () => new SystemMigrationConflict([PACKAGE_STATUS]);
export const statusHash = (text: string) => createHash("sha256").update(text).digest("hex");

// Debian's status file is a database of deb822 package records, not one app's file.
// Merge whole records only: mixing fields from two package versions can invent an
// installation that never existed. The ordinary filesystem merge still verifies
// every package file, maintainer script and ownership list independently.
export function mergePackageStatus(base: string, target: string, current: string): string {
  const parse = (text: string) => {
    if (Buffer.byteLength(text) > 16 * 1024 * 1024 || text.includes("\0") || text.includes("\r"))
      throw conflict();
    const records = new Map<string, string>();
    for (const record of text.trimEnd().split(/\n\n+/).filter(Boolean)) {
      const fields = new Map<string, string>();
      let previous = "";
      for (const line of record.split("\n")) {
        if (/^[ \t]/.test(line)) {
          if (!previous) throw conflict();
          continue;
        }
        const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
        if (!match) throw conflict();
        previous = (match[1] ?? "").toLowerCase();
        if (fields.has(previous)) throw conflict();
        fields.set(previous, match[2] ?? "");
      }
      const name = fields.get("package"),
        architecture = fields.get("architecture");
      if (
        !name ||
        !/^[a-z0-9][a-z0-9+.-]+$/.test(name) ||
        !architecture ||
        !/^[a-z0-9][a-z0-9-]*$/.test(architecture) ||
        !fields.has("status")
      )
        throw conflict();
      const key = `${name}:${architecture}`;
      if (records.has(key)) throw conflict();
      records.set(key, record);
    }
    return records;
  };
  const before = parse(base),
    next = parse(target),
    now = parse(current);
  const merged = new Map(now);
  for (const key of new Set([...before.keys(), ...next.keys()])) {
    const old = before.get(key),
      updated = next.get(key),
      installed = now.get(key);
    if (old === updated || installed === updated) continue;
    if (old !== installed) throw conflict();
    if (updated === undefined) merged.delete(key);
    else merged.set(key, updated);
  }
  return [...merged.values()].map((record) => `${record}\n\n`).join("");
}

export function mergedStatusEntry(
  entries: [Manifest[string], Manifest[string], Manifest[string]],
  texts: [string, string, string],
): { entry: Manifest[string]; text: string } {
  if (
    entries.some((entry, index) => entry[0] !== "f" || entry[4] !== statusHash(texts[index] ?? ""))
  )
    throw conflict();
  const [base, target, current] = entries;
  const metadata = (entry: Manifest[string]) => entry.slice(0, 4);
  // Keep local metadata when upstream did not change it; otherwise require agreement.
  const meta = equal(metadata(base), metadata(target)) ? current : target;
  if (
    !equal(metadata(base), metadata(target)) &&
    !equal(metadata(base), metadata(current)) &&
    !equal(metadata(target), metadata(current))
  )
    throw conflict();
  const text = mergePackageStatus(...texts);
  return { entry: ["f", meta[1], meta[2], meta[3], statusHash(text)], text };
}

export const READ_PACKAGE_STATUS = `
import os, json, stat
fd = os.open('/var/lib/dpkg/status', os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as f:
    assert stat.S_ISREG(os.fstat(f.fileno()).st_mode)
    data = f.read(16 * 1024 * 1024 + 1)
    assert len(data) <= 16 * 1024 * 1024
print(json.dumps(data.decode('utf-8')))
`;
