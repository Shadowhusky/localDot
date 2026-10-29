import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CellKeydWiring } from "../keyd/cell-wiring.ts";
import { KeydClient } from "../keyd/client.ts";
import { type KeydProcess, startKeyd, TEST_KEYD_PORTS } from "../keyd/testing/keyd-process.ts";
import { ComputerUpdates } from "./computer-update.ts";
import { DockerClient } from "./docker.ts";
import { hostAddress } from "./ipv4.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { probeDesktopd, probeStream } from "./readiness.ts";
import { newCellToken } from "./secrets.ts";
import {
  cellNames,
  DESKTOP_OFFSET,
  desktopSpec,
  egressNetworkSpec,
  GATE_OFFSET,
  gateSpec,
  homeVolumeSpec,
  internalNetworkSpec,
} from "./spec.ts";
import { CellStore } from "./store.ts";
import { SystemMigration } from "./system-migration.ts";
import { DOCKER_TESTS, docker, dockerExec } from "./testing/docker-cli.ts";
import type { CellRecord } from "./types.ts";

// Everything this suite makes carries the label, and only the label decides what it removes.
const LABEL = { "dev.localdot.test": "l9" };
const PREFIX = "ldtest-l9-up-";
const ROLES = ["desktop", "gate"] as const;
const tag = (role: (typeof ROLES)[number], build: string) => `localdot/${role}:l9-${build}`;
const images = { desktop: tag("desktop", "cur"), gate: tag("gate", "cur") };
const PROOF = "/config/l9-update-proof.txt";

const STATUS = "/var/lib/dpkg/status";
const MARKS = "/var/lib/apt/extended_states";
const LIBRARY_IDS = "/var/cache/ldconfig/aux-cache";
const markAuto = (name: string) =>
  `printf 'Package: ${name}\\nArchitecture: arm64\\nAuto-Installed: 1\\n\\n' >> ${MARKS}`;
// A library in a folder of its own, listed for the loader the way a package's would be.
const addLibrary = (name: string) =>
  `mkdir /usr/local/lib/${name} && cp -L /lib/*-linux-gnu/libz.so.1 /usr/local/lib/${name}/ && echo /usr/local/lib/${name} > /etc/ld.so.conf.d/${name}.conf && ldconfig`;

// Each new desktop installs packages and libraries the way apt would, rewriting the package
// databases and ldconfig's caches; so does the user, independently, in between. The user and
// the first new desktop also install the same package.
function buildImages(): void {
  const desktop: Record<string, string> = {
    a: "FROM localdot/desktop:dev\n",
    b: `FROM localdot/desktop:dev\nRUN printf '\\nPackage: localdot-test-shared\\nStatus: install ok installed\\nArchitecture: all\\nVersion: 1\\n\\n' >> ${STATUS}\nRUN ${markAuto("localdot-test-image-dep")} && ${addLibrary("l9-image")}\n`,
    c: `FROM ${tag("desktop", "b")}\nRUN ${markAuto("localdot-test-later-dep")} && ldconfig\n`,
  };
  for (const build of ["a", "b", "c"])
    for (const role of ROLES) {
      const from = role === "desktop" ? desktop[build] : "FROM localdot/gate:dev\n";
      const dockerfile = `${from}LABEL dev.localdot.test=l9 dev.localdot.l9.build=${build}\n`;
      const made = spawnSync("docker", ["build", "-q", "-t", tag(role, build), "-"], {
        input: dockerfile,
        encoding: "utf8",
      });
      if (made.status !== 0) throw new Error(`image build failed: ${made.stderr}`);
    }
  for (const role of ROLES) docker("tag", tag(role, "a"), tag(role, "cur"));
}

function removeLabelled(): void {
  const listed = (...args: string[]) =>
    docker(...args, "--filter", "label=dev.localdot.test=l9")
      .split("\n")
      .filter(Boolean);
  for (const id of listed("ps", "-aq")) spawnSync("docker", ["rm", "-fv", id], { stdio: "ignore" });
  for (const id of listed("network", "ls", "-q"))
    spawnSync("docker", ["network", "rm", id], { stdio: "ignore" });
  for (const name of listed("volume", "ls", "-q"))
    spawnSync("docker", ["volume", "rm", "-f", name], { stdio: "ignore" });
  // Updates also tag this suite's images as migration bases, backups and updated systems.
  for (const ref of listed("image", "ls", "--format", "{{.Repository}}:{{.Tag}}"))
    if (
      /^localdot\/(desktop|gate):l9-[a-z]+$/.test(ref) ||
      /^localdot\/(system-base|update-backup|updated-system):[a-z0-9-]+$/.test(ref)
    )
      spawnSync("docker", ["rmi", ref], { stdio: "ignore" });
  spawnSync("docker", ["image", "prune", "-f", "--filter", "label=dev.localdot.test=l9"], {
    stdio: "ignore",
  });
}

