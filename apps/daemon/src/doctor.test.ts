import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient, DockerError } from "./cells/docker.ts";
import { type FakeDocker, startFakeDocker } from "./cells/testing/fake-docker.ts";
import { runDoctor, vaultCheck } from "./doctor.ts";
import { findDockerSocket } from "./doctor-socket.ts";
import { KeydClient } from "./keyd/client.ts";
import { type FakeKeyd, startFakeKeyd } from "./keyd/testing/fake-keyd.ts";
import type { HostPlatform } from "./platform/host.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
describe("runDoctor's key layer checks", () => {
  let keyd: FakeKeyd | undefined;
  afterEach(async () => {
    await keyd?.close();
    keyd = undefined;
  });

  const keydChecks = async (client?: Pick<KeydClient, "status">) => {
    fake = await startFakeDocker();
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      keyd: client ?? new KeydClient(keyd?.socketPath ?? "/tmp/ld-no-keyd/admin.sock", 500),
    });
    return { report, checks: byName(report) };
  };

  it("passes while keyd answers and its hairpin guard knows the public address", async () => {
    keyd = await startFakeKeyd();
    const { report, checks } = await keydChecks();
    expect(report.ok).toBe(true);
    expect(checks.keyd?.detail).toContain(`boot ${keyd.bootId}`);
    expect(checks["hairpin-guard"]).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^active/),
    });
  });

  it("fails while the hairpin guard is unknown or off, and says why", async () => {
    keyd = await startFakeKeyd();
    keyd.hairpin = { state: "unknown", addresses: 0, error: "nat-pmp 192.168.1.1: timeout" };
    const unknown = (await keydChecks()).checks["hairpin-guard"];
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown?.detail).toMatch(/^unknown: .*keeps asking: nat-pmp 192\.168\.1\.1: timeout$/);
    await fake?.close();
    keyd.hairpin = { state: "off", addresses: 0 };
    expect((await keydChecks()).checks["hairpin-guard"]?.detail).toMatch(/^off: /);
  });

  it("says to start keyd when it does not answer", async () => {
    const { report, checks } = await keydChecks();
    expect(report.ok).toBe(false);
    expect(checks.keyd).toMatchObject({ ok: false, detail: expect.stringContaining("start keyd") });
    expect(checks["hairpin-guard"]).toMatchObject({ ok: false, detail: "skipped" });
  });

  it("fails while the audit log cannot be written", async () => {
    keyd = await startFakeKeyd();
    keyd.auditOk = false;
    const { report, checks } = await keydChecks();
    expect(report.ok).toBe(false);
    expect(checks.keyd).toMatchObject({ ok: false, detail: expect.stringContaining("disk full") });
    expect(report.checks.slice(-2).map((check) => check.name)).toEqual(["keyd", "hairpin-guard"]);
  });

  it("does not assume that a missing hairpin status is active", async () => {
    keyd = await startFakeKeyd();
    const client = new KeydClient(keyd.socketPath);
    const { report, checks } = await keydChecks({
      status: async () => ({ ...(await client.status()), hairpin: undefined }),
    });
    expect(report.ok).toBe(false);
    expect(checks["hairpin-guard"]).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/^unknown:/),
    });
  });
});
let fake: FakeDocker | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const byName = (report: Awaited<ReturnType<typeof runDoctor>>) =>
  Object.fromEntries(report.checks.map((c) => [c.name, c]));

