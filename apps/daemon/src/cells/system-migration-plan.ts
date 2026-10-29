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
export const SYSTEM_BASE_MISSING =
  "The previous system image is missing from Docker. Restore it before updating this computer. Your apps and files are unchanged.";
export class SystemBaseMissing extends Error {
  constructor(readonly image: string) {
    super(SYSTEM_BASE_MISSING);
  }
}
export class SystemMigrationConflict extends Error {
  constructor(readonly paths: string[]) {
    super("An installed app changed files needed by this update. Nothing was replaced.");
  }
}

// ldconfig's private record of the libraries it has read, keyed by each file's identity. It checks
// every entry against the file it names and reads changed files again, so the user's copy stays.
export const LIBRARY_ID_CACHE = "/var/cache/ldconfig/aux-cache";
// The loader's index of the libraries present, which ldconfig derives from them alone.
export const LIBRARY_CACHE = "/etc/ld.so.cache";
// What ldconfig writes as root, with the modes it gives them.
const LDCONFIG_OUTPUT: Record<string, number> = {
  [LIBRARY_CACHE]: 0o644,
  [LIBRARY_ID_CACHE]: 0o600,
};

// Start from the user's whole system. Apply only upstream changes whose previous contents are
// still intact. User additions/deletions outside that delta never need to be reconstructed.
export function migrationPlan(base: Manifest, target: Manifest, current: Manifest) {
  const copy: string[] = [],
    remove: string[] = [],
    directories: string[] = [],
    conflicts: string[] = [];
  let ldconfig = false;
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
      if (path === LIBRARY_ID_CACHE) continue;
      // Neither side's index lists the other's libraries; rebuild it from both once they are in.
      if (path === LIBRARY_CACHE && [before, next, now].every((entry) => entry?.[0] === "f"))
        ldconfig = true;
      else conflicts.push(path);
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
  const rebuilt = (path: string) => ldconfig && path in LDCONFIG_OUTPUT;
  return {
    copy: copy.filter((path) => !rebuilt(path)),
    remove: remove.filter((path) => !rebuilt(path)).sort((a, b) => b.length - a.length),
    directories: directories.sort((a, b) => a.length - b.length),
    ldconfig,
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
  // ldconfig's output depends on the merged libraries, so only how it was written can be checked.
  if (plan.ldconfig)
    for (const [path, mode] of Object.entries(LDCONFIG_OUTPUT)) {
      const entry = actual[path];
      if (entry?.[0] !== "f" || entry[1] !== mode || entry[2] !== 0 || entry[3] !== 0)
        throw unverified();
      expected[path] = entry;
    }
  if (!equal(expected, actual)) throw unverified();
}
const unverified = () =>
  new Error("Computer update verification failed; the original computer was kept");

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

// Opens a regular file from the root without following a symlink substituted for any part of it.
export const OPEN_FILE = `
def open_file(path, flags):
    parts = path.strip('/').split('/')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            fd, parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd), fd
            os.close(parent)
        if not stat.S_ISREG(os.stat(parts[-1], dir_fd=fd, follow_symlinks=False).st_mode):
            raise OSError(errno.EINVAL, 'not a regular file', path)
        return os.open(parts[-1], flags | os.O_NOFOLLOW, dir_fd=fd)
    finally:
        os.close(fd)
`;

// Runs in the private clone only. A second run, once the new files are in, rebuilds the loader's
// index without touching library links.
export const PREPARE_SYSTEM = `
import os, sys, json, stat, errno, subprocess
${OPEN_FILE}
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
for p, merged in plan.get('packageDatabases', {}).items():
    with os.fdopen(open_file(p, os.O_WRONLY | os.O_TRUNC), 'wb') as f:
        f.write(merged['text'].encode('utf-8'))
        os.fchown(f.fileno(), merged['entry'][2], merged['entry'][3])
        os.fchmod(f.fileno(), merged['entry'][1])
if plan.get('ldconfig'):
    subprocess.run(['/sbin/ldconfig', '-X'], check=True, stdout=subprocess.DEVNULL)
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
