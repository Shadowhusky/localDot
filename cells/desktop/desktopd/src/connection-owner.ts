import { readdir, readFile, readlink } from "node:fs/promises";

const LISTEN = "0A";

// The program holding the TCP connection from a local port, found as ss -p finds it: the socket's
// inode in /proc/net/tcp, then the process with that inode among its open files. desktopd reads
// only its own user's processes, which run every program the user and the agent start; for any
// other the answer is unknown.
export async function connectionOwner(port: number, proc = "/proc"): Promise<string | undefined> {
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
      if (socket?.[1] && inodes.has(socket[1])) return nameOf(`${proc}/${pid}`);
    }
  }
  return undefined;
}

async function nameOf(dir: string): Promise<string | undefined> {
  const comm = (await readFile(`${dir}/comm`, "utf8").catch(() => "")).trim();
  const name = comm || (await readlink(`${dir}/exe`).catch(() => "")).split("/").pop() || "";
  const clean = [...name]
    .filter((c) => c >= " " && c !== "\x7f")
    .join("")
    .slice(0, 128);
  return clean || undefined;
}
