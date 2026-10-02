### Task 9: `doctor` checks for the Docker prerequisites

**Files:**
- Create: `apps/daemon/src/doctor.ts`, `apps/daemon/src/doctor-main.ts`
- Modify: `apps/daemon/package.json` (script `doctor`)
- Test: `apps/daemon/src/doctor.test.ts`, `apps/daemon/src/doctor.docker.test.ts`

**Interfaces:**
- Consumes: `DockerClient`, `DockerError`, `Images`, `isolatedNetworkSpec` (the probe network
  carries no `localdot.cell` label), `ISOLATED_GATEWAY_OPTION`.
- Produces: `interface DoctorCheck { name: string; ok: boolean; detail: string }`,
  `interface DoctorReport { ok: boolean; checks: DoctorCheck[] }`,
  `runDoctor(deps: { docker: DockerClient; images: Images; port: number }): Promise<DoctorReport>`,
  `MIN_ENGINE_MAJOR = 28`; CLI `pnpm --filter @localdot/daemon doctor` (exit 1 when any check fails).
  Check names: `docker-socket`, `docker-engine`, `isolated-gateway-mode`, `image-desktop`,
  `image-gate`, `port-<n>`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/doctor.test.ts`:
```ts
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "./cells/docker.ts";
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
    const report = await runDoctor({ docker: new DockerClient(fake.socketPath), images, port: await freePort() });
    expect(report.ok).toBe(true);
    const checks = byName(report);
    expect(checks["docker-engine"]?.detail).toContain("29.2.0");
    expect(checks["isolated-gateway-mode"]?.ok).toBe(true);
    expect(fake.state.networks.size).toBe(0);
    const probe = fake.state.calls.find((c) => c.method === "POST" && c.path === "/networks/create");
    expect(probe?.body).toMatchObject({ Internal: true });
    expect(probe?.body).not.toHaveProperty("Labels");
  });

  it("fails when the engine does not honour isolated gateway mode and removes its probe", async () => {
    fake = await startFakeDocker({ gatewayOnInternal: true });
    const report = await runDoctor({ docker: new DockerClient(fake.socketPath), images, port: await freePort() });
    expect(report.ok).toBe(false);
    expect(byName(report)["isolated-gateway-mode"]).toMatchObject({ ok: false });
    expect(byName(report)["isolated-gateway-mode"]?.detail).toContain("gateway");
    expect(fake.state.networks.size).toBe(0);
  });

  it("fails on an engine older than 28", async () => {
    fake = await startFakeDocker({
      version: { Version: "27.5.1", ApiVersion: "1.47", MinAPIVersion: "1.24", Os: "linux", Arch: "arm64" },
    });
    const report = await runDoctor({ docker: new DockerClient(fake.socketPath), images, port: await freePort() });
    expect(byName(report)["docker-engine"]).toMatchObject({ ok: false });
  });

  it("names a missing image and how to build it", async () => {
    fake = await startFakeDocker();
    fake.state.images.delete("localdot/desktop:dev");
    const report = await runDoctor({ docker: new DockerClient(fake.socketPath), images, port: await freePort() });
    expect(byName(report)["image-desktop"]).toMatchObject({ ok: false });
    expect(byName(report)["image-desktop"]?.detail).toContain("cells/desktop/build.sh");
    expect(byName(report)["image-gate"]?.ok).toBe(true);
  });

  it("skips the engine checks when the socket is unreachable", async () => {
    const report = await runDoctor({ docker: new DockerClient("/tmp/localdot-no-such.sock"), images, port: await freePort() });
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
```

- [ ] **Step 2: Run it to see it fail, then implement**

Run: `pnpm exec vitest run apps/daemon/src/doctor.test.ts`
Expected: FAIL — `Failed to load url ./doctor.ts`.

`apps/daemon/src/doctor.ts`:
```ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { type DockerClient, DockerError } from "./cells/docker.ts";
import type { Images } from "./cells/images.ts";
import { ISOLATED_GATEWAY_OPTION, isolatedNetworkSpec } from "./cells/spec.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  docker: DockerClient;
  images: Images;
  port: number;
}

// Isolated gateway mode for internal networks shipped with Engine 28; S3 verified it on 29.2.
export const MIN_ENGINE_MAJOR = 28;
const PROBE_NETWORK = "localdot-doctor-probe";

export async function runDoctor({ docker, images, port }: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const engineChecks = ["docker-engine", "isolated-gateway-mode", "image-desktop", "image-gate"];
  let socketOk = false;
  try {
    const v = await docker.version();
    socketOk = true;
    checks.push({ name: "docker-socket", ok: true, detail: `${docker.socketPath} (Engine ${v.Version}, API ${v.ApiVersion})` });
    const major = Number(v.Version.split(".")[0]);
    checks.push({
      name: "docker-engine",
      ok: major >= MIN_ENGINE_MAJOR,
      detail: major >= MIN_ENGINE_MAJOR ? `Engine ${v.Version}` : `Engine ${v.Version}; ${MIN_ENGINE_MAJOR}+ is required`,
    });
  } catch (err) {
    checks.push({ name: "docker-socket", ok: false, detail: messageOf(err) });
  }
  if (socketOk) {
    checks.push(await isolatedGatewayCheck(docker));
    checks.push(await imageCheck(docker, "image-desktop", images.desktop, "cells/desktop/build.sh"));
    checks.push(await imageCheck(docker, "image-gate", images.gate, "cells/gate/build.sh"));
  } else {
    for (const name of engineChecks) checks.push({ name, ok: false, detail: "skipped" });
  }
  checks.push(await portCheck(port));
  return { ok: checks.every((c) => c.ok), checks };
}

async function isolatedGatewayCheck(docker: DockerClient): Promise<DoctorCheck> {
  const name = "isolated-gateway-mode";
  let id: string | undefined;
  try {
    // A random suffix: a probe left behind by a crashed run must not make every later run a 409.
    // No localdot.cell label either, so nothing that looks for cells ever finds the probe.
    const probe = `${PROBE_NETWORK}-${randomBytes(4).toString("hex")}`;
    const created = await docker.request<{ Id: string }>({ method: "POST", path: "/networks/create", body: isolatedNetworkSpec(probe) });
    id = created.Id;
    const info = await docker.request<{ Options?: Record<string, string>; IPAM: { Config: { Gateway?: string }[] } }>({ method: "GET", path: `/networks/${id}` });
    // The API serializes an unset gateway as "" (or leaves it out); the CLI prints "invalid IP".
    const raw = info.IPAM.Config[0]?.Gateway;
    const gateway = raw && raw !== "invalid IP" ? raw : undefined;
    const honoured = info.Options?.[ISOLATED_GATEWAY_OPTION] === "isolated" && !gateway;
    return {
      name,
      ok: honoured,
      detail: honoured ? "internal networks get no gateway address" : `the engine still assigns a gateway (${gateway ?? "option dropped"}) to an isolated internal network`,
    };
  } catch (err) {
    return { name, ok: false, detail: messageOf(err) };
  } finally {
    if (id) await docker.request({ method: "DELETE", path: `/networks/${id}` }).catch(() => {});
  }
}

async function imageCheck(docker: DockerClient, name: string, image: string, buildScript: string): Promise<DoctorCheck> {
  try {
    await docker.request({ method: "GET", path: `/images/${encodeURIComponent(image)}/json` });
    return { name, ok: true, detail: image };
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) {
      return { name, ok: false, detail: `${image} is missing: build it with ${buildScript}` };
    }
    return { name, ok: false, detail: messageOf(err) };
  }
}

