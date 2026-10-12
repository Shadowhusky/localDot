import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostAddress } from "./ipv4.ts";
import { gateRelay, gateRelayEnv, gateRelayMounts, makeRelayDirs } from "./relay.ts";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  publishedPort,
  removeAll,
  sleepSync,
  subnetOf,
} from "./testing/docker-cli.ts";

const GATE_DIR = fileURLToPath(new URL("../../../../cells/gate", import.meta.url));
const GATE_IMAGE = process.env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev";
const PROBE_IMAGE = "localdot/probe:test";
const PROBE_DOCKERFILE = `FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache curl busybox-extras && mkdir -p /www && echo cell-ok > /www/index.html
CMD ["sh", "-c", "httpd -f -p 3000 -h /www & exec httpd -f -p 7700 -h /www"]
`;
const names = {
  containers: ["localdot-test-cell", "localdot-test-gate", "localdot-test-egressprobe"],
  networks: ["localdot-test-sbx", "localdot-test-egress"],
};
const KEYD_PORT = 4799;
// The keyd stand-in answers from its own thread: dockerExec blocks this one until curl exits.
const HOST_LISTENER = `const { parentPort, workerData } = require("node:worker_threads");
require("node:http")
  .createServer((_req, res) => res.end("host-ok\\n"))
  .listen(workerData.socket ? { path: workerData.socket } : { port: ${KEYD_PORT}, host: "127.0.0.1" }, () => {
    if (workerData.socket) require("node:fs").chmodSync(workerData.socket, 0o666);
    parentPort.postMessage("listening");
  });
`;

let listener: Worker;
let relayHome: string | undefined;
let gateInternal = "";
let gateEgress = "";
let cell = "";
let desktopdPort = 0;
let streamPort = 0;

const curl = (container: string, url: string) =>
  dockerExec(container, "curl", "-sS", "-m", "5", url);

