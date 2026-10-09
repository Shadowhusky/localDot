import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectionOwner } from "./connection-owner.ts";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (local: string, remote: string, state: string, inode: number) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function proc(tcp: string, processes: Record<string, { comm: string; sockets: number[] }>) {
  const dir = mkdtempSync(join(tmpdir(), "ld-proc-"));
  dirs.push(dir);
  mkdirSync(join(dir, "net"));
  writeFileSync(join(dir, "net", "tcp"), HEADER + tcp);
  writeFileSync(join(dir, "net", "tcp6"), HEADER);
  for (const [pid, { comm, sockets }] of Object.entries(processes)) {
    mkdirSync(join(dir, pid, "fd"), { recursive: true });
    writeFileSync(join(dir, pid, "comm"), `${comm}\n`);
    for (const [fd, inode] of sockets.entries())
      symlinkSync(`socket:[${inode}]`, join(dir, pid, "fd", `${fd + 3}`));
  }
  return dir;
}

describe("connectionOwner", () => {
  it("names the program whose socket holds the local port", async () => {
    // 192.0.0.2:41234 to a placeholder, and the forwarder's own socket on 3129.
    const dir = proc(
      row("020000C0:A112", "020012C6:1466", "01", 7001) +
        row("0100007F:0C39", "0100007F:A0D3", "01", 7002),
      { "100": { comm: "wechat", sockets: [7001] }, "200": { comm: "node", sockets: [7002] } },
    );
    expect(await connectionOwner(41234, dir)).toBe("wechat");
  });

  it("calls an app by the name its launcher entry gives it", async () => {
    const dir = proc(row("020000C0:A112", "020012C6:1466", "01", 7001), {
      "100": { comm: "wechat", sockets: [7001] },
    });
    const apps = join(dir, "applications");
    mkdirSync(apps);
    writeFileSync(
      join(apps, "wechat.desktop"),
      "[Desktop Entry]\nName=WeChat\nName[zh_CN]=\u5fae\u4fe1\nExec=/usr/bin/wechat %U\nType=Application\n[Desktop Action New]\nName=New window\nExec=other\n",
    );
    writeFileSync(join(apps, "editor.desktop"), "[Desktop Entry]\nName=Editor\nExec=mousepad %F\n");
    expect(await connectionOwner(41234, dir, [apps])).toBe("WeChat");
    expect(await connectionOwner(41234, dir, [join(dir, "none")])).toBe("wechat");
  });

  it("ignores listening sockets and says nothing for a port nobody holds", async () => {
    const dir = proc(row("00000000:A112", "00000000:0000", "0A", 7001), {
      "100": { comm: "server", sockets: [7001] },
    });
    expect(await connectionOwner(41234, dir)).toBeUndefined();
    expect(await connectionOwner(9, dir)).toBeUndefined();
  });

  it("says nothing when the process cannot be read", async () => {
    const dir = proc(row("020000C0:A112", "020012C6:1466", "01", 7001), {});
    expect(await connectionOwner(41234, dir)).toBeUndefined();
  });
});
