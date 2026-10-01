import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerClient } from "./docker.ts";
import { imagesFromEnv } from "./images.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { probeDesktopd, probeStream } from "./readiness.ts";
import { cellNames } from "./spec.ts";
import { CellStore } from "./store.ts";
import { DOCKER_TESTS, docker, dockerExec, dockerOk, removeAll } from "./testing/docker-cli.ts";
import type { CellSummary } from "./types.ts";

const PREFIX = "localdot-test-";
const BOUNDED_LOGS = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

// A probe counts only with the exit status it is expected to have: a missing tool also exits
// non-zero, so "not 0" would pass for the wrong reason.
function probe(container: string, status: number, ...cmd: string[]): string {
  const r = dockerExec(container, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(status);
  return r.out;
}

describe.skipIf(!DOCKER_TESTS)("CellOrchestrator against Docker Desktop", () => {
  // Built in beforeAll: Vitest runs a skipped describe's body too, and nothing may be left behind.
  let home = "";
  let store: CellStore;
  let orchestrator: CellOrchestrator;
  const seen = new Set<string>();
  let cell: CellSummary | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "local dot's orch-docker-"));
    store = new CellStore(home);
    orchestrator = new CellOrchestrator({
      docker: new DockerClient(),
      store,
      images: imagesFromEnv(),
      probeDesktopd,
      probeStream,
      namePrefix: PREFIX,
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
    orchestrator.dispose();
    for (const id of new Set([...seen, ...store.list().map((r) => r.id)])) {
      if (store.get(id)) await orchestrator.remove(id, { purgeHome: true }).catch(() => {});
      const n = cellNames(id, PREFIX);
      removeAll({
        containers: [n.desktop, n.gate],
        networks: [n.internalNetwork, n.egressNetwork],
        volumes: [n.homeVolume],
      });
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a ready cell whose desktop reaches nothing but its gate", async () => {
    cell = await orchestrator.create({ scale: 2 });
    const id = cell.id;
    await readyAgain(id);
    const record = store.get(id);
    if (!record) throw new Error("record missing");
    const { desktop, gate } = record.docker;
    expect(desktop).toBe(`${PREFIX}desktop-${id}`);

    // 6: no DNS for outside names, 2: getent found nothing; the gate's keyd relay still answers.
    probe(desktop, 6, "curl", "-sS", "-m", "5", "https://example.com");
    probe(desktop, 6, "curl", "-sS", "-m", "5", "http://host.docker.internal:4750/");
    probe(desktop, 2, "sh", "-c", "getent hosts example.com");
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
    expect(
      docker(
        "inspect",
        "-f",
        "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}} {{.Config.User}}",
        gate,
      ),
    ).toBe("true [ALL] [no-new-privileges] 64 nobody");
    expect(probe(gate, 0, "id", "-u").trim()).toBe("65534");
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

    const endpoints = orchestrator.endpoints(id);
    if (!endpoints) throw new Error("endpoints missing");
    expect(endpoints.desktopd.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await probeDesktopd(endpoints.desktopd);
    expect(health?.ok).toBe(true);
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