describe.skipIf(!DOCKER_TESTS)("gate image", () => {
  beforeAll(async () => {
    removeAll(names);
    if (!process.env.LOCALDOT_GATE_IMAGE)
      execFileSync("docker", ["build", "-q", "-t", GATE_IMAGE, GATE_DIR], {
        stdio: "ignore",
      });
    execFileSync("docker", ["build", "-q", "-t", PROBE_IMAGE, "-"], {
      input: PROBE_DOCKERFILE,
      stdio: ["pipe", "ignore", "ignore"],
    });
    relayHome = mkdtempSync(join(tmpdir(), "localdot-gate-relay-"));
    const relay = gateRelay(JSON.parse(docker("info", "--format", "{{json .}}")), relayHome);
    if (relay.kind === "socket") makeRelayDirs(relayHome);
    listener = new Worker(HOST_LISTENER, {
      eval: true,
      workerData: {
        socket: relay.kind === "socket" ? join(relay.keydDir, `${KEYD_PORT}.sock`) : undefined,
      },
    });
    await once(listener, "message");

    // Reserve unused subnets with Docker, then declare them explicitly: older engines
    // reject static --ip assignments on networks using automatic IPAM configuration.
    for (const name of names.networks) docker("network", "create", name);
    const internalSubnet = subnetOf("localdot-test-sbx");
    const egressSubnet = subnetOf("localdot-test-egress");
    for (const name of names.networks) docker("network", "rm", name);
    docker(
      "network",
      "create",
      "--subnet",
      internalSubnet,
      "--internal",
      "-o",
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      "localdot-test-sbx",
    );
    docker("network", "create", "--subnet", egressSubnet, "localdot-test-egress");
    gateInternal = hostAddress(subnetOf("localdot-test-sbx"), 10);
    cell = hostAddress(subnetOf("localdot-test-sbx"), 11);
    gateEgress = hostAddress(subnetOf("localdot-test-egress"), 10);

    docker(
      "run",
      "-d",
      "--name",
      "localdot-test-cell",
      "--network",
      "localdot-test-sbx",
      "--ip",
      cell,
      PROBE_IMAGE,
    );
    docker(
      "run",
      "-d",
      "--name",
      "localdot-test-gate",
      "--network",
      "localdot-test-egress",
      "--ip",
      gateEgress,
      "-p",
      "127.0.0.1:0:8081",
      "-p",
      "127.0.0.1:0:8082",
      "--cap-drop",
      "ALL",
      "--read-only",
      "--security-opt",
      "no-new-privileges",
      "-e",
      `LD_INTERNAL_ADDR=${gateInternal}`,
      "-e",
      `LD_EGRESS_ADDR=${gateEgress}`,
      "-e",
      `LD_DESKTOP_ADDR=${cell}`,
      "-e",
      `LD_KEYD_PORT=${KEYD_PORT}`,
      ...gateRelayEnv(relay, KEYD_PORT, false).flatMap((value) => ["-e", value]),
      ...(gateRelayMounts(relay, false).Mounts ?? []).flatMap((mount) => [
        "--mount",
        `type=bind,src=${mount.Source},dst=${mount.Target},readonly`,
      ]),
      GATE_IMAGE,
    );
    docker("network", "connect", "--ip", gateInternal, "localdot-test-sbx", "localdot-test-gate");
    docker(
      "run",
      "-d",
      "--name",
      "localdot-test-egressprobe",
      "--network",
      "localdot-test-egress",
      PROBE_IMAGE,
    );
    desktopdPort = publishedPort("localdot-test-gate", "8081");
    streamPort = publishedPort("localdot-test-gate", "8082");
    sleepSync(2000);
  });

  afterAll(async () => {
    removeAll(names);
    await listener?.terminate();
    if (relayHome) rmSync(relayHome, { recursive: true, force: true });
  });

  it("relays the cell through the platform’s private host transport", () => {
    expect(curl("localdot-test-cell", `http://${gateInternal}:3128/`).out).toContain("host-ok");
  });

  it("publishes the inbound relays on 127.0.0.1 only", async () => {
    expect(await (await fetch(`http://127.0.0.1:${desktopdPort}/`)).text()).toContain("cell-ok");
    expect(await (await fetch(`http://127.0.0.1:${streamPort}/`)).text()).toContain("cell-ok");
    expect(docker("port", "localdot-test-gate", "8081")).toMatch(/^127\.0\.0\.1:/);
  });

  it("does not expose the keyd relay on the egress network", () => {
    expect(curl("localdot-test-egressprobe", `http://${gateEgress}:3128/`).status).not.toBe(0);
    expect(curl("localdot-test-egressprobe", `http://${gateEgress}:8081/`).out).toContain(
      "cell-ok",
    );
  });

  it("does not expose the inbound relays on the internal network", () => {
    expect(curl("localdot-test-cell", `http://${gateInternal}:8081/`).status).not.toBe(0);
    expect(curl("localdot-test-cell", `http://${gateInternal}:8082/`).status).not.toBe(0);
  });

  it("keeps the cell off the internet and the host", () => {
    expect(curl("localdot-test-cell", "https://example.com").status).not.toBe(0);
    expect(curl("localdot-test-cell", `http://host.docker.internal:${KEYD_PORT}/`).status).not.toBe(
      0,
    );
    // Engine 29 renders the unset gateway of an isolated network as "invalid IP" (S3 saw the same).
    expect(["", "invalid IP"]).toContain(
      docker(
        "network",
        "inspect",
        "-f",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
        "localdot-test-sbx",
      ),
    );
  });

  it("runs as nobody with every capability dropped", () => {
    expect(dockerExec("localdot-test-gate", "id", "-u").out.trim()).toBe("65534");
    expect(
      docker(
        "inspect",
        "-f",
        "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}",
        "localdot-test-gate",
      ),
    ).toBe("true [ALL]");
  });

  // Last: it stops the shared gate.
  it("exits cleanly on docker stop instead of waiting to be killed", () => {
    const started = Date.now();
    docker("stop", "-t", "10", "localdot-test-gate");
    const elapsedMs = Date.now() - started;
    expect(docker("inspect", "-f", "{{.State.ExitCode}}", "localdot-test-gate")).toBe("0");
    expect(elapsedMs).toBeLessThan(3000);
  });
});