// A port nothing listens on, so the port check passes even while a daemon runs on 4750.
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe("runDoctor", () => {
  it("passes on a healthy engine with both images", async () => {
    fake = await startFakeDocker();
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    expect(report.ok).toBe(true);
    const checks = byName(report);
    expect(checks["docker-engine"]?.detail).toContain("29.2.0");
    expect(checks["isolated-gateway-mode"]?.ok).toBe(true);
    expect(fake.state.networks.size).toBe(0);
    const probe = fake.state.calls.find(
      (c) => c.method === "POST" && c.path === "/networks/create",
    );
    expect(probe?.body).toMatchObject({ Internal: true });
    expect(probe?.body).toMatchObject({
      Labels: { "localdot.doctor-probe": expect.stringMatching(/^[a-f0-9]{32}$/) },
    });
  });

  it("fails when the engine does not honour isolated gateway mode and removes its probe", async () => {
    fake = await startFakeDocker({ gatewayOnInternal: true });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    expect(report.ok).toBe(false);
    expect(byName(report)["isolated-gateway-mode"]).toMatchObject({ ok: false });
    expect(byName(report)["isolated-gateway-mode"]?.detail).toContain("gateway");
    expect(fake.state.networks.size).toBe(0);
  });

  it("reports the installed image architecture instead of trusting its tag", async () => {
    fake = await startFakeDocker();
    fake.state.imageInspect = (reference, reply) =>
      reference === images.desktop ? { ...reply, Architecture: "amd64" } : reply;
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    expect(report.ok).toBe(false);
    expect(byName(report)["image-desktop"]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("linux/amd64"),
    });
    expect(byName(report)["image-gate"]?.ok).toBe(true);
    expect(fake.state.networks.size).toBe(0);
  });

  it("refuses a missing repository digest even when the image inspect request succeeds", async () => {
    fake = await startFakeDocker();
    const desktop = `ghcr.io/localdot/desktop@sha256:${"a".repeat(64)}`;
    fake.state.images.add(desktop);
    fake.state.imageInspect = (reference, reply) =>
      reference === desktop ? { ...reply, RepoDigests: [] } : reply;
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images: { ...images, desktop },
      port: await freePort(),
    });
    expect(report.ok).toBe(false);
    expect(byName(report)["image-desktop"]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("repository digest"),
    });
    expect(fake.state.networks.size).toBe(0);
  });

  it("fails on an engine older than 28", async () => {
    fake = await startFakeDocker({
      version: {
        Version: "27.5.1",
        ApiVersion: "1.47",
        MinAPIVersion: "1.24",
        Os: "linux",
        Arch: "arm64",
      },
    });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    expect(byName(report)["docker-engine"]).toMatchObject({ ok: false });
  });

  it("names a missing image and how to build it", async () => {
    fake = await startFakeDocker();
    fake.state.images.delete("localdot/desktop:dev");
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    expect(byName(report)["image-desktop"]).toMatchObject({ ok: false });
    expect(byName(report)["image-desktop"]?.detail).toContain("cells/desktop/build.sh");
    expect(byName(report)["image-gate"]?.ok).toBe(true);
  });

  it("skips the engine checks when the socket is unreachable", async () => {
    const report = await runDoctor({
      docker: new DockerClient("/tmp/localdot-no-such.sock"),
      images,
      port: await freePort(),
    });
    expect(report.ok).toBe(false);
    expect(byName(report)["docker-socket"]?.ok).toBe(false);
    expect(byName(report)["isolated-gateway-mode"]).toMatchObject({ ok: false, detail: "skipped" });
  });

  it("reports a port that is already in use", async () => {
    fake = await startFakeDocker();
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const port = (holder.address() as { port: number }).port;
    const report = await runDoctor({ docker: new DockerClient(fake.socketPath), images, port });
    expect(byName(report)[`port-${port}`]).toMatchObject({ ok: false });
    await new Promise<void>((r) => holder.close(() => r()));
  });
});

const details = (report: Awaited<ReturnType<typeof runDoctor>>) =>
  report.checks.map((c) => c.detail).join("\n");

const engine26 = {
  Version: "26.1.4",
  ApiVersion: "1.45",
  MinAPIVersion: "1.24",
  Os: "linux",
  Arch: "arm64",
};

