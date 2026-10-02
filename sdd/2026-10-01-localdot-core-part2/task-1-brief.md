### Task 1: Gate image with address-bound relays, and the Docker test gate

The gate is a cell's only door. Its relay to keyd must listen only on the gate's internal-network
address, and its inbound relays only on the egress-network address where Docker delivers published
ports. S3 proved the topology with relays on every interface; this task pins the bind addresses and
proves them.

**Files:**
- Create: `cells/gate/Dockerfile`, `cells/gate/relay.sh`, `cells/gate/build.sh`
- Create: `apps/daemon/src/cells/ipv4.ts`, `apps/daemon/src/cells/testing/docker-cli.ts`
- Create: `vitest.docker.config.ts`
- Modify: `vitest.config.ts`, `package.json` (root), `.gitignore`
- Test: `apps/daemon/src/cells/ipv4.test.ts`, `apps/daemon/src/cells/gate-image.docker.test.ts`

**Interfaces:**
- Produces: image `localdot/gate:dev` taking env `LD_INTERNAL_ADDR`, `LD_EGRESS_ADDR`,
  `LD_DESKTOP_ADDR`, `LD_KEYD_PORT`; relays `internal:3128 → host.docker.internal:LD_KEYD_PORT`,
  `egress:8081 → LD_DESKTOP_ADDR:7700` (desktopd), `egress:8082 → LD_DESKTOP_ADDR:3000` (Selkies
  behind nginx). `hostAddress(cidr: string, offset: number): string`. Test helpers `docker(...args)`,
  `dockerOk(...args)`, `dockerExec(container, ...cmd)`, `publishedPort(container, port)`,
  `subnetOf(network)`, `removeAll({containers, networks, volumes})`, `sleepSync(ms)`,
  `waitFor(pred, ms)`, `DOCKER_TESTS`. Root script `pnpm test:docker`.

- [ ] **Step 1: Branch and the Docker test gate**

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot" && git switch -c feat/core-part2 feat/core-part1
```

`vitest.docker.config.ts`:
```ts
import { defineConfig } from "vitest/config";

// Docker-backed suites: opt in with LOCALDOT_DOCKER_TESTS=1 pnpm test:docker.
export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.docker.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
```

`vitest.config.ts` (replace the whole file):
```ts
import { defineConfig } from "vitest/config";

// No `esbuild` block: Vite 8 (under Vitest 5) deprecates it in favour of oxc, and its default JSX
// runtime is already automatic.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "cells/*/desktopd/src/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", "**/*.docker.test.ts"],
  },
});
```

Root `package.json`: add to `"scripts"` (keep the others):
```json
    "test:docker": "vitest run --config vitest.docker.config.ts",
```

`.gitignore`: append
```
cells/desktop/desktopd/dist/
apps/web/dist/
apps/web/e2e/out/
spikes/s8-hosted-client/client/
test-results/
```

- [ ] **Step 2: Write the failing IPv4 helper test**

`apps/daemon/src/cells/ipv4.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hostAddress } from "./ipv4.ts";

