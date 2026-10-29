import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";

const LISTEN = "0A";
// Where installed apps name themselves for the user, as the desktop's launcher lists them.
export const APP_DIRS = ["/usr/share/applications", "/config/.local/share/applications"];

interface SocketRow {
  address: string;
  port: number;
  listening: boolean;
  inode: string;
}

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
  return (await socketOwners(inodes, proc, apps, 1)).values().next().value;
}

// Every listening TCP socket on a `wanted` port, once per address and port, with the program that
// listens when it is one of this user's. Finding a program reads every process's open files, so
// `names` keeps them by socket for the next listing: a server's socket lasts as long as it runs.
export async function listeningSockets(
  proc = "/proc",
  apps: readonly string[] = APP_DIRS,
  wanted: (port: number) => boolean = () => true,
  names = new Map<string, string>(),
): Promise<{ address: string; port: number; name?: string }[]> {
  const rows = new Map<string, SocketRow>();
  for (const row of await socketRows(proc)) {
    const key = `${row.address} ${row.port}`;
    if (row.listening && wanted(row.port) && !rows.has(key)) rows.set(key, row);
  }
  const unnamed = new Set([...rows.values()].map((row) => row.inode).filter((i) => !names.has(i)));
  if (names.size > 1024) names.clear();
  const owners = await socketOwners(unnamed, proc, apps);
  // An owner desktopd can't read (another user's) is remembered as unknown, not searched again.
  for (const inode of unnamed) names.set(inode, owners.get(inode) ?? "");
  return [...rows.values()]
    .sort((a, b) => a.port - b.port || a.address.localeCompare(b.address))
    .map(({ address, port, inode }) => {
      const name = names.get(inode);
      return name ? { address, port, name } : { address, port };
    });
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

// The programs whose open files hold these sockets, by socket inode, until `enough` are named.
async function socketOwners(
  inodes: ReadonlySet<string>,
  proc: string,
  apps: readonly string[],
  enough = inodes.size,
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (!inodes.size) return owners;
  const pids = (await readdir(proc).catch(() => [])).filter((entry) => /^\d+$/.test(entry));
  for (const pid of pids) {
    for (const fd of await readdir(`${proc}/${pid}/fd`).catch(() => [])) {
      const socket = /^socket:\[(\d+)\]$/.exec(
        await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => ""),
      )?.[1];
      if (!socket || !inodes.has(socket) || owners.has(socket)) continue;
      const name = await nameOf(`${proc}/${pid}`, apps);
      if (name) owners.set(socket, name);
      if (owners.size >= enough) return owners;
    }
  }
  return owners;
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