describe("runDoctor's readable answers", () => {
  it("explains an engine too old for the API localdot speaks, instead of Docker's raw reply", async () => {
    fake = await startFakeDocker({ version: engine26 });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    const checks = byName(report);
    expect(checks["docker-socket"]).toMatchObject({ ok: true });
    expect(checks["docker-socket"]?.detail).toContain("Engine 26.1.4, API 1.24–1.45");
    expect(checks["docker-engine"]).toMatchObject({
      ok: false,
      detail:
        "Docker Engine 26.1.4 is too old: it serves API 1.24–1.45 and localdot speaks 1.47; update Docker Desktop (Engine 28+)",
    });
    expect(checks["isolated-gateway-mode"]).toMatchObject({ ok: false, detail: "skipped" });
    expect(fake.state.calls.some((c) => c.path === "/networks/create")).toBe(false);
    expect(details(report)).not.toMatch(/[{}]/);
  });

  it("explains an engine that no longer serves the API localdot speaks", async () => {
    fake = await startFakeDocker({
      version: {
        Version: "35.0.0",
        ApiVersion: "1.60",
        MinAPIVersion: "1.50",
        Os: "linux",
        Arch: "arm64",
      },
    });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    expect(byName(report)["docker-engine"]).toMatchObject({
      ok: false,
      detail:
        "Docker Engine 35.0.0 is too new: it serves API 1.50–1.60 and localdot speaks 1.47; update localdot",
    });
    expect(details(report)).not.toMatch(/[{}]/);
  });

  it("names a refused API version even when the engine will not say which it serves", async () => {
    fake = await startFakeDocker({ version: engine26 });
    const docker = new (class extends DockerClient {
      override engineVersion() {
        return Promise.reject(new DockerError(0, "ECONNRESET", "/version"));
      }
    })(fake.socketPath);
    const report = await runDoctor({ docker, images, port: await freePort() });
    expect(byName(report)["docker-engine"]).toMatchObject({
      ok: false,
      detail: "Docker refused API 1.47, the version localdot speaks (HTTP 400 on /version)",
    });
    expect(details(report)).not.toMatch(/[{}]/);
  });

  it("says which socket it used", async () => {
    fake = await startFakeDocker();
    const fromEnv = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      socket: { path: fake.socketPath, source: "DOCKER_HOST" },
    });
    expect(byName(fromEnv)["docker-socket"]).toMatchObject({
      ok: true,
      detail: `${fake.socketPath} (DOCKER_HOST; Engine 29.2.0, API 1.53)`,
    });
  });

  it("passes the docker context's socket, which the daemon finds too, and names it", async () => {
    fake = await startFakeDocker();
    const path = fake.socketPath;
    const socket = findDockerSocket(
      { HOME: "/Users/me" },
      {
        exists: (candidate) => candidate === path,
        context: () => ({ name: "desktop-linux", host: `unix://${path}` }),
      },
    );
    const report = await runDoctor({
      docker: new DockerClient(socket.path),
      socket,
      images,
      port: await freePort(),
    });
    expect(byName(report)["docker-socket"]).toEqual({
      name: "docker-socket",
      ok: true,
      detail: `${path} (the docker context desktop-linux; Engine 29.2.0, API 1.53)`,
    });
    expect(report.ok).toBe(true);
  });

  it("reports a socket that does not answer, and skips the engine checks", async () => {
    fake = await startFakeDocker();
    const answer = Promise.withResolvers<void>();
    fake.state.holds.set("GET /version", answer.promise);
    // Docker answers after a second, so a doctor without a deadline returns instead of hanging.
    const late = setTimeout(answer.resolve, 1000);
    try {
      const report = await runDoctor({
        docker: new DockerClient(fake.socketPath),
        images,
        port: await freePort(),
        versionDeadlineMs: 50,
      });
      expect(byName(report)["docker-socket"]).toEqual({
        name: "docker-socket",
        ok: false,
        detail: `not answering on ${fake.socketPath} after 0.05 s`,
      });
      expect(byName(report)["isolated-gateway-mode"]).toMatchObject({
        ok: false,
        detail: "skipped",
      });
    } finally {
      clearTimeout(late);
      answer.resolve();
    }
  });

  it("names the socket it could not reach", async () => {
    const report = await runDoctor({
      docker: new DockerClient("/tmp/localdot-no-such.sock"),
      images,
      port: await freePort(),
      socket: { path: "/tmp/localdot-no-such.sock", source: "DOCKER_HOST" },
    });
    expect(byName(report)["docker-socket"]?.detail).toBe(
      "/tmp/localdot-no-such.sock (DOCKER_HOST): docker unreachable on /version: ENOENT; is Docker Desktop running?",
    );
  });
});