describe("hostAddress", () => {
  it("adds an offset to the network address", () => {
    expect(hostAddress("172.24.0.0/16", 10)).toBe("172.24.0.10");
    expect(hostAddress("10.1.2.0/24", 11)).toBe("10.1.2.11");
    expect(hostAddress("172.24.0.0/16", 300)).toBe("172.24.1.44");
  });

  it("rejects offsets outside the host range and malformed inputs", () => {
    expect(() => hostAddress("10.1.2.0/24", 255)).toThrow(RangeError);
    expect(() => hostAddress("10.1.2.0/24", 0)).toThrow(RangeError);
    expect(() => hostAddress("10.1.2.0", 1)).toThrow(RangeError);
    expect(() => hostAddress("10.1.2.300/24", 1)).toThrow(RangeError);
    expect(() => hostAddress("fd00::/64", 1)).toThrow(RangeError);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd "/Volumes/Husky's SSD 4T/Projects/localdot" && pnpm exec vitest run apps/daemon/src/cells/ipv4.test.ts`
Expected: FAIL — `Failed to load url ./ipv4.ts`.

- [ ] **Step 4: Implement the helper and the Docker CLI test helpers**

`apps/daemon/src/cells/ipv4.ts`:
```ts
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

// Docker picks each cell network's subnet; the daemon places the gate and the desktop at fixed
// offsets inside it, so the gate knows every address before any container starts.
export function hostAddress(cidr: string, offset: number): string {
  const m = CIDR.exec(cidr);
  if (!m) throw new RangeError(`not an IPv4 CIDR: ${cidr}`);
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 30) throw new RangeError(`not an IPv4 CIDR: ${cidr}`);
  const size = 2 ** (32 - prefix);
  if (!Number.isInteger(offset) || offset < 1 || offset >= size - 1) {
    throw new RangeError(`offset ${offset} is outside the hosts of ${cidr}`);
  }
  const base = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const network = base - (base % size);
  const address = network + offset;
  return [24, 16, 8, 0].map((shift) => (address >>> shift) & 255).join(".");
}
```

`apps/daemon/src/cells/testing/docker-cli.ts`:
```ts
import { execFileSync, spawnSync } from "node:child_process";

export const DOCKER_TESTS = process.env.LOCALDOT_DOCKER_TESTS === "1";

export function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function dockerOk(...args: string[]): boolean {
  return spawnSync("docker", args, { stdio: "ignore" }).status === 0;
}

export function dockerExec(container: string, ...cmd: string[]): { status: number; out: string } {
  const r = spawnSync("docker", ["exec", container, ...cmd], { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export function dockerExecAs(
  container: string,
  user: string,
  ...cmd: string[]
): { status: number; out: string } {
  const r = spawnSync("docker", ["exec", "-u", user, container, ...cmd], { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export function publishedPort(container: string, port: string): number {
  // docker port prints "127.0.0.1:55123" (one line per address family).
  const line = docker("port", container, port).split("\n")[0] ?? "";
  const host = Number(line.split(":").at(-1));
  if (!Number.isInteger(host) || host <= 0) throw new Error(`no published port for ${port}: ${line}`);
  return host;
}

export function subnetOf(network: string): string {
  return docker("network", "inspect", "-f", "{{(index .IPAM.Config 0).Subnet}}", network);
}

export function removeAll(names: { containers?: string[]; networks?: string[]; volumes?: string[] }) {
  for (const c of names.containers ?? []) spawnSync("docker", ["rm", "-f", c], { stdio: "ignore" });
  for (const n of names.networks ?? []) spawnSync("docker", ["network", "rm", n], { stdio: "ignore" });
  for (const v of names.volumes ?? []) spawnSync("docker", ["volume", "rm", "-f", v], { stdio: "ignore" });
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitFor(label: string, pred: () => boolean, ms: number, everyMs = 1000): void {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    sleepSync(everyMs);
  }
}
```

- [ ] **Step 5: Run the helper test**

Run: `pnpm exec vitest run apps/daemon/src/cells/ipv4.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the gate image**

`cells/gate/Dockerfile`:
```dockerfile
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache socat
COPY relay.sh /relay.sh
RUN chmod 555 /relay.sh
USER nobody
ENTRYPOINT ["/relay.sh"]
```

`cells/gate/relay.sh`:
```sh
#!/bin/sh
# Each relay binds one address: the keyd relay exists only on the cell's internal network, the
# inbound relays only on the egress network, where Docker delivers the ports it publishes.
set -eu
: "${LD_INTERNAL_ADDR:?}" "${LD_EGRESS_ADDR:?}" "${LD_DESKTOP_ADDR:?}" "${LD_KEYD_PORT:?}"

has_addr() { ip -4 -o addr show | grep -q " inet $1/"; }

# The daemon starts the gate on its egress network and connects the internal one afterwards.
n=0
until has_addr "$LD_INTERNAL_ADDR"; do
  n=$((n + 1))
  if [ "$n" -gt 150 ]; then
    echo "gate: $LD_INTERNAL_ADDR never appeared" >&2
    exit 1
  fi
  sleep 0.1
done

socat "TCP4-LISTEN:3128,bind=$LD_INTERNAL_ADDR,fork,reuseaddr" "TCP4:host.docker.internal:$LD_KEYD_PORT" &
keyd=$!
socat "TCP4-LISTEN:8081,bind=$LD_EGRESS_ADDR,fork,reuseaddr" "TCP4:$LD_DESKTOP_ADDR:7700" &
desktopd=$!
socat "TCP4-LISTEN:8082,bind=$LD_EGRESS_ADDR,fork,reuseaddr" "TCP4:$LD_DESKTOP_ADDR:3000" &
stream=$!
echo "gate: keyd $LD_INTERNAL_ADDR:3128 -> host.docker.internal:$LD_KEYD_PORT; inbound $LD_EGRESS_ADDR:8081 -> $LD_DESKTOP_ADDR:7700, $LD_EGRESS_ADDR:8082 -> $LD_DESKTOP_ADDR:3000"

while kill -0 "$keyd" "$desktopd" "$stream" 2>/dev/null; do sleep 1; done
echo "gate: a relay exited" >&2
exit 1
```

`cells/gate/build.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker build -t localdot/gate:dev .
```

Run: `chmod +x cells/gate/build.sh cells/gate/relay.sh && cells/gate/build.sh`
Expected: `docker image ls localdot/gate` lists `dev`, about 16 MB.

- [ ] **Step 7: Write the Docker-backed gate test**

`apps/daemon/src/cells/gate-image.docker.test.ts`:
```ts
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostAddress } from "./ipv4.ts";
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

let listener: Server;
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
    execFileSync("docker", ["build", "-q", "-t", "localdot/gate:dev", GATE_DIR], { stdio: "ignore" });
    execFileSync("docker", ["build", "-q", "-t", PROBE_IMAGE, "-"], {
      input: PROBE_DOCKERFILE,
      stdio: ["pipe", "ignore", "ignore"],
    });
    listener = createServer((_req, res) => res.end("host-ok\n"));
    await new Promise<void>((r) => listener.listen(KEYD_PORT, "127.0.0.1", r));

    docker("network", "create", "--internal",
      "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "localdot-test-sbx");
    docker("network", "create", "localdot-test-egress");
    gateInternal = hostAddress(subnetOf("localdot-test-sbx"), 10);
    cell = hostAddress(subnetOf("localdot-test-sbx"), 11);
    gateEgress = hostAddress(subnetOf("localdot-test-egress"), 10);

    docker("run", "-d", "--name", "localdot-test-cell", "--network", "localdot-test-sbx",
      "--ip", cell, PROBE_IMAGE);
    docker("run", "-d", "--name", "localdot-test-gate", "--network", "localdot-test-egress",
      "--ip", gateEgress, "-p", "127.0.0.1:0:8081", "-p", "127.0.0.1:0:8082",
      "--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges",
      "-e", `LD_INTERNAL_ADDR=${gateInternal}`, "-e", `LD_EGRESS_ADDR=${gateEgress}`,
      "-e", `LD_DESKTOP_ADDR=${cell}`, "-e", `LD_KEYD_PORT=${KEYD_PORT}`, "localdot/gate:dev");
    docker("network", "connect", "--ip", gateInternal, "localdot-test-sbx", "localdot-test-gate");
    docker("run", "-d", "--name", "localdot-test-egressprobe", "--network", "localdot-test-egress",
      PROBE_IMAGE);
    desktopdPort = publishedPort("localdot-test-gate", "8081");
    streamPort = publishedPort("localdot-test-gate", "8082");
    sleepSync(2000);
  });

  afterAll(async () => {
    removeAll(names);
    await new Promise<void>((r) => listener?.close(() => r()));
  });

  it("relays the cell to the host listener bound to 127.0.0.1", () => {
    expect(curl("localdot-test-cell", `http://${gateInternal}:3128/`).out).toContain("host-ok");
  });

  it("publishes the inbound relays on 127.0.0.1 only", async () => {
    expect(await (await fetch(`http://127.0.0.1:${desktopdPort}/`)).text()).toContain("cell-ok");
    expect(await (await fetch(`http://127.0.0.1:${streamPort}/`)).text()).toContain("cell-ok");
    expect(docker("port", "localdot-test-gate", "8081")).toMatch(/^127\.0\.0\.1:/);
  });

  it("does not expose the keyd relay on the egress network", () => {
    expect(curl("localdot-test-egressprobe", `http://${gateEgress}:3128/`).status).not.toBe(0);
    expect(curl("localdot-test-egressprobe", `http://${gateEgress}:8081/`).out).toContain("cell-ok");
  });

  it("does not expose the inbound relays on the internal network", () => {
    expect(curl("localdot-test-cell", `http://${gateInternal}:8081/`).status).not.toBe(0);
    expect(curl("localdot-test-cell", `http://${gateInternal}:8082/`).status).not.toBe(0);
  });

  it("keeps the cell off the internet and the host", () => {
    expect(curl("localdot-test-cell", "https://example.com").status).not.toBe(0);
    expect(curl("localdot-test-cell", `http://host.docker.internal:${KEYD_PORT}/`).status).not.toBe(0);
    // Engine 29 renders the unset gateway of an isolated network as "invalid IP" (S3 saw the same).
    expect(["", "invalid IP"]).toContain(docker("network", "inspect", "-f",
      "{{range .IPAM.Config}}{{.Gateway}}{{end}}", "localdot-test-sbx"));
  });

  it("runs as nobody with every capability dropped", () => {
    expect(dockerExec("localdot-test-gate", "id", "-u").out.trim()).toBe("65534");
    expect(docker("inspect", "-f", "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}",
      "localdot-test-gate")).toBe("true [ALL]");
  });
});
```

- [ ] **Step 8: Run the Docker-backed test, then the unit suite**

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker -- apps/daemon/src/cells/gate-image.docker.test.ts`
Expected: 6 tests pass. `docker ps -a --filter name=localdot-test` and
`docker network ls --filter name=localdot-test` print no rows afterwards.
Run: `pnpm test:docker` (without the variable)
Expected: the suite is reported as skipped, exit code 0.
Run: `pnpm test`
Expected: the Part 1 suites still pass (143 tests) plus the 2 ipv4 tests; no `docker.test` file runs.

- [ ] **Step 9: Format, lint, commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add cells/gate apps/daemon/src/cells vitest.config.ts vitest.docker.config.ts package.json .gitignore
git commit -m "feat(gate): forwarder image with address-bound relays and the Docker test gate"
```

---