function portCheck(port: number): Promise<DoctorCheck> {
  const name = `port-${port}`;
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve({ name, ok: false, detail: err.code === "EADDRINUSE" ? `127.0.0.1:${port} is in use (a localdot daemon may be running)` : err.message });
    });
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve({ name, ok: true, detail: `127.0.0.1:${port} is free` })));
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

`apps/daemon/src/doctor-main.ts`:
```ts
import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { runDoctor } from "./doctor.ts";
import { parsePort } from "./port.ts";

const report = await runDoctor({ docker: new DockerClient(), images: imagesFromEnv(), port: parsePort(process.env.LOCALDOT_PORT) });
for (const check of report.checks) {
  console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(24)} ${check.detail}`);
}
process.exit(report.ok ? 0 : 1);
```

`apps/daemon/package.json` scripts — add:
```json
    "doctor": "tsx src/doctor-main.ts",
```

`apps/daemon/src/doctor.docker.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { DOCKER_TESTS } from "./cells/testing/docker-cli.ts";
import { runDoctor } from "./doctor.ts";

describe.skipIf(!DOCKER_TESTS)("doctor against Docker Desktop", () => {
  it("finds isolated gateway mode honoured and both images present", async () => {
    const report = await runDoctor({ docker: new DockerClient(), images: imagesFromEnv(), port: 4798 });
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests and the CLI**

Run: `pnpm exec vitest run apps/daemon/src/doctor.test.ts && LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/doctor.docker.test.ts && pnpm --filter @localdot/daemon doctor`
Expected: 6 unit tests and 1 Docker test pass; the CLI prints six `ok` lines (`docker-socket`,
`docker-engine`, `isolated-gateway-mode`, `image-desktop`, `image-gate`, `port-4750`) and exits 0
(or `FAIL port-4750 … in use` if a daemon is running, which is correct).

- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(daemon): doctor checks for Docker prerequisites"
```

---