describe("runDoctor's gateway check", () => {
  it.each([
    [
      "has no IPAM at all",
      (r: Record<string, unknown>) => ({ ...r, IPAM: null }),
      "no IPv4 subnet",
    ],
    [
      "has no IPv4 subnet",
      (r: Record<string, unknown>) => ({ ...r, IPAM: { Config: [] } }),
      "no IPv4 subnet",
    ],
    [
      "is not internal",
      (r: Record<string, unknown>) => ({ ...r, Internal: false }),
      "not internal",
    ],
  ])("fails, with a reason, a probe network that %s", async (_what, reply, reason) => {
    fake = await startFakeDocker({ networkInspect: reply });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
    });
    const check = byName(report)["isolated-gateway-mode"];
    expect(check).toMatchObject({ ok: false, detail: expect.stringContaining(reason) });
    expect(check?.detail).not.toMatch(/Cannot read|undefined|null/);
    expect(fake.state.networks.size).toBe(0);
  });
});

describe("runDoctor's probe network", () => {
  const network = (name: string) => ({
    method: "POST" as const,
    path: "/networks/create",
    body: { Name: name, Driver: "bridge" },
  });

  it("never removes older networks by a shared prefix or age", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    for (const name of ["localdot-doctor-probe-stale", "localdot-doctor-probe-fresh", "other"]) {
      await docker.request(network(name));
    }
    const age = (name: string, minutes: number) => {
      const net = fake?.state.networks.get(name);
      if (net) net.created = new Date(Date.now() - minutes * 60_000).toISOString();
    };
    age("localdot-doctor-probe-stale", 10);
    age("localdot-doctor-probe-fresh", 1);
    await runDoctor({ docker, images, port: await freePort() });
    expect([...fake.state.networks.keys()].sort()).toEqual([
      "localdot-doctor-probe-fresh",
      "localdot-doctor-probe-stale",
      "other",
    ]);
  });

  it("leaves a network of its name alone when Docker refuses to create the probe", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    await docker.request(network("localdot-doctor-probe-taken"));
    const report = await runDoctor({
      docker,
      images,
      port: await freePort(),
      probeNetwork: "localdot-doctor-probe-taken",
    });
    expect(byName(report)["isolated-gateway-mode"]).toMatchObject({ ok: false });
    expect(fake.state.networks.has("localdot-doctor-probe-taken")).toBe(true);
  });

  it("does not delete anything when the failed create left no owned network", async () => {
    fake = await startFakeDocker();
    fake.state.failRequests.add("POST /networks/create");
    await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      probeNetwork: "localdot-doctor-probe-maybe",
    });
    const deletes = fake.state.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual([]);
  });

  const creates = (f: FakeDocker) =>
    f.state.calls
      .filter((c) => c.method === "POST" && c.path === "/networks/create")
      .map((c) => (c.body as { Name: string }).Name);

  it("is named localdot-doctor-probe-<hex>, or the name it is given, and removed", async () => {
    fake = await startFakeDocker();
    await runDoctor({ docker: new DockerClient(fake.socketPath), images, port: await freePort() });
    await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      probeNetwork: "localdot-test-doctor-x",
    });
    const [generated, given] = creates(fake);
    expect(generated).toMatch(/^localdot-doctor-probe-[0-9a-f]{32}$/);
    expect(given).toBe("localdot-test-doctor-x");
    expect(fake.state.networks.size).toBe(0);
  });

  it("is removed even when the create's reply or the inspect is lost", async () => {
    fake = await startFakeDocker();
    for (const lost of ["POST /networks/create", `GET /networks/${"2".padStart(64, "0")}`]) {
      fake.state.loseReplies.add(lost);
      const docker = new DockerClient(fake.socketPath);
      const report = await runDoctor({ docker, images, port: await freePort() });
      expect(byName(report)["isolated-gateway-mode"], lost).toMatchObject({ ok: false });
      expect(fake.state.networks.size, lost).toBe(0);
    }
  });

  it("reports uncertain cleanup without instructing deletion of a possibly replaced name", async () => {
    fake = await startFakeDocker();
    fake.state.failRequests.add("DELETE /networks/");
    const docker = new DockerClient(fake.socketPath);
    const report = await runDoctor({
      docker,
      images,
      port: await freePort(),
      probeNetwork: "localdot-doctor-probe-left",
    });
    expect(byName(report)["isolated-gateway-mode"]).toMatchObject({ ok: false });
    expect(byName(report)["isolated-gateway-mode"]?.detail).toBe(
      "Diagnostic network cleanup could not be confirmed. Check Docker Desktop; no other network was removed.",
    );
  });
});

