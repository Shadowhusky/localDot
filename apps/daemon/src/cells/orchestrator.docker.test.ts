import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELFTEST_CHECK_IDS, type SecretBinding, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KillSwitch } from "../gateway/kill-switch.ts";
import { LiveSessions } from "../gateway/live.ts";
import { CellKeydWiring } from "../keyd/cell-wiring.ts";
import { KeydClient } from "../keyd/client.ts";
import { type KeydProcess, startKeyd, TEST_KEYD_PORTS } from "../keyd/testing/keyd-process.ts";
import { DockerClient } from "./docker.ts";
import { imagesFromEnv } from "./images.ts";
import { hostAddress } from "./ipv4.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { probeDesktopd, probeStream } from "./readiness.ts";
import { cellNames } from "./spec.ts";
import { CellStore } from "./store.ts";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerOk,
  removeAll,
  subnetOf,
} from "./testing/docker-cli.ts";
import type { CellSummary } from "./types.ts";

const PREFIX = process.env.LOCALDOT_ORCH_TEST_PREFIX || "localdot-test-";
const [LABEL_KEY, LABEL_VALUE] = (process.env.LOCALDOT_ORCH_TEST_LABEL ?? "").split("=");
// Docker Desktop's address for the Mac (host.docker.internal), and an address on the internet.
const DESKTOP_HOST_ADDRESS = "192.168.65.254";
const PUBLIC_ADDRESS = "1.1.1.1";
// curl reached the gate, which refused the connection for keyd: refused, an empty reply or a reset,
// but never an answer and never a timeout (a connection held for the user).
const REFUSED = [7, 52, 55, 56];
const BOUNDED_LOGS = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

