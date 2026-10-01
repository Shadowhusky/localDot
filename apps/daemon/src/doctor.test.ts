import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient, DockerError, type DockerRequest } from "./cells/docker.ts";
import { type FakeDocker, startFakeDocker } from "./cells/testing/fake-docker.ts";
import { runDoctor } from "./doctor.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
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
    expect(probe?.body).not.toHaveProperty("Labels");
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

// Rejects the requests `fail` picks: "before" never reaches Docker; "after" does, the way a reply
// lost on its way back leaves Docker's change made.
function failing(socketPath: string, fail: (req: DockerRequest) => "before" | "after" | undefined) {
  return new (class extends DockerClient {
    override async request<T = undefined>(req: DockerRequest): Promise<T> {
      const when = fail(req);
      if (when === "after") await super.request(req);
      if (when) throw new DockerError(0, "ECONNRESET; is Docker Desktop running?", req.path);
      return super.request<T>(req);
    }
  })(socketPath);
}

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

  it("says which socket it used, and fails one the daemon would not find by itself", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    const fromEnv = await runDoctor({
      docker,
      images,
      port: await freePort(),
      socket: { path: fake.socketPath, source: "DOCKER_HOST" },
    });
    expect(byName(fromEnv)["docker-socket"]).toMatchObject({
      ok: true,
      detail: `${fake.socketPath} (DOCKER_HOST; Engine 29.2.0, API 1.53)`,
    });

    const fix = "localdot looks for /var/run/docker.sock (the default socket), which is missing: …";
    const viaContext = await runDoctor({
      docker,
      images,
      port: await freePort(),
      socket: { path: fake.socketPath, source: "the docker context desktop-linux", fix },
    });
    expect(byName(viaContext)["docker-socket"]).toMatchObject({
      ok: false,
      detail: `${fake.socketPath} (the docker context desktop-linux; Engine 29.2.0, API 1.53), but ${fix}`,
    });
    // The engine behind it is still checked, so the user sees that only the socket needs fixing.
    expect(viaContext.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["docker-socket"]);
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

describe("runDoctor's probe network", () => {
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
    expect(generated).toMatch(/^localdot-doctor-probe-[0-9a-f]{8}$/);
    expect(given).toBe("localdot-test-doctor-x");
    expect(fake.state.networks.size).toBe(0);
  });

  it("is removed even when the create's reply or the inspect is lost", async () => {
    fake = await startFakeDocker();
    for (const lost of ["POST /networks/create", "GET /networks/"]) {
      const docker = failing(fake.socketPath, (req) =>
        `${req.method} ${req.path}`.startsWith(lost) ? "after" : undefined,
      );
      const report = await runDoctor({ docker, images, port: await freePort() });
      expect(byName(report)["isolated-gateway-mode"], lost).toMatchObject({ ok: false });
      expect(fake.state.networks.size, lost).toBe(0);
    }
  });

  it("is reported, with the command that removes it, when Docker would not remove it", async () => {
    fake = await startFakeDocker();
    const docker = failing(fake.socketPath, (req) =>
      req.method === "DELETE" ? "before" : undefined,
    );
    const report = await runDoctor({
      docker,
      images,
      port: await freePort(),
      probeNetwork: "localdot-doctor-probe-left",
    });
    expect(byName(report)["isolated-gateway-mode"]).toMatchObject({ ok: false });
    expect(byName(report)["isolated-gateway-mode"]?.detail).toBe(
      "internal networks get no gateway address; could not remove the probe network (docker network rm localdot-doctor-probe-left): docker unreachable on /networks/localdot-doctor-probe-left: ECONNRESET; is Docker Desktop running?",
    );
  });
});
