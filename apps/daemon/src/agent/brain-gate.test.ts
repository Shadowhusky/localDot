import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../../cells/gate/relay.sh", import.meta.url));
// Execute the actual shell entry point with inert ip/socat stand-ins. No sockets,
// Docker containers or long-lived processes are opened by this fixture.
function run(role: string | undefined, toolPort?: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "localdot-brain-gate-"));
  try {
    const log = join(dir, "calls");
    writeFileSync(log, "");
    writeFileSync(join(dir, "ip"), '#!/bin/sh\necho "2: fixture inet 172.30.4.10/24"\n', {
      mode: 0o700,
    });
    writeFileSync(
      join(dir, "socat"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GATE_CALLS"\nn=0\nwhile [ "$(wc -l < "$GATE_CALLS")" -lt "$GATE_EXPECTED" ] && [ "$n" -lt 50 ]; do n=$((n + 1)); sleep 0.01; done\nexit 1\n',
      { mode: 0o700 },
    );
    const result = spawnSync("/bin/sh", [script], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        GATE_CALLS: log,
        GATE_EXPECTED: role === "brain" ? "2" : role === "connector" ? "1" : "3",
        LD_INTERNAL_ADDR: "172.30.4.10",
        LD_EGRESS_ADDR: "172.30.5.10",
        LD_DESKTOP_ADDR: "172.30.4.11",
        LD_KEYD_PORT: "4791",
        ...(role === undefined ? {} : { LD_ROLE: role }),
        ...(toolPort === undefined ? {} : { LD_TOOL_PORT: toolPort }),
        ...extra,
      },
      timeout: 4000,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return {
      ...result,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).sort(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gate role boundary", () => {
  it("brain exposes only keyd and tool relays on its internal address", () => {
    const result = run("brain", "4999");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a relay exited");
    expect(result.calls).toEqual([
      "-t60 TCP4-LISTEN:3128,bind=172.30.4.10,fork,max-children=16,reuseaddr TCP4:host.docker.internal:4791",
      "TCP4-LISTEN:4751,bind=172.30.4.10,fork,max-children=16,reuseaddr TCP4:host.docker.internal:4999",
    ]);
  });
  it("connector relays only keyd out, and nothing in", () => {
    const result = run("connector");
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      "-t60 TCP4-LISTEN:3128,bind=172.30.4.10,fork,max-children=16,reuseaddr TCP4:host.docker.internal:4791",
    ]);
  });
  it("reserves separate bounded listeners for desktop control and video", () => {
    const result = run(undefined);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      "-t60 TCP4-LISTEN:3128,bind=172.30.4.10,fork,max-children=64,reuseaddr TCP4:host.docker.internal:4791",
      "TCP4-LISTEN:8081,bind=172.30.5.10,fork,max-children=16,reuseaddr TCP4:172.30.4.11:7700",
      "TCP4-LISTEN:8082,bind=172.30.5.10,fork,max-children=16,reuseaddr TCP4:172.30.4.11:3000",
    ]);
  });
  it("relays out through the mounted sockets on Docker Engine", () => {
    const sockets = {
      LD_KEYD_SOCKET: "/run/localdot/keyd/4791.sock",
      LD_TOOL_SOCKET: "/run/localdot/tool/tool.sock",
    };
    expect(run("brain", "4999", sockets).calls).toEqual([
      "-t60 TCP4-LISTEN:3128,bind=172.30.4.10,fork,max-children=16,reuseaddr UNIX-CONNECT:/run/localdot/keyd/4791.sock",
      "TCP4-LISTEN:4751,bind=172.30.4.10,fork,max-children=16,reuseaddr UNIX-CONNECT:/run/localdot/tool/tool.sock",
    ]);
    expect(run(undefined, undefined, sockets).calls).toEqual([
      "-t60 TCP4-LISTEN:3128,bind=172.30.4.10,fork,max-children=64,reuseaddr UNIX-CONNECT:/run/localdot/keyd/4791.sock",
      "TCP4-LISTEN:8081,bind=172.30.5.10,fork,max-children=16,reuseaddr TCP4:172.30.4.11:7700",
      "TCP4-LISTEN:8082,bind=172.30.5.10,fork,max-children=16,reuseaddr TCP4:172.30.4.11:3000",
    ]);
  });
  it("refuses unknown roles or a missing tool backend before spawning relays", () => {
    for (const result of [run("unrecognized", "4999"), run("brain")]) {
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
    }
  });
});