// A probe counts only with the exit status it is expected to have: a missing tool also exits
// non-zero, so "not 0" would pass for the wrong reason.
function probe(container: string, status: number, ...cmd: string[]): string {
  const r = dockerExec(container, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(status);
  return r.out;
}

function refused(container: string, url: string) {
  const r = dockerExec(container, "curl", "--noproxy", "*", "-sS", "-m", "5", url);
  expect(REFUSED, `${url}: ${r.status} ${r.out}`).toContain(r.status);
}

describe.skipIf(!DOCKER_TESTS)("CellOrchestrator against Docker Desktop", () => {
  // Built in beforeAll: Vitest runs a skipped describe's body too, and nothing may be left behind.
  let home = "";
  let store: CellStore;
  let orchestrator: CellOrchestrator;
  let keyd: KeydProcess;
  let keydClient: KeydClient;
  let wiring: CellKeydWiring;
  const seen = new Set<string>();
  let cell: CellSummary | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "local dot's orch-docker-"));
    keyd = await startKeyd();
    keydClient = new KeydClient(keyd.socketPath);
    const binding: SecretBinding = {
      id: "weather",
      kind: "http",
      hosts: ["api.example.test"],
      header: "Authorization",
      format: "bearer",
    };
    await keydClient.putSecret(
      binding,
      await sealSecret(
        (await keydClient.status()).sealKey,
        binding,
        "fake-key-for-pause-resume-acceptance",
      ),
    );
    store = new CellStore(home, TEST_KEYD_PORTS);
    const client = new DockerClient();
    wiring = new CellKeydWiring({ keyd: keydClient, docker: client });
    orchestrator = new CellOrchestrator({
      docker: client,
      keyd: wiring,
      store,
      images: imagesFromEnv(),
      probeDesktopd,
      probeStream,
      namePrefix: PREFIX,
      ...(LABEL_KEY && LABEL_VALUE ? { labels: { [LABEL_KEY]: LABEL_VALUE } } : {}),
    });
    orchestrator.subscribe((c) => seen.add(c.id));
  });

  // Resolves at the cell's next ready, after the restart whose note contains `restarting`.
  const readyAgain = (id: string, restarting?: string) =>
    new Promise<void>((resolve, reject) => {
      let noted = restarting === undefined;
      const stop = orchestrator.subscribe((c) => {
        if (c.id !== id) return;
        if (c.state === "starting" && restarting && (c.error ?? "").includes(restarting)) {
          noted = true;
        }
        if (c.state === "ready" && noted) {
          stop();
          resolve();
        }
        if (c.state === "failed") {
          stop();
          reject(new Error(c.error));
        }
      });
    });

  afterAll(async () => {
    orchestrator?.dispose();
    for (const id of new Set([...seen, ...(store?.list() ?? []).map((r) => r.id)])) {
      if (store.get(id)) await orchestrator.remove(id, { purgeHome: true }).catch(() => {});
      const n = cellNames(id, PREFIX);
      removeAll({
        containers: [n.desktop, n.gate],
        networks: [n.internalNetwork, n.egressNetwork],
        volumes: [n.homeVolume],
      });
    }
    if (home) rmSync(home, { recursive: true, force: true });
    await keyd?.stop();
  });

  it("creates a ready cell whose desktop reaches out only through its gate", async () => {
    cell = await orchestrator.create({ scale: 2 });
    const id = cell.id;
    await readyAgain(id);
    const record = store.get(id);
    if (!record) throw new Error("record missing");
    const { desktop, gate } = record.docker;
    expect(desktop).toBe(`${PREFIX}desktop-${id}`);

    // Names resolve to the gate's placeholders, which only keyd turns into addresses; the Mac's
    // own names resolve to nothing, and the gate's keyd relay still answers.
    expect(probe(desktop, 0, "getent", "hosts", "example.com")).toMatch(/^198\.1[89]\./);
    probe(
      desktop,
      6,
      "curl",
      "--noproxy",
      "*",
      "-sS",
      "-m",
      "5",
      "http://host.docker.internal:4750/",
    );
    // By address too: the subnet's gateway slot, the Mac and SMTP are refused at the gate.
    const gatewaySlot = hostAddress(subnetOf(record.docker.internalNetwork), 1);
    for (const address of [gatewaySlot, DESKTOP_HOST_ADDRESS])
      refused(desktop, `http://${address}:4750/`);
    refused(desktop, `telnet://${PUBLIC_ADDRESS}:25`);
    probe(
      desktop,
      0,
      "timeout",
      "5",
      "bash",
      "-c",
      `exec 3<>/dev/tcp/${record.docker.gateInternalIp}/3128`,
    );
    // NET_RAW is dropped: not even root inside the desktop can open a raw socket (D15, A13).
    expect(
      probe(
        desktop,
        1,
        "python3",
        "-c",
        "import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)",
      ),
    ).toContain("Operation not permitted");

    expect(docker("inspect", "-f", "{{.HostConfig.CapDrop}} {{.HostConfig.Binds}}", desktop)).toBe(
      "[NET_RAW] []",
    );
    expect(
      docker("inspect", "-f", "{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}", desktop),
    ).toBe("volume:/config");
    expect(
      docker("inspect", "-f", "{{.HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}}", desktop),
    ).toBe("[] 4096");
    expect(docker("inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", desktop)).toMatch(
      /^(no)?$/,
    );
    // The gate starts as root only to take the desktop's traffic, then runs as nobody with nothing.
    expect(
      docker(
        "inspect",
        "-f",
        "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}} {{.Config.User}}",
        gate,
      ),
    ).toBe("true [ALL] [NET_ADMIN SETUID SETGID SETPCAP] [no-new-privileges] 64 root");
    const status = probe(gate, 0, "grep", "-E", "^(Uid|CapEff)", "/proc/1/status");
    expect(status).toMatch(/^Uid:\s+65534\s+65534\s+65534\s+65534$/m);
    expect(status).toMatch(/^CapEff:\s+0+$/m);
    for (const name of [gate, desktop]) {
      expect(JSON.parse(docker("inspect", "-f", "{{json .HostConfig.LogConfig}}", name))).toEqual(
        BOUNDED_LOGS,
      );
    }

    // Templates range over a map in key order: the cell-… network sorts before egress-….
    const addresses = (name: string) =>
      docker(
        "inspect",
        "-f",
        "{{range $net, $ep := .NetworkSettings.Networks}}{{$net}}={{$ep.IPAddress}} {{end}}",
        name,
      );
    expect(addresses(gate)).toBe(
      `${record.docker.internalNetwork}=${record.docker.gateInternalIp} ${record.docker.egressNetwork}=${record.docker.gateEgressIp}`,
    );
    expect(addresses(desktop)).toBe(`${record.docker.internalNetwork}=${record.docker.desktopIp}`);
    // Engine 29 renders the unset gateway of an isolated network as "invalid IP" (S3 saw the same).
    expect(["", "invalid IP"]).toContain(
      docker(
        "network",
        "inspect",
        "-f",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
        record.docker.internalNetwork,
      ),
    );

    for (const network of [record.docker.internalNetwork, record.docker.egressNetwork]) {
      expect(docker("network", "inspect", "-f", "{{.EnableIPv6}}", network)).toBe("false");
    }

    const endpoints = orchestrator.endpoints(id);
    if (!endpoints) throw new Error("endpoints missing");
    // What Docker actually bound, not what the daemon assumed: one 127.0.0.1 port per relay.
    const bound = JSON.parse(docker("inspect", "-f", "{{json .NetworkSettings.Ports}}", gate));
    expect(bound).toEqual({
      "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: new URL(endpoints.desktopd.baseUrl).port }],
      "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: new URL(endpoints.stream.baseUrl).port }],
    });
    const health = await probeDesktopd(endpoints.desktopd);
    expect(health?.ok).toBe(true);
    expect(health?.selftest?.checks.map((c) => `${c.id}:${c.ok}`)).toEqual(
      SELFTEST_CHECK_IDS.map((id) => `${id}:true`),
    );
  }, 300_000);

  it("restarts a killed gate on new ports and a killed desktop behind the same ones", async () => {
    if (!cell) throw new Error("no cell");
    const id = cell.id;
    const record = store.get(id);
    if (!record) throw new Error("record missing");
    const { desktop, gate } = record.docker;
    const before = orchestrator.endpoints(id);

    const gateBack = readyAgain(id, "gate container exited with 137; restarting (attempt 1 of 5)");
    docker("kill", gate);
    await gateBack;
    const afterGate = orchestrator.endpoints(id);
    if (!afterGate) throw new Error("endpoints missing");
    expect(afterGate.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
    expect(afterGate.stream.baseUrl).not.toBe(before?.stream.baseUrl);
    expect((await probeDesktopd(afterGate.desktopd))?.ok).toBe(true);
    probe(
      desktop,
      0,
      "timeout",
      "5",
      "bash",
      "-c",
      `exec 3<>/dev/tcp/${record.docker.gateInternalIp}/3128`,
    );

    const desktopBack = readyAgain(
      id,
      "desktop container exited with 137; restarting (attempt 2 of 5)",
    );
    docker("kill", desktop);
    await desktopBack;
    expect(orchestrator.endpoints(id)).toEqual(afterGate);
    expect((await probeDesktopd(afterGate.desktopd))?.ok).toBe(true);
    // The daemon started both again itself; Docker restarted nothing (no restart policy).
    expect(docker("inspect", "-f", "{{.RestartCount}}", gate)).toBe("0");
    expect(docker("inspect", "-f", "{{.RestartCount}}", desktop)).toBe("0");
  }, 300_000);

  it("runs a Start that lands during a Stop after the Stop, with no failure between", async () => {
    if (!cell) throw new Error("no cell");
    const id = cell.id;
    const record = store.get(id);
    if (!record) throw new Error("record missing");
    const before = orchestrator.endpoints(id);
    const states: string[] = [];
    const off = orchestrator.subscribe((c) => {
      if (c.id === id) states.push(c.state);
    });
    const ready = readyAgain(id);
    await Promise.all([orchestrator.stop(id), orchestrator.start(id)]);
    // Both calls are done, so the Start has run after the Stop and both containers are up again.
    expect(states).toEqual(["stopping", "stopped", "starting", "starting"]);
    expect(docker("inspect", "-f", "{{.State.Running}}", record.docker.gate)).toBe("true");
    expect(docker("inspect", "-f", "{{.State.Running}}", record.docker.desktop)).toBe("true");
    await ready;
    off();
    expect(states.at(-1)).toBe("ready");
    expect(orchestrator.endpoints(id)?.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
  }, 300_000);

  it("revokes, freezes and resumes a real desktop with fresh surrogates", async () => {
    if (!cell) throw new Error("no cell");
    const id = cell.id;
    const record = store.get(id);
    if (!record) throw new Error("record missing");
    const before = await keydClient.cell(id);
    expect(before?.surrogates).toHaveLength(1);
    const live = new LiveSessions();
    const killSwitch = new KillSwitch({ cells: orchestrator, keyd: wiring, live });
    const session = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
    live.start(
      id,
      session,
      (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve)),
    );
    const started = performance.now();
    expect(await killSwitch.stopSession(session)).toEqual({
      revoked: true,
      paused: true,
      closed: false,
      stopped: false,
      errors: [],
    });
    const stopMs = performance.now() - started;
    console.info(`real desktop Stop: ${Math.round(stopMs)} ms`);
    expect(stopMs).toBeLessThan(5000);
    expect(docker("inspect", "-f", "{{.State.Paused}}", record.docker.desktop)).toBe("true");
    expect(docker("inspect", "-f", "{{.State.Running}}", record.docker.gate)).toBe("true");
    expect((await keydClient.cell(id))?.surrogates).toEqual([]);
    expect(orchestrator.endpoints(id)).toBeUndefined();
    await killSwitch.resume(id);
    expect(docker("inspect", "-f", "{{.State.Paused}}", record.docker.desktop)).toBe("false");
    const after = await keydClient.cell(id);
    expect(after?.surrogates).toHaveLength(1);
    expect(after?.surrogates).not.toEqual(before?.surrogates);
    const endpoint = orchestrator.endpoints(id)?.desktopd;
    if (!endpoint) throw new Error("no resumed endpoint");
    expect((await probeDesktopd(endpoint))?.ok).toBe(true);
  }, 60_000);

  it("stops, starts with new ports, and removes everything but the home volume", async () => {
    if (!cell) throw new Error("no cell");
    const id = cell.id;
    const record = store.get(id);
    if (!record) throw new Error("record missing");
    const before = orchestrator.endpoints(id)?.desktopd.baseUrl;
    await orchestrator.stop(id);
    expect(docker("inspect", "-f", "{{.State.Running}}", record.docker.desktop)).toBe("false");
    expect(docker("inspect", "-f", "{{.State.Running}}", record.docker.gate)).toBe("false");
    const ready = readyAgain(id);
    await orchestrator.start(id);
    await ready;
    expect(orchestrator.endpoints(id)?.desktopd.baseUrl).not.toBe(before);

    await orchestrator.remove(id);
    expect(dockerOk("inspect", record.docker.desktop)).toBe(false);
    expect(dockerOk("inspect", record.docker.gate)).toBe(false);
    expect(dockerOk("network", "inspect", record.docker.internalNetwork)).toBe(false);
    expect(dockerOk("network", "inspect", record.docker.egressNetwork)).toBe(false);
    expect(dockerOk("volume", "inspect", record.docker.homeVolume)).toBe(true);
    docker("volume", "rm", record.docker.homeVolume);
    cell = undefined;
  }, 300_000);
});
