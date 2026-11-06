import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";

const LISTEN = "0A";
const ESTABLISHED = "01";
// Where installed apps name themselves for the user, as the desktop's launcher lists them.
export const APP_DIRS = ["/usr/share/applications", "/config/.local/share/applications"];

interface SocketRow {
  address: string;
  port: number;
  listening: boolean;
  established: boolean;
  inode: string;
}

// What a listening socket's process says about itself, read once: it lasts as long as the socket.
export interface SocketOwner {
  pid?: number;
  name?: string;
  task?: string;
  project?: string;
  started?: number;
}

export interface ListeningSocket extends Omit<SocketOwner, "pid"> {
  address: string;
  port: number;
  cpu?: number;
  clients?: number;
}

const TASK_VARIABLE = "LOCALDOT_TASK=";
const TASK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_HOME = process.env.LOCALDOT_HOME_DIR ?? "/config";
const PROJECT_CHARS = 256;
const STOP_WAIT_MS = 3000;
const STOP_POLL_MS = 100;

// The program holding the TCP connection from a local port, found as ss -p finds it: the socket's
// inode in /proc/net/tcp, then the process with that inode among its open files. desktopd reads
// only its own user's processes, which run every program the user and the agent start; for any
// other the answer is unknown.
export async function connectionOwner(
  port: number,
  proc = "/proc",
  apps: readonly string[] = APP_DIRS,
): Promise<string | undefined> {
  const inodes = new Set(
    (await socketRows(proc))
      .filter((row) => !row.listening && row.port === port)
      .map((row) => row.inode),
  );
  if (!inodes.size) return undefined;
  for (const owner of (await socketOwners(inodes, proc, apps, undefined, 1)).values())
    if (owner.name) return owner.name;
  return undefined;
}

// Every listening TCP socket on a `wanted` port, once per address and port, with what its process
// says of itself when it is one of this user's, and how many connections it has open. Finding a
// process reads every process's open files, so `owners` keeps them by socket for the next listing.
export async function listeningSockets(
  proc = "/proc",
  apps: readonly string[] = APP_DIRS,
  wanted: (port: number) => boolean = () => true,
  owners = new Map<string, SocketOwner>(),
  home = DEFAULT_HOME,
): Promise<ListeningSocket[]> {
  const rows = new Map<string, SocketRow>();
  const clients = new Map<number, number>();
  for (const row of await socketRows(proc)) {
    if (row.established) clients.set(row.port, (clients.get(row.port) ?? 0) + 1);
    const key = `${row.address} ${row.port}`;
    if (row.listening && wanted(row.port) && !rows.has(key)) rows.set(key, row);
  }
  const unnamed = new Set([...rows.values()].map((row) => row.inode).filter((i) => !owners.has(i)));
  if (owners.size > 1024) owners.clear();
  const found = await socketOwners(unnamed, proc, apps, home);
  // An owner desktopd can't read (another user's) is remembered as unknown, not searched again.
  for (const inode of unnamed) owners.set(inode, found.get(inode) ?? {});
  return Promise.all(
    [...rows.values()]
      .sort((a, b) => a.port - b.port || a.address.localeCompare(b.address))
      .map(async ({ address, port, inode }) => {
        const { pid, ...owner } = owners.get(inode) ?? {};
        const cpu = pid === undefined ? undefined : (await processStat(proc, pid)).cpu;
        return {
          address,
          port,
          ...owner,
          ...(cpu === undefined ? {} : { cpu }),
          ...(clients.get(port) ? { clients: clients.get(port) } : {}),
        };
      }),
  );
}

// Ends the servers listening on a port: every process holding the socket is asked to, and made to
// if it hasn't within the wait. Only its own user's can be seen or signalled.
export async function stopListening(
  port: number,
  opts: {
    proc?: string;
    kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
    waitMs?: number;
  } = {},
): Promise<boolean> {
  const proc = opts.proc ?? "/proc";
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const waitMs = opts.waitMs ?? STOP_WAIT_MS;
  const listeners = async () =>
    new Set(
      (await socketRows(proc)).filter((r) => r.listening && r.port === port).map((r) => r.inode),
    );
  const inodes = await listeners();
  if (!inodes.size) return true;
  const pids = await socketHolders(inodes, proc);
  if (!pids.size) return false;
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    for (const pid of pids)
      try {
        kill(pid, name);
      } catch {
        // It has gone, or isn't this user's; the listening socket says which.
      }
  };
  const gone = async () => {
    for (const deadline = Date.now() + waitMs; ; ) {
      if (!(await listeners()).size) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(STOP_POLL_MS, waitMs)));
    }
  };
  signal("SIGTERM");
  if (await gone()) return true;
  signal("SIGKILL");
  return gone();
}

async function socketRows(proc: string): Promise<SocketRow[]> {
  const rows: SocketRow[] = [];
  for (const table of ["tcp", "tcp6"]) {
    const text = await readFile(`${proc}/net/${table}`, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [, local, , state] = fields;
      const inode = fields[9];
      if (!local || !inode || inode === "0") continue;
      const at = local.lastIndexOf(":");
      const address = decodeAddress(local.slice(0, at));
      if (!address) continue;
      rows.push({
        address,
        port: Number.parseInt(local.slice(at + 1), 16),
        listening: state === LISTEN,
        established: state === ESTABLISHED,
        inode,
      });
    }
  }
  return rows;
}

