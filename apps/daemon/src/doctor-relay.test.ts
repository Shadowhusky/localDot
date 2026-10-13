import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerRequest } from "./cells/docker.ts";
import { DockerError } from "./cells/docker.ts";
import { type GateRelay, HOST_RELAY, relayDirs } from "./cells/relay.ts";
import { RELAY_PROBE_SCRIPT, runRelayProbe } from "./doctor-relay.ts";

// macOS caps a socket path at 104 bytes, so the home stays short.
const homes: string[] = [];
function home() {
  const dir = mkdtempSync("/tmp/ld-probe-");
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Spec {
  User: string;
  Entrypoint: string[];
  HostConfig: Record<string, unknown>;
}

// Docker as the probe sees it. `run` stands in for the container: it gets the probe's target and
// nonce, and returns the exit code.
function docker(run: (target: string, nonce: string) => Promise<number>, failCreate?: Error) {
  const calls: DockerRequest[] = [];
  let spec: Spec | undefined;
  return {
    calls,
    spec: () => spec,
    request: async <T>(req: DockerRequest): Promise<T> => {
      calls.push(req);
      if (req.path === "/networks/create") return { Id: "net1" } as T;
      if (req.path === "/containers/create") {
        if (failCreate) throw failCreate;
        spec = req.body as Spec;
        return { Id: "ctr1" } as T;
      }
      if (req.path.endsWith("/wait")) {
        const [, , , , target = "", nonce = ""] = spec?.Entrypoint ?? [];
        return { StatusCode: await run(target, nonce) } as T;
      }
      return undefined as T;
    },
  };
}

// Reads what the listener sends, as socat -u would.
const read = (options: { path: string } | { port: number; host: string }) =>
  new Promise<string>((resolve, reject) => {
    let text = "";
    connect(options as never)
      .on("data", (chunk) => {
        text += chunk;
      })
      .on("end", () => resolve(text.trim()))
      .on("error", reject);
  });

describe("runRelayProbe", () => {
  it("passes when a gate-like container reads the listener through the mounted folder", async () => {
    const dir = home();
    const relay: GateRelay = { kind: "socket", ...relayDirs(dir) };
    const d = docker(async (target, nonce) => {
      const inside = target.replace("UNIX-CONNECT:/run/localdot/keyd/", "");
      return (await read({ path: join(relay.keydDir, inside) })) === nonce ? 0 : 1;
    });
    const verdict = await runRelayProbe({ docker: d, relay, home: dir, image: "gate:dev" });
    expect(verdict).toEqual({
      ok: true,
      detail: "Computers reach localDot's key service through a shared folder.",
    });
    expect(d.spec()).toMatchObject({
      User: "nobody",
      HostConfig: {
        NetworkMode: "net1",
        CapDrop: ["ALL"],
        ReadonlyRootfs: true,
        Mounts: [{ Type: "bind", Source: relay.keydDir, Target: "/run/localdot/keyd" }],
      },
    });
    const network = d.calls.find((c) => c.path === "/networks/create")?.body as {
      Internal?: boolean;
      Labels: Record<string, string>;
    };
    expect(network.Internal).toBeUndefined();
    expect(Object.keys(network.Labels)).toEqual(["localdot.doctor-probe"]);
    expect(d.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/containers/ctr1",
      "/networks/net1",
    ]);
    expect(readdirSync(relay.keydDir)).toEqual([]);
  });

  it("names a refused socket and a folder Docker can't share, with the fix", async () => {
    const dir = home();
    const relay: GateRelay = { kind: "socket", ...relayDirs(dir) };
    const refused = await runRelayProbe({
      docker: docker(async () => 13),
      relay,
      home: dir,
      image: "gate:dev",
    });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("permission denied");
    expect(refused.detail).toContain("no internet or model access");
    const mount = new DockerError(400, "invalid mount config: bind source path does not exist", "");
    const snap = await runRelayProbe({
      docker: docker(async () => 0, mount),
      relay,
      home: dir,
      image: "gate:dev",
      snap: true,
    });
    expect(snap.detail).toContain(`Docker couldn't share ${relay.keydDir}`);
    expect(snap.detail).toContain("sudo snap remove docker");
    const other = await runRelayProbe({
      docker: docker(async () => 0, new DockerError(404, "No such image: gate:dev", "")),
      relay,
      home: dir,
      image: "gate:dev",
    });
    expect(other.detail).toMatch(/^The connection check couldn't run: .*No such image/);
  });

  it("reaches a loopback listener through host.docker.internal on Docker Desktop", async () => {
    const d = docker(async (target, nonce) => {
      const port = Number(/:(\d+),/.exec(target)?.[1]);
      return (await read({ port, host: "127.0.0.1" })) === nonce ? 0 : 1;
    });
    const ok = await runRelayProbe({ docker: d, relay: HOST_RELAY, home: "/h", image: "g" });
    expect(ok).toMatchObject({ ok: true });
    expect("Mounts" in (d.spec()?.HostConfig ?? {})).toBe(false);
    const unknown = await runRelayProbe({
      docker: docker(async () => 6),
      relay: HOST_RELAY,
      home: "/h",
      image: "g",
    });
    expect(unknown.detail).toContain("Update Docker Desktop");
  });
});

// The probe's script with stand-ins for timeout and socat, which print what socat would.
describe("RELAY_PROBE_SCRIPT", () => {
  const run = (socat: string) => {
    const bin = home();
    writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
    writeFileSync(join(bin, "socat"), `#!/bin/sh\n${socat}\n`, { mode: 0o700 });
    expect(existsSync(join(bin, "socat"))).toBe(true);
    return spawnSync("/bin/sh", ["-c", RELAY_PROBE_SCRIPT, "probe", "UNIX-CONNECT:/x", "n0nce"], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
    }).status;
  };

  it("exits 0 only for the nonce, and names each failure", () => {
    expect(run("echo n0nce")).toBe(0);
    expect(run("echo other")).toBe(1);
    expect(run('echo "E connect(5): Permission denied" >&2; exit 1')).toBe(13);
    expect(run('echo "E connect(5): No such file or directory" >&2; exit 1')).toBe(2);
    expect(run('echo "E getaddrinfo: Name does not resolve" >&2; exit 1')).toBe(6);
    expect(run('echo "E connect(5): Connection refused" >&2; exit 1')).toBe(111);
    expect(run("exit 143")).toBe(124);
    // Seven real shell processes can exceed the default timeout on a loaded macOS runner.
  }, 15_000);
});
