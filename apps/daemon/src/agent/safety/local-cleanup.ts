import type { ShellInput } from "@localdot/protocol";
import type { ToolCallContext, ToolDeps } from "../tools/deps.ts";
import { commandLines } from "./classify.ts";

export interface LocalCleanup {
  command: string;
  riskCommand: string;
}
type Fingerprint = { identity: string; content: string };
type Observation = {
  path: string;
  state: "missing" | "file" | "unsafe";
  fingerprint?: Fingerprint;
};
type Tracking = { before: Observation[]; paths: string[]; cwd?: string };
const owned = new WeakMap<object, Map<string, Fingerprint>>();
const WORD = String.raw`(?:'[^'\r\n]*'|"[^"$\x60\\\r\n]*"|[A-Za-z0-9_./~:@%+=,-]+)`;
const PREFIX = new RegExp(String.raw`^\s*(?:cd\s+(${WORD})\s*&&\s*)?rm\s+`);
const TOKEN = new RegExp(String.raw`^(${WORD})(?=\s|&&|$)`);
const CD = new RegExp(String.raw`^\s*cd\s+(${WORD})\s*&&\s*`);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function literal(word: string): string | undefined {
  const value = /^["']/.test(word) ? word.slice(1, -1) : word;
  if (!value || /[\0\r\n$`*?[\]\\]/.test(value)) return;
  if (value.startsWith("~") && !word.startsWith("~/")) return;
  if (value.split("/").some((part) => part === "..")) return;
  return value;
}

// Only a leading literal rm is eligible. All tail effects retain normal policy.
export function cleanupSyntax(input: ShellInput) {
  const match = PREFIX.exec(input.command);
  if (!match || (match[1] && literal(match[1]) === undefined)) return;
  let rest = input.command.slice(match[0].length);
  const paths: string[] = [];
  let options = true;
  while (rest && !rest.startsWith("&&")) {
    const token = TOKEN.exec(rest);
    if (!token) return;
    const word = token[1] ?? "";
    const value = literal(word);
    if (value === undefined) return;
    if (options && word === "-f") {
      /* Accepted flag; missing targets remain unverified. */
    } else if (options && word === "--") options = false;
    else {
      if (options && value.startsWith("-")) return;
      if (value.endsWith("/") || value === "." || value === "~") return;
      paths.push(value);
    }
    rest = rest.slice(token[0].length).trimStart();
  }
  if (!paths.length || paths.length > 32 || (rest && !rest.slice(2).trim())) return;
  const prefix = match[1] ? `cd ${match[1]} && ` : "";
  const suffix = rest ? ` ${rest}` : "";
  return { paths, prefix, suffix };
}

// Candidate discovery does not grant ownership. A trusted before/after probe
// must establish absence, creation and unchanged identity/content. Keep this
// intentionally small; unknown writers continue through ordinary approval.
export function creationCandidates(input: ShellInput): { paths: string[]; prefix: string } {
  const cd = CD.exec(input.command);
  const prefix = cd && literal(cd[1] ?? "") !== undefined ? cd[0] : "";
  const command = input.command.slice(prefix.length);
  const paths = new Set<string>();
  const redirect = new RegExp(String.raw`^\s*(?:cat|printf|echo)\s*>\s*(${WORD})(?=\s|$)`).exec(
    command,
  );
  if (redirect?.[1]) {
    const path = literal(redirect[1]);
    if (path) paths.add(path);
  }
  for (const { runs } of commandLines(command)) {
    for (const words of runs) {
      const name = words[0]?.replace(/^.*\//, "");
      if (name !== "ffmpeg" && name !== "import" && name !== "convert") continue;
      const output = words.at(-1);
      if (!output || output.startsWith("-")) continue;
      const path = literal(output);
      if (path) paths.add(path);
    }
  }
  return { paths: [...paths].slice(0, 32), prefix };
}

const same = (a?: Fingerprint, b?: Fingerprint) =>
  a !== undefined && b !== undefined && a.identity === b.identity && a.content === b.content;

async function observe(
  deps: ToolDeps,
  ctx: ToolCallContext,
  paths: string[],
  prefix = "",
  cwd?: string,
): Promise<Observation[]> {
  if (!paths.length) return [];
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop || typeof desktop.shell !== "function") return [];
  let output = "";
  const result = await desktop.shell(
    {
      command: `${prefix}${python({ paths, mode: "observe" })}`,
      ...(cwd ? { cwd } : {}),
      timeoutMs: 5000,
    },
    (chunk) => {
      if (output.length < 64 * 1024) output += chunk.chunk;
    },
    ctx.signal,
  );
  ctx.check();
  if (result.exitCode !== 0 || result.timedOut || result.truncated) return [];
  try {
    const data = JSON.parse(output) as Observation[];
    return Array.isArray(data) && data.length === paths.length ? data : [];
  } catch {
    return [];
  }
}

export async function beginFileTracking(
  deps: ToolDeps,
  ctx: ToolCallContext,
  paths: string[],
  prefix = "",
  cwd?: string,
): Promise<Tracking> {
  if (ctx.session.permissionMode() === "custom") return { before: [], paths: [] };
  const before = await observe(deps, ctx, paths, prefix, cwd);
  return { before, paths: before.map((item) => item.path), cwd };
}

export async function finishFileTracking(
  deps: ToolDeps,
  ctx: ToolCallContext,
  track: Tracking,
): Promise<void> {
  const after = await observe(deps, ctx, track.paths, "", track.cwd);
  const files = owned.get(ctx.session) ?? new Map<string, Fingerprint>();
  owned.set(ctx.session, files);
  for (const previous of track.before) {
    const next = after.find((item) => item.path === previous.path);
    const ours =
      previous.state === "missing" || same(files.get(previous.path), previous.fingerprint);
    files.delete(previous.path);
    if (ours && next?.state === "file" && next.fingerprint && files.size < 256)
      files.set(previous.path, next.fingerprint);
  }
}

export async function prepareLocalCleanup(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: ShellInput,
): Promise<LocalCleanup | undefined> {
  const syntax = cleanupSyntax(input);
  const files = owned.get(ctx.session);
  if (!syntax || !files?.size) return;
  const current = await observe(deps, ctx, syntax.paths, syntax.prefix, input.cwd);
  if (current.length !== syntax.paths.length) return;
  for (const item of current) {
    if (item.state !== "file" || !same(files.get(item.path), item.fingerprint)) {
      files.delete(item.path);
      return;
    }
  }
  return {
    command: `${syntax.prefix}${python({ paths: current.map((item) => item.path), expected: current, mode: "recover", sessionId: ctx.session.id })}${syntax.suffix}`,
    riskCommand: `${syntax.prefix}true${syntax.suffix}`,
  };
}

function python(request: unknown): string {
  return `/usr/bin/python3 -c ${quote(FILE_HELPER)} ${quote(Buffer.from(JSON.stringify(request)).toString("base64"))}`;
}

// No shell interpolation of paths. Probe every component without following
// symlinks and hash bounded regular files. Recheck at execution, retain bytes in
// a fresh directory, and write a durable manifest before any move. No purge.
const FILE_HELPER = `
import base64, hashlib, json, os, stat, sys, uuid
request = json.loads(base64.b64decode(sys.argv[1]))
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def directory(path, create=False):
    fd = os.open('/', flags)
    try:
        for part in path.split('/'):
            if not part: continue
            if part in ('.', '..'): raise ValueError('Unsafe cleanup path')
            if create:
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def inspect(path, anchored=None):
    path = os.path.abspath(os.path.expanduser(path))
    result = {'path': path, 'state': 'unsafe'}
    parent = anchored
    fd = None
    try:
        if parent is None: parent = directory(os.path.dirname(path))
        fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16 * 1024 * 1024: return result
        digest = hashlib.sha256()
        left = 16 * 1024 * 1024 + 1
        while left:
            data = os.read(fd, min(left, 65536))
            if not data: break
            digest.update(data)
            left -= len(data)
        if left == 0 or any(getattr(os.fstat(fd), k) != getattr(info, k) for k in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')): return result
        result.update(state='file', fingerprint={'identity': str((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)), 'content': digest.hexdigest()})
    except FileNotFoundError:
        result['state'] = 'missing'
    except OSError:
        pass
    finally:
        if fd is not None: os.close(fd)
        if parent is not None and anchored is None: os.close(parent)
    return result

observed = [inspect(path) for path in request['paths']]
if request['mode'] == 'observe':
    print(json.dumps(observed))
else:
    if observed != request['expected']: raise ValueError('Cleanup target changed; inspect it again before continuing')
    recovery = os.path.join(os.path.expanduser('~'), '.local', 'share', 'localdot', 'recovered-files', request['sessionId'], uuid.uuid4().hex)
    dest = directory(recovery, True)
    try:
        entries = [{'original': item['path'], 'saved': str(i)} for i, item in enumerate(observed)]
        manifest = os.open('manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dest)
        with os.fdopen(manifest, 'w') as out:
            json.dump(entries, out)
            out.flush()
            os.fsync(out.fileno())
        for i, item in enumerate(observed):
            path = item['path']
            parent = directory(os.path.dirname(path))
            try:
                if inspect(path, parent) != item: raise ValueError('Cleanup target changed; inspect it again before continuing')
                os.rename(os.path.basename(path), str(i), src_dir_fd=parent, dst_dir_fd=dest)
                saved = inspect(os.path.join(recovery, str(i)), dest)
                original = item['fingerprint']
                current = saved.get('fingerprint', {})
                # Rename can change ctime, but not inode, content, size or mtime.
                if current.get('content') != original['content'] or current.get('identity', '').rsplit(', ', 1)[0] != original['identity'].rsplit(', ', 1)[0]:
                    try:
                        os.link(str(i), os.path.basename(path), src_dir_fd=dest, dst_dir_fd=parent, follow_symlinks=False)
                        os.unlink(str(i), dir_fd=dest)
                    except OSError:
                        print('Changed file retained at ' + os.path.join(recovery, str(i)), flush=True)
                    raise ValueError('Cleanup target changed during removal; no bytes were destroyed')
                os.fsync(dest)
                os.fsync(parent)
                print('Removed ' + path + '; recoverable at ' + os.path.join(recovery, str(i)), flush=True)
            finally:
                os.close(parent)
        print('Recovery manifest: ' + os.path.join(recovery, 'manifest.json'), flush=True)
    finally:
        os.close(dest)
`;