// /proc/net/tcp writes an address as 32-bit words in the host's byte order (little-endian here).
export function decodeAddress(hex: string): string | undefined {
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{32})$/i.test(hex)) return undefined;
  const bytes = (hex.match(/.{8}/g) ?? []).flatMap((word) =>
    (word.match(/../g) ?? []).reverse().map((byte) => Number.parseInt(byte, 16)),
  );
  if (bytes.length === 4) return bytes.join(".");
  const groups = Array.from({ length: 8 }, (_, i) =>
    (((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0)).toString(16),
  );
  return new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1);
}

// The processes whose open files hold these sockets, by socket inode, until `enough` are found.
async function socketOwners(
  inodes: ReadonlySet<string>,
  proc: string,
  apps: readonly string[],
  home = DEFAULT_HOME,
  enough = inodes.size,
): Promise<Map<string, SocketOwner>> {
  const owners = new Map<string, SocketOwner>();
  if (!inodes.size) return owners;
  for (const pid of await processIds(proc)) {
    for (const socket of await socketsOf(proc, pid)) {
      if (!inodes.has(socket) || owners.has(socket)) continue;
      const name = await nameOf(`${proc}/${pid}`, apps);
      if (name) owners.set(socket, { ...(await ownerFacts(proc, pid, home)), name });
      if (owners.size >= enough) return owners;
    }
  }
  return owners;
}

async function socketHolders(inodes: ReadonlySet<string>, proc: string): Promise<Set<number>> {
  const pids = new Set<number>();
  for (const pid of await processIds(proc))
    for (const socket of await socketsOf(proc, pid)) if (inodes.has(socket)) pids.add(Number(pid));
  return pids;
}

async function processIds(proc: string): Promise<string[]> {
  return (await readdir(proc).catch(() => [])).filter((entry) => /^\d+$/.test(entry));
}

async function socketsOf(proc: string, pid: string): Promise<string[]> {
  const sockets: string[] = [];
  for (const fd of await readdir(`${proc}/${pid}/fd`).catch(() => [])) {
    const socket = /^socket:\[(\d+)\]$/.exec(
      await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => ""),
    )?.[1];
    if (socket) sockets.push(socket);
  }
  return sockets;
}

async function ownerFacts(proc: string, pid: string, home: string): Promise<SocketOwner> {
  const environ = await readFile(`${proc}/${pid}/environ`, "utf8").catch(() => "");
  const task = environ
    .split("\0")
    .find((entry) => entry.startsWith(TASK_VARIABLE))
    ?.slice(TASK_VARIABLE.length);
  const cwd = await readlink(`${proc}/${pid}/cwd`).catch(() => "");
  const project = cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  const { started } = await processStat(proc, Number(pid));
  return {
    pid: Number(pid),
    ...(task && TASK_ID.test(task) ? { task } : {}),
    ...(project && project.length <= PROJECT_CHARS ? { project } : {}),
    ...(started === undefined ? {} : { started }),
  };
}

// From /proc/<pid>/stat, after the name: its start (field 22), and its processor time and that of
// the children it has seen end (fields 14 to 17).
async function processStat(proc: string, pid: number): Promise<{ started?: number; cpu?: number }> {
  const stat = await readFile(`${proc}/${pid}/stat`, "utf8").catch(() => "");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const started = Number(fields[19]);
  const cpu = [11, 12, 13, 14].reduce((sum, at) => sum + Number(fields[at]), 0);
  return {
    ...(Number.isSafeInteger(started) && started >= 0 ? { started } : {}),
    ...(Number.isSafeInteger(cpu) && cpu >= 0 ? { cpu } : {}),
  };
}

async function nameOf(dir: string, apps: readonly string[]): Promise<string | undefined> {
  const comm = (await readFile(`${dir}/comm`, "utf8").catch(() => "")).trim();
  const exe = basename(await readlink(`${dir}/exe`).catch(() => ""));
  const name = (await appName([exe, comm], apps)) || comm || exe;
  const clean = [...name]
    .filter((c) => c >= " " && c !== "\x7f")
    .join("")
    .trim()
    .slice(0, 64);
  return clean || undefined;
}

// The name an app's launcher entry gives it ("WeChat" for wechat), found by its program's name.
async function appName(programs: readonly string[], dirs: readonly string[]) {
  const wanted = new Set(programs.filter(Boolean));
  if (!wanted.size) return undefined;
  for (const dir of dirs) {
    for (const file of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".desktop"))) {
      const text = await readFile(join(dir, file), "utf8").catch(() => "");
      const entry = text.split(/^\[/m).find((part) => part.startsWith("Desktop Entry]")) ?? "";
      const exec = /^Exec=\s*(?:env\s+(?:\S+=\S*\s+)*)?"?([^\s"]+)/m.exec(entry)?.[1];
      const name = /^Name=(.+)$/m.exec(entry)?.[1]?.trim();
      if (name && exec && wanted.has(basename(exec))) return name;
    }
  }
  return undefined;
}