describe("runDoctor on Linux", () => {
  const linux: HostPlatform = {
    os: "linux",
    arch: "x64",
    user: "ana",
    wsl: null,
    systemd: true,
    desktop: false,
    linger: false,
  };
  const limits = { MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true };

  it("leads with the machine and checks the engine's limits", async () => {
    fake = await startFakeDocker({ info: { OperatingSystem: "Ubuntu 24.04.1 LTS", ...limits } });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      host: linux,
    });
    expect(report.checks[0]).toMatchObject({
      name: "host-platform",
      ok: true,
      detail: expect.stringContaining("enable-linger ana"),
    });
    expect(byName(report)["docker-limits"]).toMatchObject({ ok: true });
    expect(report.ok).toBe(true);
  });

  it("fails an engine that would drop the computers' memory limit", async () => {
    fake = await startFakeDocker({ info: { ...limits, MemoryLimit: false } });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      host: linux,
    });
    expect(report.ok).toBe(false);
    expect(byName(report)["docker-limits"]?.detail).toContain("cgroup_enable=memory");
  });

  it("says how to update the native engine when internal networks keep a gateway", async () => {
    fake = await startFakeDocker({ gatewayOnInternal: true, info: limits });
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      host: linux,
    });
    expect(byName(report)["isolated-gateway-mode"]?.detail).toContain(
      "Update Docker Engine to version 28 or later",
    );
  });

  it("keeps macOS as it was: no machine check and no /info request of its own", async () => {
    const infoCalls = async (host: typeof linux) => {
      fake = await startFakeDocker({ info: limits });
      const report = await runDoctor({
        docker: new DockerClient(fake.socketPath),
        images,
        port: await freePort(),
        host,
      });
      const calls = fake.state.calls.filter((call) => call.path.endsWith("/info")).length;
      await fake.close();
      fake = undefined;
      return { report, calls };
    };
    const mac = await infoCalls({ ...linux, os: "macos", desktop: true });
    expect(mac.report.checks[0]?.name).toBe("docker-socket");
    expect(byName(mac.report)["docker-limits"]).toBeUndefined();
    expect((await infoCalls(linux)).calls).toBe(mac.calls + 1);
  });
});

describe("vaultCheck", () => {
  it("says where keys live and how to unlock a passphrase vault", () => {
    expect(vaultCheck({ backend: "secret-service", state: "ready" })).toEqual({
      name: "key-vault",
      ok: true,
      detail: "Saved keys are kept in your desktop keyring.",
    });
    expect(vaultCheck({ backend: "file", state: "ready", key: "tpm" }).detail).toContain("TPM");
    expect(vaultCheck({ backend: "file", state: "locked", key: "passphrase" })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("localdot unlock"),
    });
    expect(vaultCheck({ backend: "file", state: "setup" })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Choose its passphrase"),
    });
  });
});
