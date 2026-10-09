import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";

const LISTEN = "0A";
// Where installed apps name themselves for the user, as the desktop's launcher lists them.
export const APP_DIRS = ["/usr/share/applications", "/config/.local/share/applications"];

// The program holding the TCP connection from a local port, found as ss -p finds it: the socket's
// inode in /proc/net/tcp, then the process with that inode among its open files. desktopd reads
// only its own user's processes, which run every program the user and the agent start; for any
// other the answer is unknown.
export async function connectionOwner(
  port: number,
  proc = "/proc",
  apps: readonly string[] = APP_DIRS,
): Promise<string | undefined> {
  const inodes = new Set<string>();
  for (const table of ["tcp", "tcp6"]) {
    const text = await readFile(`${proc}/net/${table}`, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [, local, , state] = fields;
      const inode = fields[9];
      if (!local || !inode || inode === "0" || state === LISTEN) continue;
      if (Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16) === port) inodes.add(inode);
    }
  }
  if (!inodes.size) return undefined;
  const pids = (await readdir(proc).catch(() => [])).filter((entry) => /^\d+$/.test(entry));
  for (const pid of pids) {
    for (const fd of await readdir(`${proc}/${pid}/fd`).catch(() => [])) {
      const socket = /^socket:\[(\d+)\]$/.exec(
        await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => ""),
      );
      if (socket?.[1] && inodes.has(socket[1])) return nameOf(`${proc}/${pid}`, apps);
    }
  }
  return undefined;
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