const imageId = (ref: string) => docker("image", "inspect", "-f", "{{.Id}}", ref);

describe.skipIf(!DOCKER_TESTS)("Update computer against Docker Desktop", () => {
  let home = "";
  let keyd: KeydProcess | undefined;
  let orchestrator: CellOrchestrator | undefined;
  let updates: ComputerUpdates;
  let store: CellStore;
  let record: CellRecord;

  const readyAgain = (id: string) =>
    new Promise<void>((resolve, reject) => {
      const stop = orchestrator?.subscribe((cell) => {
        if (cell.id !== id) return;
        if (cell.state === "ready") {
          stop?.();
          resolve();
        }
        if (cell.state === "failed") {
          stop?.();
          reject(new Error(cell.error));
        }
      });
    });

  // The computer is made by hand, the way the orchestrator makes one, so that its networks and
  // home also carry the suite's label.
  async function makeComputer(client: DockerClient): Promise<CellRecord> {
    const id = ulid();
    const names = cellNames(id, PREFIX);
    const network = async (spec: { Labels: Record<string, string> }) => {
      const made = await client.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: { ...spec, Labels: { ...spec.Labels, ...LABEL } },
      });
      const info = await client.request<{ IPAM: { Config: { Subnet: string }[] } }>({
        method: "GET",
        path: `/networks/${made.Id}`,
      });
      return { id: made.Id, subnet: info.IPAM.Config[0]?.Subnet ?? "" };
    };
    const internal = await network(internalNetworkSpec(names.internalNetwork, id));
    const egress = await network(egressNetworkSpec(names.egressNetwork, id));
    const home = homeVolumeSpec(names.homeVolume, id);
    await client.request({
      method: "POST",
      path: "/volumes/create",
      body: { ...home, Labels: { ...home.Labels, ...LABEL } },
    });
    const made: CellRecord = {
      v: 2,
      kind: "desktop",
      ownership: { internalNetwork: internal.id, egressNetwork: egress.id, gate: "", desktop: "" },
      id,
      createdAt: new Date().toISOString(),
      scale: 2,
      keydPort: TEST_KEYD_PORTS.from,
      tokens: { desktopd: newCellToken(), stream: newCellToken() },
      docker: {
        ...names,
        gateInternalIp: hostAddress(internal.subnet, GATE_OFFSET),
        gateEgressIp: hostAddress(egress.subnet, GATE_OFFSET),
        desktopIp: hostAddress(internal.subnet, DESKTOP_OFFSET),
      },
    };
    for (const [role, spec] of [
      ["gate", gateSpec(made, images.gate)],
      ["desktop", desktopSpec(made, images.desktop, { fullcolor: false })],
    ] as const) {
      const container = await client.request<{ Id: string }>({
        method: "POST",
        path: "/containers/create",
        query: { name: names[role] },
        body: spec,
      });
      if (made.ownership) made.ownership[role] = container.Id;
    }
    return made;
  }

  beforeAll(async () => {
    removeLabelled();
    buildImages();
    home = mkdtempSync(join(tmpdir(), "local dot's l9 update-"));
    keyd = await startKeyd();
    const client = new DockerClient();
    store = new CellStore(home, TEST_KEYD_PORTS);
    const migration = new SystemMigration(client, home);
    updates = new ComputerUpdates({
      home,
      docker: client,
      images,
      stream: { fullcolor: false },
      preflightSystem: (record, target) => migration.preflight(record, target),
      migrateSystem: (record, target) => migration.prepare(record, target),
    });
    orchestrator = new CellOrchestrator({
      docker: client,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath), docker: client }),
      store,
      images,
      updates,
      probeDesktopd,
      probeStream,
      namePrefix: PREFIX,
    });
    record = await makeComputer(client);
    store.save(record);
  });

  afterAll(async () => {
    if (orchestrator && record) await orchestrator.stop(record.id).catch(() => {});
    orchestrator?.dispose();
    removeLabelled();
    if (home) rmSync(home, { recursive: true, force: true });
    await keyd?.stop();
  });

  it("keeps the files in home when the computer moves onto a rebuilt image", async () => {
    const id = record.id;
    const running = orchestrator as CellOrchestrator;
    const ready = readyAgain(id);
    await running.start(id);
    await ready;
    const desktop = record.docker.desktop;
    expect(dockerExec(desktop, "sh", "-c", `echo kept > ${PROOF}`).status).toBe(0);
    expect(
      dockerExec(
        desktop,
        "sh",
        "-c",
        `printf '\\nPackage: localdot-test-shared\\nStatus: install ok installed\\nArchitecture: all\\nVersion: 1\\n\\nPackage: localdot-test-user-app\\nStatus: install ok installed\\nArchitecture: all\\nVersion: 1\\n\\n' >> ${STATUS} && ${markAuto("localdot-test-user-dep")} && ${addLibrary("l9-user")}`,
      ).status,
    ).toBe(0);
    expect(await updates.check(record)).toBe(false);

    for (const role of ROLES) docker("tag", tag(role, "b"), tag(role, "cur"));
    expect(await updates.check(record)).toBe(true);
    expect(running.get(id)?.updateAvailable).toBe(true);

    await running.pause(id);
    expect(docker("inspect", "-f", "{{.State.Paused}}", desktop)).toBe("true");
    const updated = readyAgain(id);
    await running.update(id);
    await updated;

    const next = store.get(id) as CellRecord;
    for (const role of ROLES) {
      expect(next.ownership?.[role]).not.toBe(record.ownership?.[role]);
      const actualImage = docker("inspect", "-f", "{{.Image}}", record.docker[role]);
      if (role === "desktop")
        expect(
          docker(
            "image",
            "inspect",
            "-f",
            '{{index .Config.Labels "localdot.system-base"}}',
            actualImage,
          ),
        ).toBe(imageId(tag(role, "b")));
      else expect(actualImage).toBe(imageId(tag(role, "b")));
      expect(spawnSync("docker", ["inspect", record.ownership?.[role] ?? ""]).status).not.toBe(0);
    }
    expect(docker("inspect", "-f", "{{range .Mounts}}{{.Name}} {{end}}", desktop).trim()).toBe(
      record.docker.homeVolume,
    );
    expect(dockerExec(desktop, "cat", PROOF).out.trim()).toBe("kept");
    const status = dockerExec(desktop, "cat", STATUS).out;
    expect(status.match(/Package: localdot-test-shared/g)).toHaveLength(1);
    expect(status).toContain("Package: localdot-test-user-app");
    const marks = dockerExec(desktop, "cat", MARKS).out;
    for (const name of ["localdot-test-image-dep", "localdot-test-user-dep"])
      expect(marks.match(new RegExp(`Package: ${name}\\n`, "g"))).toHaveLength(1);
    // The loader's index was rebuilt from both sides' libraries.
    const loader = dockerExec(desktop, "/sbin/ldconfig", "-p").out;
    for (const folder of ["l9-image", "l9-user"])
      expect(loader).toContain(`/usr/local/lib/${folder}/libz.so.1`);
    expect(running.get(id)).not.toHaveProperty("updateAvailable");
  });

  // The update that failed on the user's Mac: the new desktop only installed packages, and so did
  // the user, so both rewrote APT's marks and ldconfig's library identity cache.
  it("updates again when both sides changed only package marks and library caches", async () => {
    const id = record.id;
    const running = orchestrator as CellOrchestrator;
    const desktop = record.docker.desktop;
    expect(
      dockerExec(desktop, "sh", "-c", `${markAuto("localdot-test-user-later-dep")} && ldconfig`)
        .status,
    ).toBe(0);
    const ids = dockerExec(desktop, "sha256sum", LIBRARY_IDS).out;
    for (const role of ROLES) docker("tag", tag(role, "c"), tag(role, "cur"));
    expect(await updates.check(store.get(id) as CellRecord)).toBe(true);
    const updated = readyAgain(id);
    await running.update(id);
    await updated;

    expect(
      docker(
        "image",
        "inspect",
        "-f",
        '{{index .Config.Labels "localdot.system-base"}}',
        docker("inspect", "-f", "{{.Image}}", desktop),
      ),
    ).toBe(imageId(tag("desktop", "c")));
    expect(dockerExec(desktop, "sha256sum", LIBRARY_IDS).out).toBe(ids);
    const marks = dockerExec(desktop, "cat", MARKS).out;
    for (const name of [
      "localdot-test-image-dep",
      "localdot-test-user-dep",
      "localdot-test-later-dep",
      "localdot-test-user-later-dep",
    ])
      expect(marks.match(new RegExp(`Package: ${name}\\n`, "g"))).toHaveLength(1);
    expect(dockerExec(desktop, "cat", PROOF).out.trim()).toBe("kept");
    expect(running.get(id)).not.toHaveProperty("updateAvailable");
    expect(running.get(id)).not.toHaveProperty("updateBlocked");
  });
});
