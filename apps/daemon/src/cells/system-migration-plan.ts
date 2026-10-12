import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";

const Entry = z.tuple([
  z.enum(["f", "d", "l"]),
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.string(),
]);
export const Manifest = z.record(z.string(), Entry);
export type Manifest = z.infer<typeof Manifest>;
export class SystemMigrationConflict extends Error {
  constructor(readonly paths: string[]) {
    super("An installed app changed files needed by this update. Nothing was replaced.");
  }
}

// Start from the user's whole system. Apply only upstream changes whose previous contents are
// still intact. User additions/deletions outside that delta never need to be reconstructed.
export function migrationPlan(base: Manifest, target: Manifest, current: Manifest) {
  const copy: string[] = [],
    remove: string[] = [],
    directories: string[] = [],
    conflicts: string[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(target)])) {
    if (!safePath(path)) throw new Error("Invalid migration path");
    const before = base[path],
      next = target[path],
      now = current[path];
    if (equal(before, next) || equal(now, next)) continue;
    if (!equal(before, now)) {
      // Directory contents are represented by their own entries; the directory's metadata can
      // stay user-owned without losing new children. File/type conflicts must be resolved first.
      if (before?.[0] === "d" && next?.[0] === "d" && now?.[0] === "d") continue;
      conflicts.push(path);
    } else if (!next) remove.push(path);
    else if (next[0] === "d") directories.push(path);
    else copy.push(path);
  }
  if (conflicts.length) throw new SystemMigrationConflict(conflicts);
  // A changed ancestor may otherwise route a copy through a user-created symlink.
  for (const path of [...copy, ...directories]) {
    for (
      let parent = path.slice(0, path.lastIndexOf("/"));
      parent;
      parent = parent.slice(0, parent.lastIndexOf("/"))
    ) {
      if (current[parent]?.[0] === "l" && target[parent]?.[0] !== "l")
        throw new SystemMigrationConflict([parent]);
    }
  }
  return {
    copy,
    remove: remove.sort((a, b) => b.length - a.length),
    directories: directories.sort((a, b) => a.length - b.length),
  };
}
// Check the committed candidate against the complete saved system, including files unrelated
// to the update. This catches archive omissions and metadata changes before the original retires.
export function verifyMigration(
  current: Manifest,
  target: Manifest,
  actual: Manifest,
  plan: ReturnType<typeof migrationPlan>,
): void {
  const expected = { ...current };
  for (const path of plan.remove) {
    if (
      expected[path]?.[0] !== "d" ||
      !Object.keys(expected).some((key) => key.startsWith(`${path}/`))
    )
      delete expected[path];
  }
  for (const path of [...plan.directories, ...plan.copy]) {
    const entry = target[path];
    if (!entry) throw new Error("Missing migration source");
    expected[path] = entry;
  }
  if (!equal(expected, actual))
    throw new Error("Computer update verification failed; the original computer was kept");
}

export function safePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    path !== "/" &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

// No timestamps: image rebuilds and ordinary boot writes must not look like content changes.
// No user volume or pseudo filesystem is mounted in a migration helper.
export const SCAN_SYSTEM = `
import os, stat, hashlib, json
skip = {'/proc','/sys','/dev','/run','/tmp','/config','/var/log','/etc/hosts','/etc/hostname','/etc/resolv.conf','/.dockerenv','/var/lib/dpkg/status-old'}
result = {}
def walk(root):
    for entry in os.scandir(root):
        p = entry.path
        if p in skip: continue
        s = entry.stat(follow_symlinks=False)
        mode = stat.S_IMODE(s.st_mode)
        if stat.S_ISLNK(s.st_mode): kind, content = 'l', os.readlink(p)
        elif stat.S_ISDIR(s.st_mode): kind, content = 'd', ''
        elif stat.S_ISREG(s.st_mode):
            kind = 'f'
            with open(p, 'rb') as f: content = hashlib.file_digest(f, 'sha256').hexdigest()
        else: continue
        result[p] = [kind,mode,s.st_uid,s.st_gid,content]
        if kind == 'd': walk(p)
walk('/')
print(json.dumps(result, separators=(',',':')))
`;

export const PREPARE_SYSTEM = `
import os, sys, json, stat
with open(sys.argv[1]) as f: plan = json.load(f)
os.unlink(sys.argv[1])
for p in plan['remove']:
    if os.path.isdir(p) and not os.path.islink(p):
        try: os.rmdir(p)
        except OSError: pass # user files in a removed upstream directory are retained
    elif os.path.lexists(p): os.unlink(p)
for p, meta in plan['directories']:
    if os.path.lexists(p) and not os.path.isdir(p): os.unlink(p)
    os.makedirs(p, exist_ok=True)
    os.chown(p, meta[2], meta[3]); os.chmod(p, meta[1])
print('prepared')
`;

export const ARCHIVE_SYSTEM = String.raw`
import os, sys, json, subprocess
with open(sys.argv[1]) as f: paths = json.load(f)
os.unlink(sys.argv[1])
with open('/tmp/localdot-update-paths', 'wb') as f:
    for p in paths: f.write(p.lstrip('/').encode() + b'\0')
subprocess.run(['tar','--xattrs','--acls','--numeric-owner','--no-recursion','-C','/','-cf','/tmp/localdot-update.tar','--null','-T','/tmp/localdot-update-paths'], check=True)
print('archived')
`;
