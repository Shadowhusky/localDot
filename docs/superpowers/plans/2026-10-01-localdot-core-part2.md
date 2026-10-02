# localDot Core — Part 2: Live Desktop (M1 remainder) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish milestone M1: build the desktop image (HiDPI XFCE with the macOS look: WhiteSur
light theme and icons, a Plank dock, a menu-bar panel) and the gate image, let the daemon create a
cell (one isolated internal network, a gate, a desktop with named volumes and dropped capabilities,
per-cell tokens), and show the live 2× desktop in the Theatre UI, streamed through the daemon.

**Architecture:** The desktop image extends the pinned linuxserver `webtop:ubuntu-xfce` (Selkies 2.0,
XFCE on X11) with the app set, Node 24, VSCodium, Cua Driver, one fixed-address session D-Bus, HiDPI
XFCE templates, locked Selkies settings and a small `desktopd` (Hono) that answers a token-protected
health check. The gate is Alpine + socat with every relay bound to one address. The daemon talks to
the Docker Engine API over its Unix socket with its own thin client, keeps one `cell.json` per cell
under `~/.localdot/cells/`, publishes the gate's inbound ports on 127.0.0.1 with Docker-chosen
ports, and proxies the Selkies WebSocket (adding the per-cell basic-auth credential) behind an
unguessable per-cell *stream ticket*. The React UI (Vite) stores the install token from `#token=`,
talks to the daemon only, renders the Theatre chrome from CSS tokens, and hosts Selkies' own client —
a vendored copy served by the daemon, never fetched from the cell — in a same-origin iframe whose
`<video>` track is tapped with `MediaStreamTrackProcessor` and painted once per new frame by a render
worker on an `OffscreenCanvas`.

**Tech Stack:** Node 24 (host has 25.6), pnpm 10.29.3, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3,
Hono 4.13.12 + @hono/node-server 2.1.3, ws 8.22.0, zod 4.6.5 (existing); React 19.3.0, Vite 8.3.1,
@vitejs/plugin-react 6.1.1, jsdom 30.1.1, @testing-library/react 16.3.3, @playwright/test 1.63.0
(system Google Chrome 154 via `channel: "chrome"`), sharp 0.35.5, esbuild 0.28.2 (already in the
lockfile through tsx); Docker Desktop 4.60 / Engine 29.2.0 (API 1.53, min 1.44); base images
`lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804`
(53afe260-ls3, Ubuntu 26.04.1, Selkies 2.0.0, XFCE 4.20) and
`alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8`; Node
24.21.0 (LTS), VSCodium 1.135.06055, Cua Driver 0.30.4; WhiteSur GTK theme tag `2026-09-10`
(commit `99247ecd219bdc1c7409baff062b4aafcf1102a7`, MIT) and WhiteSur icon theme tag `2026-09-10`
(commit `73d8040da51a9ed74e47c7366e7e9ff437601a5c`, GPL-3.0), Plank (Ubuntu package).

**Spec:** `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-core-design.md`.
Decisions and evidence: `localdot/docs/spikes/SUMMARY.md` (D1–D18) and `localdot/spikes/*/FINDINGS.md`.
Carry-forward: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-09-30-localdot-core-part1-carry-forward.md`.
UI direction (binding): `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/design/2026-09-30-localdot-ui-directions/README.md`
"Decision" and `c-theatre.html` / `c-theatre.png` in that folder.

**This is Part 2 of the core plan.** Part 1 (spikes S1–S7 and the foundation packages) is merged into
`main` at `992e82d`. Part 3 (M2: `desktopd` observe/hitTest/input/type/settle, the action
gateway, P0 overlays, pixel oracle) is written after this plan from the "Interfaces Part 3 builds on"
section at the end.

## Global Constraints

- Repo root: `/Volumes/Husky's SSD 4T/Projects/localdot`. Work on branch `feat/core-part2`, which
  already exists (created from `main` at `992e82d`, where Part 1 was merged); never commit on `main`.
  Quote the path in every shell command (space and apostrophe).
- Commit messages: conventional `type(scope): summary`. **Never add `Co-Authored-By` or any AI
  attribution line** (user rule; overrides any harness default).
- **Never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container** (the apostrophe path
  wedges Docker Desktop's file sharing). Containers get named volumes, `docker cp`, or build contexts
  only. Runtime data lives in `~/.localdot` (`LOCALDOT_HOME` overrides); the optional shared folder is
  `~/localDot/Shared` (not mounted in Part 2).
- Build paths from `fileURLToPath(import.meta.url)`, never `new URL(...).pathname`.
- Ports, all bound to `127.0.0.1` only: daemon and UI `4750` (`LOCALDOT_PORT` overrides), brain tool
  API `4751`, keyd listeners `4760–4789`, spikes and e2e harnesses `4790–4799`. Cell ports are
  published by Docker on `127.0.0.1` with Docker-chosen host ports.
- Auth is cookie-free: HTTP accepts the install token only as `Authorization: Bearer <token>`;
  WebSocket clients always offer the subprotocols `localdot.v1` and `localdot.token.<token>` together
  and the server selects only `localdot.v1`; the UI takes the token from a `#token=` fragment into
  origin-scoped storage and removes it from the address bar with `history.replaceState`. Every inbound
  cell port requires a per-cell token (`desktopd` bearer, Selkies basic auth): 127.0.0.1 is not
  access control on Docker Desktop.
- Every cell network is created with `--internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`
  (API: `Internal: true`, `Options: {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}`).
  Desktop: default seccomp, `NET_RAW` dropped, no added capabilities, pids/memory/CPU limits, no
  `docker.sock`, no `no-new-privileges` (passwordless sudo). Gate: read-only, `no-new-privileges`,
  all capabilities dropped, user `nobody`.
- Secrets never enter a container. Per-cell tokens (desktopd bearer, Selkies password, stream
  tickets) are not secrets: minted per cell, worthless off the Mac, dropped with the cell.
- Stream tickets (P2-R2): minted only through the authenticated API, 128 random bits, one live
  ticket per cell, compared in constant time, never logged, scoped to one cell's stream path, and
  revoked whenever the cell leaves `ready`, when it is removed, and on daemon restart (memory only).
- No Docker restart policy on any cell container (P2-R14): the orchestrator restarts an exited
  container itself with backoff and re-reads the published host ports after every start.
- The daemon is started with `node` directly (`node --import tsx src/main.ts` from `apps/daemon`;
  the test harness and any process manager do the same). `pnpm … start` is a convenience for a
  terminal only: pnpm does not forward `SIGTERM`, so a daemon started through it is not stoppable
  by a supervisor and leaves its lock behind.
- The desktop looks like macOS (spec "Look", P2-R5/R12): the WhiteSur LIGHT GTK theme with its
  xfwm4 `-hdpi`/`-xhdpi` builds, WhiteSur icons, a Plank dock with WhiteSur's light dock theme and
  the top panel styled as a menu bar; theme sources pinned by commit and verified after the clone;
  every asset's license recorded in the image (`/usr/share/doc/localdot-themes/`) and in
  `cells/desktop/THIRD-PARTY.md` (P2-R13). No Apple fonts or artwork.
- `apps/web/src/theme.css` names every token after Tailwind 4's theme namespaces (`--color-*`,
  `--font-*`, `--spacing-*`, `--radius-*`, `--shadow-*`, `--ease-*`; `--duration-*` is localDot's
  own) in a `:root` block, which M4 moves into `@theme` when Tailwind arrives (P2-R4).
- Images are pinned by digest (base images now; our own image digests per localdot version in M9).
  Every downloaded binary is verified against a sha256 written in the repo: in the Dockerfile, or,
  for Cua Driver's Python wheels, in `cells/desktop/cua-requirements.txt` (`pip install --require-hashes`).
- No [avatar-name]/[avatar-name]/[avatar-name] names or assets anywhere in the repo (`pnpm hygiene` enforces it).
- Code style: named exports only (default exports only in tool config files), small focused files,
  comments only for non-obvious rules or workarounds, relative imports with explicit `.ts`,
  workspace imports by package name. Run `pnpm format` before `pnpm lint` in every task.
  `pnpm format` does not sort imports: fix an `organizeImports` error from `pnpm lint` with
  `pnpm exec biome check --write <files>`.
- Tests: run only the suites a task touches (`pnpm exec vitest run <paths>`); the full `pnpm test`,
  `pnpm typecheck`, `pnpm lint`, `pnpm hygiene` before the final review. Tests that need Docker live in
  `*.docker.test.ts` files, are excluded from `pnpm test`, and run only with
  `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker`. They name every container, network and volume they
  create `localdot-test-*` and remove them in `afterAll`, even on failure. The Docker CLI test
  helpers are synchronous and block the test thread, so a server that a container or a `waitFor`
  predicate must reach runs on a worker thread or in a child process, never on the test thread.
- Every UI task follows `~/.agents/skills/apple-design/SKILL.md` (read it before UI work): respond on
  pointer-down, interruptible animations that start from the current value, critically damped
  springs by default, `prefers-reduced-motion` and `prefers-reduced-transparency` honoured, every
  colour a CSS token. Every UI task ends with a screenshot check of the rendered page.
- The Theatre direction is decided: near-black `--color-void` `#0A0B0D`, one accent xenon `#3FB5DE` used
  only while the agent has control (never in Part 2, where nobody holds control), status HUD on the
  picture with a solid fallback under reduced transparency, caption under the stage, quiet side
  rails that stay comfortable for long reading, mascot slot bottom-left outside the stage.

## Review Focus

1. **Daemon restart with a cell running.** `~/.localdot/cells/<id>/cell.json` exists, the containers
   are up (or gone, or exited): after restart the cell must show `ready` (after a fresh health
   check), `stopped`, or `failed` with the reason, never a duplicate cell or a crash. Test: Task 8
   (`reconcile()` with running, exited and missing containers).
2. **A container restarted or recreated gets new host ports.** Docker assigns a new host port on
   every start — after a user stop/start and after the orchestrator restarts an exited container
   with backoff; the stream proxy and the health probes must use the ports read after the latest
   start, never the ones from creation. The published ports are the gate's, so only a gate start
   changes them. Test: Task 8 (the stop/start and gate-restart tests see new endpoints; the
   desktop-restart test keeps the gate's) and Task 11 (the proxy looks the endpoint up at connect time).
3. **The desktop container dies mid-stream.** The upstream WebSocket closes: the viewer's socket is
   closed with 1012, the cell's stream state becomes `disconnected`, the UI shows "Reconnecting…",
   and the daemon keeps running. Test: Task 11 (upstream close) and Task 13 (`hudFor` shows a
   stalled or disconnected stream and a crash restart as "Reconnecting…").
4. **A browser without `MediaStreamTrackProcessor`** (Safari, Firefox): the stage must say that a
   Chromium-based browser is needed instead of showing a black canvas forever. Test: Task 14
   (`frameTapSupport()` in jsdom reports `{ ok: false }` with a reason; `Stage.test.tsx` renders
   `Stage` and reads the notice).
5. **A bad or revoked install token in the URL or storage** (`#token=abc`, a token the daemon now
   rejects): never stored when malformed; on a 401 the stored token is forgotten and the "no access
   token" panel appears, with no request loop. Test: Task 12 (`bootstrapToken`, `createApi` 401 path).

## File map

Created or modified in this part (exact paths relative to the repo root):

```
cells/gate/Dockerfile, relay.sh, build.sh
cells/desktop/Dockerfile, build.sh, .dockerignore, cua-requirements.txt, THIRD-PARTY.md
cells/desktop/root/defaults/startwm.sh, cells/desktop/root/defaults/xfce/{thunar.xml,xfce4-panel.xml}
cells/desktop/root/defaults/localdot/{xsettings.xml.in,xfwm4.xml.in,registrymodifications.xcu}
cells/desktop/root/etc/xdg/autostart/localdot-plank.desktop, cells/desktop/root/usr/local/bin/localdot-plank
cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/{type,run,dependencies.d/init-services}
cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-desktopd/{type,run,dependencies.d/svc-de}
cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-de/dependencies.d/svc-session-bus
cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-selkies/dependencies.d/svc-session-bus
cells/desktop/root/etc/s6-overlay/s6-rc.d/user/contents.d/{svc-session-bus,svc-desktopd}
cells/desktop/desktopd/{package.json,tsconfig.json,build.mjs,src/main.ts,src/app.ts,src/xsettings.ts,src/auth.ts,src/app.test.ts}
cells/desktop/scripts/extract-selkies-client.sh
spikes/s8-hosted-client/{package.json,run-desktop.sh,extract.sh,host.mjs,page.html,worker.js,FINDINGS.md}
apps/daemon/src/cells/{types.ts,ipv4.ts,docker.ts,store.ts,secrets.ts,ports.ts,images.ts,spec.ts,readiness.ts,orchestrator.ts,api.ts,status-stream.ts,watchdog.ts,stream-proxy.ts}
apps/daemon/src/cells/testing/{docker-cli.ts,fake-docker.ts,fake-orchestrator.ts,sample-record.ts}
apps/daemon/src/cells/*.test.ts, *.docker.test.ts
apps/daemon/src/{upgrade-router.ts,static-files.ts,static-ui.ts,doctor.ts,doctor-main.ts}
apps/daemon/package.json, apps/daemon/src/{app.ts,event-stream.ts,main.ts,lock.ts,event-log.ts,port.ts}   (modified)
apps/daemon/src/{lock.test.ts,event-log.test.ts}, packages/protocol/src/{ids.ts,ids.test.ts}   (modified)
apps/web/{package.json,vite.config.ts,tsconfig.json,index.html,playwright.config.ts}
apps/web/src/{main.tsx,App.tsx,theme.css,app.css}
apps/web/src/lib/{token.ts,api.ts,socket.ts}
apps/web/src/cells/{types.ts,useCell.ts,hud-state.ts}
apps/web/src/shell/{TopBar.tsx,ConversationRail.tsx,PlanRail.tsx,StageColumn.tsx,Hud.tsx,Caption.tsx,MascotDock.tsx,Mascot.tsx}
apps/web/src/stage/{frame-source.ts,pump.ts,presenter.ts,render-worker.ts,StageCanvas.tsx,DesktopFrame.tsx,Stage.tsx,webcodecs.d.ts}
apps/web/vendor/selkies/{index.html,assets/*,icon.png,icon-512.png,LICENSE,NOTICE.md}   (vendored from the pinned base image)
apps/web/e2e/{shot.ts,daemon.ts,live-desktop.spec.ts,measure.spec.ts,tsconfig.json}
docs/measurements/2026-10-stream-2x.md
vitest.config.ts, vitest.docker.config.ts, package.json, pnpm-workspace.yaml, biome.json, .gitignore, README.md   (modified)
.github/workflows/ci.yml, docs/spikes/SUMMARY.md   (modified); scripts/check-hygiene.mjs   (modified only if a vendored asset needs an allowlist entry)
```

---
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
  behind nginx); `docker stop` ends it with exit code 0 within about a second.
  `hostAddress(cidr: string, offset: number): string`. Test helpers `docker(...args)`,
  `dockerOk(...args)`, `dockerExec(container, ...cmd)`, `dockerExecAs(container, user, ...cmd)`,
  `publishedPort(container, port)`, `subnetOf(network)`, `removeAll({containers, networks, volumes})`
  (`docker rm -fv`, so anonymous volumes go too), `sleepSync(ms)`,
  `waitFor(label, pred, ms, everyMs = 1000)`, `DOCKER_TESTS`; they are synchronous and block the
  test thread, so a server that a container must reach runs on a worker thread. Root script
  `pnpm test:docker`.

- [ ] **Step 1: The branch and the Docker test gate**

The branch `feat/core-part2` already exists (created from `main` at `992e82d`). Check that it is the
one checked out:
```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot" && git branch --show-current
```
Expected: `feat/core-part2`.

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

// -v also removes anonymous volumes, such as the one an image's VOLUME line creates on every run.
export function removeAll(names: { containers?: string[]; networks?: string[]; volumes?: string[] }) {
  for (const c of names.containers ?? []) spawnSync("docker", ["rm", "-fv", c], { stdio: "ignore" });
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
# PID 1 ignores signals it doesn't trap; exiting takes the relays down with the container.
trap 'exit 0' TERM INT

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
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
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
// The keyd stand-in answers from its own thread: dockerExec blocks this one until curl exits.
const HOST_LISTENER = `const { parentPort } = require("node:worker_threads");
require("node:http")
  .createServer((_req, res) => res.end("host-ok\\n"))
  .listen(${KEYD_PORT}, "127.0.0.1", () => parentPort.postMessage("listening"));
`;

let listener: Worker;
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
    listener = new Worker(HOST_LISTENER, { eval: true });
    await once(listener, "message");

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
    await listener?.terminate();
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

  // Last: it stops the shared gate.
  it("exits cleanly on docker stop instead of waiting to be killed", () => {
    const started = Date.now();
    docker("stop", "-t", "10", "localdot-test-gate");
    const elapsedMs = Date.now() - started;
    expect(docker("inspect", "-f", "{{.State.ExitCode}}", "localdot-test-gate")).toBe("0");
    expect(elapsedMs).toBeLessThan(3000);
  });
});
```

- [ ] **Step 8: Run the Docker-backed test, then the unit suite**

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/gate-image.docker.test.ts`
Expected: 7 tests pass. `docker ps -a --filter name=localdot-test` and
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
### Task 2: Desktop image — pinned base, the app set, Node, VSCodium and Cua Driver

**Files:**
- Create: `cells/desktop/Dockerfile`, `cells/desktop/build.sh`, `cells/desktop/.dockerignore`,
  `cells/desktop/cua-requirements.txt`
- Test: `apps/daemon/src/cells/desktop-image.docker.test.ts`

**Interfaces:**
- Produces: image `localdot/desktop:dev` (stage `desktop`) and the build stage `selkies-client`
  (a scratch image holding Selkies' dashboard `index.html`, `assets/`, `icon.png`, `icon-512.png`
  and the MPL-2.0 text as `LICENSE`, copied from the pinned image and extracted in Task 4);
  `/usr/local/bin/node` (24.21.0), `/usr/local/bin/cua-driver` (the bundled 0.30.4 binary, runnable
  as the desktop user `abc`; installed with `pip install --require-hashes` from
  `cells/desktop/cua-requirements.txt`, which pins every wheel of its dependency closure by sha256),
  `codium`, the app set; env `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`,
  `CUA_DRIVER_RS_UPDATE_CHECK=0`, `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0`, `GTK_MODULES`,
  `QT_ACCESSIBILITY`, `START_DOCKER=false` baked in.

- [ ] **Step 1: Resolve the base digest**

Run: `docker image inspect --format '{{index .RepoDigests 0}}' lscr.io/linuxserver/webtop:ubuntu-xfce`
Expected: `lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804`
(the `53afe260-ls3` build of 2026-09-29, the one S1, S2 and S6 ran on). Write the printed value into
the `FROM` line below; if it differs from the one shown, use the printed one and note it in the
commit message.

- [ ] **Step 2: Pin Cua Driver and its dependencies by hash**

Cua Driver comes from PyPI as a wheel that bundles its native binary, so every wheel of its
dependency closure is pinned by sha256 in `cells/desktop/cua-requirements.txt`, and the image
installs from that file with `pip install --require-hashes`. Generate the file once, inside a
throwaway container of the pinned base image, so the wheels match the image's Python and platform
(Docker runs it for the host's architecture, the one `build.sh` builds for). Nothing is
bind-mounted; `docker cp` brings the file out. Use the digest Step 1 printed.
```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot"
docker rm -fv localdot-cua-pins >/dev/null 2>&1 || true
docker run --name localdot-cua-pins --entrypoint /bin/bash \
  lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 -c '
set -euo pipefail
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3-venv >/dev/null
python3 -m venv /tmp/pin
/tmp/pin/bin/pip download --no-cache-dir --only-binary=:all: --dest /tmp/wheels "cua-driver==0.30.4"
{
  echo "# cua-driver 0.30.4 and its dependency closure for linux/$(dpkg --print-architecture), every wheel pinned by sha256"
  for whl in /tmp/wheels/*.whl; do
    file="${whl##*/}"
    name="$(echo "$file" | cut -d- -f1 | tr _ -)"
    version="$(echo "$file" | cut -d- -f2)"
    echo "$name==$version $(/tmp/pin/bin/pip hash "$whl" | tail -n 1)"
  done | sort
} > /tmp/cua-requirements.txt'
docker cp localdot-cua-pins:/tmp/cua-requirements.txt cells/desktop/cua-requirements.txt
docker rm -fv localdot-cua-pins
cat cells/desktop/cua-requirements.txt
```
Expected: `pip download` saves only wheels (`--only-binary=:all:`); the file holds the comment line
(`linux/arm64` on Apple silicon) and one `<name>==<version> --hash=sha256:<64 hex digits>` line per
wheel, `cua-driver==0.30.4` among them, and no requirement without a hash. Step 3 checks that the
build installs from it and that a changed hash stops the build.

- [ ] **Step 3: Write the Dockerfile**

`cells/desktop/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Base: linuxserver webtop, Ubuntu 26.04.1 + XFCE 4.20 + Selkies 2.0.0 (GPL-3.0-only, a separate
# program inside this image). Pinned by digest; resolve with
#   docker image inspect --format '{{index .RepoDigests 0}}' lscr.io/linuxserver/webtop:ubuntu-xfce
FROM lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 AS base

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_ARM64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
ARG NODE_SHA256_X64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG CODIUM_VERSION=1.135.06055
ARG CODIUM_SHA256_ARM64=79d1efcb8b730d750d144c38a88af9a3449f0d6d47df1c6b8b46e6f98c738a14
ARG CODIUM_SHA256_AMD64=5f5c00a9da9d232e4c84e9eee68bbdeb4d8737462022626ce3bdb6948f3d8649

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      at-spi2-core python3-venv python3-xlib xinput libnss3-tools xz-utils x11-utils \
      libreoffice-calc libreoffice-writer libreoffice-impress libreoffice-gtk3 \
      gimp ffmpeg imagemagick pandoc \
      fonts-inter fonts-jetbrains-mono fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      arm64) node_arch=arm64; sum="$NODE_SHA256_ARM64" ;; \
      amd64) node_arch=x64; sum="$NODE_SHA256_X64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    echo "${sum}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm /tmp/node.tar.xz; \
    ln -s /opt/node/bin/node /usr/local/bin/node; \
    ln -s /opt/node/bin/npm /usr/local/bin/npm; \
    ln -s /opt/node/bin/npx /usr/local/bin/npx

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) sum="$CODIUM_SHA256_ARM64" ;; \
      amd64) sum="$CODIUM_SHA256_AMD64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/codium.deb \
      "https://github.com/VSCodium/vscodium/releases/download/${CODIUM_VERSION}/codium_${CODIUM_VERSION}_${arch}.deb"; \
    echo "${sum}  /tmp/codium.deb" | sha256sum -c -; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/codium.deb; \
    rm -rf /var/lib/apt/lists/* /tmp/codium.deb

# Cua Driver (MIT) for perception only, from cua-requirements.txt, where every wheel of its
# dependency closure is pinned by sha256. Its pip entry point chmods the root-owned binary on every
# run and fails as the desktop user (S2), so the bundled binary is linked directly.
COPY cua-requirements.txt /opt/cua/requirements.txt
RUN python3 -m venv /opt/cua \
 && /opt/cua/bin/pip install --no-cache-dir --require-hashes -r /opt/cua/requirements.txt \
 && bin="$(find /opt/cua -type f -path '*/cua_driver/bin/cua-driver' | head -n 1)" \
 && test -n "$bin" && chmod 755 "$bin" && ln -s "$bin" /usr/local/bin/cua-driver

ENV CUA_DRIVER_RS_TELEMETRY_ENABLED=0 \
    CUA_DRIVER_RS_UPDATE_CHECK=0 \
    CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0 \
    GTK_MODULES=gail:atk-bridge \
    QT_ACCESSIBILITY=1 \
    START_DOCKER=false

# Selkies' web client (MPL-2.0), served by the daemon instead of by the cell (Task 4, Task 14). It
# copies straight from the pinned image, so `--target selkies-client` never builds the base stage.
FROM scratch AS selkies-client
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/selkies/selkies-dashboard/index.html /index.html
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/selkies/selkies-dashboard/assets /assets
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/selkies/selkies-dashboard/icon.png /usr/share/selkies/selkies-dashboard/icon-512.png /
COPY --from=lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804 \
     /usr/share/common-licenses/MPL-2.0 /LICENSE

FROM base AS desktop
```

`cells/desktop/.dockerignore`:
```
desktopd/node_modules
desktopd/src
desktopd/*.test.ts
scripts
```

`cells/desktop/build.sh`:
```bash
#!/usr/bin/env bash
# Builds localdot/desktop:dev for the host architecture (arm64 on Apple silicon).
set -euo pipefail
cd "$(dirname "$0")"
docker build --target desktop -t localdot/desktop:dev .
```

Run: `chmod +x cells/desktop/build.sh && cells/desktop/build.sh`
Expected: the build finishes (first run 10–25 minutes: LibreOffice, GIMP, fonts, VSCodium, Node);
`docker image ls localdot/desktop` lists `dev`. The `sha256sum -c` lines print `/tmp/node.tar.xz: OK`
and `/tmp/codium.deb: OK` in the build log, and pip installs Cua Driver from
`/opt/cua/requirements.txt` in hash-checking mode. Then check that the hashes bind: zero the
`cua-driver` hash, build, and restore the file.
```bash
good="$(mktemp)" && cp cells/desktop/cua-requirements.txt "$good"
sed -E '/^cua-driver==/s/sha256:[0-9a-f]{64}/sha256:0000000000000000000000000000000000000000000000000000000000000000/' "$good" > cells/desktop/cua-requirements.txt
cells/desktop/build.sh || echo "refused, as it should be"
cp "$good" cells/desktop/cua-requirements.txt && cells/desktop/build.sh
```
Expected: the first build stops at the Cua Driver step with `THESE PACKAGES DO NOT MATCH THE
HASHES FROM THE REQUIREMENTS FILE` and the shell prints `refused, as it should be`; after the
restore, the second build passes from the cache.

- [ ] **Step 4: Write the image test (part 1: pinned tools)**

`apps/daemon/src/cells/desktop-image.docker.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerExecAs,
  dockerOk,
  removeAll,
} from "./testing/docker-cli.ts";

export const DESKTOP_IMAGE = "localdot/desktop:dev";
const C = "localdot-test-desktop-tools";

describe.skipIf(!DOCKER_TESTS)("desktop image: pinned tools", () => {
  beforeAll(() => {
    if (!dockerOk("image", "inspect", DESKTOP_IMAGE)) {
      throw new Error(`${DESKTOP_IMAGE} is missing: run cells/desktop/build.sh first`);
    }
    removeAll({ containers: [C] });
    docker("run", "-d", "--name", C, "--network", "none", "--shm-size=1g", DESKTOP_IMAGE);
  });

  afterAll(() => removeAll({ containers: [C] }));

  it("ships the app set", () => {
    expect(dockerExec(C, "libreoffice", "--version").out).toContain("LibreOffice");
    expect(dockerExecAs(C, "abc", "codium", "--version").out.split("\n")[0]).toBe("1.135.06055");
    expect(dockerExec(C, "gimp", "--version").out).toMatch(/Image Manipulation Program/);
    expect(dockerExec(C, "ffmpeg", "-version").out).toContain("ffmpeg version");
    expect(dockerExec(C, "convert", "-version").out).toContain("ImageMagick");
    expect(dockerExec(C, "pandoc", "--version").out).toContain("pandoc");
    expect(dockerExec(C, "chromium-browser", "--version").out).toContain("Chromium");
    for (const tool of ["thunar", "xfce4-terminal", "mousepad", "git", "curl", "jq", "python3"]) {
      expect(dockerExec(C, "sh", "-c", `command -v ${tool}`).status, tool).toBe(0);
    }
  });

  it("ships Node 24.21.0", () => {
    expect(dockerExec(C, "node", "--version").out.trim()).toBe("v24.21.0");
    expect(dockerExec(C, "readlink", "-f", "/usr/local/bin/node").out.trim()).toBe("/opt/node/bin/node");
  });

  it("runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off", () => {
    expect(dockerExecAs(C, "abc", "cua-driver", "--version").out).toContain("0.30.4");
    const env = docker("image", "inspect", "--format", "{{json .Config.Env}}", DESKTOP_IMAGE);
    expect(env).toContain('"CUA_DRIVER_RS_TELEMETRY_ENABLED=0"');
    expect(env).toContain('"CUA_DRIVER_RS_UPDATE_CHECK=0"');
    expect(env).toContain('"CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0"');
    expect(env).toContain('"START_DOCKER=false"');
  });

  it("has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji", () => {
    const families = dockerExec(C, "fc-list", ":", "family").out;
    expect(families).toMatch(/\bInter\b/);
    expect(families).toContain("JetBrains Mono");
    expect(families).toContain("Noto Sans CJK");
    expect(families).toContain("Noto Color Emoji");
  });

  it("has the X, accessibility and certificate tools", () => {
    expect(dockerExec(C, "xinput", "--version").status).toBe(0);
    expect(dockerExec(C, "python3", "-c", "import Xlib").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "command -v xprop && command -v certutil").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "ls /usr/libexec/at-spi-bus-launcher").status).toBe(0);
  });
});
```

- [ ] **Step 5: Run it**

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: 5 tests pass. If `codium --version` prints nothing as `abc`, check
`dockerExecAs(C, "abc", "codium", "--version").out` by hand: VSCodium refuses to run as root, which
is why the test runs it as `abc`.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop apps/daemon/src/cells/desktop-image.docker.test.ts
git commit -m "feat(desktop): pinned desktop image with the app set, Node, VSCodium and Cua Driver"
```

---
### Task 3: Desktop image — one session D-Bus, HiDPI XFCE at 2× (1× switchable), locked Selkies settings

The base starts XFCE with `dbus-launch --exit-with-session`, so the session bus has a random
address, and anything started without it autolaunches a second bus that can take over the
accessibility bus (S2). This task runs one `dbus-daemon --session` at a fixed address known to every
process in the container, writes the HiDPI xfconf settings from templates on every start, and bakes
the Selkies settings in. Facts from the base image used here: `svc-de` sets the X resolution from
`SELKIES_MANUAL_WIDTH/HEIGHT` with xrandr before running `/defaults/startwm.sh` as `abc`; nginx on
port 3000 serves the client and proxies `/api` to Selkies, and `PASSWORD` + `CUSTOM_USER` turn on
nginx basic auth for the whole site; Selkies reads `SELKIES_SCALING_DPI` at startup and, for XFCE,
writes `Xft/DPI` with `xfconf-query` inside the xfce4-session's environment; a single enum value
(`96`) locks it and makes Selkies ignore the client's DPI sync; bools take a `|locked` suffix.

**Files:**
- Create: `cells/desktop/root/defaults/startwm.sh`, `cells/desktop/root/defaults/xfce/thunar.xml`
- Create: `cells/desktop/root/defaults/localdot/xsettings.xml.in`, `cells/desktop/root/defaults/localdot/xfwm4.xml.in`,
  `cells/desktop/root/defaults/localdot/registrymodifications.xcu`
- Create: `cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/type`, `.../svc-session-bus/run`,
  `.../svc-session-bus/dependencies.d/init-services`, `.../svc-de/dependencies.d/svc-session-bus`,
  `.../svc-selkies/dependencies.d/svc-session-bus`, `.../user/contents.d/svc-session-bus`
- Modify: `cells/desktop/Dockerfile` (COPY root, ENV block)
- Test: `apps/daemon/src/cells/desktop-image.docker.test.ts` (part 2)

**Interfaces:**
- Produces: container env `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus` (every
  process, `docker exec` included); `LOCALDOT_SCALE=1|2` chooses the HiDPI templates at start
  (default 2, with `SELKIES_MANUAL_WIDTH/HEIGHT` 2560×1600; the orchestrator passes 1280×800 for 1);
  nginx basic auth user `localdot` with the password from `PASSWORD`; Selkies at `/api/websockets`
  on port 3000 behind that auth.

- [ ] **Step 1: Write the session-bus service and the XFCE start script**

`cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/type`:
```
longrun
```

`cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/run`:
```bash
#!/usr/bin/with-contenv bash
# The one session bus of this desktop, at the address every process in the container carries.
sock="${DBUS_SESSION_BUS_ADDRESS#unix:path=}"
rm -f "$sock"
exec s6-setuidgid abc dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS"
```

Create these empty files (`touch`): `svc-session-bus/dependencies.d/init-services`,
`svc-de/dependencies.d/svc-session-bus`, `svc-selkies/dependencies.d/svc-session-bus`,
`user/contents.d/svc-session-bus` (all under `cells/desktop/root/etc/s6-overlay/s6-rc.d/`).

`cells/desktop/root/defaults/startwm.sh`:
```bash
#!/bin/bash
# Replaces the base's startwm.sh: no dbus-launch (svc-session-bus owns the bus), and the HiDPI
# settings follow LOCALDOT_SCALE on every start so a cell can switch between 2x and 1x.
set -eu
conf="${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml"
if [ ! -d "$conf" ]; then
  mkdir -p "$conf"
  cp /defaults/xfce/*.xml "$conf"/
fi
# LibreOffice's first-run dialogs are modal and invisible to the accessibility tree (S2).
lo="${HOME}/.config/libreoffice/4/user"
if [ ! -f "$lo/registrymodifications.xcu" ]; then
  mkdir -p "$lo"
  cp /defaults/localdot/registrymodifications.xcu "$lo"/
fi
# The two files below are rewritten on every start: a theme change made inside the desktop does
# not survive a restart, on purpose (the look is localDot's, not the agent's).
scale="${LOCALDOT_SCALE:-2}"
case "$scale" in
  1) theme=Default ;;
  2) theme=Default-xhdpi ;;
  *) echo "startwm: LOCALDOT_SCALE must be 1 or 2, got $scale" >&2; exit 1 ;;
esac
sed "s/@SCALE@/$scale/g" /defaults/localdot/xsettings.xml.in > "$conf/xsettings.xml"
sed "s/@THEME@/$theme/g" /defaults/localdot/xfwm4.xml.in > "$conf/xfwm4.xml"
# xfconfd caches channels in memory: one started before this copy (Selkies' DPI restore can
# activate it) would write stale values back over these files.
pkill -u "$(id -u)" -x xfconfd || true
exec /usr/bin/xfce4-session
```

- [ ] **Step 2: Write the xfconf templates**

`cells/desktop/root/defaults/localdot/xsettings.xml.in` (`Gdk/WindowScalingFactor` from
`LOCALDOT_SCALE`, `Xft/DPI` pinned to 96 to agree with `SELKIES_SCALING_DPI=96`):
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="Greybird-dark"/>
    <property name="IconThemeName" type="string" value="elementary-xfce-dark"/>
    <property name="CursorBlink" type="bool" value="true"/>
    <property name="EnableEventSounds" type="bool" value="false"/>
    <property name="EnableInputFeedbackSounds" type="bool" value="false"/>
  </property>
  <property name="Xft" type="empty">
    <property name="DPI" type="int" value="96"/>
    <property name="Antialias" type="int" value="1"/>
    <property name="Hinting" type="int" value="1"/>
    <property name="HintStyle" type="string" value="hintslight"/>
    <property name="RGBA" type="string" value="none"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="FontName" type="string" value="Inter 10"/>
    <property name="MonospaceFontName" type="string" value="JetBrains Mono 10"/>
  </property>
  <property name="Gdk" type="empty">
    <property name="WindowScalingFactor" type="int" value="@SCALE@"/>
  </property>
</channel>
```

`cells/desktop/root/defaults/localdot/xfwm4.xml.in` — the base image's `/defaults/xfce/xfwm4.xml`
with `theme` and `title_font` changed:
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="use_compositing" type="bool" value="false"/>
    <property name="activate_action" type="string" value="bring"/>
    <property name="borderless_maximize" type="bool" value="true"/>
    <property name="box_move" type="bool" value="false"/>
    <property name="box_resize" type="bool" value="false"/>
    <property name="button_layout" type="string" value="O|SHMC"/>
    <property name="button_offset" type="int" value="0"/>
    <property name="button_spacing" type="int" value="0"/>
    <property name="click_to_focus" type="bool" value="true"/>
    <property name="cycle_apps_only" type="bool" value="false"/>
    <property name="cycle_draw_frame" type="bool" value="true"/>
    <property name="cycle_raise" type="bool" value="false"/>
    <property name="cycle_hidden" type="bool" value="true"/>
    <property name="cycle_minimum" type="bool" value="true"/>
    <property name="cycle_minimized" type="bool" value="false"/>
    <property name="cycle_preview" type="bool" value="true"/>
    <property name="cycle_tabwin_mode" type="int" value="0"/>
    <property name="cycle_workspaces" type="bool" value="false"/>
    <property name="double_click_action" type="string" value="maximize"/>
    <property name="double_click_distance" type="int" value="5"/>
    <property name="double_click_time" type="int" value="250"/>
    <property name="easy_click" type="string" value="Alt"/>
    <property name="focus_delay" type="int" value="250"/>
    <property name="focus_hint" type="bool" value="true"/>
    <property name="focus_new" type="bool" value="true"/>
    <property name="frame_opacity" type="int" value="100"/>
    <property name="frame_border_top" type="int" value="0"/>
    <property name="full_width_title" type="bool" value="true"/>
    <property name="horiz_scroll_opacity" type="bool" value="false"/>
    <property name="inactive_opacity" type="int" value="100"/>
    <property name="maximized_offset" type="int" value="0"/>
    <property name="mousewheel_rollup" type="bool" value="true"/>
    <property name="move_opacity" type="int" value="100"/>
    <property name="placement_mode" type="string" value="center"/>
    <property name="placement_ratio" type="int" value="20"/>
    <property name="popup_opacity" type="int" value="100"/>
    <property name="prevent_focus_stealing" type="bool" value="false"/>
    <property name="raise_delay" type="int" value="250"/>
    <property name="raise_on_click" type="bool" value="true"/>
    <property name="raise_on_focus" type="bool" value="false"/>
    <property name="raise_with_any_button" type="bool" value="true"/>
    <property name="repeat_urgent_blink" type="bool" value="false"/>
    <property name="resize_opacity" type="int" value="100"/>
    <property name="scroll_workspaces" type="bool" value="true"/>
    <property name="shadow_delta_height" type="int" value="0"/>
    <property name="shadow_delta_width" type="int" value="0"/>
    <property name="shadow_delta_x" type="int" value="0"/>
    <property name="shadow_delta_y" type="int" value="-3"/>
    <property name="shadow_opacity" type="int" value="50"/>
    <property name="show_app_icon" type="bool" value="false"/>
    <property name="show_dock_shadow" type="bool" value="true"/>
    <property name="show_frame_shadow" type="bool" value="true"/>
    <property name="show_popup_shadow" type="bool" value="false"/>
    <property name="snap_resist" type="bool" value="false"/>
    <property name="snap_to_border" type="bool" value="true"/>
    <property name="snap_to_windows" type="bool" value="false"/>
    <property name="snap_width" type="int" value="10"/>
    <property name="vblank_mode" type="string" value="auto"/>
    <property name="theme" type="string" value="@THEME@"/>
    <property name="tile_on_move" type="bool" value="true"/>
    <property name="title_alignment" type="string" value="center"/>
    <property name="title_font" type="string" value="Inter Bold 9"/>
    <property name="title_horizontal_offset" type="int" value="0"/>
    <property name="titleless_maximize" type="bool" value="false"/>
    <property name="title_shadow_active" type="string" value="false"/>
    <property name="title_shadow_inactive" type="string" value="false"/>
    <property name="title_vertical_offset_active" type="int" value="0"/>
    <property name="title_vertical_offset_inactive" type="int" value="0"/>
    <property name="toggle_workspaces" type="bool" value="false"/>
    <property name="unredirect_overlays" type="bool" value="true"/>
    <property name="urgent_blink" type="bool" value="false"/>
    <property name="workspace_count" type="int" value="1"/>
    <property name="wrap_cycle" type="bool" value="true"/>
    <property name="wrap_layout" type="bool" value="true"/>
    <property name="wrap_resistance" type="int" value="10"/>
    <property name="wrap_windows" type="bool" value="false"/>
    <property name="wrap_workspaces" type="bool" value="false"/>
    <property name="zoom_desktop" type="bool" value="true"/>
    <property name="zoom_pointer" type="bool" value="true"/>
    <property name="workspace_names" type="array">
      <value type="string" value="Workspace 1"/>
    </property>
  </property>
</channel>
```

`cells/desktop/root/defaults/localdot/registrymodifications.xcu` (seeded once into the LibreOffice
profile; turns off the "Welcome" first-run and "Tip of the Day" dialogs):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
```

`cells/desktop/root/defaults/xfce/thunar.xml` (copied with the other `/defaults/xfce/*.xml` on the
first run; Thunar's icon view has no items in the accessibility tree, A10):
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="thunar" version="1.0">
  <property name="default-view" type="string" value="ThunarDetailsView"/>
  <property name="last-view" type="string" value="ThunarDetailsView"/>
</channel>
```

- [ ] **Step 3: Add the overlay and the settings to the Dockerfile**

In `cells/desktop/Dockerfile`, after the Cua Driver `ENV` block and before the `selkies-client`
stage, add:
```dockerfile
COPY root/ /
RUN chmod 755 /defaults/startwm.sh /etc/s6-overlay/s6-rc.d/svc-session-bus/run

# One session bus for XFCE, AT-SPI, Selkies' xfconf writes and desktopd (A10). The Selkies values
# are locked where the client could change them; "|locked" is Selkies' bool suffix (D1, D2).
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus \
    LOCALDOT_SCALE=2 \
    SELKIES_MANUAL_WIDTH=2560 \
    SELKIES_MANUAL_HEIGHT=1600 \
    SELKIES_ENABLE_RESIZE="false|locked" \
    SELKIES_USE_CSS_SCALING="false|locked" \
    SELKIES_SCALING_DPI=96 \
    SELKIES_ENABLE_CURSORS="false|locked" \
    SELKIES_ENCODER=h264enc \
    SELKIES_FRAMERATE=60 \
    SELKIES_VIDEO_FULLCOLOR=true \
    SELKIES_AUDIO_ENABLED=false \
    SELKIES_MICROPHONE_ENABLED=false \
    SELKIES_WEBCAM_ENABLED=false \
    SELKIES_GAMEPAD_ENABLED=false \
    SELKIES_ENABLE_CLIPBOARD=false \
    SELKIES_FILE_TRANSFERS= \
    SELKIES_PRINTING_ENABLED=false \
    SELKIES_COMMAND_ENABLED=false \
    SELKIES_UI_SHOW_SIDEBAR=false \
    SELKIES_UI_SHOW_CORE_BUTTONS=false \
    SELKIES_UI_SHOW_LOGO=false \
    SELKIES_UI_TITLE=localDot \
    NO_GAMEPAD=1 \
    NO_WEBCAM=1 \
    CUSTOM_USER=localdot
```

Run: `cells/desktop/build.sh`
Expected: only the new layers build (the apt and download layers are cached).

- [ ] **Step 4: Write the image test (part 2: session, HiDPI, Selkies)**

Append to `apps/daemon/src/cells/desktop-image.docker.test.ts`:
```ts
const STREAM_PASSWORD = "p".repeat(43);

function startDesktop(name: string, scale: 1 | 2): { port: number } {
  removeAll({ containers: [name] });
  const [w, h] = scale === 2 ? ["2560", "1600"] : ["1280", "800"];
  docker("run", "-d", "--name", name, "--shm-size=1g", "--cap-drop", "NET_RAW",
    "-p", "127.0.0.1:0:3000", "-e", `PASSWORD=${STREAM_PASSWORD}`,
    "-e", `LOCALDOT_SCALE=${scale}`, "-e", `SELKIES_MANUAL_WIDTH=${w}`, "-e", `SELKIES_MANUAL_HEIGHT=${h}`,
    DESKTOP_IMAGE);
  waitFor("xfce4-panel", () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0, 180_000);
  sleepSync(5000);
  return { port: publishedPort(name, "3000") };
}

const xfconf = (name: string, channel: string, prop: string) =>
  dockerExecAs(name, "abc", "xfconf-query", "-c", channel, "-p", prop).out.trim();

function panelGeometry(name: string): { WIDTH: number; HEIGHT: number }[] {
  const ids = dockerExecAs(name, "abc", "xdotool", "search", "--classname", "xfce4-panel").out.trim();
  return ids.split("\n").filter(Boolean).map((id) => {
    const out = dockerExecAs(name, "abc", "xdotool", "getwindowgeometry", "--shell", id).out;
    const pick = (key: string) => Number(/^(?:WIDTH|HEIGHT)=(\d+)$/m.exec(out.split("\n").find((l) => l.startsWith(`${key}=`)) ?? "")?.[1]);
    return { WIDTH: pick("WIDTH"), HEIGHT: pick("HEIGHT") };
  });
}

describe.skipIf(!DOCKER_TESTS)("desktop image: session bus, HiDPI and Selkies", () => {
  const C2 = "localdot-test-desktop-2x";
  const C1 = "localdot-test-desktop-1x";
  let port2 = 0;

  beforeAll(() => {
    port2 = startDesktop(C2, 2).port;
  });
  afterAll(() => removeAll({ containers: [C2, C1] }));

  it("runs exactly one session bus at the fixed address and no dbus-launch", () => {
    expect(dockerExec(C2, "pgrep", "-c", "-f", "dbus-daemon --session").out.trim()).toBe("1");
    expect(dockerExec(C2, "pgrep", "-c", "-x", "dbus-launch").out.trim()).toBe("0");
    expect(dockerExecAs(C2, "abc", "sh", "-c", "test -S /tmp/localdot-session-bus").status).toBe(0);
    expect(dockerExecAs(C2, "abc", "printenv", "DBUS_SESSION_BUS_ADDRESS").out.trim())
      .toBe("unix:path=/tmp/localdot-session-bus");
  });

  it("has AT-SPI on that bus", () => {
    expect(dockerExecAs(C2, "abc", "xprop", "-root", "AT_SPI_BUS").out).toContain("unix:");
    expect(dockerExec(C2, "pgrep", "-c", "-f", "at-spi-bus-launcher").out.trim()).toBe("1");
  });

  it("renders HiDPI XFCE at 2x: window scaling 2, Xft/DPI 96, xhdpi theme, doubled panel", () => {
    expect(xfconf(C2, "xsettings", "/Gdk/WindowScalingFactor")).toBe("2");
    expect(xfconf(C2, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C2, "xfwm4", "/general/theme")).toBe("Default-xhdpi");
    expect(dockerExecAs(C2, "abc", "xdpyinfo").out).toMatch(/dimensions:\s+2560x1600/);
    expect(panelGeometry(C2)).toContainEqual({ WIDTH: 2560, HEIGHT: 54 });
  });

  it("starts Selkies fixed at 2560x1600 with audio off and the stream behind basic auth", async () => {
    const log = docker("logs", C2);
    expect(log).toContain("fixed 2560x1600");
    expect(log).toContain("audio off");
    const basic = `Basic ${Buffer.from(`localdot:${STREAM_PASSWORD}`).toString("base64")}`;
    expect((await fetch(`http://127.0.0.1:${port2}/`)).status).toBe(401);
    const page = await fetch(`http://127.0.0.1:${port2}/`, { headers: { authorization: basic } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("selkies-core");
    const health = await fetch(`http://127.0.0.1:${port2}/api/health`, { headers: { authorization: basic } });
    expect(health.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port2}/api/health`)).status).toBe(401);
  });

  it("keeps the HiDPI settings while a stream socket is open", async () => {
    const basic = `Basic ${Buffer.from(`localdot:${STREAM_PASSWORD}`).toString("base64")}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port2}/api/websockets`, { headers: { authorization: basic } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    sleepSync(3000);
    ws.close();
    expect(xfconf(C2, "xsettings", "/Gdk/WindowScalingFactor")).toBe("2");
    expect(xfconf(C2, "xsettings", "/Xft/DPI")).toBe("96");
  });

  it("opens Thunar in list view", () => {
    expect(xfconf(C2, "thunar", "/default-view")).toBe("ThunarDetailsView");
    expect(xfconf(C2, "thunar", "/last-view")).toBe("ThunarDetailsView");
  });

  it("seeds the LibreOffice profile so no first-run dialog appears", () => {
    const xcu = dockerExecAs(C2, "abc", "cat", "/config/.config/libreoffice/4/user/registrymodifications.xcu").out;
    expect(xcu).toContain('oor:name="FirstRun"');
    expect(xcu).toContain('oor:name="ShowTipOfTheDay"');
  });

  it("switches to 1x with LOCALDOT_SCALE=1", () => {
    removeAll({ containers: [C2] });
    startDesktop(C1, 1);
    expect(xfconf(C1, "xsettings", "/Gdk/WindowScalingFactor")).toBe("1");
    expect(xfconf(C1, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C1, "xfwm4", "/general/theme")).toBe("Default");
    expect(dockerExecAs(C1, "abc", "xdpyinfo").out).toMatch(/dimensions:\s+1280x800/);
    expect(panelGeometry(C1)).toContainEqual({ WIDTH: 1280, HEIGHT: 26 });
  });
});
```
Add `publishedPort`, `sleepSync` and `waitFor` to the import from `./testing/docker-cli.ts` at the
top of the file, and `import { WebSocket } from "ws";` (the daemon already depends on `ws`). The
full-client check of the DPI lock (a real Selkies client connected) is the e2e test of Task 15,
which reads the same two xfconf values after the stage goes live.

- [ ] **Step 5: Run it**

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: 13 tests pass (5 from part 1, 8 here). The whole file takes about 2–3 minutes (two
desktop starts). If `panelGeometry` lists no 2560-wide window, run
`docker exec -u abc localdot-test-desktop-2x xdotool search --classname xfce4-panel` by hand and
compare the geometry of each id; the panel's main window is the one as wide as the screen.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop apps/daemon/src/cells/desktop-image.docker.test.ts
git commit -m "feat(desktop): one session bus, HiDPI XFCE at 2x and locked Selkies settings"
```

---
### Task 3b: Desktop image — the macOS look (WhiteSur Light, WhiteSur icons, Plank, menu-bar panel)

The spec's "Look" is part of the desktop image (P2-R5): WhiteSur GTK theme and its xfwm4 `-hdpi`/`-xhdpi`
variants, WhiteSur icons, a Plank dock and a top panel styled as a menu bar, all in the LIGHT variant
(P2-R12: Theatre's overlays were tuned against white desktop content). Sources are pinned by commit
and verified after the clone, so no archive checksum is needed; each asset's license is recorded in
the image and in the repo (P2-R13). Facts from the pinned tag `2026-09-10` of both repositories:
the GTK repo's `release/WhiteSur-Light.tar.xz` is the pre-built theme (gtk-2.0/3.0/4.0, `xfwm4/`
at laptop size, `plank/dock.theme`); its installer builds the xfwm4 `-hdpi`/`-xhdpi` variants by
copying `src/assets/xfwm4/assets-Light-{hdpi,xhdpi}/*.png` and `src/main/xfwm4/themerc-Light`
(`libs/lib-install.sh`), which this task repeats without `sassc`; the icon repo's `install.sh -d
/usr/share/icons -t default` installs `WhiteSur`, `WhiteSur-light` and `WhiteSur-dark`; the GTK
theme's `COPYING` is the MIT text, the icon theme's `COPYING` is GPL-3.0. The screenshot checks use
ImageMagick's `import`, which Task 2 installs.

**Files:**
- Modify: `cells/desktop/Dockerfile`, `cells/desktop/root/defaults/startwm.sh`,
  `cells/desktop/root/defaults/localdot/xsettings.xml.in`, `cells/desktop/root/defaults/localdot/xfwm4.xml.in`,
  `.gitignore`
- Create: `cells/desktop/root/defaults/xfce/xfce4-panel.xml`, `cells/desktop/root/etc/xdg/autostart/localdot-plank.desktop`,
  `cells/desktop/root/usr/local/bin/localdot-plank`, `cells/desktop/THIRD-PARTY.md`
- Test: `apps/daemon/src/cells/desktop-image.docker.test.ts` (theme assertions replace Task 3's, plus Plank and screenshots)

**Interfaces:**
- Produces: GTK theme `WhiteSur-Light`; xfwm4 themes `WhiteSur-Light` (1×) and `WhiteSur-Light-xhdpi` (2×);
  icon theme `WhiteSur`; Plank theme `WhiteSur-Light` at `/usr/share/plank/themes/WhiteSur-Light/dock.theme`,
  started by `/etc/xdg/autostart/localdot-plank.desktop` → `/usr/local/bin/localdot-plank` (bottom,
  always visible, 48 px icons at 1× / 96 px device px at 2×); the top panel is a 26 px (1×) / 54 px
  (2×) menu bar: applications menu, expanding separator, status tray, audio, clock, actions; license
  files in `/usr/share/doc/localdot-themes/`; Dockerfile ARGs `WHITESUR_GTK_TAG`, `WHITESUR_GTK_COMMIT`,
  `WHITESUR_ICONS_TAG`, `WHITESUR_ICONS_COMMIT`.

- [ ] **Step 1: Resolve the pins and the licenses**

Run:
```bash
git ls-remote --tags https://github.com/vinceliuice/WhiteSur-gtk-theme 2026-09-10
git ls-remote --tags https://github.com/vinceliuice/WhiteSur-icon-theme 2026-09-10
```
Expected (the values this plan was written against): `99247ecd219bdc1c7409baff062b4aafcf1102a7 refs/tags/2026-09-10`
for the GTK theme and `73d8040da51a9ed74e47c7366e7e9ff437601a5c refs/tags/2026-09-10` for the icon
theme. Write the printed commits into the two `*_COMMIT` ARGs below (if a `^{}` line is printed, the tag
is annotated and that line holds the commit: use it). Then confirm the licenses:
```bash
curl -fsSL https://raw.githubusercontent.com/vinceliuice/WhiteSur-gtk-theme/2026-09-10/COPYING | head -3
curl -fsSL https://raw.githubusercontent.com/vinceliuice/WhiteSur-icon-theme/2026-09-10/COPYING | head -3
```
Expected: the first prints `Copyright (c) 2021 WhiteSur Developers` followed by the MIT permission
sentence; the second prints `GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007`. If either
differs, write what it says into `THIRD-PARTY.md` and the commit message; the spec's license line is
updated after execution (P2-R13).

- [ ] **Step 2: Install the themes in the image**

In `cells/desktop/Dockerfile`, after the Cua Driver `ENV` block and before `COPY root/ /`, add:
```dockerfile
ARG WHITESUR_GTK_TAG=2026-09-10
ARG WHITESUR_GTK_COMMIT=99247ecd219bdc1c7409baff062b4aafcf1102a7
ARG WHITESUR_ICONS_TAG=2026-09-10
ARG WHITESUR_ICONS_COMMIT=73d8040da51a9ed74e47c7366e7e9ff437601a5c

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends plank \
 && rm -rf /var/lib/apt/lists/*

# WhiteSur GTK theme (MIT), light variant: the repo's pre-built theme, plus the xfwm4 -hdpi/-xhdpi
# variants assembled the way its installer does (libs/lib-install.sh), so no sassc build is needed.
RUN set -eu; \
    git clone --depth 1 --branch "$WHITESUR_GTK_TAG" https://github.com/vinceliuice/WhiteSur-gtk-theme /tmp/whitesur-gtk; \
    test "$(git -C /tmp/whitesur-gtk rev-parse HEAD)" = "$WHITESUR_GTK_COMMIT"; \
    tar -xJf /tmp/whitesur-gtk/release/WhiteSur-Light.tar.xz -C /usr/share/themes; \
    for size in hdpi xhdpi; do \
      mkdir -p "/usr/share/themes/WhiteSur-Light-${size}/xfwm4"; \
      cp /tmp/whitesur-gtk/src/assets/xfwm4/assets-Light-${size}/*.png "/usr/share/themes/WhiteSur-Light-${size}/xfwm4/"; \
      cp /tmp/whitesur-gtk/src/main/xfwm4/themerc-Light "/usr/share/themes/WhiteSur-Light-${size}/xfwm4/themerc"; \
    done; \
    mkdir -p /usr/share/plank/themes/WhiteSur-Light /usr/share/doc/localdot-themes; \
    cp /usr/share/themes/WhiteSur-Light/plank/dock.theme /usr/share/plank/themes/WhiteSur-Light/dock.theme; \
    cp /tmp/whitesur-gtk/COPYING /usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING; \
    rm -rf /tmp/whitesur-gtk

# WhiteSur icon theme (GPL-3.0): separately licensed data inside the image, like the base (P2-R13).
RUN set -eu; \
    git clone --depth 1 --branch "$WHITESUR_ICONS_TAG" https://github.com/vinceliuice/WhiteSur-icon-theme /tmp/whitesur-icons; \
    test "$(git -C /tmp/whitesur-icons rev-parse HEAD)" = "$WHITESUR_ICONS_COMMIT"; \
    /tmp/whitesur-icons/install.sh -d /usr/share/icons -t default; \
    cp /tmp/whitesur-icons/COPYING /usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING; \
    rm -rf /tmp/whitesur-icons
```
Also add `/usr/local/bin/localdot-plank` to the `RUN chmod 755 …` line of the `base` stage (it is
copied by `COPY root/ /`), which becomes
`RUN chmod 755 /defaults/startwm.sh /etc/s6-overlay/s6-rc.d/svc-session-bus/run /usr/local/bin/localdot-plank`.

`cells/desktop/THIRD-PARTY.md`:
```markdown
# Third-party components in the desktop image

| Component | Version | License | Where |
|---|---|---|---|
| linuxserver webtop (Ubuntu 26.04, XFCE 4.20, Selkies 2.0.0) | 53afe260-ls3, `sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804` | GPL-3.0-only (image), Selkies MPL-2.0 | base image |
| WhiteSur GTK theme (light) | tag 2026-09-10, commit 99247ecd219bdc1c7409baff062b4aafcf1102a7 | MIT | `/usr/share/themes/WhiteSur-Light*`, license at `/usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING` |
| WhiteSur icon theme | tag 2026-09-10, commit 73d8040da51a9ed74e47c7366e7e9ff437601a5c | GPL-3.0 (separately licensed data) | `/usr/share/icons/WhiteSur*`, license at `/usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING` |
| Plank | Ubuntu package | GPL-3.0 | `/usr/bin/plank` |
| Cua Driver | 0.30.4 | MIT | `/opt/cua`, `/usr/local/bin/cua-driver` |
| VSCodium | 1.135.06055 | MIT | `/usr/share/codium` |
| Node.js | 24.21.0 | MIT | `/opt/node` |

The localDot code in this image (`desktopd`, the s6 services, the templates) is MIT like the rest
of the repository.
```

- [ ] **Step 3: Themes in the templates, the menu-bar panel and the dock**

In `cells/desktop/root/defaults/localdot/xsettings.xml.in` replace the two `Net` names:
```xml
    <property name="ThemeName" type="string" value="WhiteSur-Light"/>
    <property name="IconThemeName" type="string" value="WhiteSur"/>
```
In `cells/desktop/root/defaults/localdot/xfwm4.xml.in` set the window buttons to macOS order (close,
minimize, maximize on the left):
```xml
    <property name="button_layout" type="string" value="CHM|"/>
```
In `cells/desktop/root/defaults/startwm.sh` map the scale to the WhiteSur xfwm4 builds:
```bash
case "$scale" in
  1) theme=WhiteSur-Light ;;
  2) theme=WhiteSur-Light-xhdpi ;;
  *) echo "startwm: LOCALDOT_SCALE must be 1 or 2, got $scale" >&2; exit 1 ;;
esac
```
(startwm.sh rewrites `xsettings.xml` and `xfwm4.xml` on every start, so a theme change made inside
the desktop does not survive a restart; that is intended — the look is localDot's, not the agent's.)

`cells/desktop/root/defaults/xfce/xfce4-panel.xml` (replaces the base's default on the first run;
size 26 stays, because GTK window scaling renders it at 54 px at 2×, as S2 measured):
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="false"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=6;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="icon-size" type="uint" value="16"/>
      <property name="size" type="uint" value="26"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="3"/>
        <value type="int" value="4"/>
        <value type="int" value="5"/>
        <value type="int" value="6"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu">
      <property name="show-button-title" type="bool" value="false"/>
      <property name="button-icon" type="string" value="distributor-logo"/>
    </property>
    <property name="plugin-2" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-3" type="string" value="systray">
      <property name="square-icons" type="bool" value="true"/>
    </property>
    <property name="plugin-4" type="string" value="pulseaudio">
      <property name="enable-keyboard-shortcuts" type="bool" value="true"/>
      <property name="show-notifications" type="bool" value="false"/>
    </property>
    <property name="plugin-5" type="string" value="clock">
      <property name="digital-layout" type="uint" value="3"/>
      <property name="digital-time-format" type="string" value="%a %d %b  %H:%M"/>
    </property>
    <property name="plugin-6" type="string" value="actions"/>
  </property>
</channel>
```

`cells/desktop/root/etc/xdg/autostart/localdot-plank.desktop`:
```
[Desktop Entry]
Type=Application
Name=Dock
Exec=/usr/local/bin/localdot-plank
OnlyShowIn=XFCE;
X-GNOME-Autostart-enabled=true
```

`cells/desktop/root/usr/local/bin/localdot-plank`:
```bash
#!/bin/bash
# Plank keeps its settings in dconf on the home volume; the dock's look is pinned before every start.
dock="net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/"
gsettings set "$dock" theme "'WhiteSur-Light'"
gsettings set "$dock" position "'bottom'"
gsettings set "$dock" hide-mode "'none'"
gsettings set "$dock" icon-size 48
exec plank
```

Run: `cells/desktop/build.sh`
Expected: the theme layers build (two clones, ~200 MB of icons); `docker run --rm --entrypoint ls
localdot/desktop:dev /usr/share/themes` lists `WhiteSur-Light`, `WhiteSur-Light-hdpi`,
`WhiteSur-Light-xhdpi`; `… ls /usr/share/icons` lists `WhiteSur`, `WhiteSur-dark`, `WhiteSur-light`.

- [ ] **Step 4: Update the image test and look at the desktop**

In `apps/daemon/src/cells/desktop-image.docker.test.ts` (the "session bus, HiDPI and Selkies"
describe from Task 3) change the two xfwm4 expectations — `toBe("Default-xhdpi")` becomes
`toBe("WhiteSur-Light-xhdpi")` in the 2× test and `toBe("Default")` becomes `toBe("WhiteSur-Light")`
in the 1× test — and add these tests before `"switches to 1x with LOCALDOT_SCALE=1"`:
```ts
  it("wears the WhiteSur light look with a dock and a menu-bar panel", () => {
    expect(xfconf(C2, "xsettings", "/Net/ThemeName")).toBe("WhiteSur-Light");
    expect(xfconf(C2, "xsettings", "/Net/IconThemeName")).toBe("WhiteSur");
    expect(xfconf(C2, "xfwm4", "/general/button_layout")).toBe("CHM|");
    expect(dockerExec(C2, "sh", "-c", "ls /usr/share/themes/WhiteSur-Light-xhdpi/xfwm4/themerc /usr/share/icons/WhiteSur/index.theme /usr/share/plank/themes/WhiteSur-Light/dock.theme").status).toBe(0);
    expect(dockerExec(C2, "sh", "-c", "ls /usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING /usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING").status).toBe(0);
    const plugins = dockerExecAs(C2, "abc", "xfconf-query", "-c", "xfce4-panel", "-l", "-v").out;
    expect(plugins).toContain("applicationsmenu");
    expect(plugins).not.toContain("tasklist");
    expect(dockerExecAs(C2, "abc", "pgrep", "-x", "plank").status).toBe(0);
    expect(dockerExecAs(C2, "abc", "gsettings", "get", "net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/", "theme").out.trim()).toBe("'WhiteSur-Light'");
  });

  it("saves a 2x screenshot of the themed desktop for the executor to look at", () => {
    expect(dockerExecAs(C2, "abc", "sh", "-c", "import -window root /tmp/look-2x.png").status).toBe(0);
    docker("cp", `${C2}:/tmp/look-2x.png`, join(OUT, "look-2x.png"));
  });
```
and, inside the 1× test after its panel assertion:
```ts
    expect(xfconf(C1, "xsettings", "/Net/ThemeName")).toBe("WhiteSur-Light");
    expect(dockerExecAs(C1, "abc", "sh", "-c", "import -window root /tmp/look-1x.png").status).toBe(0);
    docker("cp", `${C1}:/tmp/look-1x.png`, join(OUT, "look-1x.png"));
```
Near the top of the file add `const OUT = fileURLToPath(new URL("./testing/out/", import.meta.url));`
and add `mkdirSync(OUT, { recursive: true })` at the top of the describe (import `mkdirSync` from
`node:fs`, `join` from `node:path` and `fileURLToPath` from `node:url`). In `.gitignore`, append
`apps/daemon/src/cells/testing/out/` and drop the lines `cells/desktop/desktopd/dist/` and
`apps/web/dist/` that Task 1 added (the existing `dist/` line already covers both).

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: 15 tests pass. Open `look-2x.png` and `look-1x.png` in
`apps/daemon/src/cells/testing/out/` and check: WhiteSur's light window
chrome with the traffic-light buttons on the left of the title bar, a light top panel with the
applications icon left and tray/clock right, and the Plank dock centred at the bottom; the 2× image
is 2560×1600 with the panel 54 px tall. If Plank draws an opaque rectangle behind its icons (it is
designed for a compositing window manager; xfwm4's compositor is off in the template), set
`use_compositing` to `true` in `xfwm4.xml.in`, rebuild, re-run, and record the container CPU
difference in the Task 15 measurement note.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop apps/daemon/src/cells/desktop-image.docker.test.ts .gitignore
git commit -m "feat(desktop): WhiteSur light look with Plank and a menu-bar panel"
```

---
### Task 4: Spike S8 — Selkies' client hosted in our own page (the risk-first proof)

S1 tapped frames inside Selkies' own dashboard page, served by the cell's nginx through a proxy.
Part 2 must not load JavaScript served by a cell into the daemon's origin (a cell's user has sudo and
could replace `/usr/share/selkies/web/*`, and same-origin iframe code can read the parent's
storage, install token included). So the daemon serves a **vendored copy** of Selkies' dashboard
(`index.html` + `assets/`, MPL-2.0, from the pinned base image) under a per-cell prefix and proxies
only `api/*` to the cell. This spike proves, before any daemon code is written, that the dashboard
runs from our server under a path prefix, inside a same-origin iframe, that the parent page can
clone its `<video>` track and feed a worker, and it measures the WebSocket's idle cadence (for the
stall watchdog) and a paused upstream.

Facts this rests on (from the pinned image's client, `assets/selkies-core-*.js`, and server): the
client derives its route prefix from `location.pathname` up to the last `/` and opens one socket at
`<prefix>/api/websockets`; `index.html` references `./assets/...` relatively (its `manifest.json`
link points at a file nginx generates at runtime, so the extractor removes that one link); the
stream socket is an aiohttp `WebSocketResponse(heartbeat=30, autoping=False)`
(`websockets_mode.py`), so the server itself sends a protocol ping only every 30 s — the 0.2 s
`PING_INTERVAL` in `stream_server.py` belongs to the file-transfer uplink gauge and never runs on
the stream socket; the client re-acks the newest frame id every 1 s. Liveness therefore rests on
the host's own pings (every 500 ms in this spike and in Task 11), which the server answers. The
dashboard's sidebar and buttons are hidden by the `SELKIES_UI_*` settings baked in Task 3.

**Files:**
- Create: `spikes/s8-hosted-client/package.json`, `extract.sh`, `run-desktop.sh`, `host.mjs`,
  `page.html`, `worker.js`, `FINDINGS.md`
- Create: `cells/desktop/scripts/extract-selkies-client.sh`

**Interfaces:**
- Consumes: image `localdot/desktop:dev` and its `selkies-client` build stage (Task 2), the Selkies
  settings of Task 3.
- Produces: `cells/desktop/scripts/extract-selkies-client.sh <dest>` (used again by Task 14);
  FINDINGS with `Result: GO | GO-WITH-CHANGES | FALLBACK`, the working tap path, fps and CPU at 2×,
  the idle WebSocket cadence (messages, pings and pongs per second on a still screen, longest
  silence) and the behaviour while the container is paused.

- [ ] **Step 1: The client extractor and the spike files**

`cells/desktop/scripts/extract-selkies-client.sh`:
```bash
#!/usr/bin/env bash
# Copies Selkies' dashboard (index.html, assets, icons, the MPL-2.0 text) out of the pinned base
# image into <dest>, using the selkies-client build stage so no container runs and nothing is
# bind-mounted. <dest> is resolved to an absolute path before the cd into the build context.
set -euo pipefail
raw=${1:?usage: extract-selkies-client.sh <dest>}
mkdir -p "$raw"
dest="$(cd "$raw" && pwd)"
cd "$(dirname "$0")/.."
rm -rf "$dest"
docker build --target selkies-client --output "type=local,dest=$dest" .
# manifest.json is generated by the cell's nginx at runtime and does not exist here.
sed -i.orig 's#<link rel="manifest" href="manifest.json" crossorigin="use-credentials">##' "$dest/index.html"
rm -f "$dest/index.html.orig"
if grep -q 'rel="manifest"' "$dest/index.html"; then
  echo "extract-selkies-client.sh: the manifest link survived the sed; update its pattern" >&2
  exit 1
fi
ls "$dest/index.html" "$dest/assets" "$dest/icon.png" "$dest/icon-512.png" "$dest/LICENSE" >/dev/null
echo "extracted Selkies client to $dest"
```

`spikes/s8-hosted-client/package.json`:
```json
{
  "name": "@localdot/spike-s8-hosted-client",
  "private": true,
  "type": "module",
  "dependencies": { "ws": "8.22.0" }
}
```

`spikes/s8-hosted-client/extract.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
../../cells/desktop/scripts/extract-selkies-client.sh "$PWD/client"
```

`spikes/s8-hosted-client/run-desktop.sh`:
```bash
#!/usr/bin/env bash
# The Part 2 desktop image, standalone (default bridge, so the desktop's Chromium can load a page
# for the motion test), stream on 127.0.0.1:4791 behind the basic-auth password s8password.
set -euo pipefail
SCALE=${1:-2}
W=$((1280 * SCALE)); H=$((800 * SCALE))
docker rm -fv ld-s8-desktop >/dev/null 2>&1 || true
docker run -d --name ld-s8-desktop --shm-size=1g --cap-drop NET_RAW -p 127.0.0.1:4791:3000 \
  -e PASSWORD=s8password -e LOCALDOT_SCALE="$SCALE" \
  -e SELKIES_MANUAL_WIDTH="$W" -e SELKIES_MANUAL_HEIGHT="$H" \
  localdot/desktop:dev >/dev/null
until docker exec -u abc ld-s8-desktop pgrep -x xfce4-panel >/dev/null 2>&1; do sleep 1; done
sleep 5
echo "desktop: http://127.0.0.1:4791 (${SCALE}x = ${W}x${H}), user localdot, password s8password"
```

`spikes/s8-hosted-client/host.mjs`:
```js
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, "client");
const UPSTREAM = { host: "127.0.0.1", port: 4791 };
const AUTH = `Basic ${Buffer.from("localdot:s8password").toString("base64")}`;
const PREFIX = "/d/t1";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:4792");
  if (url.pathname === "/") return sendFile(res, join(here, "page.html"));
  if (url.pathname === "/worker.js") return sendFile(res, join(here, "worker.js"));
  if (!url.pathname.startsWith(`${PREFIX}/`)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const rel = url.pathname.slice(PREFIX.length);
  if (rel.startsWith("/api/")) {
    const up = httpRequest(
      { ...UPSTREAM, method: req.method, path: `${rel}${url.search}`, headers: { authorization: AUTH } },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, { "content-type": upRes.headers["content-type"] ?? "application/octet-stream" });
        upRes.pipe(res);
      },
    );
    up.on("error", (err) => {
      res.writeHead(502);
      res.end(err.message);
    });
    up.end();
    return;
  }
  sendFile(res, join(CLIENT, normalize(rel === "/" ? "/index.html" : rel)));
});

const wss = new WebSocketServer({ noServer: true });
const stats = { up: 0, upBytes: 0, down: 0, pings: 0, pongs: 0, lastUpstreamAt: 0, longestSilenceMs: 0 };
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:4792");
  if (url.pathname !== `${PREFIX}/api/websockets`) {
    socket.destroy();
    return;
  }
  // Dial the desktop first and finish the viewer's upgrade from its open: the client sends its
  // settings the moment its socket opens, and Selkies streams nothing until it has them.
  const upstream = new WebSocket(`ws://${UPSTREAM.host}:${UPSTREAM.port}/api/websockets${url.search}`, {
    headers: { authorization: AUTH },
    perMessageDeflate: false,
  });
  let client = null;
  let viewerGone = false;
  const abandon = () => {
    viewerGone = true;
    upstream.terminate();
  };
  socket.on("error", () => socket.destroy());
  socket.once("close", abandon);
  const touch = () => {
    const now = Date.now();
    if (stats.lastUpstreamAt) stats.longestSilenceMs = Math.max(stats.longestSilenceMs, now - stats.lastUpstreamAt);
    stats.lastUpstreamAt = now;
  };
  const ping = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) upstream.ping();
  }, 500);
  upstream.on("open", () => {
    console.log("upstream open");
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", abandon);
      client = ws;
      client.on("message", (data, isBinary) => {
        stats.down += 1;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      client.on("error", () => {});
      client.on("close", () => upstream.close());
    });
  });
  upstream.on("message", (data, isBinary) => {
    stats.up += 1;
    stats.upBytes += data.length ?? 0;
    touch();
    if (client?.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("ping", () => { stats.pings += 1; touch(); });
  upstream.on("pong", () => { stats.pongs += 1; touch(); });
  upstream.on("error", (err) => console.log("upstream error", err.message));
  upstream.on("close", (code, reason) => {
    console.log("upstream close", code, String(reason));
    clearInterval(ping);
    if (client?.readyState === WebSocket.OPEN) client.close(1012, "upstream closed");
    else if (!client && !viewerGone) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
});

let last = { ...stats, at: Date.now() };
setInterval(() => {
  const now = Date.now();
  const dt = (now - last.at) / 1000;
  const rate = (key) => ((stats[key] - last[key]) / dt).toFixed(1);
  console.log(
    `upstream msgs/s ${rate("up")} kB/s ${((stats.upBytes - last.upBytes) / dt / 1024).toFixed(0)} ` +
      `pings/s ${rate("pings")} pongs/s ${rate("pongs")} client msgs/s ${rate("down")} ` +
      `silence now ${stats.lastUpstreamAt ? now - stats.lastUpstreamAt : "-"} ms, longest ${stats.longestSilenceMs} ms`,
  );
  last = { ...stats, at: now };
}, 5000);

server.listen(4792, "127.0.0.1", () => console.log("host on http://127.0.0.1:4792"));
```

`spikes/s8-hosted-client/page.html`:
```html
<!doctype html>
<meta charset="utf-8">
<title>S8 hosted client</title>
<style>
  body { margin: 0; background: #0A0B0D; color: #EEEFF1; font: 13px system-ui; }
  #stage { display: block; width: 1280px; height: 800px; margin: 16px; background: #000; }
  #desktop { position: absolute; left: -10px; top: -10px; width: 1px; height: 1px; opacity: 0; pointer-events: none; border: 0; }
  #stats { margin: 0 16px; white-space: pre; }
</style>
<canvas id="stage"></canvas>
<pre id="stats">waiting for #videoStream…</pre>
<iframe id="desktop" src="/d/t1/" inert></iframe>
<script type="module">
  const canvas = document.getElementById("stage");
  const statsEl = document.getElementById("stats");
  const frame = document.getElementById("desktop");
  const worker = new Worker("/worker.js");
  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
  worker.onmessage = (e) => { statsEl.textContent = JSON.stringify(e.data); };
  let tappedTrackId = null;
  const tap = () => {
    const video = frame.contentDocument?.getElementById("videoStream");
    const track = video?.srcObject?.getVideoTracks?.()[0];
    if (!track || track.id === tappedTrackId) return;
    tappedTrackId = track.id;
    const processor = new MediaStreamTrackProcessor({ track: track.clone() });
    worker.postMessage({ type: "frames", readable: processor.readable }, [processor.readable]);
    console.log("tapped", track.id, JSON.stringify(track.getSettings()));
  };
  setInterval(tap, 250);
  window.ldReady = () => tappedTrackId !== null;
</script>
```

`spikes/s8-hosted-client/worker.js`:
```js
let canvas = null;
let ctx = null;
let presented = 0;
let windowStart = 0;
let windowFrames = 0;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    canvas = m.canvas;
    ctx = canvas.getContext("2d");
    return;
  }
  if (m.type !== "frames") return;
  const reader = m.readable.getReader();
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) return;
    const format = frame.format;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    presented += 1;
    windowFrames += 1;
    const now = performance.now();
    if (now - windowStart >= 1000) {
      const fps = Math.round((windowFrames * 1000) / (now - windowStart));
      windowFrames = 0;
      windowStart = now;
      self.postMessage({ presented, fps, size: `${canvas.width}x${canvas.height}`, format });
    }
  }
};
```

Run:
```bash
chmod +x cells/desktop/scripts/extract-selkies-client.sh spikes/s8-hosted-client/*.sh
pnpm install
spikes/s8-hosted-client/extract.sh
```
Expected: `spikes/s8-hosted-client/client/index.html` (without the manifest link), `client/assets/`
with `index-*.js`, `selkies-core-*.js` and `index-*.css` (three files, about 1.1 MB), `icon.png`,
`icon-512.png` and `LICENSE` (the MPL-2.0 text).

- [ ] **Step 2: Run the desktop, the host, and open the page**

```bash
spikes/s8-hosted-client/run-desktop.sh 2
node spikes/s8-hosted-client/host.mjs
```
Open `http://127.0.0.1:4792` in Google Chrome 154 (the Chrome DevTools MCP `new_page`, or the
browser by hand). Wait 15 s. Read `#stats` (DevTools `evaluate_script`:
`document.getElementById("stats").textContent`) and `ldReady()`.
Expected: `ldReady()` is `true`; `#stats` shows `presented` rising and `size: "2560x1600"`,
`format: "I444"`; the canvas shows the XFCE desktop (take a screenshot and look at it). The console
shows one `tapped <id>` line. The host log shows `upstream open`, then every 5 s a cadence line.

If the canvas stays black, work down this list and record which step changed the result:
1. `#stats` never updates and the console has no `tapped` line: open
   `http://127.0.0.1:4792/d/t1/` directly in a tab. If the desktop shows there, the iframe is the
   problem — check `frame.contentDocument` is reachable (same origin) and that `#videoStream` exists
   in that document (`document.getElementById("videoStream")` in the iframe's console).
2. The direct tab shows no desktop: read its console. A 404 on `./assets/...` means the extracted
   files are incomplete; a failed `api/websockets` upgrade means the proxy path or the basic-auth
   header is wrong (`curl -u localdot:s8password -i http://127.0.0.1:4791/api/health` must be 200).
3. The track exists but `presented` stays 0: the sink is not the page `MediaStreamTrackGenerator`
   (S1 saw it on Chrome 154); read Selkies' console line `video sink: …`. If it says `VideoTrackGenerator
   in the video worker`, the `<video>` still carries the track and the tap is unchanged; if it says
   `OffscreenCanvas`, H.264 was refused: check `chrome://media-internals` for the decoder error,
   try `SELKIES_VIDEO_FULLCOLOR=false` on the container, and record the difference.
4. The clone fails across realms (an exception in `tap`): inject the tap into the vendored
   `index.html` instead — a 15-line module script that runs the same `tap` inside the iframe and
   hands the cloned track to the parent with `parent.postMessage(track, "*", [track])`
   (`MediaStreamTrack` is transferable in Chromium). Keep the injected copy as the Part 2 vendor
   if this is what works, and say so in FINDINGS.
5. Nothing above helps: `Result: FALLBACK` — Part 2's stream tasks then build an own host page
   around `selkies-core-*.js` (the streaming core exports one `websockets()` function with a
   `window` contract documented in its header), and KasmVNC/noVNC stays the last resort behind the
   same frame-source interface.

- [ ] **Step 3: Measure motion, the idle cadence and a paused upstream**

```bash
docker exec -d -u abc -e DISPLAY=:1 ld-s8-desktop chromium file:///usr/share/common-licenses/GPL-3
sleep 8
docker exec -u abc -e DISPLAY=:1 ld-s8-desktop xdotool key --delay 40 --repeat 500 Down &
for _ in $(seq 1 10); do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' ld-s8-desktop; sleep 2; done
wait
```
Record: `#stats` fps during the scroll (expected 45–62 at 2×, S1), the container CPU samples,
Chrome's CPU (`top -l 3 -s 2 -stats pid,cpu,command | grep -i chrome`), and the host log's
cadence lines during motion and, after the scroll stops, for 60 s of still screen. Expected on a
still screen: `pongs/s` about 2.0 (answers to the host's 500 ms pings), `pings/s` about 0.03 (the
server's 30 s heartbeat), `upstream msgs/s` near 0 (Selkies encodes on damage), and `longest
silence` well under 1000 ms, because every pong counts as life. Then:
```bash
docker pause ld-s8-desktop; sleep 6; docker unpause ld-s8-desktop
```
Record the `silence now` values during the pause (expected: climbing past 5000 ms with
`pongs/s 0.0`) and whether the stream recovers after unpause without a page reload (the client
reloads itself 5 s after its socket closes; note which happened). These numbers set the watchdog in
Task 11: `STREAM_PING_MS = 500` and `STREAM_STALL_MS = 1500` hold if the longest idle silence on a
live upstream stays under 1000 ms; otherwise raise `STREAM_STALL_MS` to twice the longest silence
and write the number into FINDINGS.

- [ ] **Step 4: Write FINDINGS.md and clean up**

`spikes/s8-hosted-client/FINDINGS.md` (under one page): date, Chrome version, image id; a table
with presented/fps at rest and during the scroll, container CPU, Chrome CPU, the sink line from
Selkies' console, the idle cadence numbers, the pause behaviour; which of the list in Step 2 was
needed; `Result: GO | GO-WITH-CHANGES | FALLBACK` and the watchdog constants for Task 11.
Then `docker rm -fv ld-s8-desktop` and stop `host.mjs`.

- [ ] **Step 5: Commit**

```bash
git add spikes/s8-hosted-client cells/desktop/scripts pnpm-lock.yaml .gitignore
git commit -m "chore(spikes): S8 host Selkies' client in our own page"
```
(`spikes/s8-hosted-client/client/` is git-ignored: it is regenerated from the image.)

---
### Task 5: desktopd skeleton with a token-protected health check

`desktopd` is the in-cell daemon the gateway will talk to (Part 3). This task ships its skeleton:
a Hono server on `0.0.0.0:7700` inside the cell (reachable only through the gate's relay), one
`GET /healthz` behind a bearer token, reporting the live xsettings so the daemon can verify the HiDPI
state at startup, bundled by esbuild into one file and run by an s6 service as the desktop user.

**Files:**
- Create: `cells/desktop/desktopd/package.json`, `tsconfig.json`, `build.mjs`
- Create: `cells/desktop/desktopd/src/main.ts`, `src/app.ts`, `src/auth.ts`, `src/xsettings.ts`
- Create: `cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-desktopd/{type,run,dependencies.d/svc-de}`,
  `cells/desktop/root/etc/s6-overlay/s6-rc.d/user/contents.d/svc-desktopd`
- Modify: `cells/desktop/Dockerfile`, `cells/desktop/build.sh`, `pnpm-workspace.yaml`
- Test: `cells/desktop/desktopd/src/app.test.ts`, `apps/daemon/src/cells/desktop-image.docker.test.ts` (part 3)

**Interfaces:**
- Produces: `GET /healthz` with `Authorization: Bearer <LOCALDOT_DESKTOPD_TOKEN>` →
  `DesktopdHealth { ok: boolean; scale: 1|2; display: string; screen: {w,h} | null; hidpi: { ok, expected: {windowScalingFactor, xftDpi: 96}, windowScalingFactor, xftDpi } }`,
  401 otherwise. Env: `LOCALDOT_DESKTOPD_TOKEN` (≥ 32 chars, required), `LOCALDOT_SCALE` (1|2,
  default 2), `LOCALDOT_DESKTOPD_PORT` (default 7700). Exports for Part 3:
  `createDesktopdApp(deps: DesktopdDeps): Hono`, `DesktopdDeps`, `DesktopdHealth`, `hidpiReport`.

- [ ] **Step 1: Package files**

`pnpm-workspace.yaml` — add the package:
```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "spikes/*"
  - "cells/desktop/desktopd"
```

`cells/desktop/desktopd/package.json`:
```json
{
  "name": "@localdot/desktopd",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "start": "tsx src/main.ts",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@hono/node-server": "2.1.3",
    "hono": "4.13.12"
  },
  "devDependencies": {
    "esbuild": "0.28.2",
    "tsx": "4.23.15"
  }
}
```

`cells/desktop/desktopd/tsconfig.json`:
```json
{ "extends": "../../../tsconfig.base.json", "include": ["src"] }
```

`cells/desktop/desktopd/build.mjs`:
```js
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(here, "dist/desktopd.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "info",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
```

Run: `pnpm install`
Expected: the lockfile gains `@localdot/desktopd`; no new network downloads beyond esbuild's
already-present 0.28.2.

- [ ] **Step 2: Write the failing app test**

`cells/desktop/desktopd/src/app.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createDesktopdApp, type DesktopdHealth, hidpiReport } from "./app.ts";

const TOKEN = "d".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };

function app(opts: { scale: 1 | 2; factor: number | null; dpi: number | null; screen: { w: number; h: number } | null }) {
  return createDesktopdApp({
    token: TOKEN,
    scale: opts.scale,
    display: ":1",
    readXsettings: async () => ({ windowScalingFactor: opts.factor, xftDpi: opts.dpi }),
    readScreen: async () => opts.screen,
  });
}

describe("desktopd health", () => {
  it("refuses requests without the cell token", async () => {
    const a = app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } });
    expect((await a.request("/healthz")).status).toBe(401);
    expect((await a.request("/healthz", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await a.request("/healthz", { headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401);
  });

  it("reports ok at 2x with window scaling 2, Xft/DPI 96 and a 2560x1600 screen", async () => {
    const res = await app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } }).request("/healthz", { headers: bearer });
    expect(res.status).toBe(200);
    const health = (await res.json()) as DesktopdHealth;
    expect(health).toEqual({
      ok: true,
      scale: 2,
      display: ":1",
      screen: { w: 2560, h: 1600 },
      hidpi: { ok: true, expected: { windowScalingFactor: 2, xftDpi: 96 }, windowScalingFactor: 2, xftDpi: 96 },
    });
  });

  it("reports the HiDPI mismatch when XFCE did not scale", async () => {
    const res = await app({ scale: 2, factor: 1, dpi: 192, screen: { w: 2560, h: 1600 } }).request("/healthz", { headers: bearer });
    const health = (await res.json()) as DesktopdHealth;
    expect(health.ok).toBe(false);
    expect(health.hidpi).toEqual({ ok: false, expected: { windowScalingFactor: 2, xftDpi: 96 }, windowScalingFactor: 1, xftDpi: 192 });
  });

  it("reports not ok when the screen has the wrong size or is unreadable", async () => {
    const wrong = await app({ scale: 2, factor: 2, dpi: 96, screen: { w: 1280, h: 800 } }).request("/healthz", { headers: bearer });
    expect(((await wrong.json()) as DesktopdHealth).ok).toBe(false);
    const none = await app({ scale: 2, factor: 2, dpi: 96, screen: null }).request("/healthz", { headers: bearer });
    expect(((await none.json()) as DesktopdHealth).ok).toBe(false);
  });

  it("treats unset xsettings as 1x at 96 dpi", () => {
    expect(hidpiReport(1, { windowScalingFactor: null, xftDpi: null }).ok).toBe(true);
    expect(hidpiReport(2, { windowScalingFactor: null, xftDpi: null }).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm exec vitest run cells/desktop/desktopd/src/app.test.ts`
Expected: FAIL — `Failed to load url ./app.ts`.

- [ ] **Step 4: Implement desktopd**

`cells/desktop/desktopd/src/auth.ts` (the same constant-time comparison as the daemon's
`tokensMatch`; desktopd is bundled into the image and cannot import the daemon):
```ts
import { timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 32;

export function bearerMatches(expected: string, authorization: string | undefined): boolean {
  const given = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (expected.length < MIN_TOKEN_LENGTH || given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

`cells/desktop/desktopd/src/xsettings.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Xsettings {
  windowScalingFactor: number | null;
  xftDpi: number | null;
}

export interface Screen {
  w: number;
  h: number;
}

// xfconf-query exits 1 for an unset property; unset means XFCE's default (1x, 96 dpi).
export async function xfconfInt(channel: string, property: string): Promise<number | null> {
  try {
    const { stdout } = await run("xfconf-query", ["-c", channel, "-p", property]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function readXsettings(): Promise<Xsettings> {
  return {
    windowScalingFactor: await xfconfInt("xsettings", "/Gdk/WindowScalingFactor"),
    xftDpi: await xfconfInt("xsettings", "/Xft/DPI"),
  };
}

export async function readScreen(): Promise<Screen | null> {
  try {
    const { stdout } = await run("xdpyinfo");
    const m = /dimensions:\s+(\d+)x(\d+)/.exec(stdout);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  } catch {
    return null;
  }
}
```

`cells/desktop/desktopd/src/app.ts`:
```ts
import { Hono } from "hono";
import { bearerMatches } from "./auth.ts";
import type { Screen, Xsettings } from "./xsettings.ts";

export type Scale = 1 | 2;

export interface DesktopdDeps {
  token: string;
  scale: Scale;
  display: string;
  readXsettings(): Promise<Xsettings>;
  readScreen(): Promise<Screen | null>;
}

export interface HidpiReport {
  ok: boolean;
  expected: { windowScalingFactor: Scale; xftDpi: 96 };
  windowScalingFactor: number | null;
  xftDpi: number | null;
}

export interface DesktopdHealth {
  ok: boolean;
  scale: Scale;
  display: string;
  screen: Screen | null;
  hidpi: HidpiReport;
}

const SCREEN: Record<Scale, Screen> = { 1: { w: 1280, h: 800 }, 2: { w: 2560, h: 1600 } };

export function hidpiReport(scale: Scale, x: Xsettings): HidpiReport {
  const factor = x.windowScalingFactor ?? 1;
  const dpi = x.xftDpi ?? 96;
  return {
    ok: factor === scale && dpi === 96,
    expected: { windowScalingFactor: scale, xftDpi: 96 },
    windowScalingFactor: x.windowScalingFactor,
    xftDpi: x.xftDpi,
  };
}

export function createDesktopdApp(deps: DesktopdDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!bearerMatches(deps.token, c.req.header("authorization"))) return c.text("unauthorized", 401);
    await next();
  });

  app.get("/healthz", async (c) => {
    const [xsettings, screen] = await Promise.all([deps.readXsettings(), deps.readScreen()]);
    const hidpi = hidpiReport(deps.scale, xsettings);
    const want = SCREEN[deps.scale];
    const ok = hidpi.ok && screen !== null && screen.w === want.w && screen.h === want.h;
    const health: DesktopdHealth = { ok, scale: deps.scale, display: deps.display, screen, hidpi };
    return c.json(health);
  });

  return app;
}
```

`cells/desktop/desktopd/src/main.ts`:
```ts
import { serve } from "@hono/node-server";
import { createDesktopdApp } from "./app.ts";
import { MIN_TOKEN_LENGTH } from "./auth.ts";
import { readScreen, readXsettings } from "./xsettings.ts";

const token = process.env.LOCALDOT_DESKTOPD_TOKEN ?? "";
if (token.length < MIN_TOKEN_LENGTH) {
  console.error(`desktopd: LOCALDOT_DESKTOPD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  process.exit(1);
}
const scale = process.env.LOCALDOT_SCALE === "1" ? 1 : 2;
const port = Number(process.env.LOCALDOT_DESKTOPD_PORT ?? 7700);
const app = createDesktopdApp({
  token,
  scale,
  display: process.env.DISPLAY ?? ":1",
  readXsettings,
  readScreen,
});
// 0.0.0.0 inside the cell: only the gate's relay on the isolated internal network can reach it.
serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => {
  console.log(`desktopd on 0.0.0.0:${port} (scale ${scale})`);
});
```

- [ ] **Step 5: Run the unit test, bundle**

Run: `pnpm exec vitest run cells/desktop/desktopd/src/app.test.ts && pnpm --filter @localdot/desktopd build`
Expected: 5 tests pass; esbuild prints `dist/desktopd.mjs` (about 300–400 kB).

- [ ] **Step 6: The s6 service and the image**

`cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-desktopd/type`:
```
longrun
```

`cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-desktopd/run`:
```bash
#!/usr/bin/with-contenv bash
# DISPLAY, DBUS_SESSION_BUS_ADDRESS and LOCALDOT_* come from the container environment.
exec s6-setuidgid abc /opt/node/bin/node /opt/localdot/desktopd.mjs
```

Create the empty files `svc-desktopd/dependencies.d/svc-de` and `user/contents.d/svc-desktopd`.

In `cells/desktop/Dockerfile`, extend the `RUN chmod 755 /defaults/startwm.sh ...` line in the
`base` stage, keeping every earlier entry, to
`RUN chmod 755 /defaults/startwm.sh /etc/s6-overlay/s6-rc.d/svc-session-bus/run /usr/local/bin/localdot-plank /etc/s6-overlay/s6-rc.d/svc-desktopd/run`,
and replace the final `FROM base AS desktop` line with:
```dockerfile
FROM base AS desktop
# The bundle lands in the final stage only, so `--target selkies-client` never needs it built.
COPY desktopd/dist/desktopd.mjs /opt/localdot/desktopd.mjs
RUN chmod 644 /opt/localdot/desktopd.mjs
EXPOSE 3000 7700
```

`cells/desktop/build.sh` (replace):
```bash
#!/usr/bin/env bash
# Bundles desktopd, then builds localdot/desktop:dev for the host architecture.
set -euo pipefail
cd "$(dirname "$0")"
pnpm --filter @localdot/desktopd build
docker build --target desktop -t localdot/desktop:dev .
```

Run: `cells/desktop/build.sh`
Expected: only the overlay layers rebuild.

- [ ] **Step 7: Extend the image test (part 3)**

In `apps/daemon/src/cells/desktop-image.docker.test.ts`, add near the top:
```ts
const DESKTOPD_TOKEN = "d".repeat(43);
```
Change `startDesktop` to publish desktopd and pass the token — the `docker("run", ...)` call gains
`"-p", "127.0.0.1:0:7700", "-e", `LOCALDOT_DESKTOPD_TOKEN=${DESKTOPD_TOKEN}`,` and the function
returns `{ port: publishedPort(name, "3000"), desktopd: publishedPort(name, "7700") }`, so its
declaration becomes `function startDesktop(name: string, scale: 1 | 2): { port: number; desktopd: number }`. In the
"session bus, HiDPI and Selkies" describe, keep `port2` and add `let desktopd2 = 0;`, set both in
`beforeAll` (`const started = startDesktop(C2, 2); port2 = started.port; desktopd2 = started.desktopd;`),
and insert these tests before `"switches to 1x with LOCALDOT_SCALE=1"`:
```ts
  it("runs desktopd as the desktop user behind the cell token", async () => {
    expect(dockerExec(C2, "sh", "-c", "ps -o user= -p $(pgrep -f desktopd.mjs | head -n 1)").out.trim()).toBe("abc");
    expect((await fetch(`http://127.0.0.1:${desktopd2}/healthz`)).status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${desktopd2}/healthz`, { headers: { authorization: `Bearer ${DESKTOPD_TOKEN}` } });
    expect(res.status).toBe(200);
    const health = (await res.json()) as { ok: boolean; scale: number; screen: unknown; hidpi: { ok: boolean } };
    expect(health.ok).toBe(true);
    expect(health.scale).toBe(2);
    expect(health.screen).toEqual({ w: 2560, h: 1600 });
    expect(health.hidpi.ok).toBe(true);
  });
```

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: 16 tests pass (Tasks 2, 3 and 3b's 15 plus this one).

- [ ] **Step 8: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add cells/desktop pnpm-workspace.yaml pnpm-lock.yaml apps/daemon/src/cells/desktop-image.docker.test.ts
git commit -m "feat(desktopd): health endpoint behind the cell token"
```

---
### Task 6: Docker Engine client over the Unix socket

The spec says the daemon orchestrates cells through the Docker Engine API. The surface the daemon
needs is small (create/inspect/start/stop/remove for containers, networks and volumes), so the
client is our own: JSON over `node:http` with `socketPath`, no dependency, fully testable against a
fake API on a temporary socket.

**Files:**
- Create: `apps/daemon/src/cells/docker.ts`
- Test: `apps/daemon/src/cells/docker.test.ts`, `apps/daemon/src/cells/docker.docker.test.ts`

**Interfaces:**
- Produces: `DOCKER_API = "v1.47"`; `class DockerError extends Error { status: number; path: string }`
  (`status` 0 when the socket is unreachable); `interface DockerRequest { method: "GET"|"POST"|"DELETE"; path: string; query?: Record<string,string>; body?: unknown }`;
  `class DockerClient { constructor(socketPath?: string); request<T>(req: DockerRequest): Promise<T>; version(): Promise<DockerVersion> }`;
  `dockerSocketPath(env?)` (`DOCKER_HOST=unix://…` or `/var/run/docker.sock`);
  `interface DockerVersion { Version; ApiVersion; MinAPIVersion; Os; Arch }`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/cells/docker.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOCKER_API, DockerClient, DockerError, dockerSocketPath } from "./docker.ts";

interface Seen {
  method: string;
  url: string;
  body: string;
  contentType: string | undefined;
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function fakeDocker(
  reply: (seen: Seen) => { status: number; body?: unknown },
): Promise<{ socketPath: string; seen: Seen[] }> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "ld-docker-")), "d.sock");
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", body, contentType: req.headers["content-type"] };
      seen.push(s);
      const r = reply(s);
      if (r.body === undefined) {
        res.writeHead(r.status);
        res.end();
        return;
      }
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  const listening = server;
  await new Promise<void>((r) => listening.listen(socketPath, r));
  return { socketPath, seen };
}

describe("DockerClient", () => {
  it("sends JSON with the API version prefix and parses JSON replies", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({ status: 201, body: { Id: "abc", Warnings: [] } }));
    const out = await new DockerClient(socketPath).request<{ Id: string }>({
      method: "POST",
      path: "/networks/create",
      body: { Name: "n", Internal: true },
    });
    expect(out.Id).toBe("abc");
    expect(seen[0]).toMatchObject({ method: "POST", url: `/${DOCKER_API}/networks/create`, contentType: "application/json" });
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ Name: "n", Internal: true });
  });

  it("encodes query parameters and resolves undefined for empty replies", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({ status: 204 }));
    await expect(
      new DockerClient(socketPath).request({ method: "DELETE", path: "/containers/c1", query: { force: "true", v: "false" } }),
    ).resolves.toBeUndefined();
    expect(seen[0]?.url).toBe(`/${DOCKER_API}/containers/c1?force=true&v=false`);
  });

  it("turns error replies into DockerError carrying Docker's message", async () => {
    const { socketPath } = await fakeDocker(() => ({ status: 404, body: { message: "No such container: c1" } }));
    const err = await new DockerClient(socketPath).request({ method: "GET", path: "/containers/c1/json" }).catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 404, path: "/containers/c1/json" });
    expect((err as Error).message).toContain("No such container: c1");
  });

  it("reports an unreachable socket as DockerError 0", async () => {
    const err = await new DockerClient(join(tmpdir(), "ld-missing.sock")).version().catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(0);
    expect((err as Error).message).toContain("Docker Desktop");
  });

  it("reads the socket path from DOCKER_HOST", () => {
    expect(dockerSocketPath({})).toBe("/var/run/docker.sock");
    expect(dockerSocketPath({ DOCKER_HOST: "unix:///Users/me/.docker/run/docker.sock" })).toBe("/Users/me/.docker/run/docker.sock");
    expect(dockerSocketPath({ DOCKER_HOST: "tcp://1.2.3.4:2375" })).toBe("/var/run/docker.sock");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/daemon/src/cells/docker.test.ts`
Expected: FAIL — `Failed to load url ./docker.ts`.

- [ ] **Step 3: Implement the client**

`apps/daemon/src/cells/docker.ts`:
```ts
import { request as httpRequest } from "node:http";

// Engine 29.2 serves 1.53 and accepts 1.44+; 1.47 (Engine 27) is the oldest this code is written against.
export const DOCKER_API = "v1.47";

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(`docker ${status || "unreachable"} on ${path}: ${message}`);
    this.name = "DockerError";
  }
}

export interface DockerRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  MinAPIVersion: string;
  Os: string;
  Arch: string;
}

export function dockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  return "/var/run/docker.sock";
}

export class DockerClient {
  constructor(readonly socketPath: string = dockerSocketPath()) {}

  request<T = undefined>(req: DockerRequest): Promise<T> {
    const query = req.query ? `?${new URLSearchParams(req.query)}` : "";
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const path = `/${DOCKER_API}${req.path}${query}`;
    return new Promise<T>((resolve, reject) => {
      const r = httpRequest(
        {
          socketPath: this.socketPath,
          method: req.method,
          path,
          headers: {
            host: "docker",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              reject(new DockerError(status, messageOf(text), req.path));
              return;
            }
            const isJson = (res.headers["content-type"] ?? "").includes("application/json");
            resolve((isJson && text.length > 0 ? JSON.parse(text) : undefined) as T);
          });
        },
      );
      r.on("error", (err: NodeJS.ErrnoException) => {
        reject(new DockerError(0, `${err.code ?? err.message}; is Docker Desktop running?`, req.path));
      });
      if (body !== undefined) r.write(body);
      r.end();
    });
  }

  version(): Promise<DockerVersion> {
    return this.request<DockerVersion>({ method: "GET", path: "/version" });
  }
}

function messageOf(text: string): string {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text || "no message";
  }
}
```

`apps/daemon/src/cells/docker.docker.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DOCKER_API, DockerClient } from "./docker.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

describe.skipIf(!DOCKER_TESTS)("DockerClient against Docker Desktop", () => {
  it("negotiates the pinned API version", async () => {
    const v = await new DockerClient().version();
    const wanted = Number(DOCKER_API.slice(1));
    expect(Number(v.MinAPIVersion)).toBeLessThanOrEqual(wanted);
    expect(Number(v.ApiVersion)).toBeGreaterThanOrEqual(wanted);
    expect(v.Os).toBe("linux");
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/cells/docker.test.ts && LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/docker.docker.test.ts`
Expected: 5 unit tests pass; the Docker-backed test passes (`ApiVersion` 1.53, `MinAPIVersion` 1.44 on this Mac).

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells
git commit -m "feat(daemon): Docker Engine client over the Unix socket"
```

---
### Task 6a: Daemon lock residuals (Ruling 36, P2-R11)

Part 1's final re-review left four items on the single-writer lock: publish the lock with the pid
already inside (a temp file linked into place, never an empty lock), treat the daemon's own pid as a
stale holder (a lock left by a previous incarnation whose pid was recycled), handle `SIGHUP`, and
give a one-line message for a lock that cannot be read. This task closes them before any new daemon
code lands, along with the same re-review's two trivia: the ")" that SUMMARY D18's quote drops, and
the `export` on `DEFAULT_PORT`, which nothing imports.

**Files:**
- Modify: `apps/daemon/src/lock.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/port.ts`,
  `docs/spikes/SUMMARY.md`
- Test: `apps/daemon/src/lock.test.ts`

**Interfaces:**
- Produces: `acquireDaemonLock(file): () => void` (unchanged signature), `DaemonLockedError { pid }`,
  new `DaemonLockError` (unreadable lock or a directory at the path; message says what to do).
  `main.ts` exits on `SIGINT`, `SIGTERM` and `SIGHUP`, and its `lockHome` prints either error's
  message without a stack trace. `port.ts` keeps `DEFAULT_PORT` to itself (`parsePort` is unchanged).

- [ ] **Step 1: Rewrite the lock tests**

`apps/daemon/src/lock.test.ts` (replace the whole file):
```ts
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireDaemonLock, DaemonLockError, DaemonLockedError } from "./lock.ts";

// Above any pid macOS (99999) or Linux (2^22) hands out, so no process can hold it.
const DEAD_PID = 2 ** 31 - 1;

const tempHome = () => mkdtempSync(join(tmpdir(), "local dot's lock-"));

// A live process that is not this one, for the "someone else holds it" case.
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
afterAll(() => sleeper.kill());

describe("acquireDaemonLock", () => {
  it("creates the home and a 0600 lock that holds this process's pid the instant it returns", () => {
    const home = join(tempHome(), "home");
    const file = join(home, "daemon.lock");
    acquireDaemonLock(file);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readdirSync(home)).toEqual(["daemon.lock"]);
  });

  it("refuses to start while another live process holds the lock", () => {
    const file = join(tempHome(), "daemon.lock");
    writeFileSync(file, `${sleeper.pid}\n`);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockedError);
    expect(() => acquireDaemonLock(file)).toThrow(`another localdot daemon is running (pid ${sleeper.pid})`);
    expect(readFileSync(file, "utf8")).toBe(`${sleeper.pid}\n`);
  });

  it.each([
    ["a pid no process holds", `${DEAD_PID}\n`],
    ["no pid at all", ""],
    ["a pid that is not a number", "not-a-pid\n"],
    ["this process's own pid", `${process.pid}\n`],
  ])("replaces a stale lock holding %s and leaves no temp file", (_label, content) => {
    const home = tempHome();
    const file = join(home, "daemon.lock");
    writeFileSync(file, content);
    acquireDaemonLock(file);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
    expect(readdirSync(home)).toEqual(["daemon.lock"]);
  });

  it("releases by removing the lock, and a second release is harmless", () => {
    const file = join(tempHome(), "daemon.lock");
    const release = acquireDaemonLock(file);
    release();
    expect(existsSync(file)).toBe(false);
    release();
    acquireDaemonLock(file);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
  });

  it("never removes a lock that another daemon has taken since", () => {
    const file = join(tempHome(), "daemon.lock");
    const release = acquireDaemonLock(file);
    writeFileSync(file, `${DEAD_PID}\n`);
    release();
    expect(readFileSync(file, "utf8")).toBe(`${DEAD_PID}\n`);
  });

  it("explains a directory at the lock path in one line", () => {
    const file = join(tempHome(), "daemon.lock");
    mkdirSync(file);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockError);
    expect(() => acquireDaemonLock(file)).toThrow(`${file} is a directory; remove it or point LOCALDOT_HOME elsewhere`);
  });

  it.skipIf(process.getuid?.() === 0)("explains an unreadable lock in one line", () => {
    const file = join(tempHome(), "daemon.lock");
    writeFileSync(file, `${DEAD_PID}\n`);
    chmodSync(file, 0o000);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockError);
    expect(() => acquireDaemonLock(file)).toThrow(`cannot read ${file} (EACCES); fix its permissions or remove it`);
    chmodSync(file, 0o600);
  });
});
```

- [ ] **Step 2: Run them to see the new cases fail**

Run: `pnpm exec vitest run apps/daemon/src/lock.test.ts`
Expected: FAIL — `DaemonLockError` is not exported; "this process's own pid" expects a replacement
but gets `DaemonLockedError`.

- [ ] **Step 3: Rewrite the lock and the signal list**

`apps/daemon/src/lock.ts` (replace the whole file):
```ts
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class DaemonLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another localdot daemon is running (pid ${pid})`);
    this.name = "DaemonLockedError";
  }
}

export class DaemonLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonLockError";
  }
}

// One daemon per home. The pid is written to a private temp file that is linked into place, so no
// reader ever sees an empty lock. A holder that is dead, or this very process (a lock left by a
// previous incarnation whose pid was recycled), is stale and gets replaced.
export function acquireDaemonLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const content = `${process.pid}\n`;
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    if (!linkIfAbsent(temp, file)) {
      const holder = readHolder(file);
      if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
        throw new DaemonLockedError(holder);
      }
      renameSync(temp, file);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return () => {
    if (readPid(file) === process.pid) rmSync(file, { force: true });
  };
}

function linkIfAbsent(temp: string, file: string): boolean {
  try {
    linkSync(temp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// A directory or an unreadable file at the lock path is a setup problem, reported in one line.
function readHolder(file: string): number | undefined {
  let text: string;
  try {
    if (statSync(file).isDirectory()) {
      throw new DaemonLockError(`${file} is a directory; remove it or point LOCALDOT_HOME elsewhere`);
    }
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err instanceof DaemonLockError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new DaemonLockError(`cannot read ${file} (${code ?? String(err)}); fix its permissions or remove it`);
  }
  return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
}

function readPid(file: string): number | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

// Signal 0 only probes: EPERM means the process exists under another user.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
```

`apps/daemon/src/main.ts` — change the two places (the rest of the file is unchanged):
```ts
import { acquireDaemonLock, DaemonLockError, DaemonLockedError } from "./lock.ts";
// ...
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => process.exit(128 + constants.signals[signal]));
}
// ...
function lockHome(file: string): () => void {
  try {
    return acquireDaemonLock(file);
  } catch (err) {
    if (err instanceof DaemonLockedError) {
      return fail(`${err.message}; remove ${file} if that process is not localdot`);
    }
    if (err instanceof DaemonLockError) return fail(err.message);
    throw err;
  }
}
```

The two trivia. In `docs/spikes/SUMMARY.md`, D18's ledger quote ends `README.md 'Decision': C: Theatre"`,
but the ledger reads `README.md 'Decision'): C: Theatre`: restore the ")". In
`apps/daemon/src/port.ts`, `export const DEFAULT_PORT = 4750;` becomes `const DEFAULT_PORT = 4750;`
(`git grep -n DEFAULT_PORT` lists only `port.ts`).

- [ ] **Step 4: Run the lock tests and the daemon suites**

Run: `pnpm exec vitest run apps/daemon/src/lock.test.ts apps/daemon/src/app.test.ts apps/daemon/src/port.test.ts`
Expected: 10 lock tests pass (9 if running as root skips the unreadable case); the app and port tests
still pass.
Then start the daemon directly with node, which is how every harness and process manager must start
it (`pnpm … start` does not forward `SIGTERM` to the daemon). The subshell `exec`s node, so `$!` is
the daemon itself; port 4795 keeps it clear of a daemon already on 4750:
```bash
h="$(mktemp -d)/h"
(cd "/Volumes/Husky's SSD 4T/Projects/localdot/apps/daemon" && exec env LOCALDOT_PORT=4795 LOCALDOT_HOME="$h" node --import tsx src/main.ts) &
sleep 2; kill -HUP $!; wait $!; echo "exit $?"; ls -A "$h"
```
Expected: `exit 129` (128 + SIGHUP); `ls` shows the token and the event log, and no `daemon.lock`.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/lock.ts apps/daemon/src/lock.test.ts apps/daemon/src/main.ts apps/daemon/src/port.ts docs/spikes/SUMMARY.md
git commit -m "fix(daemon): publish the lock with its pid, treat own pid as stale, handle SIGHUP"
```

---
### Task 6b: Session metadata in the session folder (A19, P2-R15)

The SQLite index can be rebuilt from the session folders only if a session's title and start time
live there too. Each session gets a `session.json` next to its `events.jsonl`; recovery at startup
re-inserts the `sessions` row from it, so deleting `index.sqlite` loses nothing.

**Files:**
- Modify: `apps/daemon/src/event-log.ts`, `packages/protocol/src/ids.ts`
- Test: `apps/daemon/src/event-log.test.ts`, `packages/protocol/src/ids.test.ts`

**Interfaces:**
- Produces: `ulidTime(id: string): number` in `@localdot/protocol` (the ULID's millisecond timestamp);
  `<home>/sessions/<id>/session.json` = `{ "id", "title": string | null, "startedAt": ISO string }`,
  mode 0600, written before the index row; `EventLog` rebuilds `sessions` from these files at
  startup and derives the file from the ULID time for a folder that lacks it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/ids.test.ts`:
```ts
describe("ulidTime", () => {
  it("reads the millisecond timestamp back out of a ULID", () => {
    const now = 1_759_312_800_000;
    expect(ulidTime(ulid(now))).toBe(now);
    expect(ulidTime("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(1_469_922_850_259);
  });

  it("rejects strings that are not ULIDs", () => {
    expect(() => ulidTime("nope")).toThrow(RangeError);
  });
});
```
(add `ulidTime` to the existing import from `./ids.ts`.)

Append to `apps/daemon/src/event-log.test.ts`, inside `describe("EventLog")`:
```ts
  it("stores each session's title and start time in its folder", () => {
    const dir = home();
    const log = new EventLog(dir);
    const id = log.createSession("Compare flights");
    const file = join(dir, "sessions", id, "session.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const meta = JSON.parse(readFileSync(file, "utf8")) as { id: string; title: string | null; startedAt: string };
    expect(meta.id).toBe(id);
    expect(meta.title).toBe("Compare flights");
    expect(Number.isNaN(Date.parse(meta.startedAt))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "sessions", log.createSession(), "session.json"), "utf8")).title).toBeNull();
  });

  it("rebuilds the sessions index from the session folders", () => {
    const dir = home();
    const first = new EventLog(dir);
    const a = first.createSession("A");
    const b = first.createSession("B");
    first.append(a, thinking);
    first.append(a, idle);
    first.append(b, thinking);
    const before = first.listSessions();
    first.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(join(dir, `index.sqlite${suffix}`), { force: true });
    const second = new EventLog(dir);
    // A and B usually start in the same millisecond: listSessions breaks that tie by id, so the
    // order survives a rebuild, but B need not come before A.
    expect(second.listSessions()).toEqual(before);
    expect(new Map(second.listSessions().map((s) => [s.id, [s.title, s.events]]))).toEqual(
      new Map([
        [a, ["A", 2]],
        [b, ["B", 1]],
      ]),
    );
  });

  it("derives session.json from the ULID for a folder that lacks it", () => {
    const dir = home();
    const id = ulid(1_759_312_800_000);
    mkdirSync(join(dir, "sessions", id), { recursive: true });
    writeFileSync(join(dir, "sessions", id, "events.jsonl"), "");
    const log = new EventLog(dir);
    const meta = JSON.parse(readFileSync(join(dir, "sessions", id, "session.json"), "utf8")) as { title: string | null; startedAt: string };
    expect(meta).toEqual({ id, title: null, startedAt: "2025-10-01T10:00:00.000Z" });
    expect(log.listSessions().map((s) => s.id)).toContain(id);
  });
```
(add `rmSync` to the `node:fs` import at the top of the file.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/protocol/src/ids.test.ts apps/daemon/src/event-log.test.ts`
Expected: FAIL — `ulidTime` is not exported; `session.json` does not exist; the rebuilt index lists
no sessions.

- [ ] **Step 3: Implement**

Append to `packages/protocol/src/ids.ts`:
```ts
export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) throw new RangeError(`not a ULID: ${id}`);
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}
```

`apps/daemon/src/event-log.ts` — add the imports and the metadata helpers, and use them:
```ts
import { renameSync, rmSync, writeFileSync } from "node:fs";   // added to the existing node:fs import
import { randomBytes } from "node:crypto";
import { ulidTime } from "@localdot/protocol";                  // added to the existing protocol import

export interface SessionMeta {
  id: string;
  title: string | null;
  startedAt: string;
}
```
In `createSession`, write the file before the index row:
```ts
  createSession(title?: string): string {
    const id = ulid();
    const dir = join(this.#root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const meta: SessionMeta = { id, title: title ?? null, startedAt: new Date().toISOString() };
    writeMeta(dir, meta);
    this.#db
      .prepare("INSERT INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
      .run(id, meta.title, meta.startedAt);
    // ... the rest unchanged
  }
```
In `#stateOf`, right after `const file = this.#existingFileOf(sessionId);`, re-insert the session row
from the folder:
```ts
    const meta = readMeta(join(this.#root, sessionId), sessionId);
    this.#db
      .prepare("INSERT OR IGNORE INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
      .run(meta.id, meta.title, meta.startedAt);
```
And the two helpers at the bottom of the file:
```ts
function writeMeta(dir: string, meta: SessionMeta): void {
  const file = join(dir, "session.json");
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

// A folder without session.json predates this file: its ULID carries the start time.
function readMeta(dir: string, id: string): SessionMeta {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionMeta;
    if (meta.id === id && typeof meta.startedAt === "string") return meta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`session ${id}: unreadable session.json, deriving it: ${String(err)}`);
    }
  }
  const meta: SessionMeta = { id, title: null, startedAt: new Date(ulidTime(id)).toISOString() };
  writeMeta(dir, meta);
  return meta;
}
```

In `listSessions`, break ties on the start time by id, so the order is the same before and after a
rebuild (two sessions can start in the same millisecond):
```ts
        GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC
```

- [ ] **Step 4: Run the suites**

Run: `pnpm exec vitest run packages/protocol/src apps/daemon/src/event-log.test.ts apps/daemon/src/event-stream.test.ts apps/daemon/src/app.test.ts && pnpm --filter @localdot/protocol schema && git diff --exit-code packages/protocol/schema`
Expected: all pass; the exported JSON schema is unchanged (ids are not part of it).

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/protocol/src apps/daemon/src/event-log.ts apps/daemon/src/event-log.test.ts
git commit -m "feat(daemon): keep session metadata in the session folder and rebuild the index from it"
```

---
### Task 7: Cell records, per-cell tokens, stream tickets and keyd ports

**Files:**
- Create: `apps/daemon/src/cells/types.ts`, `apps/daemon/src/cells/store.ts`,
  `apps/daemon/src/cells/secrets.ts`, `apps/daemon/src/cells/ports.ts`,
  `apps/daemon/src/cells/testing/sample-record.ts`
- Test: `apps/daemon/src/cells/store.test.ts`, `apps/daemon/src/cells/secrets.test.ts`,
  `apps/daemon/src/cells/ports.test.ts`

**Interfaces:**
- Produces (`types.ts`): `Scale = 1 | 2`; `CellState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "removed"`;
  `StreamConnection = "none" | "connecting" | "live" | "stalled" | "disconnected"`;
  `StreamState { connection; viewers: number; lastUpstreamAt: number | null }`, `NO_STREAM`;
  `CellSummary { id; state; scale; createdAt; stream: StreamState; error?: string }`;
  `CellRecord { v: 1; id; createdAt; scale; keydPort; tokens: { desktopd; stream }; docker: CellDocker }`;
  `CellDocker { internalNetwork; egressNetwork; homeVolume; gate; desktop; gateInternalIp; gateEgressIp; desktopIp }`;
  `DesktopdEndpoint { baseUrl; token }`, `StreamEndpoint { baseUrl; authorization }`,
  `CellEndpoints { desktopd; stream }`; `DesktopdHealth` (the shape Task 5 serves).
- `class CellStore { constructor(home); list(): CellRecord[]; get(id): CellRecord | undefined; save(record); remove(id) }`
  — files `<home>/cells/<id>/cell.json`, 0600, written atomically.
- `newCellToken(): string` (43 chars base64url); `TICKET_PATTERN`;
  `class TicketRegistry { issue(cellId): string (returns the cell's live ticket while one exists); resolve(ticket): string | undefined (constant-time); revoke(cellId): void }`.
- `KEYD_PORT_RANGE = { from: 4760, to: 4789 }`; `allocateKeydPort(inUse: Iterable<number>): number`.

- [ ] **Step 1: Write the types**

`apps/daemon/src/cells/types.ts`:
```ts
export type Scale = 1 | 2;

export type CellState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "removed";

export type StreamConnection = "none" | "connecting" | "live" | "stalled" | "disconnected";

export interface StreamState {
  connection: StreamConnection;
  viewers: number;
  lastUpstreamAt: number | null;
}

export const NO_STREAM: StreamState = { connection: "none", viewers: 0, lastUpstreamAt: null };

export interface CellSummary {
  id: string;
  state: CellState;
  scale: Scale;
  createdAt: string;
  stream: StreamState;
  error?: string;
}

export interface CellDocker {
  internalNetwork: string;
  egressNetwork: string;
  homeVolume: string;
  gate: string;
  desktop: string;
  gateInternalIp: string;
  gateEgressIp: string;
  desktopIp: string;
}

export interface CellRecord {
  v: 1;
  id: string;
  createdAt: string;
  scale: Scale;
  keydPort: number;
  tokens: { desktopd: string; stream: string };
  docker: CellDocker;
}

export interface DesktopdEndpoint {
  baseUrl: string;
  token: string;
}

export interface StreamEndpoint {
  baseUrl: string;
  authorization: string;
}

export interface CellEndpoints {
  desktopd: DesktopdEndpoint;
  stream: StreamEndpoint;
}

// What desktopd's GET /healthz returns (cells/desktop/desktopd/src/app.ts).
export interface DesktopdHealth {
  ok: boolean;
  scale: Scale;
  display: string;
  screen: { w: number; h: number } | null;
  hidpi: {
    ok: boolean;
    expected: { windowScalingFactor: Scale; xftDpi: 96 };
    windowScalingFactor: number | null;
    xftDpi: number | null;
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/cells/testing/sample-record.ts` (a test helper shared by the store, spec and
orchestrator tests; it lives outside the `*.test.ts` files so importing it never re-registers tests):
```ts
import { ulid } from "@localdot/protocol";
import type { CellRecord } from "../types.ts";

export function sampleRecord(id = ulid(), createdAt = "2026-10-01T10:00:00.000Z"): CellRecord {
  return {
    v: 1,
    id,
    createdAt,
    scale: 2,
    keydPort: 4760,
    tokens: { desktopd: "d".repeat(43), stream: "s".repeat(43) },
    docker: {
      internalNetwork: `localdot-cell-${id}`,
      egressNetwork: `localdot-egress-${id}`,
      homeVolume: `localdot-home-${id}`,
      gate: `localdot-gate-${id}`,
      desktop: `localdot-desktop-${id}`,
      gateInternalIp: "172.24.0.10",
      gateEgressIp: "172.25.0.10",
      desktopIp: "172.24.0.11",
    },
  };
}
```

`apps/daemon/src/cells/store.test.ts`:
```ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const home = () => mkdtempSync(join(tmpdir(), "local dot's cells-"));

describe("CellStore", () => {
  it("round-trips a record through a 0600 file in a 0700 directory", () => {
    const dir = home();
    const store = new CellStore(dir);
    const record = sampleRecord();
    store.save(record);
    const file = join(dir, "cells", record.id, "cell.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cells")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    expect(store.get(record.id)).toEqual(record);
  });

  it("lists records oldest first and skips ids that are not ULIDs or files that are not records", () => {
    const dir = home();
    const store = new CellStore(dir);
    const older = sampleRecord(ulid(), "2026-10-01T09:00:00.000Z");
    const newer = sampleRecord(ulid(), "2026-10-01T11:00:00.000Z");
    store.save(newer);
    store.save(older);
    const bad = sampleRecord();
    store.save(bad);
    writeFileSync(join(dir, "cells", bad.id, "cell.json"), "{not json");
    expect(store.list().map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(store.get("../etc")).toBeUndefined();
    expect(store.get(bad.id)).toBeUndefined();
  });

  it("removes a cell directory and refuses invalid ids", () => {
    const store = new CellStore(home());
    const record = sampleRecord();
    store.save(record);
    store.remove(record.id);
    expect(store.get(record.id)).toBeUndefined();
    expect(() => store.remove("../..")).toThrow("invalid cell id");
  });
});
```

`apps/daemon/src/cells/secrets.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newCellToken, TICKET_PATTERN, TicketRegistry } from "./secrets.ts";

describe("cell secrets", () => {
  it("mints 43-character base64url tokens that differ", () => {
    const a = newCellToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCellToken()).not.toBe(a);
  });

  it("keeps one live ticket per cell, resolves it, and revokes per cell", () => {
    const tickets = new TicketRegistry();
    const t1 = tickets.issue("cell-a");
    const t2 = tickets.issue("cell-b");
    expect(t1).toMatch(TICKET_PATTERN);
    expect(tickets.issue("cell-a")).toBe(t1);
    expect(tickets.resolve(t1)).toBe("cell-a");
    expect(tickets.resolve(t2)).toBe("cell-b");
    expect(tickets.resolve("nope")).toBeUndefined();
    expect(tickets.resolve(`${t1}x`)).toBeUndefined();
    const flipped = `${t1.slice(0, 21)}${t1.endsWith("A") ? "B" : "A"}`;
    expect(tickets.resolve(flipped)).toBeUndefined();
    tickets.revoke("cell-a");
    expect(tickets.resolve(t1)).toBeUndefined();
    expect(tickets.resolve(t2)).toBe("cell-b");
    expect(tickets.issue("cell-a")).not.toBe(t1);
  });
});
```

`apps/daemon/src/cells/ports.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { allocateKeydPort, KEYD_PORT_RANGE } from "./ports.ts";

describe("allocateKeydPort", () => {
  it("hands out the lowest free listener port in 4760-4789", () => {
    expect(allocateKeydPort([])).toBe(4760);
    expect(allocateKeydPort([4760, 4761])).toBe(4762);
    expect(allocateKeydPort([4760, 4762])).toBe(4761);
  });

  it("fails when the range is exhausted", () => {
    const all: number[] = [];
    for (let p = KEYD_PORT_RANGE.from; p <= KEYD_PORT_RANGE.to; p++) all.push(p);
    expect(() => allocateKeydPort(all)).toThrow("no free keyd listener port");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/cells/store.test.ts apps/daemon/src/cells/secrets.test.ts apps/daemon/src/cells/ports.test.ts`
Expected: FAIL — three `Failed to load url` errors.

- [ ] **Step 4: Implement the three modules**

`apps/daemon/src/cells/store.ts`:
```ts
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";
import type { CellRecord } from "./types.ts";

// One cell.json per cell under <home>/cells/<id>/, mode 0600: it holds the per-cell tokens.
export class CellStore {
  readonly #root: string;

  constructor(home: string) {
    this.#root = join(home, "cells");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }

  list(): CellRecord[] {
    return readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ULID_PATTERN.test(entry.name))
      .flatMap((entry) => {
        const record = this.get(entry.name);
        return record ? [record] : [];
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): CellRecord | undefined {
    if (!ULID_PATTERN.test(id)) return undefined;
    let text: string;
    try {
      text = readFileSync(this.#file(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      const record = JSON.parse(text) as CellRecord;
      return record.v === 1 && record.id === id ? record : undefined;
    } catch (err) {
      console.error(`cell ${id}: unreadable record: ${String(err)}`);
      return undefined;
    }
  }

  save(record: CellRecord): void {
    mkdirSync(join(this.#root, record.id), { recursive: true, mode: 0o700 });
    const file = this.#file(record.id);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  remove(id: string): void {
    if (!ULID_PATTERN.test(id)) throw new Error("invalid cell id");
    rmSync(join(this.#root, id), { recursive: true, force: true });
  }

  #file(id: string): string {
    return join(this.#root, id, "cell.json");
  }
}
```

`apps/daemon/src/cells/secrets.ts`:
```ts
import { randomBytes, timingSafeEqual } from "node:crypto";

export function newCellToken(): string {
  return randomBytes(32).toString("base64url");
}

export const TICKET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// A stream ticket lets the Selkies iframe, which can carry no Authorization header, open one
// cell's stream path (P2-R2): one live ticket per cell, 128 random bits, kept in memory only (a
// daemon restart revokes every ticket), compared in constant time, never logged. The ticket itself
// is kept so the API can hand the same one back while the cell stays ready.
export class TicketRegistry {
  readonly #byCell = new Map<string, string>();

  issue(cellId: string): string {
    const live = this.#byCell.get(cellId);
    if (live !== undefined) return live;
    const ticket = randomBytes(16).toString("base64url");
    this.#byCell.set(cellId, ticket);
    return ticket;
  }

  resolve(ticket: string): string | undefined {
    if (!TICKET_PATTERN.test(ticket)) return undefined;
    const given = Buffer.from(ticket);
    for (const [cellId, live] of this.#byCell) {
      if (timingSafeEqual(given, Buffer.from(live))) return cellId;
    }
    return undefined;
  }

  revoke(cellId: string): void {
    this.#byCell.delete(cellId);
  }
}
```

`apps/daemon/src/cells/ports.ts`:
```ts
export const KEYD_PORT_RANGE = { from: 4760, to: 4789 } as const;

// Each cell gets its own keyd listener port; the gate relays to it and keyd knows the cell by it.
export function allocateKeydPort(inUse: Iterable<number>): number {
  const used = new Set(inUse);
  for (let port = KEYD_PORT_RANGE.from; port <= KEYD_PORT_RANGE.to; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`no free keyd listener port in ${KEYD_PORT_RANGE.from}-${KEYD_PORT_RANGE.to}`);
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/cells/store.test.ts apps/daemon/src/cells/secrets.test.ts apps/daemon/src/cells/ports.test.ts`
Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells
git commit -m "feat(daemon): cell records, per-cell tokens, tickets and keyd ports"
```

---
### Task 8: Container specs and the cell orchestrator

**Files:**
- Create: `apps/daemon/src/cells/images.ts`, `apps/daemon/src/cells/spec.ts`,
  `apps/daemon/src/cells/readiness.ts`, `apps/daemon/src/cells/orchestrator.ts`,
  `apps/daemon/src/cells/testing/fake-docker.ts`
- Test: `apps/daemon/src/cells/spec.test.ts`, `apps/daemon/src/cells/orchestrator.test.ts`,
  `apps/daemon/src/cells/orchestrator.docker.test.ts`

**Interfaces:**
- Consumes: `DockerClient`, `DockerError` (Task 6); `CellStore`, `newCellToken`, `allocateKeydPort`,
  the types (Task 7); `hostAddress` (Task 1).
- Produces: `imagesFromEnv(env?): Images` (`LOCALDOT_DESKTOP_IMAGE`, `LOCALDOT_GATE_IMAGE`, defaults
  `localdot/desktop:dev`, `localdot/gate:dev`); pure spec builders `cellNames(id, prefix = NAME_PREFIX)`
  (`NAME_PREFIX = "localdot-"`), `isolatedNetworkSpec(name)` (internal, isolated gateway mode, no
  labels), `internalNetworkSpec(name)` (the same plus the `localdot.cell` label),
  `egressNetworkSpec(name)`, `homeVolumeSpec(name)`,
  `gateSpec(record, image)`, `desktopSpec(record, image)`, `desktopEnv(record)`, constants
  `GATE_OFFSET = 10`, `DESKTOP_OFFSET = 11`, `GATE_PORTS`, `DESKTOP_LIMITS`, `DESKTOPD_PORT = 7700`,
  `SELKIES_PORT = 3000`; `probeDesktopd(endpoint)`, `probeStream(endpoint)`;
  `class CellOrchestrator { list(); get(id); record(id); endpoints(id): CellEndpoints | undefined; create({scale}); start(id); stop(id); remove(id, {purgeHome?}); reconcile(); subscribe(listener); updateStream(id, patch); dispose() }`
  (deps also take `namePrefix` = `"localdot-"`, which the Docker test sets to `"localdot-test-"`,
  `watchEveryMs` = 5000 and `restartBackoffMs` = [2000, 4000, 8000, 16000, 30000]:
  a ready cell is watched, an exited container is restarted with that backoff and its ports re-read,
  and the cell fails once the list is exhausted; a stop, a remove or a newer start that lands while
  a watch, readiness or start loop awaits wins, and that loop ends without touching the cell's
  state; `create` reserves the keyd port before its first await), `UnknownCellError`,
  `endpointsFor(record, ports)`.

- [ ] **Step 1: Write the failing spec test**

`apps/daemon/src/cells/spec.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  cellNames,
  DESKTOP_LIMITS,
  desktopSpec,
  egressNetworkSpec,
  gateSpec,
  ISOLATED_GATEWAY_OPTION,
  internalNetworkSpec,
  isolatedNetworkSpec,
} from "./spec.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const record = sampleRecord("01JXYZ0000000000000000ABCD");

describe("network specs", () => {
  it("creates every cell network internal with isolated gateway mode", () => {
    expect(internalNetworkSpec("n")).toMatchObject({
      Name: "n",
      Driver: "bridge",
      Internal: true,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
      Labels: { "localdot.cell": "1" },
    });
    expect(isolatedNetworkSpec("p")).toEqual({
      Name: "p",
      Driver: "bridge",
      Internal: true,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
    });
    expect(egressNetworkSpec("e")).toMatchObject({ Name: "e", Driver: "bridge" });
    expect((egressNetworkSpec("e") as { Internal?: boolean }).Internal).toBeUndefined();
  });

  it("derives every Docker object name from the cell id and the name prefix", () => {
    expect(cellNames("X")).toEqual({
      internalNetwork: "localdot-cell-X",
      egressNetwork: "localdot-egress-X",
      homeVolume: "localdot-home-X",
      gate: "localdot-gate-X",
      desktop: "localdot-desktop-X",
    });
    expect(cellNames("X", "localdot-test-").desktop).toBe("localdot-test-desktop-X");
  });
});

describe("gateSpec", () => {
  const spec = gateSpec(record, "localdot/gate:dev");

  it("is read-only, unprivileged, capability-free and bound to 127.0.0.1", () => {
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: record.docker.egressNetwork,
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      PortBindings: {
        "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
    });
    expect("Binds" in spec.HostConfig).toBe(false);
    expect("RestartPolicy" in spec.HostConfig).toBe(false);
    expect(spec.NetworkingConfig.EndpointsConfig[record.docker.egressNetwork]).toEqual({
      IPAMConfig: { IPv4Address: "172.25.0.10" },
    });
  });

  it("tells the relays their addresses and the cell's keyd port", () => {
    expect(spec.Env).toEqual([
      "LD_INTERNAL_ADDR=172.24.0.10",
      "LD_EGRESS_ADDR=172.25.0.10",
      "LD_DESKTOP_ADDR=172.24.0.11",
      "LD_KEYD_PORT=4760",
    ]);
  });
});

describe("desktopSpec", () => {
  const spec = desktopSpec(record, "localdot/desktop:dev");

  it("drops NET_RAW, keeps sudo possible, limits resources and mounts only the named home volume", () => {
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: record.docker.internalNetwork,
      CapDrop: ["NET_RAW"],
      Mounts: [{ Type: "volume", Source: record.docker.homeVolume, Target: "/config" }],
      ShmSize: DESKTOP_LIMITS.shmBytes,
      Memory: DESKTOP_LIMITS.memoryBytes,
      MemorySwap: DESKTOP_LIMITS.memoryBytes,
      NanoCpus: DESKTOP_LIMITS.nanoCpus,
      PidsLimit: DESKTOP_LIMITS.pids,
    });
    expect("Binds" in spec.HostConfig).toBe(false);
    expect("SecurityOpt" in spec.HostConfig).toBe(false);
    expect("CapAdd" in spec.HostConfig).toBe(false);
    expect("RestartPolicy" in spec.HostConfig).toBe(false);
    expect(spec.NetworkingConfig.EndpointsConfig[record.docker.internalNetwork]).toEqual({
      IPAMConfig: { IPv4Address: "172.24.0.11" },
    });
  });

  it("passes only the per-cell tokens and the scale into the container", () => {
    const keys = spec.Env.map((e) => e.split("=")[0]);
    expect(keys).toEqual([
      "PUID", "PGID", "TZ", "LOCALDOT_SCALE", "SELKIES_MANUAL_WIDTH", "SELKIES_MANUAL_HEIGHT",
      "LOCALDOT_DESKTOPD_TOKEN", "PASSWORD",
    ]);
    expect(spec.Env).toContain(`LOCALDOT_DESKTOPD_TOKEN=${record.tokens.desktopd}`);
    expect(spec.Env).toContain(`PASSWORD=${record.tokens.stream}`);
    expect(spec.Env).toContain("SELKIES_MANUAL_WIDTH=2560");
    expect(desktopSpec({ ...record, scale: 1 }, "i").Env).toContain("SELKIES_MANUAL_HEIGHT=800");
  });
});
```

- [ ] **Step 2: Run it to see it fail, then implement the specs**

Run: `pnpm exec vitest run apps/daemon/src/cells/spec.test.ts`
Expected: FAIL — `Failed to load url ./spec.ts`.

`apps/daemon/src/cells/images.ts`:
```ts
export interface Images {
  desktop: string;
  gate: string;
}

export function imagesFromEnv(env: NodeJS.ProcessEnv = process.env): Images {
  return {
    desktop: env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev",
    gate: env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev",
  };
}
```

`apps/daemon/src/cells/spec.ts`:
```ts
import type { CellRecord } from "./types.ts";

export const ISOLATED_GATEWAY_OPTION = "com.docker.network.bridge.gateway_mode_ipv4";
export const GATE_OFFSET = 10;
export const DESKTOP_OFFSET = 11;
export const DESKTOPD_PORT = 7700;
export const SELKIES_PORT = 3000;
export const GATE_PORTS = { desktopd: "8081/tcp", stream: "8082/tcp" } as const;
export const DESKTOP_LIMITS = {
  memoryBytes: 4 * 1024 ** 3,
  nanoCpus: 4_000_000_000,
  pids: 4096,
  shmBytes: 1024 ** 3,
} as const;
export const NAME_PREFIX = "localdot-";
const LABELS = { "localdot.cell": "1" };

export function cellNames(id: string, prefix = NAME_PREFIX) {
  return {
    internalNetwork: `${prefix}cell-${id}`,
    egressNetwork: `${prefix}egress-${id}`,
    homeVolume: `${prefix}home-${id}`,
    gate: `${prefix}gate-${id}`,
    desktop: `${prefix}desktop-${id}`,
  };
}

// Plain --internal still exposes Docker Desktop VM listeners on the bridge gateway (S3, D14).
export function isolatedNetworkSpec(name: string) {
  return {
    Name: name,
    Driver: "bridge",
    Internal: true,
    Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
  };
}

export function internalNetworkSpec(name: string) {
  return { ...isolatedNetworkSpec(name), Labels: LABELS };
}

export function egressNetworkSpec(name: string) {
  return { Name: name, Driver: "bridge", Labels: LABELS };
}

export function homeVolumeSpec(name: string) {
  return { Name: name, Labels: LABELS };
}

export function gateSpec(record: CellRecord, image: string) {
  const d = record.docker;
  return {
    Image: image,
    Env: [
      `LD_INTERNAL_ADDR=${d.gateInternalIp}`,
      `LD_EGRESS_ADDR=${d.gateEgressIp}`,
      `LD_DESKTOP_ADDR=${d.desktopIp}`,
      `LD_KEYD_PORT=${record.keydPort}`,
    ],
    Labels: { "localdot.cell": record.id, "localdot.role": "gate" },
    ExposedPorts: { [GATE_PORTS.desktopd]: {}, [GATE_PORTS.stream]: {} },
    HostConfig: {
      NetworkMode: d.egressNetwork,
      PortBindings: {
        [GATE_PORTS.desktopd]: [{ HostIp: "127.0.0.1", HostPort: "" }],
        [GATE_PORTS.stream]: [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 64 * 1024 ** 2,
      PidsLimit: 64,
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.egressNetwork]: { IPAMConfig: { IPv4Address: d.gateEgressIp } } },
    },
  };
}

export function desktopEnv(record: CellRecord): string[] {
  const [w, h] = record.scale === 2 ? [2560, 1600] : [1280, 800];
  return [
    "PUID=1000",
    "PGID=1000",
    "TZ=Etc/UTC",
    `LOCALDOT_SCALE=${record.scale}`,
    `SELKIES_MANUAL_WIDTH=${w}`,
    `SELKIES_MANUAL_HEIGHT=${h}`,
    `LOCALDOT_DESKTOPD_TOKEN=${record.tokens.desktopd}`,
    `PASSWORD=${record.tokens.stream}`,
  ];
}

// The desktop keeps the default capability set minus NET_RAW and no no-new-privileges: the agent
// installs software with passwordless sudo (spec, Hardening). Neither container gets a Docker
// restart policy: the orchestrator restarts them itself and re-reads the ports (P2-R14).
export function desktopSpec(record: CellRecord, image: string) {
  const d = record.docker;
  return {
    Image: image,
    Env: desktopEnv(record),
    Labels: { "localdot.cell": record.id, "localdot.role": "desktop" },
    HostConfig: {
      NetworkMode: d.internalNetwork,
      Mounts: [{ Type: "volume", Source: d.homeVolume, Target: "/config" }],
      CapDrop: ["NET_RAW"],
      ShmSize: DESKTOP_LIMITS.shmBytes,
      Memory: DESKTOP_LIMITS.memoryBytes,
      MemorySwap: DESKTOP_LIMITS.memoryBytes,
      NanoCpus: DESKTOP_LIMITS.nanoCpus,
      PidsLimit: DESKTOP_LIMITS.pids,
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.internalNetwork]: { IPAMConfig: { IPv4Address: d.desktopIp } } },
    },
  };
}
```

Run: `pnpm exec vitest run apps/daemon/src/cells/spec.test.ts`
Expected: 6 tests pass.

- [ ] **Step 3: Write the fake Docker API for the orchestrator tests**

`apps/daemon/src/cells/testing/fake-docker.ts` — an HTTP server on a temporary Unix socket that
implements the subset of the Engine API the orchestrator and `doctor` use, with in-memory state the
tests can read and mutate:
```ts
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeContainer {
  name: string;
  body: { Image: string; HostConfig: Record<string, unknown>; NetworkingConfig?: { EndpointsConfig: Record<string, unknown> } };
  running: boolean;
  exitCode: number;
  starts: number;
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  networks: Record<string, unknown>;
}

export interface FakeNetwork {
  Id: string;
  Name: string;
  Internal: boolean;
  Options: Record<string, string>;
  subnet: string;
}

export interface FakeDockerState {
  version: { Version: string; ApiVersion: string; MinAPIVersion: string; Os: string; Arch: string };
  images: Set<string>;
  networks: Map<string, FakeNetwork>;
  volumes: Set<string>;
  containers: Map<string, FakeContainer>;
  calls: { method: string; path: string; query: URLSearchParams; body: unknown }[];
  nextPort: number;
  // An engine that ignores isolated gateway mode reports a gateway on internal networks.
  gatewayOnInternal: boolean;
  failCreate: Set<string>;
}

export interface FakeDocker {
  socketPath: string;
  state: FakeDockerState;
  close(): Promise<void>;
}

const json = (status: number, body: unknown) => ({ status, body });
const notFound = (what: string) => json(404, { message: `No such ${what}` });

export async function startFakeDocker(overrides: Partial<FakeDockerState> = {}): Promise<FakeDocker> {
  const state: FakeDockerState = {
    version: { Version: "29.2.0", ApiVersion: "1.53", MinAPIVersion: "1.44", Os: "linux", Arch: "arm64" },
    images: new Set(["localdot/desktop:dev", "localdot/gate:dev"]),
    networks: new Map(),
    volumes: new Set(),
    containers: new Map(),
    calls: [],
    nextPort: 50000,
    gatewayOnInternal: false,
    failCreate: new Set(),
    ...overrides,
  };
  let networkSeq = 20;

  // failCreate holds name prefixes: cell object names carry the (unpredictable) cell id.
  const failsCreate = (name: string) => [...state.failCreate].some((prefix) => name.startsWith(prefix));
  const findNetwork = (ref: string) =>
    state.networks.get(ref) ?? [...state.networks.values()].find((n) => n.Id === ref);
  const containerJson = (c: FakeContainer) => ({
    Id: `id-${c.name}`,
    Name: `/${c.name}`,
    State: { Running: c.running, ExitCode: c.exitCode, Error: "" },
    HostConfig: c.body.HostConfig,
    NetworkSettings: { Ports: c.running ? c.ports : {}, Networks: c.networks },
  });

  function handle(method: string, path: string, query: URLSearchParams, body: unknown): { status: number; body?: unknown } {
    if (method === "GET" && path === "/version") return json(200, state.version);
    const image = /^\/images\/(.+)\/json$/.exec(path);
    if (method === "GET" && image) {
      return state.images.has(decodeURIComponent(image[1] ?? "")) ? json(200, { Id: "sha256:img" }) : notFound("image");
    }
    if (method === "POST" && path === "/networks/create") {
      const spec = body as { Name: string; Internal?: boolean; Options?: Record<string, string> };
      if (failsCreate(spec.Name)) return json(500, { message: `refusing to create ${spec.Name}` });
      networkSeq += 1;
      const net: FakeNetwork = { Id: `net-${networkSeq}`, Name: spec.Name, Internal: spec.Internal ?? false, Options: spec.Options ?? {}, subnet: `172.${networkSeq}.0.0/16` };
      state.networks.set(net.Name, net);
      return json(201, { Id: net.Id, Warning: "" });
    }
    const network = /^\/networks\/([^/]+)$/.exec(path);
    if (network) {
      const net = findNetwork(network[1] ?? "");
      if (!net) return notFound("network");
      if (method === "DELETE") {
        state.networks.delete(net.Name);
        return { status: 204 };
      }
      const isolated = net.Internal && net.Options["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated";
      const gateway = isolated && !state.gatewayOnInternal ? {} : { Gateway: net.subnet.replace(/0\/16$/, "1") };
      return json(200, { Id: net.Id, Name: net.Name, Internal: net.Internal, Options: net.Options, IPAM: { Config: [{ Subnet: net.subnet, ...gateway }] } });
    }
    const connect = /^\/networks\/([^/]+)\/connect$/.exec(path);
    if (method === "POST" && connect) {
      const net = findNetwork(connect[1] ?? "");
      const { Container, EndpointConfig } = body as { Container: string; EndpointConfig?: unknown };
      const c = state.containers.get(Container);
      if (!net || !c) return notFound("network or container");
      if (net.Name in c.networks) return json(403, { message: "endpoint already exists" });
      c.networks[net.Name] = EndpointConfig ?? {};
      return { status: 200 };
    }
    if (method === "POST" && path === "/volumes/create") {
      state.volumes.add((body as { Name: string }).Name);
      return json(201, { Name: (body as { Name: string }).Name });
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === "DELETE" && volume) {
      return state.volumes.delete(volume[1] ?? "") ? { status: 204 } : notFound("volume");
    }
    if (method === "POST" && path === "/containers/create") {
      const name = query.get("name") ?? "";
      if (failsCreate(name)) return json(500, { message: `refusing to create ${name}` });
      const spec = body as FakeContainer["body"];
      const networks: Record<string, unknown> = {};
      for (const [net, cfg] of Object.entries(spec.NetworkingConfig?.EndpointsConfig ?? {})) networks[net] = cfg;
      state.containers.set(name, { name, body: spec, running: false, exitCode: 0, starts: 0, ports: {}, networks });
      return json(201, { Id: `id-${name}`, Warnings: [] });
    }
    const action = /^\/containers\/([^/]+)\/(json|start|stop)$/.exec(path);
    if (action) {
      const c = state.containers.get(action[1] ?? "");
      if (!c) return notFound("container");
      if (action[2] === "json") return json(200, containerJson(c));
      if (action[2] === "start") {
        if (c.running) return { status: 304 };
        c.starts += 1;
        c.running = true;
        c.ports = {};
        for (const port of Object.keys((c.body.HostConfig.PortBindings as Record<string, unknown>) ?? {})) {
          c.ports[port] = [{ HostIp: "127.0.0.1", HostPort: String(state.nextPort++) }];
        }
        return { status: 204 };
      }
      if (!c.running) return { status: 304 };
      c.running = false;
      c.exitCode = 0;
      return { status: 204 };
    }
    const container = /^\/containers\/([^/]+)$/.exec(path);
    if (method === "DELETE" && container) {
      return state.containers.delete(container[1] ?? "") ? { status: 204 } : notFound("container");
    }
    return json(404, { message: `fake docker: no route ${method} ${path}` });
  }

  const socketPath = join(mkdtempSync(join(tmpdir(), "ld-fake-docker-")), "d.sock");
  const server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://docker");
      const path = url.pathname.replace(/^\/v1\.\d+/, "");
      const body = text ? JSON.parse(text) : undefined;
      state.calls.push({ method: req.method ?? "", path, query: url.searchParams, body });
      const out = handle(req.method ?? "", path, url.searchParams, body);
      if (out.body === undefined) {
        res.writeHead(out.status);
        res.end();
        return;
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 4: Write the failing orchestrator test**

`apps/daemon/src/cells/orchestrator.test.ts`:
```ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator, UnknownCellError } from "./orchestrator.ts";
import { ISOLATED_GATEWAY_OPTION } from "./spec.ts";
import { CellStore } from "./store.ts";
import { type FakeDocker, startFakeDocker } from "./testing/fake-docker.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { CellSummary, DesktopdHealth } from "./types.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
const healthy: DesktopdHealth = {
  ok: true,
  scale: 2,
  display: ":1",
  screen: { w: 2560, h: 1600 },
  hidpi: { ok: true, expected: { windowScalingFactor: 2, xftDpi: 96 }, windowScalingFactor: 2, xftDpi: 96 },
};

let fake: FakeDocker;
const made: CellOrchestrator[] = [];
afterEach(async () => {
  for (const o of made.splice(0)) o.dispose();
  await fake?.close();
});

// The default probe answers like a real desktop: healthy only while the fake container runs.
const runningDesktop = (store: CellStore) => () => {
  const names = store.list().map((r) => r.docker.desktop);
  return names.every((n) => fake.state.containers.get(n)?.running) ? healthy : undefined;
};

async function setup(
  opts: {
    desktopd?: (store: CellStore) => () => DesktopdHealth | undefined;
    stream?: () => boolean;
    readyTimeoutMs?: number;
    restartBackoffMs?: number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  fake = await startFakeDocker();
  const home = mkdtempSync(join(tmpdir(), "local dot's orch-"));
  const store = new CellStore(home);
  const changes: CellSummary[] = [];
  const probe = (opts.desktopd ?? runningDesktop)(store);
  const orchestrator = new CellOrchestrator({
    docker: new DockerClient(fake.socketPath),
    store,
    images,
    probeDesktopd: async () => probe(),
    probeStream: async () => (opts.stream ?? (() => true))(),
    sleep: opts.sleep ?? (async () => {}),
    readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
    watchEveryMs: 0,
    restartBackoffMs: opts.restartBackoffMs ?? [0, 0],
  });
  made.push(orchestrator);
  orchestrator.subscribe((cell) => changes.push(cell));
  const stateOf = (id: string, state: CellSummary["state"]) =>
    new Promise<CellSummary>((resolve) => {
      const hit = changes.find((c) => c.id === id && c.state === state);
      if (hit) return resolve(hit);
      orchestrator.subscribe((cell) => {
        if (cell.id === id && cell.state === state) resolve(cell);
      });
    });
  return { orchestrator, store, home, changes, stateOf };
}

describe("CellOrchestrator.create", () => {
  it("provisions networks, volume and hardened containers, then reaches ready", async () => {
    const { orchestrator, store, home, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    expect(cell.state).toBe("starting");
    await stateOf(cell.id, "ready");

    const record = store.get(cell.id);
    expect(record).toBeDefined();
    expect(statSync(join(home, "cells", cell.id, "cell.json")).mode & 0o777).toBe(0o600);
    expect(record?.keydPort).toBe(4760);
    expect(record?.docker).toMatchObject({
      gateInternalIp: "172.21.0.10",
      desktopIp: "172.21.0.11",
      gateEgressIp: "172.22.0.10",
    });

    const internal = fake.state.networks.get(record?.docker.internalNetwork ?? "");
    expect(internal).toMatchObject({ Internal: true, Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" } });
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(true);

    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    expect(gate?.body.HostConfig).toMatchObject({ CapDrop: ["ALL"], ReadonlyRootfs: true });
    expect(gate?.networks).toEqual({
      [record?.docker.egressNetwork ?? ""]: { IPAMConfig: { IPv4Address: "172.22.0.10" } },
      [record?.docker.internalNetwork ?? ""]: { IPAMConfig: { IPv4Address: "172.21.0.10" } },
    });
    expect(desktop?.body.HostConfig).toMatchObject({ CapDrop: ["NET_RAW"] });
    expect(desktop?.running).toBe(true);

    const order = fake.state.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`POST /containers/${record?.docker.gate}/start`)).toBeLessThan(
      order.indexOf(`POST /networks/${record?.docker.internalNetwork}/connect`),
    );
    expect(order.indexOf(`POST /networks/${record?.docker.internalNetwork}/connect`)).toBeLessThan(
      order.indexOf(`POST /containers/${record?.docker.desktop}/start`),
    );

    const endpoints = orchestrator.endpoints(cell.id);
    expect(endpoints?.desktopd).toEqual({ baseUrl: "http://127.0.0.1:50000", token: record?.tokens.desktopd });
    expect(endpoints?.stream).toEqual({
      baseUrl: "http://127.0.0.1:50001",
      authorization: `Basic ${Buffer.from(`localdot:${record?.tokens.stream}`).toString("base64")}`,
    });
  });

  it("undoes everything when the desktop container cannot be created", async () => {
    const { orchestrator, store } = await setup();
    fake.state.failCreate.add("localdot-desktop-");
    const err = await orchestrator.create({ scale: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("refusing to create");
    expect(store.list()).toEqual([]);
    expect(fake.state.networks.size).toBe(0);
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.volumes.size).toBe(0);
  });
});

describe("CellOrchestrator lifecycle", () => {
  it("reads new ports after a stop and start and connects the internal network only once", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    await orchestrator.stop(cell.id);
    expect(orchestrator.get(cell.id)?.state).toBe("stopped");
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    const after = orchestrator.endpoints(cell.id);
    expect(after?.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
    const record = store.get(cell.id);
    const connects = fake.state.calls.filter((c) => c.path === `/networks/${record?.docker.internalNetwork}/connect`);
    expect(connects).toHaveLength(1);
  });

  it("fails with the exit code when the desktop container dies while starting", async () => {
    const { orchestrator, store, stateOf } = await setup({ desktopd: () => () => undefined });
    const cell = await orchestrator.create({ scale: 2 });
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toContain("exited with 137");
  });

  it("fails with the last detail when readiness times out", async () => {
    const { orchestrator, stateOf } = await setup({ desktopd: () => () => ({ ...healthy, ok: false }), readyTimeoutMs: 30 });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toMatch(/not ready after/);
    expect(failed.error).toContain("desktopd not ready");
  });

  it("removes containers and networks, keeps the home volume unless purged, and emits removed", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    await orchestrator.remove(cell.id);
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.networks.size).toBe(0);
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(true);
    expect(store.get(cell.id)).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({ id: cell.id, state: "removed" });
    await expect(orchestrator.remove(cell.id)).rejects.toBeInstanceOf(UnknownCellError);
  });

  it("purges the home volume on request", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    await orchestrator.remove(cell.id, { purgeHome: true });
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(false);
  });
});

describe("CellOrchestrator restarts", () => {
  it("restarts an exited desktop with backoff and keeps the gate's published ports", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () =>
        changes.some((c) => c.id === cell.id && c.state === "starting" && (c.error ?? "").includes("restarting (attempt 1 of 2)"))
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    await new Promise<void>((resolve) => {
      const check = () => (desktop?.starts === 2 && orchestrator.get(cell.id)?.state === "ready" ? resolve() : setTimeout(check, 5));
      check();
    });
    expect(orchestrator.endpoints(cell.id)).toEqual(before);
    expect(orchestrator.get(cell.id)?.error).toBeUndefined();
  });

  it("restarts an exited gate with backoff and reads its new published ports", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    const record = store.get(cell.id);
    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    if (gate) {
      gate.running = false;
      gate.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () => (gate?.starts === 2 && orchestrator.get(cell.id)?.state === "ready" ? resolve() : setTimeout(check, 5));
      check();
    });
    const after = orchestrator.endpoints(cell.id);
    expect(after?.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
    expect(after?.stream.baseUrl).not.toBe(before?.stream.baseUrl);
    expect(orchestrator.get(cell.id)?.error).toBeUndefined();
  });

  it("gives up once the backoff list is exhausted, even across recoveries", async () => {
    const { orchestrator, store, stateOf } = await setup({ restartBackoffMs: [0] });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const kill = () => {
      if (desktop) {
        desktop.running = false;
        desktop.exitCode = 137;
      }
    };
    const until = (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (pred() ? resolve() : setTimeout(check, 5));
        check();
      });
    kill();
    await until(() => desktop?.starts === 2 && orchestrator.get(cell.id)?.state === "ready");
    kill();
    await until(() => orchestrator.get(cell.id)?.state === "failed");
    expect(orchestrator.get(cell.id)?.error).toBe("desktop container exited with 137; gave up after 1 restarts");
    expect(desktop?.starts).toBe(2);
  });

  it("keeps a cell stopped when the stop lands during the restart backoff", async () => {
    const backoff = Promise.withResolvers<void>();
    const { orchestrator, store, stateOf, changes } = await setup({
      restartBackoffMs: [60_000],
      sleep: (ms) => (ms === 60_000 ? backoff.promise : Promise.resolve()),
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () =>
        changes.some((c) => c.id === cell.id && c.state === "starting" && (c.error ?? "").includes("restarting (attempt 1 of 1)"))
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    await orchestrator.stop(cell.id);
    backoff.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(orchestrator.get(cell.id)?.state).toBe("stopped");
    expect(changes.at(-1)).toMatchObject({ id: cell.id, state: "stopped" });
    expect(desktop?.starts).toBe(1);
  });
});

describe("CellOrchestrator.reconcile", () => {
  it("marks a cell whose desktop died while its gate runs as failed with the exit code", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    orchestrator.dispose();
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 139;
    }
    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    await fresh.reconcile();
    expect(fresh.get(cell.id)).toMatchObject({ state: "failed", error: expect.stringContaining("desktop container exited with 139") });
  });

  it("recovers running, stopped and vanished cells from their records", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const running = await orchestrator.create({ scale: 2 });
    await stateOf(running.id, "ready");
    const stopped = await orchestrator.create({ scale: 2 });
    await stateOf(stopped.id, "ready");
    await orchestrator.stop(stopped.id);
    const vanished = sampleRecord();
    store.save(vanished);

    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    const seen: CellSummary[] = [];
    fresh.subscribe((c) => seen.push(c));
    await fresh.reconcile();
    await new Promise<void>((resolve) => {
      const check = () => (seen.some((c) => c.id === running.id && c.state === "ready") ? resolve() : setTimeout(check, 5));
      check();
    });
    expect(fresh.get(stopped.id)?.state).toBe("stopped");
    expect(fresh.get(vanished.id)).toMatchObject({ state: "failed", error: expect.stringContaining("removed outside localDot") });
    expect(fresh.list()).toHaveLength(3);
  });
});
```

- [ ] **Step 5: Run it to see it fail, then implement readiness and the orchestrator**

Run: `pnpm exec vitest run apps/daemon/src/cells/orchestrator.test.ts`
Expected: FAIL — `Failed to load url ./orchestrator.ts`.

`apps/daemon/src/cells/readiness.ts`:
```ts
import type { DesktopdEndpoint, DesktopdHealth, StreamEndpoint } from "./types.ts";

export async function probeDesktopd(endpoint: DesktopdEndpoint, timeoutMs = 3000): Promise<DesktopdHealth | undefined> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/healthz`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as DesktopdHealth;
  } catch {
    return undefined;
  }
}

export async function probeStream(endpoint: StreamEndpoint, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/api/health`, {
      headers: { authorization: endpoint.authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

`apps/daemon/src/cells/orchestrator.ts`:
```ts
import { ulid } from "@localdot/protocol";
import { type DockerClient, DockerError } from "./docker.ts";
import type { Images } from "./images.ts";
import { hostAddress } from "./ipv4.ts";
import { allocateKeydPort } from "./ports.ts";
import { newCellToken } from "./secrets.ts";
import {
  cellNames,
  DESKTOP_OFFSET,
  desktopSpec,
  egressNetworkSpec,
  GATE_OFFSET,
  GATE_PORTS,
  gateSpec,
  homeVolumeSpec,
  internalNetworkSpec,
  NAME_PREFIX,
} from "./spec.ts";
import type { CellStore } from "./store.ts";
import {
  type CellEndpoints,
  type CellRecord,
  type CellState,
  type CellSummary,
  type DesktopdHealth,
  NO_STREAM,
  type Scale,
  type StreamState,
} from "./types.ts";

export interface OrchestratorDeps {
  docker: DockerClient;
  store: CellStore;
  images: Images;
  probeDesktopd(endpoint: CellEndpoints["desktopd"]): Promise<DesktopdHealth | undefined>;
  probeStream(endpoint: CellEndpoints["stream"]): Promise<boolean>;
  // Docker-backed tests pass "localdot-test-", so they never create or touch a real cell's objects.
  namePrefix?: string;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  watchEveryMs?: number;
  restartBackoffMs?: number[];
}

export type CellListener = (cell: CellSummary) => void;

export type CellApi = Pick<
  CellOrchestrator,
  "list" | "get" | "endpoints" | "create" | "start" | "stop" | "remove" | "subscribe" | "updateStream"
>;

interface Ports {
  desktopd: number;
  stream: number;
}

interface Live {
  state: CellState;
  restarts: number;
  error?: string;
  ports?: Ports;
  stream: StreamState;
}

interface NetworkInspect {
  Id: string;
  IPAM: { Config: { Subnet?: string }[] };
}

interface ContainerInspect {
  State: { Running: boolean; ExitCode: number; Error: string };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks: Record<string, unknown>;
  };
}

export class UnknownCellError extends Error {
  constructor(readonly cellId: string) {
    super(`unknown cell ${cellId}`);
    this.name = "UnknownCellError";
  }
}

export function endpointsFor(record: CellRecord, ports: Ports): CellEndpoints {
  const basic = Buffer.from(`localdot:${record.tokens.stream}`).toString("base64");
  return {
    desktopd: { baseUrl: `http://127.0.0.1:${ports.desktopd}`, token: record.tokens.desktopd },
    stream: { baseUrl: `http://127.0.0.1:${ports.stream}`, authorization: `Basic ${basic}` },
  };
}

const isStatus = (err: unknown, ...statuses: number[]) =>
  err instanceof DockerError && statuses.includes(err.status);

// Spec, error handling: a crashed cell is restarted with backoff. Docker's own restart policy is not
// used (P2-R14): it would restart behind the daemon's back and change the published ports unseen.
const DEFAULT_RESTART_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

export class CellOrchestrator {
  readonly #docker: DockerClient;
  readonly #store: CellStore;
  readonly #images: Images;
  readonly #probeDesktopd: OrchestratorDeps["probeDesktopd"];
  readonly #probeStream: OrchestratorDeps["probeStream"];
  readonly #namePrefix: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #readyTimeoutMs: number;
  readonly #watchEveryMs: number;
  readonly #restartBackoffMs: number[];
  readonly #live = new Map<string, Live>();
  readonly #listeners = new Set<CellListener>();
  readonly #reservedKeydPorts = new Set<number>();
  #disposed = false;

  constructor(deps: OrchestratorDeps) {
    this.#docker = deps.docker;
    this.#store = deps.store;
    this.#images = deps.images;
    this.#probeDesktopd = deps.probeDesktopd;
    this.#probeStream = deps.probeStream;
    this.#namePrefix = deps.namePrefix ?? NAME_PREFIX;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#readyTimeoutMs = deps.readyTimeoutMs ?? 180_000;
    this.#watchEveryMs = deps.watchEveryMs ?? 5000;
    this.#restartBackoffMs = deps.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
  }

  list(): CellSummary[] {
    return this.#store.list().map((record) => this.#summary(record));
  }

  get(id: string): CellSummary | undefined {
    const record = this.#store.get(id);
    return record && this.#summary(record);
  }

  record(id: string): CellRecord | undefined {
    return this.#store.get(id);
  }

  endpoints(id: string): CellEndpoints | undefined {
    const record = this.#store.get(id);
    const live = this.#live.get(id);
    if (!record || !live?.ports) return undefined;
    return endpointsFor(record, live.ports);
  }

  subscribe(listener: CellListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  updateStream(id: string, patch: Partial<StreamState>): void {
    const live = this.#live.get(id);
    if (!live) return;
    live.stream = { ...live.stream, ...patch };
    this.#emit(id);
  }

  // Stops the background watch and readiness loops; the daemon's process exit does the rest.
  dispose(): void {
    this.#disposed = true;
  }

  // Restart counters live in memory, so a daemon restart starts them again at 0.
  async reconcile(): Promise<void> {
    for (const record of this.#store.list()) {
      try {
        const desktop = await this.#inspect(record.docker.desktop);
        const gate = await this.#inspect(record.docker.gate);
        if (desktop.State.Running && gate.State.Running) {
          const ports = await this.#readPorts(record.docker.gate);
          this.#set(record.id, { state: "starting", restarts: 0, ports, stream: NO_STREAM });
          void this.#waitReady(record);
        } else if (!desktop.State.Running && !gate.State.Running) {
          this.#set(record.id, { state: "stopped", restarts: 0, stream: NO_STREAM });
        } else {
          const [role, info] = desktop.State.Running ? ["gate", gate] : ["desktop", desktop];
          this.#set(record.id, {
            state: "failed",
            restarts: 0,
            error: `${role} container exited with ${info.State.ExitCode}; stop and start the computer`,
            stream: NO_STREAM,
          });
        }
      } catch (err) {
        const error = isStatus(err, 404) ? "containers missing: removed outside localDot" : messageOf(err);
        this.#set(record.id, { state: "failed", restarts: 0, error, stream: NO_STREAM });
      }
    }
  }

  async create(opts: { scale: Scale }): Promise<CellSummary> {
    const id = ulid();
    const names = cellNames(id, this.#namePrefix);
    // keyd tells cells apart by their listener port (M3), so the port is reserved before the first
    // await: two concurrent creates never get the same one.
    const keydPort = allocateKeydPort([...this.#store.list().map((r) => r.keydPort), ...this.#reservedKeydPorts]);
    this.#reservedKeydPorts.add(keydPort);
    const undo: (() => Promise<unknown>)[] = [];
    try {
      const internal = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: internalNetworkSpec(names.internalNetwork),
      });
      undo.push(() => this.#docker.request({ method: "DELETE", path: `/networks/${internal.Id}` }));
      const egress = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: egressNetworkSpec(names.egressNetwork),
      });
      undo.push(() => this.#docker.request({ method: "DELETE", path: `/networks/${egress.Id}` }));
      const internalSubnet = await this.#subnet(internal.Id);
      const egressSubnet = await this.#subnet(egress.Id);
      await this.#docker.request({ method: "POST", path: "/volumes/create", body: homeVolumeSpec(names.homeVolume) });
      undo.push(() =>
        this.#docker.request({ method: "DELETE", path: `/volumes/${names.homeVolume}`, query: { force: "true" } }),
      );
      const record: CellRecord = {
        v: 1,
        id,
        createdAt: new Date().toISOString(),
        scale: opts.scale,
        keydPort,
        tokens: { desktopd: newCellToken(), stream: newCellToken() },
        docker: {
          ...names,
          gateInternalIp: hostAddress(internalSubnet, GATE_OFFSET),
          gateEgressIp: hostAddress(egressSubnet, GATE_OFFSET),
          desktopIp: hostAddress(internalSubnet, DESKTOP_OFFSET),
        },
      };
      for (const [name, spec] of [
        [names.gate, gateSpec(record, this.#images.gate)],
        [names.desktop, desktopSpec(record, this.#images.desktop)],
      ] as const) {
        await this.#docker.request({ method: "POST", path: "/containers/create", query: { name }, body: spec });
        undo.push(() =>
          this.#docker.request({ method: "DELETE", path: `/containers/${name}`, query: { force: "true" } }),
        );
      }
      this.#store.save(record);
      undo.push(async () => this.#store.remove(id));
      if (await this.#startContainers(record, 0)) void this.#waitReady(record);
      return this.#summary(record);
    } catch (err) {
      for (const step of undo.reverse()) await step().catch(() => {});
      this.#live.delete(id);
      throw err;
    } finally {
      this.#reservedKeydPorts.delete(keydPort);
    }
  }

  async start(id: string): Promise<void> {
    const record = this.#require(id);
    if (await this.#startContainers(record, 0)) void this.#waitReady(record);
  }

  async stop(id: string): Promise<void> {
    const record = this.#require(id);
    this.#set(id, { state: "stopping", restarts: 0, stream: NO_STREAM });
    for (const name of [record.docker.desktop, record.docker.gate]) {
      await this.#docker
        .request({ method: "POST", path: `/containers/${name}/stop`, query: { t: "10" } })
        .catch((err) => {
          if (!isStatus(err, 304, 404)) throw err;
        });
    }
    this.#set(id, { state: "stopped", restarts: 0, stream: NO_STREAM });
  }

  async remove(id: string, opts: { purgeHome?: boolean } = {}): Promise<void> {
    const record = this.#require(id);
    const d = record.docker;
    const ignoreMissing = (err: unknown) => {
      if (!isStatus(err, 404)) throw err;
    };
    for (const name of [d.desktop, d.gate]) {
      await this.#docker
        .request({ method: "DELETE", path: `/containers/${name}`, query: { force: "true" } })
        .catch(ignoreMissing);
    }
    for (const name of [d.internalNetwork, d.egressNetwork]) {
      await this.#docker.request({ method: "DELETE", path: `/networks/${name}` }).catch(ignoreMissing);
    }
    if (opts.purgeHome) {
      await this.#docker
        .request({ method: "DELETE", path: `/volumes/${d.homeVolume}`, query: { force: "true" } })
        .catch(ignoreMissing);
    }
    this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
    this.#store.remove(id);
    this.#live.delete(id);
  }

  // Resolves false when a stop, a remove or a newer start took the cell over while it ran.
  async #startContainers(record: CellRecord, restarts: number, error?: string): Promise<boolean> {
    const d = record.docker;
    const starting: Live = { state: "starting", restarts, stream: NO_STREAM, ...(error ? { error } : {}) };
    this.#set(record.id, starting);
    try {
      await this.#docker.request({ method: "POST", path: `/containers/${d.gate}/start` });
      // The gate starts on its egress network (where its ports are published) and joins the
      // internal network afterwards, the order S3 proved; a restarted gate is still connected.
      const gate = await this.#inspect(d.gate);
      if (!(d.internalNetwork in gate.NetworkSettings.Networks)) {
        await this.#docker.request({
          method: "POST",
          path: `/networks/${d.internalNetwork}/connect`,
          body: { Container: d.gate, EndpointConfig: { IPAMConfig: { IPv4Address: d.gateInternalIp } } },
        });
      }
      if (!this.#current(record.id, starting)) return false;
      await this.#docker.request({ method: "POST", path: `/containers/${d.desktop}/start` });
      // Every start publishes new host ports (Review Focus 2).
      const ports = await this.#readPorts(d.gate);
      if (!this.#current(record.id, starting)) return false;
      this.#set(record.id, { ...starting, ports });
      return true;
    } catch (err) {
      if (this.#current(record.id, starting)) {
        this.#set(record.id, { state: "failed", restarts, error: messageOf(err), stream: NO_STREAM });
      }
      throw err;
    }
  }

  async #waitReady(record: CellRecord): Promise<void> {
    const live = this.#live.get(record.id);
    if (this.#disposed || live?.state !== "starting" || !live.ports) return;
    const ports = live.ports;
    const endpoints = endpointsFor(record, ports);
    const deadline = Date.now() + this.#readyTimeoutMs;
    let lastDetail = "no answer from desktopd yet";
    while (Date.now() < deadline) {
      const health = await this.#probeDesktopd(endpoints.desktopd);
      if (!this.#current(record.id, live)) return;
      if (health?.ok) {
        const streaming = await this.#probeStream(endpoints.stream);
        if (!this.#current(record.id, live)) return;
        if (streaming) {
          // The restart count survives a recovery: it resets only on a user start or stop, so a
          // cell that keeps dying runs out of attempts instead of flapping forever.
          this.#set(record.id, { state: "ready", restarts: live.restarts, ports, stream: NO_STREAM });
          void this.#watch(record);
          return;
        }
        lastDetail = "desktopd is ready; the stream is not answering yet";
      } else if (health) {
        lastDetail = `desktopd not ready: hidpi ${JSON.stringify(health.hidpi)}, screen ${JSON.stringify(health.screen)}`;
      }
      const desktop = await this.#inspect(record.docker.desktop).catch(() => undefined);
      if (!this.#current(record.id, live)) return;
      if (desktop && !desktop.State.Running) {
        const detail = desktop.State.Error ? `: ${desktop.State.Error}` : "";
        this.#set(record.id, { ...live, state: "failed", error: `desktop container exited with ${desktop.State.ExitCode}${detail}` });
        return;
      }
      await this.#sleep(1000);
      if (!this.#current(record.id, live)) return;
    }
    this.#set(record.id, { ...live, state: "failed", error: `not ready after ${this.#readyTimeoutMs / 1000} s: ${lastDetail}` });
  }

  // Runs while the cell is ready: an exited container is restarted with backoff, and a cell that
  // keeps dying is marked failed once the backoff list is exhausted.
  async #watch(record: CellRecord): Promise<void> {
    const live = this.#live.get(record.id);
    if (live?.state !== "ready") return;
    for (;;) {
      await this.#sleep(this.#watchEveryMs);
      if (!this.#current(record.id, live)) return;
      const exited = await this.#exitedContainer(record);
      if (!this.#current(record.id, live)) return;
      if (exited === undefined) continue;
      const attempt = live.restarts + 1;
      if (attempt > this.#restartBackoffMs.length) {
        this.#set(record.id, { ...live, state: "failed", error: `${exited}; gave up after ${live.restarts} restarts` });
        return;
      }
      const note = `${exited}; restarting (attempt ${attempt} of ${this.#restartBackoffMs.length})`;
      const restarting: Live = { ...live, state: "starting", restarts: attempt, error: note };
      this.#set(record.id, restarting);
      await this.#sleep(this.#restartBackoffMs[attempt - 1] ?? 0);
      if (!this.#current(record.id, restarting)) return;
      if (await this.#startContainers(record, attempt, note).catch(() => false)) await this.#waitReady(record);
      return;
    }
  }

  // A loop that awaited goes on only while the cell still holds the entry it set or read: a stop, a
  // remove, a newer start or dispose() in the meantime wins (a user's Stop beats a restart).
  #current(id: string, entry: Live): boolean {
    return !this.#disposed && this.#live.get(id) === entry;
  }

  async #exitedContainer(record: CellRecord): Promise<string | undefined> {
    for (const [role, name] of [
      ["desktop", record.docker.desktop],
      ["gate", record.docker.gate],
    ] as const) {
      const info = await this.#inspect(name).catch(() => undefined);
      if (info && !info.State.Running) return `${role} container exited with ${info.State.ExitCode}`;
    }
    return undefined;
  }

  async #readPorts(gate: string): Promise<Ports> {
    const info = await this.#inspect(gate);
    const port = (key: string) => {
      const p = Number(info.NetworkSettings.Ports[key]?.[0]?.HostPort);
      if (!Number.isInteger(p) || p <= 0) throw new Error(`gate ${gate}: no published host port for ${key}`);
      return p;
    };
    return { desktopd: port(GATE_PORTS.desktopd), stream: port(GATE_PORTS.stream) };
  }

  #inspect(name: string): Promise<ContainerInspect> {
    return this.#docker.request<ContainerInspect>({ method: "GET", path: `/containers/${name}/json` });
  }

  async #subnet(networkId: string): Promise<string> {
    const info = await this.#docker.request<NetworkInspect>({ method: "GET", path: `/networks/${networkId}` });
    const subnet = info.IPAM.Config[0]?.Subnet;
    if (!subnet) throw new Error(`network ${networkId} has no IPv4 subnet`);
    return subnet;
  }

  #require(id: string): CellRecord {
    const record = this.#store.get(id);
    if (!record) throw new UnknownCellError(id);
    return record;
  }

  #set(id: string, live: Live): void {
    this.#live.set(id, live);
    this.#emit(id);
  }

  #emit(id: string): void {
    const record = this.#store.get(id);
    if (!record) return;
    const summary = this.#summary(record);
    for (const listener of this.#listeners) {
      try {
        listener(summary);
      } catch (err) {
        console.error(`cell listener failed: ${String(err)}`);
      }
    }
  }

  #summary(record: CellRecord): CellSummary {
    const live = this.#live.get(record.id) ?? { state: "stopped" as const, restarts: 0, stream: NO_STREAM };
    return {
      id: record.id,
      state: live.state,
      scale: record.scale,
      createdAt: record.createdAt,
      stream: live.stream,
      ...(live.error ? { error: live.error } : {}),
    };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 6: Run the orchestrator tests**

Run: `pnpm exec vitest run apps/daemon/src/cells/orchestrator.test.ts apps/daemon/src/cells/spec.test.ts`
Expected: 19 tests pass (6 spec, 13 orchestrator). Note for the reviewer: the fake assigns ports
from 50000 upwards each time a stopped container starts, and answers a start of a running one with
304, as Docker does; the published ports are the gate's, so the stop/start and gate-restart tests
see new endpoints and the desktop-restart test sees the old ones. The restart tests use
`watchEveryMs: 0` with an immediate `sleep`, except the stop-during-backoff test, whose `sleep`
holds the 60 s backoff open until the stop has landed.

- [ ] **Step 7: The Docker-backed isolation test**

`apps/daemon/src/cells/orchestrator.docker.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DockerClient } from "./docker.ts";
import { imagesFromEnv } from "./images.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { probeDesktopd, probeStream } from "./readiness.ts";
import { CellStore } from "./store.ts";
import { DOCKER_TESTS, docker, dockerExec, dockerOk } from "./testing/docker-cli.ts";
import type { CellSummary } from "./types.ts";

const PREFIX = "localdot-test-";

describe.skipIf(!DOCKER_TESTS)("CellOrchestrator against Docker Desktop", () => {
  const store = new CellStore(mkdtempSync(join(tmpdir(), "local dot's orch-docker-")));
  const orchestrator = new CellOrchestrator({
    docker: new DockerClient(),
    store,
    images: imagesFromEnv(),
    probeDesktopd,
    probeStream,
    namePrefix: PREFIX,
  });
  let cell: CellSummary | undefined;

  afterAll(async () => {
    if (cell && store.get(cell.id)) await orchestrator.remove(cell.id, { purgeHome: true }).catch(() => {});
  });

  it("creates a ready cell whose desktop reaches nothing but its gate", async () => {
    cell = await orchestrator.create({ scale: 2 });
    const ready = await new Promise<CellSummary>((resolve, reject) => {
      orchestrator.subscribe((c) => {
        if (c.id !== cell?.id) return;
        if (c.state === "ready") resolve(c);
        if (c.state === "failed") reject(new Error(c.error));
      });
    });
    expect(ready.state).toBe("ready");
    const record = store.get(cell.id);
    if (!record) throw new Error("record missing");
    const desktop = record.docker.desktop;
    expect(desktop).toBe(`${PREFIX}desktop-${cell.id}`);

    expect(dockerExec(desktop, "curl", "-sS", "-m", "5", "https://example.com").status).not.toBe(0);
    expect(dockerExec(desktop, "curl", "-sS", "-m", "5", "http://host.docker.internal:4750/").status).not.toBe(0);
    expect(dockerExec(desktop, "sh", "-c", "getent hosts example.com").status).not.toBe(0);
    expect(dockerExec(desktop, "timeout", "5", "bash", "-c", `exec 3<>/dev/tcp/${record.docker.gateInternalIp}/3128`).status).toBe(0);
    expect(docker("inspect", "-f", "{{.HostConfig.CapDrop}} {{.HostConfig.Binds}}", desktop)).toBe("[NET_RAW] []");
    expect(docker("inspect", "-f", "{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}", desktop).trim()).toBe("volume:/config");
    expect(docker("inspect", "-f", "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}", record.docker.gate)).toBe("true [ALL]");
    expect(docker("inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", desktop)).toMatch(/^(no)?$/);
    // Engine 29 renders the unset gateway of an isolated network as "invalid IP" (S3 saw the same).
    expect(["", "invalid IP"]).toContain(docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", record.docker.internalNetwork));
    // NET_RAW is dropped: not even root inside the desktop can open a raw socket (D15, A13).
    expect(dockerExec(desktop, "python3", "-c", "import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)").status).not.toBe(0);

    const endpoints = orchestrator.endpoints(cell.id);
    if (!endpoints) throw new Error("endpoints missing");
    expect(endpoints.desktopd.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await probeDesktopd(endpoints.desktopd);
    expect(health?.ok).toBe(true);
  }, 300_000);

  it("stops, starts with new ports, and removes everything but the home volume", async () => {
    if (!cell) throw new Error("no cell");
    const record = store.get(cell.id);
    if (!record) throw new Error("record missing");
    const before = orchestrator.endpoints(cell.id)?.desktopd.baseUrl;
    await orchestrator.stop(cell.id);
    expect(dockerOk("inspect", "-f", "{{.State.Running}}", record.docker.desktop)).toBe(true);
    expect(docker("inspect", "-f", "{{.State.Running}}", record.docker.desktop)).toBe("false");
    await orchestrator.start(cell.id);
    await new Promise<void>((resolve, reject) => {
      orchestrator.subscribe((c) => {
        if (c.id !== cell?.id) return;
        if (c.state === "ready") resolve();
        if (c.state === "failed") reject(new Error(c.error));
      });
    });
    expect(orchestrator.endpoints(cell.id)?.desktopd.baseUrl).not.toBe(before);

    await orchestrator.remove(cell.id);
    expect(dockerOk("inspect", record.docker.desktop)).toBe(false);
    expect(dockerOk("inspect", record.docker.gate)).toBe(false);
    expect(dockerOk("network", "inspect", record.docker.internalNetwork)).toBe(false);
    expect(dockerOk("volume", "inspect", record.docker.homeVolume)).toBe(true);
    docker("volume", "rm", record.docker.homeVolume);
    cell = undefined;
  }, 300_000);
});
```

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/orchestrator.docker.test.ts`
Expected: 2 tests pass in about 2–4 minutes. `docker ps -a --filter name=localdot-test-`,
`docker network ls --filter name=localdot-test-` and `docker volume ls --filter name=localdot-test-`
print no rows afterwards. Every check goes by the test prefix: a real cell's objects are named
`localdot-<role>-<id>` and carry the same `localdot.cell` labels, so a label filter would list them too.

- [ ] **Step 8: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells
git commit -m "feat(daemon): cell orchestrator with isolated networks and hardened containers"
```

---
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
  `MIN_ENGINE_MAJOR = 28`; CLI `pnpm --filter @localdot/daemon run doctor` (exit 1 when any check fails).
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

Run: `pnpm exec vitest run apps/daemon/src/doctor.test.ts && LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/doctor.docker.test.ts && pnpm --filter @localdot/daemon run doctor`
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
### Task 10: Cell API, the cell status socket and the upgrade router

The daemon gets a second WebSocket route (cell status) and, in the next task, a third (the stream
proxy), so the single `upgrade` handler in `event-stream.ts` becomes a router that runs the Host and
Origin checks once and dispatches by path; token checks stay per route because the stream route is
authorised by a ticket instead.

**Files:**
- Create: `apps/daemon/src/upgrade-router.ts`, `apps/daemon/src/cells/api.ts`,
  `apps/daemon/src/cells/status-stream.ts`, `apps/daemon/src/cells/testing/fake-orchestrator.ts`
- Modify: `apps/daemon/src/event-stream.ts`, `apps/daemon/src/app.ts`, `apps/daemon/src/main.ts`
- Test: `apps/daemon/src/cells/api.test.ts`, `apps/daemon/src/cells/status-stream.test.ts`;
  `apps/daemon/src/app.test.ts` and `apps/daemon/src/event-stream.test.ts` keep passing.

**Interfaces:**
- Produces: `WS_PROTOCOL` (moved; still re-exported from `event-stream.ts`);
  `interface UpgradeRoute { pattern: RegExp; params: string[]; auth: "token" | "ticket"; open(ctx: UpgradeContext): void }`;
  `interface UpgradeContext { req; socket; head; url: URL; params: Record<string, string> }`;
  `attachUpgradeRouter(server, { port, token }, routes)`; `refuse(socket, status)`;
  `tokenSocketServer(): WebSocketServer`; `sessionStreamRoute(eventLog): UpgradeRoute`;
  `cellStatusRoute(cells: CellApi): UpgradeRoute` at `/api/cells/:id/status` (JSON `CellSummary`
  on connect and on every change; closes with 1000 after `removed`);
  `type CellApi = Pick<CellOrchestrator, "list" | "get" | "endpoints" | "create" | "start" | "stop" | "remove" | "subscribe" | "updateStream">`;
  `cellRoutes(app, { cells, tickets })` — `GET /api/cells`, `POST /api/cells {scale?}` → 202,
  `GET /api/cells/:id`, `POST /api/cells/:id/start|stop` → 202, `DELETE /api/cells/:id[?purge=1]` → 204,
  `POST /api/cells/:id/stream-ticket` → `{ ticket, path }` (409 unless `ready`; the same ticket
  while the cell stays ready; revoked by `cellRoutes`' subscription whenever the cell leaves `ready`);
  `AppOptions` gains `cells?: { cells: CellApi; tickets: TicketRegistry }`; `main.ts` prints
  `open http://127.0.0.1:<port>/#token=<token>` at startup.

- [ ] **Step 1: The upgrade router, and the event stream on top of it**

`apps/daemon/src/upgrade-router.ts`:
```ts
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { tokensMatch } from "./token.ts";

export const WS_PROTOCOL = "localdot.v1";

export interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: Record<string, string>;
}

export interface UpgradeRoute {
  pattern: RegExp;
  params: string[];
  // "ticket" routes authorise themselves (the Selkies iframe cannot carry the install token).
  auth: "token" | "ticket";
  open(ctx: UpgradeContext): void;
}

export function refuse(socket: Duplex, status: string): void {
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

// Never select the localdot.token.<t> entry: the chosen subprotocol is echoed back in the response.
export function tokenSocketServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
}

export function attachUpgradeRouter(
  server: Server,
  opts: { port: number; token: string },
  routes: UpgradeRoute[],
): void {
  const base = `http://127.0.0.1:${opts.port}`;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const target = req.url ?? "/";
    if (!URL.canParse(target, base)) {
      refuse(socket, "400 Bad Request");
      return;
    }
    const url = new URL(target, base);
    const allowed =
      isAllowedHost(req.headers.host, opts.port) &&
      isAllowedHost(url.host, opts.port) &&
      isAllowedOrigin(req.headers.origin, opts.port);
    if (!allowed) {
      refuse(socket, "403 Forbidden");
      return;
    }
    for (const route of routes) {
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      if (route.auth === "token") {
        const given = tokenFromHeaders({
          authorization: req.headers.authorization,
          "sec-websocket-protocol": req.headers["sec-websocket-protocol"],
        });
        if (!tokensMatch(opts.token, given)) {
          refuse(socket, "403 Forbidden");
          return;
        }
      }
      const params = Object.fromEntries(route.params.map((name, i) => [name, match[i + 1] ?? ""]));
      route.open({ req, socket, head, url, params });
      return;
    }
    refuse(socket, "404 Not Found");
  });
}
```

`apps/daemon/src/event-stream.ts` (replace the whole file; `streamSession` is unchanged):
```ts
import type { Server } from "node:http";
import { type LocalDotEvent, ULID_PATTERN } from "@localdot/protocol";
import type { WebSocket } from "ws";
import type { EventLog } from "./event-log.ts";
import {
  attachUpgradeRouter,
  refuse,
  tokenSocketServer,
  type UpgradeRoute,
  WS_PROTOCOL,
} from "./upgrade-router.ts";

export { WS_PROTOCOL };

export interface EventStreamOptions {
  port: number;
  token: string;
  eventLog: EventLog;
}

export function sessionStreamRoute(eventLog: EventLog): UpgradeRoute {
  const wss = tokenSocketServer();
  return {
    pattern: /^\/api\/sessions\/([^/]+)\/stream$/,
    params: ["id"],
    auth: "token",
    open({ req, socket, head, url, params }) {
      const sessionId = params.id ?? "";
      if (!ULID_PATTERN.test(sessionId)) {
        refuse(socket, "403 Forbidden");
        return;
      }
      if (!eventLog.hasSession(sessionId)) {
        refuse(socket, "404 Not Found");
        return;
      }
      const fromSeq = Math.max(0, Number(url.searchParams.get("fromSeq")) || 0);
      wss.handleUpgrade(req, socket, head, (ws) => streamSession(ws, eventLog, sessionId, fromSeq));
    },
  };
}

export function attachEventStream(server: Server, { port, token, eventLog }: EventStreamOptions): void {
  attachUpgradeRouter(server, { port, token }, [sessionStreamRoute(eventLog)]);
}

function streamSession(
  ws: WebSocket,
  eventLog: EventLog,
  sessionId: string,
  fromSeq: number,
): void {
  // ws closes the connection itself after a protocol error; an unhandled 'error' would crash the daemon.
  ws.on("error", () => {});
  let nextSeq = fromSeq;
  const send = (event: LocalDotEvent) => {
    if (event.seq < nextSeq) return;
    ws.send(JSON.stringify(event));
    nextSeq = event.seq + 1;
  };
  try {
    for (const event of eventLog.read(sessionId, fromSeq)) send(event);
  } catch {
    ws.close(1011, "backlog unavailable");
    return;
  }
  const unsubscribe = eventLog.subscribe((sid, event) => {
    if (sid === sessionId) send(event);
  });
  ws.on("close", unsubscribe);
}
```

Run: `pnpm exec vitest run apps/daemon/src/event-stream.test.ts`
Expected: the Part 1 event-stream tests still pass unchanged.

- [ ] **Step 2: Write the fake orchestrator for route tests**

`CellApi` (the subset of `CellOrchestrator` the routes consume) is already exported by Task 8's
`orchestrator.ts`; the fake below implements it.

`apps/daemon/src/cells/testing/fake-orchestrator.ts`:
```ts
import { ulid } from "@localdot/protocol";
import { type CellApi, type CellListener, UnknownCellError } from "../orchestrator.ts";
import { type CellEndpoints, type CellSummary, NO_STREAM, type Scale, type StreamState } from "../types.ts";

export class FakeOrchestrator implements CellApi {
  readonly cells = new Map<string, CellSummary>();
  readonly endpointsById = new Map<string, CellEndpoints>();
  readonly listeners = new Set<CellListener>();
  readonly streamUpdates: { id: string; patch: Partial<StreamState> }[] = [];
  failWith: Error | undefined;

  list(): CellSummary[] {
    return [...this.cells.values()];
  }

  get(id: string): CellSummary | undefined {
    return this.cells.get(id);
  }

  endpoints(id: string): CellEndpoints | undefined {
    return this.endpointsById.get(id);
  }

  subscribe(listener: CellListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(cell: CellSummary): void {
    this.cells.set(cell.id, cell);
    for (const listener of this.listeners) listener(cell);
  }

  updateStream(id: string, patch: Partial<StreamState>): void {
    this.streamUpdates.push({ id, patch });
    const cell = this.cells.get(id);
    if (cell) this.emit({ ...cell, stream: { ...cell.stream, ...patch } });
  }

  async create({ scale }: { scale: Scale }): Promise<CellSummary> {
    if (this.failWith) throw this.failWith;
    const cell: CellSummary = { id: ulid(), state: "starting", scale, createdAt: new Date().toISOString(), stream: NO_STREAM };
    this.cells.set(cell.id, cell);
    return cell;
  }

  async start(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "starting" });
  }

  async stop(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "stopped" });
  }

  async remove(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "removed" });
    this.cells.delete(id);
  }

  #require(id: string): CellSummary {
    const cell = this.cells.get(id);
    if (!cell) throw new UnknownCellError(id);
    return cell;
  }
}
```

- [ ] **Step 3: Write the failing API and status tests**

`apps/daemon/src/cells/api.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { DockerError } from "./docker.ts";
import { TicketRegistry } from "./secrets.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import type { CellSummary } from "./types.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

function setup() {
  const cells = new FakeOrchestrator();
  const tickets = new TicketRegistry();
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's api-")));
  const app = createApp({ token: TOKEN, port: PORT, eventLog, cells: { cells, tickets } });
  return { app, cells, tickets };
}

describe("cell API", () => {
  it("requires the install token", async () => {
    const { app } = setup();
    expect((await app.request(url("/api/cells"))).status).toBe(401);
    expect((await app.request(url("/api/cells"), { method: "POST" })).status).toBe(401);
  });

  it("lists, creates and reads cells", async () => {
    const { app } = setup();
    expect(await (await app.request(url("/api/cells"), { headers: bearer })).json()).toEqual([]);
    const created = await app.request(url("/api/cells"), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ scale: 1 }) });
    expect(created.status).toBe(202);
    const cell = (await created.json()) as CellSummary;
    expect(cell).toMatchObject({ state: "starting", scale: 1 });
    const read = await app.request(url(`/api/cells/${cell.id}`), { headers: bearer });
    expect(await read.json()).toEqual(cell);
    const empty = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
    expect(((await empty.json()) as CellSummary).scale).toBe(2);
  });

  it("rejects bad scales, bad ids and unknown cells", async () => {
    const { app } = setup();
    const bad = await app.request(url("/api/cells"), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ scale: 3 }) });
    expect(bad.status).toBe(400);
    expect((await app.request(url("/api/cells/../etc"), { headers: bearer })).status).toBe(404);
    expect((await app.request(url("/api/cells/not-a-ulid"), { headers: bearer })).status).toBe(400);
    expect((await app.request(url("/api/cells/01JXYZ0000000000000000ABCD"), { headers: bearer })).status).toBe(404);
    expect((await app.request(url("/api/cells/01JXYZ0000000000000000ABCD/stop"), { method: "POST", headers: bearer })).status).toBe(404);
  });

  it("issues stream tickets only for ready cells and revokes them on removal", async () => {
    const { app, cells, tickets } = setup();
    const cell = await cells.create({ scale: 2 });
    const early = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    expect(early.status).toBe(409);
    cells.emit({ ...cell, state: "ready" });
    const res = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    expect(res.status).toBe(200);
    const { ticket, path } = (await res.json()) as { ticket: string; path: string };
    expect(path).toBe(`/cells/${cell.id}/desktop/${ticket}/`);
    expect(tickets.resolve(ticket)).toBe(cell.id);
    const again = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    expect(((await again.json()) as { ticket: string }).ticket).toBe(ticket);
    expect((await app.request(url(`/api/cells/${cell.id}/stop`), { method: "POST", headers: bearer })).status).toBe(202);
    expect(tickets.resolve(ticket)).toBeUndefined();
    cells.emit({ ...cell, state: "ready" });
    const fresh = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    const reissued = ((await fresh.json()) as { ticket: string }).ticket;
    expect(reissued).not.toBe(ticket);
    expect((await app.request(url(`/api/cells/${cell.id}`), { method: "DELETE", headers: bearer })).status).toBe(204);
    expect(tickets.resolve(reissued)).toBeUndefined();
    expect(cells.get(cell.id)).toBeUndefined();
  });

  it("stops and starts a cell and maps Docker failures to 502", async () => {
    const { app, cells } = setup();
    const cell = await cells.create({ scale: 2 });
    expect((await app.request(url(`/api/cells/${cell.id}/stop`), { method: "POST", headers: bearer })).status).toBe(202);
    expect(cells.get(cell.id)?.state).toBe("stopped");
    expect((await app.request(url(`/api/cells/${cell.id}/start`), { method: "POST", headers: bearer })).status).toBe(202);
    cells.failWith = new DockerError(0, "ECONNREFUSED; is Docker Desktop running?", "/networks/create");
    const failed = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("Docker Desktop");
  });
});
```

`apps/daemon/src/cells/status-stream.test.ts`:
```ts
import type { Server } from "node:http";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WS_TOKEN_PREFIX } from "../guard.ts";
import { attachUpgradeRouter, WS_PROTOCOL } from "../upgrade-router.ts";
import { cellStatusRoute } from "./status-stream.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import type { CellSummary } from "./types.ts";

const TOKEN = "s".repeat(43);
const PROTOCOLS = [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${TOKEN}`];
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

let stop: (() => void) | undefined;
afterEach(() => stop?.());

async function start() {
  const port = await freePort();
  const cells = new FakeOrchestrator();
  const server = serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(server as Server, { port, token: TOKEN }, [cellStatusRoute(cells)]);
  await new Promise((r) => server.once("listening", r));
  stop = () => server.close();
  const origin = `http://127.0.0.1:${port}`;
  const open = (path: string, protocols = PROTOCOLS) => new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { origin });
  const messages = (ws: WebSocket, n: number) =>
    new Promise<CellSummary[]>((resolve) => {
      const got: CellSummary[] = [];
      ws.on("message", (data) => {
        got.push(JSON.parse(String(data)) as CellSummary);
        if (got.length === n) resolve(got);
      });
    });
  const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const refused = (ws: WebSocket) => new Promise<string>((resolve) => ws.on("error", (err) => resolve(err.message)));
  return { cells, open, messages, closed, refused };
}

describe("cell status socket", () => {
  it("sends the current summary, then every change, and closes after removal", async () => {
    const { cells, open, messages, closed } = await start();
    const cell = await cells.create({ scale: 2 });
    const ws = open(`/api/cells/${cell.id}/status`);
    const first = messages(ws, 1);
    await new Promise((r) => ws.once("open", r));
    expect((await first)[0]).toEqual(cell);
    const next = messages(ws, 3);
    cells.emit({ ...cell, state: "ready" });
    cells.updateStream(cell.id, { connection: "live" });
    cells.emit({ ...cell, state: "removed" });
    const got = await next;
    expect(got.map((c) => c.state)).toEqual(["ready", "ready", "removed"]);
    expect(got[1]?.stream.connection).toBe("live");
    expect(await closed(ws)).toBe(1000);
  });

  it("refuses unknown cells, bad ids and missing tokens", async () => {
    const { cells, open, refused } = await start();
    expect(await refused(open("/api/cells/01JXYZ0000000000000000ABCD/status"))).toContain("404");
    expect(await refused(open("/api/cells/nope/status"))).toContain("403");
    const cell = await cells.create({ scale: 2 });
    expect(await refused(open(`/api/cells/${cell.id}/status`, [WS_PROTOCOL]))).toContain("403");
  });
});
```

- [ ] **Step 4: Run them to see them fail, then implement the routes**

Run: `pnpm exec vitest run apps/daemon/src/cells/api.test.ts apps/daemon/src/cells/status-stream.test.ts`
Expected: FAIL — `Failed to load url ./status-stream.ts` and type errors on `cells` in `createApp`.

`apps/daemon/src/cells/status-stream.ts`:
```ts
import { ULID_PATTERN } from "@localdot/protocol";
import { refuse, tokenSocketServer, type UpgradeRoute } from "../upgrade-router.ts";
import type { CellApi } from "./orchestrator.ts";

export function cellStatusRoute(cells: CellApi): UpgradeRoute {
  const wss = tokenSocketServer();
  return {
    pattern: /^\/api\/cells\/([^/]+)\/status$/,
    params: ["id"],
    auth: "token",
    open({ req, socket, head, params }) {
      const id = params.id ?? "";
      if (!ULID_PATTERN.test(id)) {
        refuse(socket, "403 Forbidden");
        return;
      }
      const current = cells.get(id);
      if (!current) {
        refuse(socket, "404 Not Found");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        ws.send(JSON.stringify(current));
        const unsubscribe = cells.subscribe((cell) => {
          if (cell.id !== id) return;
          ws.send(JSON.stringify(cell));
          if (cell.state === "removed") ws.close(1000, "cell removed");
        });
        ws.on("close", unsubscribe);
      });
    },
  };
}
```

`apps/daemon/src/cells/api.ts`:
```ts
import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { DockerError } from "./docker.ts";
import { type CellApi, UnknownCellError } from "./orchestrator.ts";
import type { TicketRegistry } from "./secrets.ts";

export interface CellApiDeps {
  cells: CellApi;
  tickets: TicketRegistry;
}

export function cellRoutes(app: Hono, { cells, tickets }: CellApiDeps): void {
  // A stream ticket lives only while its cell is ready (P2-R2): stopping, failing or removing the
  // cell revokes it, so no stream path stays open for a computer that is off.
  cells.subscribe((cell) => {
    if (cell.state !== "ready") tickets.revoke(cell.id);
  });

  app.get("/api/cells", (c) => c.json(cells.list()));

  app.post("/api/cells", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scale?: unknown };
    const scale = body.scale === undefined || body.scale === 2 ? 2 : body.scale === 1 ? 1 : undefined;
    if (scale === undefined) return c.text("scale must be 1 or 2", 400);
    return withDocker(c, async () => c.json(await cells.create({ scale }), 202));
  });

  app.get("/api/cells/:id", (c) =>
    withCell(c, (id) => {
      const cell = cells.get(id);
      return cell ? c.json(cell) : c.text("unknown cell", 404);
    }),
  );

  app.post("/api/cells/:id/start", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.start(id);
        return c.body(null, 202);
      }),
    ),
  );

  app.post("/api/cells/:id/stop", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.stop(id);
        return c.body(null, 202);
      }),
    ),
  );

  app.delete("/api/cells/:id", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.remove(id, { purgeHome: c.req.query("purge") === "1" });
        tickets.revoke(id);
        return c.body(null, 204);
      }),
    ),
  );

  app.post("/api/cells/:id/stream-ticket", (c) =>
    withCell(c, (id) => {
      const cell = cells.get(id);
      if (!cell) return c.text("unknown cell", 404);
      if (cell.state !== "ready") return c.text(`cell is ${cell.state}`, 409);
      // The registry hands back the cell's live ticket, so a second viewer shares the same path.
      const ticket = tickets.issue(id);
      return c.json({ ticket, path: `/cells/${id}/desktop/${ticket}/` });
    }),
  );
}

function withCell(c: Context, fn: (id: string) => Response | Promise<Response>): Response | Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
  return fn(id);
}

async function withDocker(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnknownCellError) return c.text("unknown cell", 404);
    if (err instanceof DockerError) return c.text(err.message, 502);
    throw err;
  }
}
```

`apps/daemon/src/app.ts` — extend `AppOptions` and wire the routes (the rest of the file is unchanged):
```ts
import { type CellApiDeps, cellRoutes } from "./cells/api.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
}

export function createApp({ token, port, eventLog, cells }: AppOptions): Hono {
  // ... existing guard, /healthz, /api/* token middleware, /api/whoami, session routes ...
  if (cells) cellRoutes(app, cells);
  return app;
}
```
(Place the `cellRoutes` call after the existing session routes, inside `createApp`, so the `/api/*`
token middleware registered above it applies.)

`apps/daemon/src/main.ts` — replace the token/app/server block (keep the lock, port and home code):
```ts
import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { CellOrchestrator } from "./cells/orchestrator.ts";
import { probeDesktopd, probeStream } from "./cells/readiness.ts";
import { TicketRegistry } from "./cells/secrets.ts";
import { cellStatusRoute } from "./cells/status-stream.ts";
import { CellStore } from "./cells/store.ts";
import { sessionStreamRoute } from "./event-stream.ts";
import { attachUpgradeRouter } from "./upgrade-router.ts";

const tokenFile = join(home, "daemon-token");
const token = loadOrCreateToken(tokenFile);
const eventLog = new EventLog(home);
const tickets = new TicketRegistry();
const orchestrator = new CellOrchestrator({
  docker: new DockerClient(),
  store: new CellStore(home),
  images: imagesFromEnv(),
  probeDesktopd,
  probeStream,
});
// The daemon serves the UI without Docker; the UI shows the cell as failed with the reason.
await orchestrator.reconcile().catch((err) => console.error(`cell reconcile failed: ${String(err)}`));
const app = createApp({ token, port, eventLog, cells: { cells: orchestrator, tickets } });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`localdot daemon on http://127.0.0.1:${port} (token in ${tokenFile})`);
  console.log(`open http://127.0.0.1:${port}/#token=${token}`);
});
// serve() is typed as HTTP/1-or-HTTP/2; this daemon only ever creates an HTTP/1 server.
attachUpgradeRouter(server as Server, { port, token }, [sessionStreamRoute(eventLog), cellStatusRoute(orchestrator)]);
server.on("error", (err: NodeJS.ErrnoException) => {
  fail(err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message);
});
```
Remove the now-unused `attachEventStream` import from `main.ts`. The `server.on("error")` handler is
the one Part 1 has: keep it, or a busy port ends the daemon with a stack trace.

- [ ] **Step 5: Run the suites**

Run: `pnpm exec vitest run apps/daemon/src`
Expected: every daemon unit suite passes (the Part 1 app, event-stream, event-log, guard, lock,
paths, port, token tests plus the cells tests, api and status-stream). Start the daemon
(`LOCALDOT_HOME=$(mktemp -d) pnpm --filter @localdot/daemon start`) and check it prints the
`open http://127.0.0.1:4750/#token=…` line, then stop it with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(daemon): cell API, status stream and upgrade router"
```

---
### Task 11: Desktop stream proxy with tickets and a connection-level stall watchdog

The UI never talks to a cell. The daemon serves the vendored Selkies client under
`/cells/:id/desktop/:ticket/`, proxies `GET api/*` to the cell's published stream port with the
per-cell basic-auth credential, and relays the WebSocket `api/websockets` the same way. The relay
dials the cell first and completes the viewer's upgrade only once the cell's socket is open:
Selkies' client sends its settings the moment its own socket opens, and the server streams nothing
until it has them. A cell that refuses the upgrade or can't be reached gets the viewer a 502. While a
relay is open the daemon pings the upstream every `STREAM_PING_MS`; when nothing (no frame, no
message, no pong) arrives for `STREAM_STALL_MS` the cell's stream state becomes `stalled` (A30: a
still screen on a live connection is not a stall, because the pongs keep coming; Selkies' own
server heartbeat is only every 30 s, so the daemon's pings are the liveness signal). Use the S8
numbers if FINDINGS raised the stall constant. The relay does not watch `client.bufferedAmount`;
backpressure towards a slow viewer is a Part 3 obligation (see the closing section).

**Files:**
- Create: `apps/daemon/src/static-files.ts`, `apps/daemon/src/cells/watchdog.ts`,
  `apps/daemon/src/cells/stream-proxy.ts`, `apps/daemon/src/static-ui.ts` (a stub holding `webDir`;
  Task 12 replaces it)
- Modify: `apps/daemon/src/app.ts`, `apps/daemon/src/main.ts`
- Test: `apps/daemon/src/static-files.test.ts`, `apps/daemon/src/cells/watchdog.test.ts`,
  `apps/daemon/src/cells/stream-proxy.test.ts`

**Interfaces:**
- Produces: `readStatic(dir, rel): { body: Uint8Array<ArrayBuffer>; type: string } | undefined` (never escapes `dir`);
  `class StallWatchdog { constructor({ pingEveryMs, stallAfterMs, ping(), onChange(state, lastAt), now? }); start(); touch(); stop(); get lastAt }`;
  `STREAM_PING_MS = 500`, `STREAM_STALL_MS = 1500`;
  `interface StreamProxyDeps { cells: CellApi; tickets: TicketRegistry; vendorDir: string; pingEveryMs?; stallAfterMs? }`;
  `desktopRoutes(app, deps)` (HTTP: `GET|HEAD /cells/:id/desktop/:ticket/*`), `desktopStreamRoute(deps): UpgradeRoute`
  (`/cells/:id/desktop/:ticket/api/websockets`, `auth: "ticket"`; dials the cell first, completes the
  viewer's upgrade from the cell socket's `open`, and answers 502 when the cell refuses or can't be
  reached); `AppOptions` gains `desktop?: StreamProxyDeps`.

- [ ] **Step 1: Static file reader with a traversal guard**

`apps/daemon/src/static-files.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStatic } from "./static-files.ts";

describe("readStatic", () => {
  const dir = mkdtempSync(join(tmpdir(), "local dot's static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>hi</html>");
  writeFileSync(join(dir, "assets", "a.js"), "export {}");
  writeFileSync(join(tmpdir(), "ld-outside.txt"), "secret");

  it("serves files under the directory with their media type", () => {
    expect(readStatic(dir, "/index.html")).toEqual({ body: Buffer.from("<html>hi</html>"), type: "text/html; charset=utf-8" });
    expect(readStatic(dir, "assets/a.js")?.type).toBe("text/javascript; charset=utf-8");
  });

  it("refuses paths that escape the directory, directories and missing files", () => {
    expect(readStatic(dir, "/../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets/../../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets")).toBeUndefined();
    expect(readStatic(dir, "/nope.js")).toBeUndefined();
  });
});
```

`apps/daemon/src/static-files.ts`:
```ts
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

export function readStatic(dir: string, rel: string): StaticFile | undefined {
  const root = resolve(dir);
  const file = resolve(root, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  try {
    if (!statSync(file).isFile()) return undefined;
    return { body: readFileSync(file), type: TYPES[extname(file)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}
```

Run: `pnpm exec vitest run apps/daemon/src/static-files.test.ts`
Expected: 2 tests pass.

- [ ] **Step 2: The watchdog**

`apps/daemon/src/cells/watchdog.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StallWatchdog } from "./watchdog.ts";

describe("StallWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pings on every tick, reports stalled after silence and live again on the next sign of life", () => {
    const pings: number[] = [];
    const changes: string[] = [];
    const dog = new StallWatchdog({
      pingEveryMs: 100,
      stallAfterMs: 250,
      ping: () => pings.push(Date.now()),
      onChange: (state) => changes.push(state),
    });
    dog.start();
    vi.advanceTimersByTime(200);
    dog.touch();
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(changes).toEqual(["stalled"]);
    expect(pings).toHaveLength(6);
    dog.touch();
    expect(changes).toEqual(["stalled", "live"]);
    dog.stop();
    vi.advanceTimersByTime(1000);
    expect(pings).toHaveLength(6);
  });
});
```

`apps/daemon/src/cells/watchdog.ts`:
```ts
export type WatchdogState = "live" | "stalled";

export interface WatchdogOptions {
  pingEveryMs: number;
  stallAfterMs: number;
  ping(): void;
  onChange(state: WatchdogState, lastAt: number): void;
  now?: () => number;
}

export class StallWatchdog {
  #timer: NodeJS.Timeout | undefined;
  #lastAt = 0;
  #state: WatchdogState = "live";
  readonly #opts: WatchdogOptions;
  readonly #now: () => number;

  constructor(opts: WatchdogOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get lastAt(): number {
    return this.#lastAt;
  }

  start(): void {
    this.#lastAt = this.#now();
    this.#state = "live";
    this.#timer = setInterval(() => this.#tick(), this.#opts.pingEveryMs);
  }

  touch(): void {
    this.#lastAt = this.#now();
    if (this.#state === "stalled") {
      this.#state = "live";
      this.#opts.onChange("live", this.#lastAt);
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #tick(): void {
    this.#opts.ping();
    if (this.#state === "live" && this.#now() - this.#lastAt > this.#opts.stallAfterMs) {
      this.#state = "stalled";
      this.#opts.onChange("stalled", this.#lastAt);
    }
  }
}
```

Run: `pnpm exec vitest run apps/daemon/src/cells/watchdog.test.ts`
Expected: 1 test passes.

- [ ] **Step 3: Write the failing proxy test**

`apps/daemon/src/cells/stream-proxy.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { attachUpgradeRouter } from "../upgrade-router.ts";
import { TicketRegistry } from "./secrets.ts";
import { desktopStreamRoute } from "./stream-proxy.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import { NO_STREAM } from "./types.ts";

const TOKEN = "s".repeat(43);
const AUTH = `Basic ${Buffer.from("localdot:streamtoken").toString("base64")}`;
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

// A Selkies stand-in: basic auth on every request and upgrade, /api/health, an echoing WebSocket
// that answers pings only while `alive` (ws's automatic pong is off), and a way to drop the connection.
async function fakeSelkies() {
  const port = await freePort();
  const seenAuth: (string | undefined)[] = [];
  const state = { alive: true, sockets: new Set<WebSocket>() };
  const server = createHttpServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  const wss = new WebSocketServer({
    server,
    path: "/api/websockets",
    autoPong: false,
    verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.authorization === AUTH,
  });
  wss.on("connection", (ws, req) => {
    seenAuth.push(req.headers.authorization);
    state.sockets.add(ws);
    ws.on("ping", () => {
      if (state.alive) ws.pong();
    });
    ws.on("message", (data, isBinary) => ws.send(isBinary ? Buffer.concat([Buffer.from("echo:"), data as Buffer]) : `echo:${data}`, { binary: isBinary }));
    ws.on("close", () => state.sockets.delete(ws));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  stops.push(() => server.close());
  return { baseUrl: `http://127.0.0.1:${port}`, seenAuth, state };
}

async function daemon(upstreamBaseUrl: string) {
  const port = await freePort();
  const cells = new FakeOrchestrator();
  const tickets = new TicketRegistry();
  const vendorDir = mkdtempSync(join(tmpdir(), "local dot's vendor-"));
  mkdirSync(join(vendorDir, "assets"));
  writeFileSync(join(vendorDir, "index.html"), "<html>selkies-core</html>");
  writeFileSync(join(vendorDir, "assets", "core.js"), "// core");
  const desktop = { cells, tickets, vendorDir, pingEveryMs: 50, stallAfterMs: 150 };
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's proxy-")));
  const app = createApp({ token: TOKEN, port, eventLog, cells: { cells, tickets }, desktop });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(server as Server, { port, token: TOKEN }, [desktopStreamRoute(desktop)]);
  await new Promise((r) => server.once("listening", r));
  stops.push(() => {
    server.close();
    eventLog.close();
  });
  const id = ulid();
  cells.emit({ id, state: "ready", scale: 2, createdAt: new Date().toISOString(), stream: NO_STREAM });
  cells.endpointsById.set(id, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: "x".repeat(43) },
    stream: { baseUrl: upstreamBaseUrl, authorization: AUTH },
  });
  const ticket = tickets.issue(id);
  const origin = `http://127.0.0.1:${port}`;
  const prefix = `/cells/${id}/desktop/${ticket}`;
  const open = (path: string) => new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
  const connections = (id2: string) => cells.streamUpdates.filter((u) => u.id === id2).map((u) => u.patch.connection);
  return { port, cells, tickets, id, ticket, prefix, origin, open, connections, fetch: (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init) };
}

describe("desktop stream proxy", () => {
  it("serves the vendored client and proxies api/* with the cell's credential", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const index = await d.fetch(`${d.prefix}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("selkies-core");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect((await d.fetch(`${d.prefix}/assets/core.js`)).status).toBe(200);
    const health = await d.fetch(`${d.prefix}/api/health?x=1`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ path: "/api/health?x=1" });
    expect(selkies.seenAuth).toEqual([AUTH]);
    expect((await d.fetch(`${d.prefix}/api/health`, { method: "POST" })).status).toBe(405);
  });

  it("refuses wrong tickets, other cells' tickets and traversal", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    expect((await d.fetch(`/cells/${d.id}/desktop/${"A".repeat(22)}/`)).status).toBe(403);
    const other = ulid();
    expect((await d.fetch(`/cells/${other}/desktop/${d.ticket}/`)).status).toBe(403);
    // fetch() and the daemon's URL parsing fold "../" and "%2e%2e/" away before any route runs; an
    // encoded separator survives both and reaches readStatic's guard, aimed at a file that exists.
    writeFileSync(join(tmpdir(), "ld-proxy-outside.txt"), "secret");
    expect((await d.fetch(`${d.prefix}/..%2fld-proxy-outside.txt`)).status).toBe(404);
    expect((await d.fetch(`${d.prefix}/assets/..%2f..%2fld-proxy-outside.txt`)).status).toBe(404);
    d.tickets.revoke(d.id);
    expect((await d.fetch(`${d.prefix}/`)).status).toBe(403);
    expect(selkies.seenAuth).toEqual([]);
  });

  it("relays the WebSocket both ways, pings upstream, and reports stalled and live", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await new Promise((r) => ws.once("open", r));
    const echoed = new Promise<string>((r) => ws.once("message", (data) => r(String(data))));
    ws.send("hello");
    expect(await echoed).toBe("echo:hello");
    const binary = new Promise<Buffer>((r) => ws.once("message", (data) => r(data as Buffer)));
    ws.send(Buffer.from([1, 2, 3]));
    expect([...(await binary)]).toEqual([...Buffer.from("echo:"), 1, 2, 3]);
    await settle(200);
    expect(d.connections(d.id).at(-1)).toBe("live");
    selkies.state.alive = false;
    await settle(400);
    expect(d.connections(d.id).at(-1)).toBe("stalled");
    selkies.state.alive = true;
    await settle(200);
    expect(d.connections(d.id).at(-1)).toBe("live");
    expect(d.cells.get(d.id)?.stream.viewers).toBe(1);
    ws.close();
    await settle(100);
    expect(d.cells.get(d.id)?.stream.viewers).toBe(0);
    expect(d.connections(d.id).at(-1)).toBe("none");
  });

  it("closes the viewer with 1012 and reports disconnected when the upstream drops", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    for (const s of selkies.state.sockets) s.terminate();
    expect(await closed).toBe(1012);
    expect(d.connections(d.id).at(-1)).toBe("disconnected");
  });

  it("refuses a stream upgrade with a bad ticket, when the cell refuses it, or without endpoints", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const bad = d.open(`/cells/${d.id}/desktop/${"B".repeat(22)}/api/websockets`);
    expect(await new Promise<string>((r) => bad.once("error", (e) => r(e.message)))).toContain("403");
    d.cells.endpointsById.set(d.id, {
      desktopd: { baseUrl: "http://127.0.0.1:1", token: "x".repeat(43) },
      stream: { baseUrl: selkies.baseUrl, authorization: "Basic d3Jvbmc=" },
    });
    const refused = d.open(`${d.prefix}/api/websockets`);
    expect(await new Promise<string>((r) => refused.once("error", (e) => r(e.message)))).toContain("502");
    d.cells.endpointsById.delete(d.id);
    const gone = d.open(`${d.prefix}/api/websockets`);
    expect(await new Promise<string>((r) => gone.once("error", (e) => r(e.message)))).toContain("503");
  });
});
```

- [ ] **Step 4: Run it to see it fail, then implement the proxy**

Run: `pnpm exec vitest run apps/daemon/src/cells/stream-proxy.test.ts`
Expected: FAIL — `Failed to load url ./stream-proxy.ts`.

`apps/daemon/src/cells/stream-proxy.ts`:
```ts
import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { readStatic } from "../static-files.ts";
import { refuse, type UpgradeContext, type UpgradeRoute } from "../upgrade-router.ts";
import type { CellApi } from "./orchestrator.ts";
import type { TicketRegistry } from "./secrets.ts";
import type { StreamConnection } from "./types.ts";
import { StallWatchdog } from "./watchdog.ts";

// Selkies' stream socket is an aiohttp WebSocketResponse(heartbeat=30): the server pings only every
// 30 s and encodes video only on damage, so liveness rests on the daemon's own ping every 0.5 s,
// which the server answers; 1.5 s without a pong, a message or a server ping is a stall (S8
// measured the idle cadence; raise STREAM_STALL_MS if its FINDINGS says so).
export const STREAM_PING_MS = 500;
export const STREAM_STALL_MS = 1500;

export interface StreamProxyDeps {
  cells: CellApi;
  tickets: TicketRegistry;
  vendorDir: string;
  pingEveryMs?: number;
  stallAfterMs?: number;
}

function cellFor(deps: StreamProxyDeps, id: string, ticket: string): string | undefined {
  if (!ULID_PATTERN.test(id)) return undefined;
  return deps.tickets.resolve(ticket) === id ? id : undefined;
}

export function desktopRoutes(app: Hono, deps: StreamProxyDeps): void {
  app.on(["GET", "HEAD"], "/cells/:id/desktop/:ticket/*", async (c) => {
    const id = c.req.param("id") ?? "";
    const ticket = c.req.param("ticket") ?? "";
    if (!cellFor(deps, id, ticket)) return c.text("forbidden", 403);
    const url = new URL(c.req.url);
    const rel = url.pathname.slice(`/cells/${id}/desktop/${ticket}`.length) || "/";
    if (rel.startsWith("/api/")) return proxyApi(c, deps, id, `${rel}${url.search}`);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return c.text("bad path", 400);
    }
    const file = readStatic(deps.vendorDir, decoded === "/" ? "/index.html" : decoded);
    if (!file) return c.text("not found", 404);
    return c.body(file.body, 200, { "content-type": file.type, "cache-control": "no-store" });
  });
  app.all("/cells/:id/desktop/:ticket/*", (c) => c.text("method not allowed", 405));
}

async function proxyApi(c: Context, deps: StreamProxyDeps, id: string, pathWithQuery: string): Promise<Response> {
  const endpoints = deps.cells.endpoints(id);
  if (!endpoints) return c.text("cell not running", 503);
  try {
    const upstream = await fetch(`${endpoints.stream.baseUrl}${pathWithQuery}`, {
      method: c.req.method,
      headers: { authorization: endpoints.stream.authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const headers = new Headers({ "cache-control": "no-store" });
    const type = upstream.headers.get("content-type");
    if (type) headers.set("content-type", type);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return c.text(`upstream failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
}

export function desktopStreamRoute(deps: StreamProxyDeps): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true });
  const viewers = new Map<string, number>();
  return {
    pattern: /^\/cells\/([^/]+)\/desktop\/([^/]+)\/api\/websockets$/,
    params: ["id", "ticket"],
    auth: "ticket",
    open({ req, socket, head, url, params }) {
      const id = cellFor(deps, params.id ?? "", params.ticket ?? "");
      if (!id) {
        refuse(socket, "403 Forbidden");
        return;
      }
      const endpoints = deps.cells.endpoints(id);
      if (!endpoints) {
        refuse(socket, "503 Service Unavailable");
        return;
      }
      const upstreamUrl = `${endpoints.stream.baseUrl.replace(/^http/, "ws")}/api/websockets${url.search}`;
      relay({ req, socket, head }, { id, upstreamUrl, authorization: endpoints.stream.authorization, deps, viewers, wss });
    },
  };
}

interface RelayOptions {
  id: string;
  upstreamUrl: string;
  authorization: string;
  deps: StreamProxyDeps;
  viewers: Map<string, number>;
  wss: WebSocketServer;
}

// The cell is dialled first and the viewer's upgrade completes from its open: Selkies' client sends
// its settings the moment its socket opens, and the server streams nothing until it has them.
function relay({ req, socket, head }: Pick<UpgradeContext, "req" | "socket" | "head">, opts: RelayOptions): void {
  const { id, deps, viewers } = opts;
  const count = (delta: number) => viewers.set(id, Math.max(0, (viewers.get(id) ?? 0) + delta));
  const report = (connection: StreamConnection, lastUpstreamAt: number | null) =>
    deps.cells.updateStream(id, { connection, viewers: viewers.get(id) ?? 0, lastUpstreamAt });
  const upstream = new WebSocket(opts.upstreamUrl, { headers: { authorization: opts.authorization }, perMessageDeflate: false });
  const watchdog = new StallWatchdog({
    pingEveryMs: deps.pingEveryMs ?? STREAM_PING_MS,
    stallAfterMs: deps.stallAfterMs ?? STREAM_STALL_MS,
    ping: () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.ping();
    },
    onChange: (state, lastAt) => report(state, lastAt),
  });
  let client: WebSocket | undefined;
  let viewerGone = false;
  const abandon = () => {
    viewerGone = true;
    upstream.terminate();
  };
  socket.once("close", abandon);
  count(1);
  report("connecting", null);

  upstream.on("open", () => {
    opts.wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", abandon);
      client = ws;
      ws.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        viewerGone = true;
        upstream.close();
      });
      watchdog.start();
      report("live", Date.now());
    });
  });
  upstream.on("message", (data, isBinary) => {
    watchdog.touch();
    if (client?.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("ping", () => watchdog.touch());
  upstream.on("pong", () => watchdog.touch());
  upstream.on("error", () => {});
  upstream.on("close", () => {
    watchdog.stop();
    count(-1);
    report(viewerGone ? "none" : "disconnected", watchdog.lastAt || null);
    if (client?.readyState === WebSocket.OPEN) client.close(1012, "upstream closed");
    else if (!client && !viewerGone) refuse(socket, "502 Bad Gateway");
  });
}
```

`apps/daemon/src/app.ts` — add the option and the routes (before `cellRoutes`, outside the
`/api/*` token middleware, because the iframe carries no token):
```ts
import { desktopRoutes, type StreamProxyDeps } from "./cells/stream-proxy.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
  desktop?: StreamProxyDeps;
}
// inside createApp, after the host/origin guard middleware and before the /api/* token middleware:
  if (desktop) desktopRoutes(app, desktop);
```

`apps/daemon/src/main.ts` — wire it:
```ts
import { desktopStreamRoute } from "./cells/stream-proxy.ts";
import { webDir } from "./static-ui.ts";
// ...
const desktop = { cells: orchestrator, tickets, vendorDir: webDir("vendor/selkies") };
const app = createApp({ token, port, eventLog, cells: { cells: orchestrator, tickets }, desktop });
// ...
attachUpgradeRouter(server as Server, { port, token }, [
  sessionStreamRoute(eventLog),
  cellStatusRoute(orchestrator),
  desktopStreamRoute(desktop),
]);
```
`webDir` is written in Task 12 (`apps/daemon/src/static-ui.ts`); until then, create that file with
only:
```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// apps/daemon/src → apps/web/<sub>; fileURLToPath keeps the apostrophe in the repo path intact.
export function webDir(sub: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", sub);
}
```

- [ ] **Step 5: Run the suites**

Run: `pnpm exec vitest run apps/daemon/src/cells/stream-proxy.test.ts apps/daemon/src/app.test.ts apps/daemon/src/cells/api.test.ts`
Expected: 5 proxy tests pass; the app and API tests still pass. The stall test waits about one
second in total; if it is flaky on a loaded machine, raise `settle(400)` to `settle(600)` once and
leave it.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(daemon): desktop stream proxy with tickets and a stall watchdog"
```

---
### Task 12: Web app scaffold — token bootstrap, API and WebSocket clients, served by the daemon

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`,
  `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/theme.css`
- Create: `apps/web/src/lib/token.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/socket.ts`
- Create: `apps/web/e2e/shot.ts`, `apps/web/e2e/tsconfig.json`
- Create: `apps/daemon/src/static-ui.ts` (replace the stub from Task 11)
- Modify: `apps/daemon/src/app.ts`, `apps/daemon/src/main.ts`, root `package.json`, `biome.json`
- Test: `apps/web/src/lib/token.test.ts`, `apps/web/src/lib/api.test.ts`, `apps/web/src/lib/socket.test.ts`,
  `apps/web/src/App.test.tsx`, `apps/daemon/src/static-ui.test.ts`

**Interfaces:**
- Produces: `bootstrapToken(host?): string | null`, `forgetToken(host?)`, `TOKEN_KEY = "localdot.token"`;
  `createApi(token, { fetchImpl?, onUnauthorized?, origin? }): ApiClient` with
  `get<T>(path)`, `post<T>(path, body?)`, `del(path)`, `socketUrl(path)`, `socketProtocols()`
  (`["localdot.v1", "localdot.token.<t>"]`), `ApiError { status }`;
  `openSocket({ url, protocols, handlers: { onMessage, onOpen?, onClose? }, WebSocketImpl?, backoffMs? }): { close() }`;
  daemon `serveUi(app, dir)` (`GET /` → `index.html` no-store, `GET /assets/*` immutable, 503 with a
  build hint when `dist` is missing), `webDir(sub)`; `AppOptions.ui?: { dir: string }`;
  `pnpm --filter @localdot/web shot <url> <out.png> [w] [h] [settleMs]` (system Chrome, DPR 2, a
  fresh profile with no stored token, so pass the `#token=` URL; prints the final URL);
  `theme.css` tokens named after Tailwind 4's theme namespaces, in a `:root` block that M4 moves
  into `@theme` (`--color-*`, `--font-ui`, `--font-mono`, `--spacing-rail`, `--radius-stage`,
  `--shadow-stage`, `--ease-press`; `--duration-press` is localDot's own).

- [ ] **Step 1: Package, configs and the root changes**

`apps/web/package.json`:
```json
{
  "name": "@localdot/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "typecheck": "tsc --noEmit -p . && tsc --noEmit -p e2e",
    "shot": "tsx e2e/shot.ts",
    "e2e": "playwright test"
  },
  "dependencies": {
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@testing-library/dom": "10.4.2",
    "@testing-library/react": "16.3.3",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "sharp": "0.35.5",
    "tsx": "4.23.15",
    "vite": "8.3.1"
  }
}
```

`apps/web/vite.config.ts`:
```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", target: "es2024", sourcemap: true },
  worker: { format: "es" },
});
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["es2024", "dom", "dom.iterable"],
    "types": ["vite/client"],
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

`apps/web/e2e/tsconfig.json`:
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "lib": ["es2024", "dom"], "types": ["node"] },
  "include": ["."]
}
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>localDot</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Root `package.json`: add `"jsdom": "30.1.1"` to `devDependencies` (Vitest resolves the `jsdom`
environment from the root). `biome.json` `files.includes`:
```json
  "files": { "includes": ["**", "!spikes", "!packages/protocol/schema", "!apps/web/vendor", "!apps/web/dist"] },
```

Run: `pnpm install`
Expected: React, Vite, Playwright, Testing Library, jsdom and sharp are added to the lockfile.
(Playwright's own browsers are not needed: the screenshot script and the e2e use the installed
Google Chrome through `channel: "chrome"`.)

- [ ] **Step 2: Write the failing library tests**

`apps/web/src/lib/token.test.ts`:
```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapToken, forgetToken, TOKEN_KEY } from "./token.ts";

const GOOD = "a".repeat(43);

describe("bootstrapToken", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("stores a token from the fragment and removes the fragment from the address bar", () => {
    window.location.hash = `#token=${GOOD}`;
    expect(bootstrapToken()).toBe(GOOD);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(GOOD);
    expect(window.location.hash).toBe("");
    expect(window.location.href.endsWith("/")).toBe(true);
  });

  it("ignores a malformed fragment token but still clears the fragment", () => {
    window.location.hash = "#token=abc";
    expect(bootstrapToken()).toBeNull();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("returns the stored token when there is no fragment, and nothing when the stored one is malformed", () => {
    window.localStorage.setItem(TOKEN_KEY, GOOD);
    expect(bootstrapToken()).toBe(GOOD);
    window.localStorage.setItem(TOKEN_KEY, "short");
    expect(bootstrapToken()).toBeNull();
  });

  it("forgets the token", () => {
    window.localStorage.setItem(TOKEN_KEY, GOOD);
    forgetToken();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
```

`apps/web/src/lib/api.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api.ts";

const TOKEN = "t".repeat(43);
const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { "content-type": "application/json" } });

describe("createApi", () => {
  it("sends the bearer token, JSON bodies, and parses replies", async () => {
    const fetchImpl = vi.fn(async () => reply(202, { id: "x" }));
    const api = createApi(TOKEN, { fetchImpl, origin: "http://127.0.0.1:4750" });
    expect(await api.post("/api/cells", { scale: 2 })).toEqual({ id: "x" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4750/api/cells");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe('{"scale":2}');
  });

  it("resolves undefined for empty replies and throws ApiError with the body text otherwise", async () => {
    const api = createApi(TOKEN, { fetchImpl: async () => reply(204), origin: "http://x" });
    await expect(api.del("/api/cells/1")).resolves.toBeUndefined();
    const failing = createApi(TOKEN, { fetchImpl: async () => new Response("cell is starting", { status: 409 }), origin: "http://x" });
    const err = await failing.post("/api/cells/1/stream-ticket").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: "cell is starting" });
  });

  it("reports a 401 once through onUnauthorized and throws", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi(TOKEN, { fetchImpl: async () => reply(401), origin: "http://x", onUnauthorized });
    await expect(api.get("/api/whoami")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("builds WebSocket URLs and offers both subprotocols", () => {
    const api = createApi(TOKEN, { origin: "http://127.0.0.1:4750" });
    expect(api.socketUrl("/api/cells/1/status")).toBe("ws://127.0.0.1:4750/api/cells/1/status");
    expect(api.socketProtocols()).toEqual(["localdot.v1", `localdot.token.${TOKEN}`]);
  });
});
```

`apps/web/src/lib/socket.test.ts`:
```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSocket } from "./socket.ts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

describe("openSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("opens with both subprotocols, delivers messages, and reconnects with backoff until closed", () => {
    const got: string[] = [];
    const handle = openSocket({
      url: "ws://127.0.0.1:4750/api/cells/1/status",
      protocols: ["localdot.v1", "localdot.token.t"],
      handlers: { onMessage: (d) => got.push(d) },
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      backoffMs: { min: 100, max: 400 },
    });
    const first = FakeWebSocket.instances[0];
    expect(first?.protocols).toEqual(["localdot.v1", "localdot.token.t"]);
    first?.onopen?.();
    first?.onmessage?.({ data: '{"a":1}' });
    expect(got).toEqual(['{"a":1}']);
    first?.onclose?.();
    vi.advanceTimersByTime(99);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]?.onclose?.();
    vi.advanceTimersByTime(200);
    expect(FakeWebSocket.instances).toHaveLength(3);
    handle.close();
    expect(FakeWebSocket.instances[2]?.closed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run them to see them fail, then implement the library**

Run: `pnpm exec vitest run apps/web/src/lib`
Expected: FAIL — three `Failed to load url` errors.

`apps/web/src/lib/token.ts`:
```ts
export const TOKEN_KEY = "localdot.token";
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

export interface TokenHost {
  location: { hash: string; pathname: string; search: string };
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  history: { replaceState(data: unknown, unused: string, url?: string): void };
}

// The daemon opens http://127.0.0.1:4750/#token=<t>. The fragment never reaches the daemon and is
// removed from the address bar once stored, so history and bookmarks never keep the token.
export function bootstrapToken(host: TokenHost = window): string | null {
  const given = new URLSearchParams(host.location.hash.replace(/^#/, "")).get("token");
  if (given !== null) {
    if (TOKEN_PATTERN.test(given)) safely(() => host.localStorage.setItem(TOKEN_KEY, given));
    host.history.replaceState(null, "", `${host.location.pathname}${host.location.search}`);
  }
  const stored = safely(() => host.localStorage.getItem(TOKEN_KEY)) ?? null;
  return stored !== null && TOKEN_PATTERN.test(stored) ? stored : null;
}

export function forgetToken(host: Pick<TokenHost, "localStorage"> = window): void {
  safely(() => host.localStorage.removeItem(TOKEN_KEY));
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
```

`apps/web/src/lib/api.ts`:
```ts
export const WS_PROTOCOL = "localdot.v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  socketUrl(path: string): string;
  socketProtocols(): string[];
}

export interface ApiOptions {
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
  origin?: string;
}

export function createApi(token: string, opts: ApiOptions = {}): ApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const origin = opts.origin ?? window.location.origin;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      opts.onUnauthorized?.();
      throw new ApiError(401, "unauthorized");
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text || res.statusText);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    del: async (path) => {
      await call("DELETE", path);
    },
    socketUrl: (path) => `${origin.replace(/^http/, "ws")}${path}`,
    socketProtocols: () => [WS_PROTOCOL, `localdot.token.${token}`],
  };
}
```

`apps/web/src/lib/socket.ts`:
```ts
export interface SocketHandlers {
  onMessage(data: string): void;
  onOpen?(): void;
  onClose?(): void;
}

export interface SocketOptions {
  url: string;
  protocols: string[];
  handlers: SocketHandlers;
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: { min: number; max: number };
}

export interface SocketHandle {
  close(): void;
}

// Reconnects with doubling backoff until close(). The daemon selects localdot.v1 and never the
// localdot.token.<t> entry, which only rides along for authentication.
export function openSocket(opts: SocketOptions): SocketHandle {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const backoff = opts.backoffMs ?? { min: 500, max: 5000 };
  let delay = backoff.min;
  let closed = false;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    ws = new Impl(opts.url, opts.protocols);
    ws.onopen = () => {
      delay = backoff.min;
      opts.handlers.onOpen?.();
    };
    ws.onmessage = (e) => opts.handlers.onMessage(String(e.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      ws = null;
      opts.handlers.onClose?.();
      if (closed) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(backoff.max, delay * 2);
    };
  };
  connect();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
```

Run: `pnpm exec vitest run apps/web/src/lib`
Expected: 9 tests pass.

- [ ] **Step 4: The app shell (token states) and the theme tokens**

`apps/web/src/theme.css` (the Theatre tokens from `c-theatre.html`, named after Tailwind 4's theme
namespaces in a `:root` block that M4 moves into `@theme` — P2-R4; `--duration-*` is localDot's own,
not a Tailwind namespace; every colour the UI uses comes from here so a theme pack can restyle it):
```css
:root {
  color-scheme: dark;
  --color-void: #0a0b0d;
  --color-surface: #15161a;
  --color-surface-2: #1d1e23;
  --color-line: #25272c;
  --color-text: #eeeff1;
  --color-text-2: #999ca4;
  --color-text-3: #5d6068;
  --color-xenon: #3fb5de;
  --color-xenon-a08: rgba(63, 181, 222, 0.08);
  --color-xenon-a40: rgba(63, 181, 222, 0.4);
  --color-hud: rgba(14, 15, 18, 0.74);
  --color-hud-solid: rgba(14, 15, 18, 0.92);
  --color-hud-line: rgba(255, 255, 255, 0.1);
  --color-hud-button: rgba(255, 255, 255, 0.08);
  --color-edge: rgba(0, 0, 0, 0.55);
  --color-edge-stage: rgba(255, 255, 255, 0.05);
  --color-shade-hud: rgba(0, 0, 0, 0.35);
  --color-cursor-fill: #ffffff;
  --color-cursor-rim: #121316;
  --color-avatar-body: #ecedef;
  --color-avatar-eye: #0a0b0d;
  --font-ui: -apple-system, "Inter", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --spacing-rail: 264px;
  --radius-stage: 12px;
  --shadow-stage: 0 30px 80px var(--color-edge), 0 0 0 1px var(--color-edge-stage);
  --duration-press: 100ms;
  --ease-press: ease-out;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#root {
  height: 100%;
}

body {
  background: var(--color-void);
  color: var(--color-text);
  font: 13.5px/1.55 var(--font-ui);
  font-optical-sizing: auto;
  -webkit-font-smoothing: antialiased;
}

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}

button:active {
  transform: scale(0.97);
  transition: transform var(--duration-press) var(--ease-press);
}

.notice {
  max-width: 480px;
  margin: 20vh auto 0;
  padding: 0 16px;
  color: var(--color-text-2);
}

.notice h1 {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-text);
  margin-bottom: 8px;
}

.notice code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--color-text);
}

@media (prefers-reduced-motion: reduce) {
  button:active {
    transform: none;
  }
}
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/web/src/App.tsx` (Task 13 replaces the connected branch with the Theatre shell):
```tsx
import { useEffect, useMemo, useState } from "react";
import { type ApiClient, createApi } from "./lib/api.ts";
import { bootstrapToken, forgetToken } from "./lib/token.ts";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => bootstrapToken());
  const [rejected, setRejected] = useState(false);
  const api = useMemo<ApiClient | null>(
    () =>
      token
        ? createApi(token, {
            fetchImpl,
            onUnauthorized: () => {
              forgetToken();
              setRejected(true);
              setToken(null);
            },
          })
        : null,
    [token, fetchImpl],
  );
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setConnected(false);
    api.get("/api/whoami").then(
      () => {
        if (!cancelled) setConnected(true);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!api) return <NoToken rejected={rejected} />;
  return <p className="notice">{connected ? "Connected to the daemon." : "Connecting…"}</p>;
}

function NoToken({ rejected }: { rejected: boolean }) {
  return (
    <section className="notice" role="alert">
      <h1>No access token</h1>
      <p>
        {rejected ? "The daemon rejected the stored token." : "This page needs the install token."} Open
        the link the daemon printed at startup: <code>http://127.0.0.1:4750/#token=…</code>
      </p>
    </section>
  );
}
```

`apps/web/src/App.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { TOKEN_KEY } from "./lib/token.ts";

const ok = async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
const unauthorized = async () => new Response("unauthorized", { status: 401 });

describe("App token states", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  // Vitest runs without globals, so Testing Library's automatic cleanup never registers.
  afterEach(cleanup);

  it("asks for the token when none is stored", () => {
    render(<App fetchImpl={ok as typeof fetch} />);
    expect(screen.getByRole("alert").textContent).toContain("No access token");
  });

  it("connects with a stored token", async () => {
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(43));
    render(<App fetchImpl={ok as typeof fetch} />);
    expect(await screen.findByText("Connected to the daemon.")).toBeTruthy();
  });

  it("forgets a rejected token and says so", async () => {
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(43));
    render(<App fetchImpl={unauthorized as typeof fetch} />);
    expect(await screen.findByText(/rejected the stored token/)).toBeTruthy();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
```

Run: `pnpm exec vitest run apps/web/src`
Expected: 12 tests pass.

- [ ] **Step 5: The daemon serves the built UI**

`apps/daemon/src/static-ui.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

function appWithUi(dir: string) {
  return createApp({ token: TOKEN, port: PORT, eventLog: new EventLog(mkdtempSync(join(tmpdir(), "local dot's ui-"))), ui: { dir } });
}

describe("serveUi", () => {
  it("serves index.html and hashed assets without a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local dot's dist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html>localDot</html>");
    writeFileSync(join(dir, "assets", "index-abc.js"), "// app");
    const app = appWithUi(dir);
    const index = await app.request(url("/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(await index.text()).toContain("localDot");
    const asset = await app.request(url("/assets/index-abc.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    // URL parsing folds "../" and "%2e%2e/" away before routing; an encoded separator survives and
    // reaches readStatic's guard, aimed at a file that exists outside dist.
    writeFileSync(join(tmpdir(), "ld-ui-outside.txt"), "secret");
    expect((await app.request(url("/assets/..%2f..%2fld-ui-outside.txt"))).status).toBe(404);
  });

  it("explains how to build the UI when dist is missing", async () => {
    const res = await appWithUi(join(tmpdir(), "local dot's missing-dist")).request(url("/"));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pnpm --filter @localdot/web build");
  });
});
```

`apps/daemon/src/static-ui.ts` (replace the Task 11 stub):
```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { readStatic } from "./static-files.ts";

// apps/daemon/src → apps/web/<sub>; fileURLToPath keeps the apostrophe in the repo path intact.
export function webDir(sub: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", sub);
}

const BUILD_HINT = "UI not built: run pnpm --filter @localdot/web build";

export function serveUi(app: Hono, dir: string): void {
  app.get("/", (c) => {
    const file = readStatic(dir, "/index.html");
    if (!file) return c.text(BUILD_HINT, 503);
    return c.body(file.body, 200, { "content-type": file.type, "cache-control": "no-store" });
  });
  app.get("/assets/*", (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("bad path", 400);
    }
    const file = readStatic(dir, rel);
    if (!file) return c.text("not found", 404);
    return c.body(file.body, 200, { "content-type": file.type, "cache-control": "public, max-age=31536000, immutable" });
  });
}
```

`apps/daemon/src/app.ts` — add `ui?: { dir: string }` to `AppOptions` and, after the host/origin
guard middleware, `if (ui) serveUi(app, ui.dir);`. `apps/daemon/src/main.ts` — pass
`ui: { dir: webDir("dist") }` into `createApp`.

Run: `pnpm exec vitest run apps/daemon/src/static-ui.test.ts apps/daemon/src/app.test.ts`
Expected: all pass.

- [ ] **Step 6: The screenshot script, build, and the screenshot check**

`apps/web/e2e/shot.ts`:
```ts
import { chromium } from "@playwright/test";

const [url, out, width = "1440", height = "900", settleMs = "1000"] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: pnpm --filter @localdot/web shot <url> <out.png> [width] [height] [settleMs]");
  process.exit(2);
}
// A fresh profile every run: it holds no install token, so the URL must carry #token=.
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(settleMs));
await page.screenshot({ path: out });
console.log(`wrote ${out}; final url ${page.url()}`);
await browser.close();
```

Run:
```bash
pnpm --filter @localdot/web build
LOCALDOT_HOME="$(mktemp -d)/local dot's home" pnpm --filter @localdot/daemon start
```
In a second terminal, with the token the daemon printed (pnpm runs `shot` inside `apps/web`, so its
output path is relative to that package):
```bash
mkdir -p apps/web/e2e/out
pnpm --filter @localdot/web shot http://127.0.0.1:4750/ e2e/out/no-token.png
pnpm --filter @localdot/web shot "http://127.0.0.1:4750/#token=<token>" e2e/out/connected.png
```
Expected: the first screenshot shows the "No access token" notice on the void background; the
second shows "Connected to the daemon." and the script prints `final url http://127.0.0.1:4750/`
(fragment gone). Look at both PNGs in `apps/web/e2e/out/`. Stop the daemon.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web apps/daemon package.json pnpm-lock.yaml biome.json
git commit -m "feat(web): Vite app with token bootstrap and the daemon API client"
```

---
### Task 13: The Theatre shell

The decided direction, built from CSS tokens: the void surround, one large lit stage box (empty in
this task; the live picture arrives in Task 14), the status HUD floating on the picture with the
Start/Stop control, a caption under the stage, two quiet rails (conversation left with the mascot
dock, plan and steps right) and the top bar with the mode switch. No xenon anywhere: nobody holds
control in Part 2. Read `~/.agents/skills/apple-design/SKILL.md` first; the mockup is
`docs/superpowers/design/2026-09-30-localdot-ui-directions/c-theatre.html` in the umbrella repo.

**Files:**
- Create: `apps/web/src/app.css`, `apps/web/src/cells/types.ts`, `apps/web/src/cells/hud-state.ts`,
  `apps/web/src/cells/useCell.ts`, `apps/web/src/shell/TopBar.tsx`, `apps/web/src/shell/ConversationRail.tsx`,
  `apps/web/src/shell/PlanRail.tsx`, `apps/web/src/shell/StageColumn.tsx`, `apps/web/src/shell/Hud.tsx`,
  `apps/web/src/shell/Caption.tsx`, `apps/web/src/shell/MascotDock.tsx`, `apps/web/src/shell/Mascot.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/cells/hud-state.test.ts`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `ApiClient`, `openSocket` (Task 12); the daemon's cell API and status socket (Task 10).
- Produces: `CellSummary`/`CellState`/`StreamState` (web copies of the daemon's `cells/types.ts`);
  `hudFor(cell: CellSummary | null, busy: boolean): HudState { label; caption; action: "start" | "stop" | "none"; live: boolean }`
  (a crash restart, that is a `starting` cell whose `error` is the orchestrator's
  `…; restarting (attempt n of m)` note, reads "Reconnecting…" as the spec's error table asks, and
  offers Stop);
  `useCell(api): { cell: CellSummary | null; busy: boolean; error: string | null; start(): void; stop(): void }`;
  `StageColumn` renders `children` inside the `.stage` box (Task 14 passes the live stage);
  CSS classes `.app`, `.bar`, `.house`, `.rail`, `.stage-col`, `.stage`, `.hud`, `.caption`.

- [ ] **Step 1: Types and the pure HUD state, test first**

`apps/web/src/cells/types.ts` (the same shapes as `apps/daemon/src/cells/types.ts`):
```ts
export type Scale = 1 | 2;
export type CellState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "removed";
export type StreamConnection = "none" | "connecting" | "live" | "stalled" | "disconnected";

export interface StreamState {
  connection: StreamConnection;
  viewers: number;
  lastUpstreamAt: number | null;
}

export interface CellSummary {
  id: string;
  state: CellState;
  scale: Scale;
  createdAt: string;
  stream: StreamState;
  error?: string;
}
```

`apps/web/src/cells/hud-state.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hudFor } from "./hud-state.ts";
import type { CellSummary } from "./types.ts";

const cell = (state: CellSummary["state"], connection: CellSummary["stream"]["connection"] = "none", error?: string): CellSummary => ({
  id: "01JXYZ0000000000000000ABCD",
  state,
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection, viewers: 0, lastUpstreamAt: null },
  ...(error ? { error } : {}),
});

describe("hudFor", () => {
  it("offers to start when there is no computer or it is stopped or failed", () => {
    expect(hudFor(null, false)).toMatchObject({ label: "No computer", action: "start", live: false });
    expect(hudFor(cell("stopped"), false)).toMatchObject({ label: "Stopped", action: "start" });
    expect(hudFor(cell("failed", "none", "desktop container exited with 137"), false)).toMatchObject({
      label: "Failed",
      caption: "desktop container exited with 137",
      action: "start",
    });
  });

  it("shows progress without an action while starting, stopping or busy", () => {
    expect(hudFor(cell("starting"), false)).toMatchObject({ label: "Starting…", action: "none" });
    expect(hudFor(cell("stopping"), false)).toMatchObject({ label: "Stopping…", action: "none" });
    expect(hudFor(null, true)).toMatchObject({ action: "none" });
  });

  it("reflects the stream once the computer is ready", () => {
    expect(hudFor(cell("ready", "live"), false)).toMatchObject({ label: "Live", action: "stop", live: true });
    expect(hudFor(cell("ready", "connecting"), false)).toMatchObject({ label: "Connecting…", live: false });
    expect(hudFor(cell("ready", "stalled"), false)).toMatchObject({ label: "Reconnecting…", live: false });
    expect(hudFor(cell("ready", "disconnected"), false)).toMatchObject({ label: "Reconnecting…", action: "stop" });
  });

  it("shows a crash restart as reconnecting, with the orchestrator's note", () => {
    const note = "desktop container exited with 137; restarting (attempt 2 of 5)";
    expect(hudFor(cell("starting", "none", note), false)).toEqual({
      label: "Reconnecting…",
      caption: note,
      action: "stop",
      live: false,
    });
    expect(hudFor(cell("starting", "none", note), true).action).toBe("none");
  });
});
```

`apps/web/src/cells/hud-state.ts`:
```ts
import type { CellSummary } from "./types.ts";

export interface HudState {
  label: string;
  caption: string;
  action: "start" | "stop" | "none";
  live: boolean;
}

// The orchestrator marks a crash restart with this note on a starting cell; the spec shows a
// crashed cell as "Reconnecting…".
const RESTART_NOTE = /; restarting \(attempt \d+ of \d+\)$/;

export function hudFor(cell: CellSummary | null, busy: boolean): HudState {
  const idle = (label: string, caption: string, action: HudState["action"]): HudState => ({
    label,
    caption,
    action: busy ? "none" : action,
    live: false,
  });
  if (!cell) return idle("No computer", "Start your computer to see it here.", "start");
  switch (cell.state) {
    case "starting":
      if (cell.error && RESTART_NOTE.test(cell.error)) return idle("Reconnecting…", cell.error, "stop");
      return idle("Starting…", cell.error ?? "Starting your computer. The first start takes about a minute.", "none");
    case "stopping":
      return idle("Stopping…", "Stopping your computer.", "none");
    case "stopped":
    case "removed":
      return idle("Stopped", "Your computer is off.", "start");
    case "failed":
      return idle("Failed", cell.error ?? "Your computer could not start.", "start");
    case "ready":
      break;
  }
  switch (cell.stream.connection) {
    case "live":
      return { label: "Live", caption: "Your computer is live.", action: busy ? "none" : "stop", live: true };
    case "stalled":
    case "disconnected":
      return idle("Reconnecting…", "The stream paused. Reconnecting.", "stop");
    default:
      return idle("Connecting…", "Connecting to the stream.", "stop");
  }
}
```

Run: `pnpm exec vitest run apps/web/src/cells/hud-state.test.ts`
Expected: 4 tests pass.

- [ ] **Step 2: The cell hook**

`apps/web/src/cells/useCell.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import type { CellSummary } from "./types.ts";

export interface CellController {
  cell: CellSummary | null;
  busy: boolean;
  error: string | null;
  start(): void;
  stop(): void;
}

// One computer per install in Part 2: the first cell the daemon lists, created on demand.
export function useCell(api: ApiClient): CellController {
  const [cell, setCell] = useState<CellSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cellId = cell?.id ?? null;
  const api$ = useRef(api);
  api$.current = api;

  useEffect(() => {
    let cancelled = false;
    api.get<CellSummary[]>("/api/cells").then(
      (cells) => {
        if (!cancelled) setCell(cells[0] ?? null);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!cellId) return;
    const socket = openSocket({
      url: api.socketUrl(`/api/cells/${cellId}/status`),
      protocols: api.socketProtocols(),
      handlers: {
        onMessage: (data) => {
          const next = JSON.parse(data) as CellSummary;
          setCell(next.state === "removed" ? null : next);
        },
      },
    });
    return () => socket.close();
  }, [api, cellId]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(() => {
    void run(async () => {
      if (cellId) await api$.current.post(`/api/cells/${cellId}/start`);
      else setCell(await api$.current.post<CellSummary>("/api/cells", { scale: 2 }));
    });
  }, [cellId, run]);

  const stop = useCallback(() => {
    if (cellId) void run(() => api$.current.post(`/api/cells/${cellId}/stop`));
  }, [cellId, run]);

  return { cell, busy, error, start, stop };
}
```

- [ ] **Step 3: The shell components and layout**

`apps/web/src/shell/Mascot.tsx` (the mockup's flat circle with two short eye strokes, pushed up
and toward the stage):
```tsx
export function Mascot({ size = 44 }: { size?: number }) {
  return (
    <svg className="mascot" width={size} height={size} viewBox="0 0 64 64" aria-label="dot" role="img">
      <circle cx="32" cy="32" r="24" fill="var(--color-avatar-body)" />
      <rect x="40" y="19" width="4.6" height="9.5" rx="2.3" fill="var(--color-avatar-eye)" />
      <rect x="49.4" y="20" width="4.3" height="8.5" rx="2.15" fill="var(--color-avatar-eye)" />
    </svg>
  );
}
```

`apps/web/src/shell/TopBar.tsx`:
```tsx
import { Mascot } from "./Mascot.tsx";

export function TopBar({ title, live }: { title: string; live: boolean }) {
  return (
    <header className="bar">
      <div className="bar-l">
        <span className="brand">
          <Mascot size={16} />
          localDot
        </span>
        <span className="title">{title}</span>
      </div>
      <nav className="modes" aria-label="Mode">
        <span aria-disabled="true">Glance</span>
        <span className="on" aria-current="page">
          Watch
        </span>
        <span aria-disabled="true">Replay</span>
      </nav>
      <div className="bar-r">
        <span className={live ? "live on" : "live"}>
          <b aria-hidden="true" />
          {live ? "Live" : "Offline"}
        </span>
      </div>
    </header>
  );
}
```

`apps/web/src/shell/ConversationRail.tsx`:
```tsx
import { MascotDock } from "./MascotDock.tsx";

export function ConversationRail() {
  return (
    <aside className="rail" aria-label="Conversation">
      <div className="rail-h">
        <span>Conversation</span>
      </div>
      <div className="msgs">
        <p className="say empty">Your conversation with dot appears here once the first task starts.</p>
      </div>
      <MascotDock />
    </aside>
  );
}
```

`apps/web/src/shell/MascotDock.tsx`:
```tsx
import { Mascot } from "./Mascot.tsx";

export function MascotDock() {
  return (
    <div className="dock">
      <Mascot />
      <div className="input" aria-disabled="true">
        <span>Message dot…</span>
      </div>
    </div>
  );
}
```

`apps/web/src/shell/PlanRail.tsx`:
```tsx
export function PlanRail() {
  return (
    <aside className="rail r" aria-label="Plan and steps">
      <div className="rail-h">
        <span>Plan</span>
      </div>
      <p className="say empty">No plan yet.</p>
      <div className="rail-h">
        <span>Steps</span>
      </div>
      <p className="say empty">Steps appear here as dot works.</p>
    </aside>
  );
}
```

`apps/web/src/shell/Hud.tsx`:
```tsx
import type { HudState } from "../cells/hud-state.ts";
import { Mascot } from "./Mascot.tsx";

export function Hud({ hud, onStart, onStop }: { hud: HudState; onStart(): void; onStop(): void }) {
  return (
    <div className="hud" role="status" aria-live="polite">
      <span className="st">
        <Mascot size={18} />
        <span data-testid="hud-status">{hud.label}</span>
      </span>
      <span className="acts">
        {hud.action === "start" && (
          <button type="button" className="a" onClick={onStart}>
            Start computer
          </button>
        )}
        {hud.action === "stop" && (
          <button type="button" className="a" onClick={onStop}>
            <span className="sq" aria-hidden="true" />
            Stop computer
          </button>
        )}
      </span>
    </div>
  );
}
```

`apps/web/src/shell/Caption.tsx`:
```tsx
export function Caption({ text }: { text: string }) {
  return (
    <p className="caption">
      <span>dot</span>
      {text}
    </p>
  );
}
```

`apps/web/src/shell/StageColumn.tsx`:
```tsx
import type { ReactNode } from "react";
import type { HudState } from "../cells/hud-state.ts";
import { Caption } from "./Caption.tsx";
import { Hud } from "./Hud.tsx";

export interface StageColumnProps {
  hud: HudState;
  onStart(): void;
  onStop(): void;
  children?: ReactNode;
}

export function StageColumn({ hud, onStart, onStop, children }: StageColumnProps) {
  return (
    <main className="stage-col">
      <div className={hud.live ? "stage lit" : "stage"}>
        {children}
        <Hud hud={hud} onStart={onStart} onStop={onStop} />
      </div>
      <Caption text={hud.caption} />
    </main>
  );
}
```

`apps/web/src/App.tsx` — replace the connected branch:
```tsx
import { useEffect, useMemo, useState } from "react";
import { hudFor } from "./cells/hud-state.ts";
import { useCell } from "./cells/useCell.ts";
import { type ApiClient, createApi } from "./lib/api.ts";
import { bootstrapToken, forgetToken } from "./lib/token.ts";
import { ConversationRail } from "./shell/ConversationRail.tsx";
import { PlanRail } from "./shell/PlanRail.tsx";
import { StageColumn } from "./shell/StageColumn.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import "./app.css";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => bootstrapToken());
  const [rejected, setRejected] = useState(false);
  const api = useMemo<ApiClient | null>(
    () =>
      token
        ? createApi(token, {
            fetchImpl,
            onUnauthorized: () => {
              forgetToken();
              setRejected(true);
              setToken(null);
            },
          })
        : null,
    [token, fetchImpl],
  );
  if (!api) return <NoToken rejected={rejected} />;
  return <Theatre api={api} />;
}

function Theatre({ api }: { api: ApiClient }) {
  const { cell, busy, error, start, stop } = useCell(api);
  const hud = hudFor(cell, busy);
  useEffect(() => {
    document.title = `localDot — ${hud.label}`;
  }, [hud.label]);
  return (
    <div className="app">
      <TopBar title="Your computer" live={hud.live} />
      <div className="house">
        <ConversationRail />
        <StageColumn hud={error ? { ...hud, caption: error } : hud} onStart={start} onStop={stop} />
        <PlanRail />
      </div>
    </div>
  );
}

function NoToken({ rejected }: { rejected: boolean }) {
  return (
    <section className="notice" role="alert">
      <h1>No access token</h1>
      <p>
        {rejected ? "The daemon rejected the stored token." : "This page needs the install token."} Open
        the link the daemon printed at startup: <code>http://127.0.0.1:4750/#token=…</code>
      </p>
    </section>
  );
}
```

`apps/web/src/app.css` (layout and the Theatre surfaces; values from the mockup, the rails widened
and set in `--color-text` at 13.5 px / 1.55 so they read comfortably at length, per the direction's
carry-over note):
```css
.app {
  display: grid;
  grid-template-rows: 44px 1fr;
  height: 100%;
  min-height: 600px;
}

.bar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 20px;
}

.bar-l,
.bar-r {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bar-r {
  justify-content: flex-end;
  color: var(--color-text-2);
}

.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--color-text-2);
  font-weight: 600;
  font-size: 12.5px;
}

.title {
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.modes {
  display: flex;
  gap: 22px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--color-text-3);
}

.modes span {
  position: relative;
}

.modes span.on {
  color: var(--color-text);
}

.modes span.on::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -8px;
  width: 4px;
  height: 4px;
  margin-left: -2px;
  border-radius: 50%;
  background: var(--color-text);
}

.live {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 500;
}

.live b {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-3);
}

.live.on b {
  background: var(--color-text);
}

.house {
  display: grid;
  grid-template-columns: var(--spacing-rail) 1fr var(--spacing-rail);
  column-gap: 20px;
  padding: 0 16px 16px;
  min-height: 0;
}

.rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-top: 18px;
  color: var(--color-text);
}

.rail-h {
  display: flex;
  justify-content: space-between;
  margin-bottom: 14px;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--color-text-3);
}

.msgs {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 16px;
  overflow: hidden;
}

.say {
  color: var(--color-text);
  line-height: 1.55;
}

.say.empty {
  color: var(--color-text-2);
}

.rail.r .say.empty {
  margin-bottom: 22px;
}

.dock {
  display: grid;
  grid-template-columns: 44px 1fr;
  gap: 10px;
  align-items: center;
  padding-top: 14px;
}

.input {
  height: 40px;
  border-radius: 20px;
  background: var(--color-surface);
  display: flex;
  align-items: center;
  padding: 0 14px;
  color: var(--color-text-3);
}

.stage-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-bottom: 20px;
  min-width: 0;
}

.stage {
  position: relative;
  width: min(100%, calc((100vh - 200px) * 1.6));
  aspect-ratio: 16 / 10;
  border-radius: var(--radius-stage);
  background: var(--color-surface);
  box-shadow: var(--shadow-stage);
  overflow: hidden;
}

.stage > canvas,
.stage > .stage-veil {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-stage);
}

.stage > canvas {
  opacity: 0;
  transition: opacity 400ms ease-out;
}

.stage.lit > canvas {
  opacity: 1;
}

.hud {
  position: absolute;
  left: 50%;
  top: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 5px 0 12px;
  border-radius: 20px;
  background: var(--color-hud);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  backdrop-filter: blur(16px) saturate(140%);
  box-shadow: inset 0 0 0 1px var(--color-hud-line), 0 8px 24px var(--color-shade-hud);
  white-space: nowrap;
  z-index: 4;
}

.hud .st {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
}

.hud .acts {
  display: flex;
  gap: 4px;
}

.hud .a {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  background: var(--color-hud-button);
  font-weight: 500;
  font-size: 12.5px;
}

.hud .sq {
  width: 8px;
  height: 8px;
  border-radius: 1.5px;
  background: var(--color-text);
}

.caption {
  margin-top: 26px;
  max-width: 640px;
  text-align: center;
  font-size: 15px;
  line-height: 1.45;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.caption span {
  color: var(--color-text-3);
  font-weight: 400;
  margin-right: 8px;
}

@media (prefers-reduced-transparency: reduce) {
  .hud {
    background: var(--color-hud-solid);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .stage > canvas {
    transition: none;
  }
}
```

- [ ] **Step 4: Extend the App test and run the web suites**

In `apps/web/src/App.test.tsx`, replace the "connects with a stored token" test with:
```tsx
  it("shows the Theatre with a Start computer control when the daemon has no cell", async () => {
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(43));
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/api/cells") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "01JXYZ0000000000000000ABCD", state: "starting", scale: 2, createdAt: "", stream: { connection: "none", viewers: 0, lastUpstreamAt: null } }), { status: 202, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    render(<App fetchImpl={fetchImpl} />);
    const start = await screen.findByRole("button", { name: "Start computer" });
    expect(screen.getByTestId("hud-status").textContent).toBe("No computer");
    expect(screen.getByRole("navigation", { name: "Mode" }).textContent).toContain("Watch");
    start.click();
    expect(await screen.findByText("Starting…")).toBeTruthy();
    expect(calls).toContain("POST /api/cells");
  });
```
The status socket opens only once a cell exists; jsdom's `WebSocket` will try and fail to connect
to `ws://localhost:3000/...` after the click, which `openSocket` swallows (`onerror` is a no-op).
The file's `afterEach(cleanup)` (Task 12) unmounts the Theatre after the test, which closes the
socket and clears its reconnect timer.

Run: `pnpm exec vitest run apps/web/src`
Expected: 16 tests pass.

- [ ] **Step 5: Screenshot check**

Run `pnpm --filter @localdot/web build`, start the daemon with a temporary home, then
`pnpm --filter @localdot/web shot "http://127.0.0.1:4750/#token=<token>" e2e/out/theatre-empty.png`
and look at `apps/web/e2e/out/theatre-empty.png` next to `c-theatre.png`:
- the 44 px top bar with the brand, "Your computer", Glance/Watch/Replay (Watch marked) and the
  Offline dot; the near-black void; two 264 px rails whose text is readable at a glance (not the
  mockup's slim grey); a large 16:10 stage box with the HUD pill centred at its top reading
  "No computer" with a "Start computer" button; the caption "dot Start your computer to see it here."
- no xenon anywhere; no horizontal scrollbar at 1440×900; the HUD is blurred over the stage surface.
Click "Start computer" in Chrome by hand (or with the DevTools MCP) and take a second screenshot:
the HUD reads "Starting…" without a button, then "Failed" with the Docker error if the images are
missing, or "Connecting…" when a cell comes up. Remove the cell it created with
`DELETE /api/cells/<id>?purge=1` and the token, then stop the daemon. If the daemon is already gone,
remove that cell's objects by its id only (never a `localdot-*` pattern, which also matches your own
cells): `docker rm -fv localdot-gate-<id> localdot-desktop-<id>`,
`docker network rm localdot-cell-<id> localdot-egress-<id>`, `docker volume rm localdot-home-<id>`.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web
git commit -m "feat(web): Theatre shell"
```

---
### Task 14: The live desktop in the stage

The vendored Selkies client (S8's working path) runs in a 1×1 inert same-origin iframe served by
the daemon under the cell's ticket path. The parent page clones the iframe's `<video>` track into
a `MediaStreamTrackProcessor`, transfers its `ReadableStream<VideoFrame>` to the render worker, and
the worker paints each frame once onto the stage's `OffscreenCanvas` (never per
`requestAnimationFrame`). Part 3 replaces the worker's 2D presenter with the PixiJS renderer; the
frame source, the worker protocol and the canvas mount stay.

**Files:**
- Create: `apps/web/vendor/selkies/` (extracted; `index.html`, `assets/*`, `NOTICE.md`)
- Create: `apps/web/src/stage/webcodecs.d.ts`, `apps/web/src/stage/frame-source.ts`,
  `apps/web/src/stage/pump.ts`, `apps/web/src/stage/presenter.ts`, `apps/web/src/stage/render-worker.ts`,
  `apps/web/src/stage/StageCanvas.tsx`, `apps/web/src/stage/DesktopFrame.tsx`, `apps/web/src/stage/Stage.tsx`
- Modify: `apps/web/src/App.tsx` (Theatre passes `<Stage>` into `StageColumn`), `apps/web/src/app.css`,
  `scripts/check-hygiene.mjs` (only if a vendored asset trips a key-shaped pattern, Step 1)
- Test: `apps/web/src/stage/frame-source.test.ts`, `apps/web/src/stage/pump.test.ts`,
  `apps/web/src/stage/Stage.test.tsx`

**Interfaces:**
- Produces: `frameTapSupport(): { ok: true } | { ok: false; reason: string }`;
  `tapVideoTrack(video: HTMLVideoElement): FrameSource | undefined` with
  `FrameSource { readable: ReadableStream<VideoFrame>; trackId: string; stop(): void }`;
  `Presenter { present(frame: VideoFrame): void }`, `canvasPresenter(canvas: OffscreenCanvas): Presenter`;
  `pumpFrames(readable, presenter, report, opts?): { stop(): Promise<void> }`, `PumpStats { presented; fps; lastFrameAt; width; height }`;
  worker protocol `WorkerIn = { type: "init"; canvas } | { type: "frames"; readable } | { type: "stop" }`,
  `WorkerOut = { type: "stats"; stats: PumpStats } | { type: "error"; message: string }`;
  `StageCanvas` (ref handle `{ attach(source: FrameSource): void; detach(): void }`, attributes
  `data-frames`, `data-fps`, `data-size` on the `<canvas class="stage-canvas">`);
  `DesktopFrame { src: string; onSource(source: FrameSource): void }`; `Stage { cell; api }`.

- [ ] **Step 1: Vendor the client**

```bash
cells/desktop/scripts/extract-selkies-client.sh "$PWD/apps/web/vendor/selkies"
ls apps/web/vendor/selkies apps/web/vendor/selkies/assets
```
Expected: `index.html` (its manifest link removed), three assets (`index-*.js`,
`selkies-core-*.js`, `index-*.css`), `icon.png`, `icon-512.png` and `LICENSE` (the MPL-2.0 text,
373 lines, copied from the image's `/usr/share/common-licenses/MPL-2.0`). If S8 needed the
injected-tap variant (its FINDINGS says so), apply the same change to this `index.html` now and
describe it in the notice. Write `apps/web/vendor/selkies/NOTICE.md`:
```markdown
# Selkies web client (vendored)

These files are the `selkies-dashboard` build shipped in
`lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804`
(Selkies 2.0.0, per its startup log), extracted with `cells/desktop/scripts/extract-selkies-client.sh`.
One change: the `<link rel="manifest" href="manifest.json">` element was removed from `index.html`,
because that file is generated by the cell's nginx at runtime and does not exist here.

Selkies is licensed under the Mozilla Public License 2.0; `LICENSE` next to this file is that
license's text. Its source is https://github.com/selkies-project/selkies at tag `2.0.0`
(`addons/selkies-dashboard` and `addons/selkies-web-core`), the `SELKIES_RELEASE` that linuxserver's
`docker-baseimage-selkies` Dockerfile pins for the build `53afe260-ls3` (2026-09-29) packaged in this
image. localDot serves these files itself so that
no code loaded into localDot's origin ever comes from a cell. Re-extract them whenever the base
image digest changes.
```
Run `pnpm hygiene`. If a vendored asset trips a key-shaped pattern, add
`apps/web/vendor/selkies/assets/<file>` to `ALLOWLIST` in `scripts/check-hygiene.mjs` with a comment
naming the false positive, and re-run.

- [ ] **Step 2: Types and the pure pump, test first**

`apps/web/src/stage/webcodecs.d.ts`:
```ts
// Chromium-only: not in TypeScript's DOM lib.
interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

declare class MediaStreamTrackProcessor {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<VideoFrame>;
}
```

`apps/web/src/stage/pump.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { type Presenter, type PumpStats, pumpFrames } from "./pump.ts";

const fakeFrame = (w = 2560, h = 1600) =>
  ({ displayWidth: w, displayHeight: h, close: vi.fn() }) as unknown as VideoFrame;

function stream(frames: VideoFrame[]): ReadableStream<VideoFrame> {
  return new ReadableStream<VideoFrame>({
    pull(controller) {
      const next = frames.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

describe("pumpFrames", () => {
  it("presents every frame once, closes it, and reports stats at most every reportEveryMs", async () => {
    const frames = [fakeFrame(), fakeFrame(), fakeFrame(1280, 800)];
    const presented: VideoFrame[] = [];
    const presenter: Presenter = { present: (f) => presented.push(f) };
    const reports: PumpStats[] = [];
    let t = 0;
    const pump = pumpFrames(stream([...frames]), presenter, (s) => reports.push(s), { now: () => (t += 400), reportEveryMs: 500 });
    await new Promise((r) => setTimeout(r, 20));
    await pump.stop();
    expect(presented).toEqual(frames);
    for (const f of frames) expect(f.close).toHaveBeenCalledTimes(1);
    expect(reports[0]).toMatchObject({ presented: 1, width: 2560, height: 1600 });
    expect(reports.at(-1)).toMatchObject({ presented: 3, width: 1280, height: 800 });
    expect(reports.length).toBeLessThan(frames.length + 1);
  });

  it("stops reading when stopped", async () => {
    let pulls = 0;
    // Each frame arrives on a later macrotask, as a real track's do: a source that enqueued at once
    // would keep the read loop on microtasks and starve every timer, Vitest's included.
    const endless = new ReadableStream<VideoFrame>({
      async pull(controller) {
        pulls += 1;
        await new Promise((r) => setTimeout(r, 1));
        controller.enqueue(fakeFrame());
      },
    });
    const pump = pumpFrames(endless, { present: () => {} }, () => {});
    await new Promise((r) => setTimeout(r, 20));
    await pump.stop();
    const after = pulls;
    await new Promise((r) => setTimeout(r, 20));
    expect(pulls).toBe(after);
  });
});
```

`apps/web/src/stage/pump.ts`:
```ts
export interface Presenter {
  present(frame: VideoFrame): void;
}

export interface PumpStats {
  presented: number;
  fps: number;
  lastFrameAt: number;
  width: number;
  height: number;
}

export interface PumpOptions {
  now?: () => number;
  reportEveryMs?: number;
}

// One frame in, one upload out: the loop presents each decoded frame as it arrives and never
// re-uploads on a display tick (A20).
export function pumpFrames(
  readable: ReadableStream<VideoFrame>,
  presenter: Presenter,
  report: (stats: PumpStats) => void,
  opts: PumpOptions = {},
): { stop(): Promise<void> } {
  const now = opts.now ?? (() => performance.now());
  const reportEveryMs = opts.reportEveryMs ?? 500;
  const reader = readable.getReader();
  let presented = 0;
  let windowStart = now();
  let windowFrames = 0;
  let fps = 0;
  let lastReportAt = Number.NEGATIVE_INFINITY;

  const loop = async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) return;
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      try {
        presenter.present(frame);
      } finally {
        frame.close();
      }
      presented += 1;
      windowFrames += 1;
      const t = now();
      if (t - windowStart >= 1000) {
        fps = Math.round((windowFrames * 1000) / (t - windowStart));
        windowFrames = 0;
        windowStart = t;
      }
      if (presented === 1 || t - lastReportAt >= reportEveryMs) {
        lastReportAt = t;
        report({ presented, fps, lastFrameAt: t, width, height });
      }
    }
  };
  const running = loop().catch(() => {});

  return {
    async stop() {
      await reader.cancel().catch(() => {});
      await running;
    },
  };
}
```

`apps/web/src/stage/frame-source.test.ts`:
```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameTapSupport, tapVideoTrack } from "./frame-source.ts";

afterEach(() => vi.unstubAllGlobals());

describe("frame source", () => {
  it("names the missing API in a browser without MediaStreamTrackProcessor", () => {
    const support = frameTapSupport();
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("Chromium");
  });

  it("returns no source for a video without a stream", () => {
    const video = document.createElement("video");
    expect(tapVideoTrack(video)).toBeUndefined();
    expect(tapVideoTrack({ srcObject: {} })).toBeUndefined();
  });

  it("taps a track from another realm by shape, never by instanceof", () => {
    const stopped: string[] = [];
    const track = { id: "t1", clone: () => ({ id: "t1-clone", stop: () => stopped.push("clone") }) };
    const video = { srcObject: { getVideoTracks: () => [track] } };
    const readable = new ReadableStream<VideoFrame>();
    vi.stubGlobal(
      "MediaStreamTrackProcessor",
      class {
        readonly readable = readable;
        constructor(readonly init: { track: unknown }) {}
      },
    );
    const source = tapVideoTrack(video);
    expect(source?.trackId).toBe("t1");
    expect(source?.readable).toBe(readable);
    source?.stop();
    expect(stopped).toEqual(["clone"]);
  });
});
```

`apps/web/src/stage/frame-source.ts`:
```ts
export interface FrameSource {
  readable: ReadableStream<VideoFrame>;
  trackId: string;
  stop(): void;
}

export function frameTapSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof MediaStreamTrackProcessor === "undefined") {
    return {
      ok: false,
      reason: "This browser has no MediaStreamTrackProcessor. Open localDot in Google Chrome or another Chromium browser.",
    };
  }
  if (typeof VideoFrame === "undefined" || typeof OffscreenCanvas === "undefined") {
    return { ok: false, reason: "This browser lacks WebCodecs. Open localDot in a current Chromium browser." };
  }
  return { ok: true };
}

interface VideoLike {
  srcObject: unknown;
}

interface StreamLike {
  getVideoTracks?: () => MediaStreamTrack[];
}

// A clone of the client's track sees every decoded frame (S1); the client's own <video> keeps the
// original, so the stage never interferes with Selkies' pipeline. The video lives in the iframe's
// realm, where `MediaStream` is a different constructor, so the stream is recognised by shape.
export function tapVideoTrack(video: VideoLike): FrameSource | undefined {
  const stream = video.srcObject as StreamLike | null | undefined;
  if (!stream || typeof stream.getVideoTracks !== "function") return undefined;
  const track = stream.getVideoTracks()[0];
  if (!track) return undefined;
  const clone = track.clone();
  const processor = new MediaStreamTrackProcessor({ track: clone });
  return { readable: processor.readable, trackId: track.id, stop: () => clone.stop() };
}
```

Run: `pnpm exec vitest run apps/web/src/stage`
Expected: 5 tests pass (2 pump, 3 frame source).

- [ ] **Step 3: The presenter, the worker and the canvas mount**

`apps/web/src/stage/presenter.ts`:
```ts
import type { Presenter } from "./pump.ts";

// Part 2 paints with a 2D context; Part 3 swaps in the PixiJS presenter behind the same interface.
export function canvasPresenter(canvas: OffscreenCanvas): Presenter {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context on the stage canvas");
  return {
    present(frame) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
    },
  };
}
```

`apps/web/src/stage/render-worker.ts`:
```ts
import { canvasPresenter } from "./presenter.ts";
import { type Presenter, type PumpStats, pumpFrames } from "./pump.ts";

export type WorkerIn =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "frames"; readable: ReadableStream<VideoFrame> }
  | { type: "stop" };

export type WorkerOut = { type: "stats"; stats: PumpStats } | { type: "error"; message: string };

const scope = self as unknown as {
  postMessage(message: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let presenter: Presenter | undefined;
let pump: { stop(): Promise<void> } | undefined;

scope.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      presenter = canvasPresenter(m.canvas);
      return;
    }
    if (m.type === "stop" || m.type === "frames") {
      await pump?.stop();
      pump = undefined;
    }
    if (m.type === "frames") {
      if (!presenter) throw new Error("frames before init");
      pump = pumpFrames(m.readable, presenter, (stats) => scope.postMessage({ type: "stats", stats }));
    }
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
```

`apps/web/src/stage/StageCanvas.tsx`:
```tsx
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FrameSource } from "./frame-source.ts";
import type { PumpStats } from "./pump.ts";
import type { WorkerIn, WorkerOut } from "./render-worker.ts";

export interface StageCanvasHandle {
  attach(source: FrameSource): void;
  detach(): void;
}

export const StageCanvas = forwardRef<StageCanvasHandle, { onStats?(stats: PumpStats): void }>(function StageCanvas({ onStats }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const [stats, setStats] = useState<PumpStats | null>(null);

  // The worker owns the canvas for the component's lifetime: the effect depends on nothing, and the
  // latest onStats is read through a ref, which keeps Biome's useExhaustiveDependencies satisfied.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "init", canvas: offscreen } satisfies WorkerIn, [offscreen]);
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      if (e.data.type === "stats") {
        setStats(e.data.stats);
        onStatsRef.current?.(e.data.stats);
      } else console.error(`stage worker: ${e.data.message}`);
    };
    workerRef.current = worker;
    return () => {
      sourceRef.current?.stop();
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    attach(source) {
      sourceRef.current?.stop();
      sourceRef.current = source;
      workerRef.current?.postMessage({ type: "frames", readable: source.readable } satisfies WorkerIn, [source.readable]);
    },
    detach() {
      sourceRef.current?.stop();
      sourceRef.current = null;
      workerRef.current?.postMessage({ type: "stop" } satisfies WorkerIn);
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="stage-canvas"
      data-frames={stats?.presented ?? 0}
      data-fps={stats?.fps ?? 0}
      data-size={stats ? `${stats.width}x${stats.height}` : ""}
      aria-label="The virtual computer"
    />
  );
});
```

`apps/web/src/stage/DesktopFrame.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { type FrameSource, tapVideoTrack } from "./frame-source.ts";

export interface DesktopFrameProps {
  src: string;
  onSource(source: FrameSource): void;
}

interface FrameVideo {
  tagName?: string;
  srcObject?: unknown;
}

// Hosts Selkies' client out of sight and hands its video track to the stage. Polling is the only
// signal: the client swaps its track on every (re)connect without an event the parent can hear.
// Everything read from the iframe is checked by shape: its objects are not instances of this
// realm's HTMLVideoElement or MediaStream.
export function DesktopFrame({ src, onSource }: DesktopFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const tapped = useRef<string | null>(null);

  // No `src` dependency: a new src loads a new document whose client makes a new track, and the
  // poll taps any track id it has not tapped yet.
  useEffect(() => {
    tapped.current = null;
    const timer = setInterval(() => {
      const doc = frameRef.current?.contentDocument;
      const video = doc?.getElementById("videoStream") as FrameVideo | null | undefined;
      if (video?.tagName !== "VIDEO") return;
      const stream = video.srcObject as { getVideoTracks?: () => { id: string }[] } | null | undefined;
      const track = typeof stream?.getVideoTracks === "function" ? stream.getVideoTracks()[0] : undefined;
      if (!track || track.id === tapped.current) return;
      const source = tapVideoTrack({ srcObject: video.srcObject });
      if (!source) return;
      tapped.current = source.trackId;
      onSource(source);
    }, 250);
    return () => clearInterval(timer);
  }, [onSource]);

  return <iframe ref={frameRef} className="desktop-frame" src={src} title="Desktop stream client" inert />;
}
```

`apps/web/src/stage/Stage.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { DesktopFrame } from "./DesktopFrame.tsx";
import { type FrameSource, frameTapSupport } from "./frame-source.ts";
import { StageCanvas, type StageCanvasHandle } from "./StageCanvas.tsx";

export function Stage({ cell, api }: { cell: CellSummary | null; api: ApiClient }) {
  const support = frameTapSupport();
  const canvas = useRef<StageCanvasHandle>(null);
  const [src, setSrc] = useState<string | null>(null);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";

  useEffect(() => {
    if (!cellId || !ready || !support.ok) {
      setSrc(null);
      canvas.current?.detach();
      return;
    }
    let cancelled = false;
    api.post<{ path: string }>(`/api/cells/${cellId}/stream-ticket`).then(
      ({ path }) => {
        if (!cancelled) setSrc(path);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, cellId, ready, support.ok]);

  const onSource = useCallback((source: FrameSource) => canvas.current?.attach(source), []);
  const paused = cell?.stream.connection === "stalled" || cell?.stream.connection === "disconnected";

  if (!support.ok) {
    return (
      <div className="stage-veil" role="alert">
        <p>{support.reason}</p>
      </div>
    );
  }
  return (
    <>
      <StageCanvas ref={canvas} />
      {src && <DesktopFrame src={src} onSource={onSource} />}
      <div className={paused ? "stage-veil on" : "stage-veil"} aria-hidden={!paused}>
        <p>Reconnecting…</p>
      </div>
    </>
  );
}
```

`apps/web/src/stage/Stage.test.tsx` (jsdom has no `MediaStreamTrackProcessor`, like Safari and
Firefox, so the stage must explain itself instead of staying black):
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { Stage } from "./Stage.tsx";

const ready: CellSummary = {
  id: "01JXYZ0000000000000000ABCD",
  state: "ready",
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
};

afterEach(cleanup);

describe("Stage", () => {
  it("says a Chromium browser is needed where frames cannot be tapped", () => {
    render(<Stage cell={ready} api={createApi("a".repeat(43), { origin: "http://127.0.0.1:4750" })} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "This browser has no MediaStreamTrackProcessor. Open localDot in Google Chrome or another Chromium browser.",
    );
  });
});
```

In `apps/web/src/App.tsx`'s `Theatre`, render the stage inside the column:
```tsx
        <StageColumn hud={error ? { ...hud, caption: error } : hud} onStart={start} onStop={stop}>
          <Stage cell={cell} api={api} />
        </StageColumn>
```
with `import { Stage } from "./stage/Stage.tsx";`.

Append to `apps/web/src/app.css`:
```css
.desktop-frame {
  position: absolute;
  left: -20px;
  top: -20px;
  width: 2px;
  height: 2px;
  opacity: 0;
  border: 0;
  pointer-events: none;
}

.stage-veil {
  display: grid;
  place-items: center;
  background: var(--color-hud-solid);
  color: var(--color-text-2);
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.01em;
  opacity: 0;
  pointer-events: none;
  transition: opacity 240ms ease-out;
}

.stage-veil.on,
.stage-veil[role="alert"] {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .stage-veil {
    transition: none;
  }
}
```

Run: `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck && pnpm --filter @localdot/web build`
Expected: 22 web tests pass (16 from Tasks 12 and 13, 5 stage, 1 `Stage` render); the build emits
`dist/assets/render-worker-*.js` next to the app bundle.

- [ ] **Step 4: See the live desktop**

Start the daemon with a temporary home (images built, Docker running), open
`http://127.0.0.1:4750/#token=<token>` in Google Chrome, click "Start computer", wait for the HUD
to read "Live" (one to two minutes on the first start). Expected: the XFCE desktop fills the stage,
sharp at 2× (DPR 2 display), the top bar's dot reads "Live", `document.querySelector("canvas.stage-canvas").dataset.frames`
is above 0 and rises when something on the desktop moves, `data-size` is `2560x1600`.
Then `docker pause localdot-desktop-<id>`: within about two seconds the HUD reads "Reconnecting…"
and the veil appears; `docker unpause` brings "Live" back (the client reconnects by itself).
Then, with the computer still running, take
`pnpm --filter @localdot/web shot "http://127.0.0.1:4750/#token=<token>" e2e/out/theatre-live.png 1440 900 8000`
(the shot script opens a fresh Chrome profile with no stored token, so the URL must carry the
token; the 8 s settle lets the new page connect and receive frames) and look at
`apps/web/e2e/out/theatre-live.png`: the WhiteSur
light desktop with its menu-bar panel and dock inside the lit stage, the HUD on the picture, no
xenon. Stop the computer from the HUD, then stop the daemon.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm hygiene
git add apps/web scripts/check-hygiene.mjs
git commit -m "feat(web): live desktop in the stage"
```

---
### Task 15: End-to-end acceptance, 2× measurements, the Node 24 run and the docs

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/daemon.ts`, `apps/web/e2e/live-desktop.spec.ts`,
  `apps/web/e2e/measure.spec.ts`, `docs/measurements/2026-10-stream-2x.md`
- Modify: `apps/daemon/src/cells/spec.ts`, `apps/daemon/src/cells/spec.test.ts`,
  `apps/daemon/src/cells/orchestrator.ts`, `apps/daemon/src/main.ts` (4:2:0 switch for the
  measurement), `README.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above. Produces: `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e`
  (the acceptance run), `LOCALDOT_MEASURE=1 … e2e --grep measure`, env `LOCALDOT_STREAM_FULLCOLOR=0`
  (desktop cells then stream 4:2:0; default 4:4:4).

- [ ] **Step 1: The 4:2:0 switch**

In `apps/daemon/src/cells/spec.ts`, give `desktopEnv` and `desktopSpec` an options argument:
```ts
export interface DesktopOptions {
  fullcolor: boolean;
}

export function desktopEnv(record: CellRecord, opts: DesktopOptions = { fullcolor: true }): string[] {
  // ... existing entries, then:
  return [...entries, `SELKIES_VIDEO_FULLCOLOR=${opts.fullcolor}`];
}

export function desktopSpec(record: CellRecord, image: string, opts: DesktopOptions = { fullcolor: true }) {
  // Env: desktopEnv(record, opts)
}
```
In `apps/daemon/src/cells/orchestrator.ts`, add `streamFullcolor?: boolean` to `OrchestratorDeps`
(default `true`) and pass `{ fullcolor }` into `desktopSpec` in `create`. In `main.ts`, pass
`streamFullcolor: process.env.LOCALDOT_STREAM_FULLCOLOR !== "0"`. In `spec.test.ts`, extend the
env-keys test: the key list ends with `"SELKIES_VIDEO_FULLCOLOR"`, and
`desktopEnv(record, { fullcolor: false })` contains `SELKIES_VIDEO_FULLCOLOR=false`.

Run: `pnpm exec vitest run apps/daemon/src/cells/spec.test.ts apps/daemon/src/cells/orchestrator.test.ts`
Expected: pass.

- [ ] **Step 2: Playwright config and the daemon harness**

`apps/web/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 420_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "e2e/out/results",
  use: { channel: "chrome", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
});
```

`apps/web/e2e/daemon.ts`:
```ts
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
export const E2E_PORT = 4790;

// The desktop container of one cell, found by its id label: the user's own cells share this Docker.
export function desktopContainer(cellId: string): string {
  return execFileSync(
    "docker",
    ["ps", "--filter", `label=localdot.cell=${cellId}`, "--filter", "label=localdot.role=desktop", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  ).trim();
}

export interface RunningDaemon {
  origin: string;
  token: string;
  home: string;
  stop(): Promise<void>;
}

export async function startDaemon(env: Record<string, string> = {}): Promise<RunningDaemon> {
  const home = join(mkdtempSync(join(tmpdir(), "local dot's e2e-")), "home");
  // node directly (pnpm would not forward SIGTERM) in its own process group, so stop() can kill
  // the whole group and never leaves a daemon holding 4790 and daemon.lock behind.
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: join(REPO, "apps", "daemon"),
    env: { ...process.env, LOCALDOT_HOME: home, LOCALDOT_PORT: String(E2E_PORT), ...env },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  const origin = `http://127.0.0.1:${E2E_PORT}`;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    }
  };
  const exited = () =>
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const force = setTimeout(() => killGroup("SIGKILL"), 10_000);
          child.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
        });
  const stop = async () => {
    try {
      const token = readFileSync(join(home, "daemon-token"), "utf8").trim();
      const headers = { authorization: `Bearer ${token}` };
      const cells = (await (await fetch(`${origin}/api/cells`, { headers })).json()) as { id: string }[];
      for (const cell of cells) await fetch(`${origin}/api/cells/${cell.id}?purge=1`, { method: "DELETE", headers });
    } catch {}
    killGroup("SIGTERM");
    await exited();
  };
  const deadline = Date.now() + 60_000;
  let up = false;
  while (!up && Date.now() < deadline) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    await stop();
    throw new Error(`the daemon did not answer on ${origin}/healthz within 60 s`);
  }
  const token = readFileSync(join(home, "daemon-token"), "utf8").trim();
  return { origin, token, home, stop };
}
```

- [ ] **Step 3: The acceptance test**

`apps/web/e2e/live-desktop.spec.ts`:
```ts
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
let daemon: RunningDaemon;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");

test.beforeAll(async () => {
  daemon = await startDaemon();
});

test.afterAll(async () => {
  await daemon?.stop();
});

test("start a computer from the UI and see the live 2x desktop", async ({ page }) => {
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page).toHaveURL(`${daemon.origin}/`);
  await expect(page.getByTestId("hud-status")).toHaveText("No computer");
  await page.screenshot({ path: "e2e/out/01-empty.png" });

  const created = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/cells");
  await page.getByRole("button", { name: "Start computer" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("Starting…", { timeout: 30_000 });
  const cellId = ((await (await created).json()) as { id: string }).id;
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });

  const canvas = page.locator("canvas.stage-canvas");
  await expect.poll(async () => Number(await canvas.getAttribute("data-frames")), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute("data-size", "2560x1600");

  const png = await canvas.screenshot({ path: "e2e/out/02-live-stage.png" });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  let sum = 0;
  let sumSq = 0;
  const pixels = info.width * info.height;
  for (let i = 0; i < pixels; i++) {
    const luma = 0.2126 * (data[i * info.channels] ?? 0) + 0.7152 * (data[i * info.channels + 1] ?? 0) + 0.0722 * (data[i * info.channels + 2] ?? 0);
    if (luma > 30) bright += 1;
    sum += luma;
    sumSq += luma * luma;
  }
  const mean = sum / pixels;
  const stddev = Math.sqrt(sumSq / pixels - mean * mean);
  expect(bright / pixels, "the stage shows a desktop, not the void").toBeGreaterThan(0.05);
  expect(stddev, "the picture has structure").toBeGreaterThan(10);

  await page.screenshot({ path: "e2e/out/03-theatre-live.png" });
  await expect(page.locator(".stage.lit")).toBeVisible();
  await expect(page.locator(".stage-veil.on")).toHaveCount(0);

  // The HiDPI pins survive a real Selkies client connecting (A9: Selkies writes Xft/DPI itself).
  const desktop = desktopContainer(cellId);
  expect(desktop).toBe(`localdot-desktop-${cellId}`);
  const xfconf = (prop: string) => execFileSync("docker", ["exec", "-u", "abc", desktop, "xfconf-query", "-c", "xsettings", "-p", prop], { encoding: "utf8" }).trim();
  expect(xfconf("/Gdk/WindowScalingFactor")).toBe("2");
  expect(xfconf("/Xft/DPI")).toBe("96");

  await page.getByRole("button", { name: "Stop computer" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("Stopped", { timeout: 60_000 });
});
```

Run: `mkdir -p apps/web/e2e/out && pnpm --filter @localdot/web build && LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e`
Expected: 1 passed. Look at `apps/web/e2e/out/03-theatre-live.png`: the live desktop in the stage
wearing WhiteSur's light window chrome, the menu-bar panel across the top and the Plank dock at the
bottom of the picture, the HUD reading Live, the rails. (Without `LOCALDOT_DOCKER_TESTS=1` the
file reports 1 skipped.) After the run, `lsof -nP -iTCP:4790` prints nothing: the harness killed
the daemon's process group.

- [ ] **Step 4: The 2× measurement**

`apps/web/e2e/measure.spec.ts`:
```ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";

const MEASURE = process.env.LOCALDOT_MEASURE === "1";
const fullcolor = process.env.LOCALDOT_STREAM_FULLCOLOR !== "0";
let daemon: RunningDaemon;

test.skip(!MEASURE, "needs LOCALDOT_MEASURE=1 (and Docker, the images, Google Chrome)");

test.beforeAll(async () => {
  daemon = await startDaemon({ LOCALDOT_STREAM_FULLCOLOR: fullcolor ? "1" : "0" });
});
test.afterAll(async () => {
  await daemon?.stop();
});

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const cpuSample = (container: string) => Number(docker("stats", "--no-stream", "--format", "{{.CPUPerc}}", container).replace("%", ""));
const chromeCpu = () =>
  execFileSync("ps", ["-A", "-o", "%cpu=,comm="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => /Google Chrome/.test(l))
    .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0]), 0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

test("measure fps and CPU at 2x", async ({ page }) => {
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  const created = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/cells");
  await page.getByRole("button", { name: "Start computer" }).click();
  const cellId = ((await (await created).json()) as { id: string }).id;
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });
  const canvas = page.locator("canvas.stage-canvas");
  await expect.poll(async () => Number(await canvas.getAttribute("data-frames")), { timeout: 60_000 }).toBeGreaterThan(0);
  const container = desktopContainer(cellId);
  expect(container).toBe(`localdot-desktop-${cellId}`);

  const idle = { cpu: [] as number[], chrome: [] as number[] };
  for (let i = 0; i < 5; i++) {
    idle.cpu.push(cpuSample(container));
    idle.chrome.push(chromeCpu());
  }

  docker("exec", "-d", "-u", "abc", "-e", "DISPLAY=:1", container, "chromium", "file:///usr/share/common-licenses/GPL-3");
  await page.waitForTimeout(8000);
  docker("exec", "-d", "-u", "abc", "-e", "DISPLAY=:1", container, "xdotool", "key", "--delay", "40", "--repeat", "600", "Down");
  const moving = { fps: [] as number[], cpu: [] as number[], chrome: [] as number[] };
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    moving.fps.push(Number(await canvas.getAttribute("data-fps")));
    moving.cpu.push(cpuSample(container));
    moving.chrome.push(chromeCpu());
  }
  const result = {
    date: new Date().toISOString(),
    fullcolor,
    size: await canvas.getAttribute("data-size"),
    idle: { containerCpuMedian: median(idle.cpu), chromeCpuMedian: median(idle.chrome) },
    moving: { fpsMedian: median(moving.fps), fpsMin: Math.min(...moving.fps), containerCpuMedian: median(moving.cpu), containerCpuPeak: Math.max(...moving.cpu), chromeCpuMedian: median(moving.chrome) },
    samples: { idle, moving },
  };
  writeFileSync(`e2e/out/measure-${fullcolor ? "444" : "420"}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  expect(result.moving.fpsMedian).toBeGreaterThan(20);
});
```

Run both chroma modes:
```bash
LOCALDOT_MEASURE=1 pnpm --filter @localdot/web e2e --grep measure
LOCALDOT_MEASURE=1 LOCALDOT_STREAM_FULLCOLOR=0 pnpm --filter @localdot/web e2e --grep measure
```
Expected: two JSON files in `apps/web/e2e/out/`. S1's reference on this Mac (M3 Ultra, 2×,
continuous motion, 4:4:4): 61 fps, container CPU 234 % median / 251 % peak, viewer Chrome 38–49 %.
Also note, from `chrome://media-internals` while the 4:2:0 run streams, whether the H.264 decoder
is hardware (`VideoDecoder` kind in the stream's entry) — that is the open item from S1.

Write `docs/measurements/2026-10-stream-2x.md`:
```markdown
# Stream at 2× through the daemon and the stage (Part 2 acceptance)

<date> · <machine> · Docker Desktop <version> · Google Chrome <version> · `localdot/desktop:dev` on
`lscr.io/linuxserver/webtop@sha256:73f966bd…` · `apps/web/e2e/measure.spec.ts`

| Chroma | fps moving (median / min) | container CPU moving (median / peak) | container CPU idle | Chrome CPU moving | Chrome CPU idle | decoder |
|---|---|---|---|---|---|---|
| 4:4:4 (`SELKIES_VIDEO_FULLCOLOR=true`, default) | <from measure-444.json> | <…> | <…> | <…> | <…> | software (S1) |
| 4:2:0 (`LOCALDOT_STREAM_FULLCOLOR=0`) | <from measure-420.json> | <…> | <…> | <…> | <…> | <from chrome://media-internals> |

Load: Chromium in the desktop scrolling `/usr/share/common-licenses/GPL-3` with `xdotool key
--delay 40 --repeat 600 Down`; 10 samples two seconds apart. Idle: five samples on a still screen.
S1's reference for the same desktop at 2×, continuous motion, measured in Selkies' own page:
61 fps, 234 % median / 251 % peak container CPU, Chrome 38–49 %.

Conclusion: <one or two sentences: whether the daemon proxy and the worker upload change the
picture, and whether 4:2:0 is worth switching to on M1-class hardware, which remains unmeasured>.
```
Fill the table from the two JSON files.

- [ ] **Step 5: Run the whole suite on Node 24, then on the host Node**

```bash
npx -y -p node@24.21.0 -c 'node --version && pnpm test && pnpm typecheck'
```
Expected: `v24.21.0`; every unit suite passes (the Part 1 suites were only exercised on Node 25.6;
`node:sqlite`'s `timeout` option and `isTransaction` exist on 24.21). If a `node:sqlite` API is
missing on 24, replace its use in `apps/daemon/src/event-log.ts` with the equivalent that exists on
both (`isTransaction` → track `BEGIN`/`COMMIT` in a boolean) and re-run; note it in the commit.
Then: `pnpm test && pnpm typecheck && pnpm lint && pnpm hygiene && LOCALDOT_DOCKER_TESTS=1 pnpm test:docker`
Expected: all green; the Docker run takes 8–12 minutes (gate, desktop images at 2× and 1×,
orchestrator against Docker, doctor).

`.github/workflows/ci.yml`: add `- run: pnpm --filter @localdot/web build` before `pnpm test`, so
CI also compiles the UI (the Docker suites stay local).

- [ ] **Step 6: README and commit**

Add to `README.md` under "Development":
```markdown
## Images and the live desktop

- `cells/gate/build.sh` builds `localdot/gate:dev`; `cells/desktop/build.sh` bundles `desktopd`
  and builds `localdot/desktop:dev` (the first build takes 10–25 minutes).
- `pnpm --filter @localdot/daemon run doctor` checks Docker Desktop (Engine 28+ with isolated gateway
  mode), the images and the port.
- `pnpm --filter @localdot/web build`, then `pnpm --filter @localdot/daemon start` (a terminal
  convenience; anything that must be able to stop the daemon — the e2e harness, a process manager —
  runs `node --import tsx src/main.ts` from `apps/daemon`, because pnpm does not forward `SIGTERM`)
  and open the `#token=` link it prints. "Start computer" creates a cell: one isolated internal
  network, a gate and a desktop whose home is the named volume `localdot-home-<id>`. The stream
  reaches the browser only through the daemon.
- The desktop wears the WhiteSur light theme and icons with a Plank dock and a menu-bar panel;
  the pinned theme commits and every third-party license are listed in `cells/desktop/THIRD-PARTY.md`.
- `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker` runs the Docker-backed suites;
  `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e` runs the browser acceptance test in
  the installed Google Chrome; `LOCALDOT_MEASURE=1 … e2e --grep measure` records fps and CPU.
- `apps/web/vendor/selkies` is Selkies' MPL-2.0 web client, extracted from the pinned base image
  (`cells/desktop/scripts/extract-selkies-client.sh`); the daemon serves it so no code from a cell
  ever runs in the UI's origin.
```

```bash
pnpm format && pnpm lint
git add apps/web apps/daemon docs/measurements README.md .github/workflows/ci.yml
git commit -m "test(e2e): live desktop acceptance and 2x measurements"
```

---

## Interfaces Part 3 builds on

Exact module paths and exports as they exist at the end of this plan.

**Daemon — cells**
- `apps/daemon/src/cells/orchestrator.ts`: `class CellOrchestrator` with `list(): CellSummary[]`,
  `get(id): CellSummary | undefined`, `record(id): CellRecord | undefined` (`record.tokens.desktopd`,
  `record.tokens.stream`, `record.keydPort` in 4760–4789, `record.docker.*` names and IPs),
  `endpoints(id): CellEndpoints | undefined` — `endpoints.desktopd = { baseUrl: "http://127.0.0.1:<port>", token }`
  is the gateway's `desktopd` base URL and bearer; `endpoints.stream = { baseUrl, authorization }`;
  `create({ scale })`, `start(id)`, `stop(id)`, `remove(id, { purgeHome? })`, `reconcile()`,
  `subscribe((cell: CellSummary) => void): () => void`, `updateStream(id, patch)`;
  `type CellApi` (the subset routes consume), `UnknownCellError`, `endpointsFor(record, ports)`.
  While it restarts a crashed cell, the cell is `starting` with `error` set to
  `<role> container exited with <code>; restarting (attempt n of m)`; the UI's `hudFor` reads that
  note as "Reconnecting…", so keep its shape.
- `apps/daemon/src/cells/types.ts`: `Scale`, `CellState` (`starting | ready | stopping | stopped | failed | removed`),
  `StreamConnection` (`none | connecting | live | stalled | disconnected`), `StreamState`,
  `CellSummary`, `CellRecord`, `CellEndpoints`, `DesktopdHealth`. The gateway holds dispatch while
  `get(id).stream.connection !== "live"` (spec, Error handling).
- `apps/daemon/src/cells/readiness.ts`: `probeDesktopd(endpoint)`, `probeStream(endpoint)`.
- `apps/daemon/src/cells/docker.ts`: `DockerClient.request<T>({ method, path, query?, body? })`, `DockerError`.
- `apps/daemon/src/cells/spec.ts`: `desktopSpec`, `gateSpec`, `desktopEnv`, `DESKTOPD_PORT = 7700`, `GATE_PORTS`.

**Daemon — HTTP and WebSocket**
- `apps/daemon/src/app.ts`: `createApp({ token, port, eventLog, cells?, desktop?, ui? })`.
- `apps/daemon/src/upgrade-router.ts`: `attachUpgradeRouter(server, { port, token }, routes)`,
  `UpgradeRoute { pattern; params; auth: "token" | "ticket"; open(ctx) }`, `tokenSocketServer()`,
  `refuse()`, `WS_PROTOCOL`. Part 3 adds its routes to the array in `main.ts`.
- `apps/daemon/src/event-stream.ts`: `sessionStreamRoute(eventLog)`.
- `apps/daemon/src/cells/status-stream.ts`: `cellStatusRoute(cells)` at `/api/cells/:id/status`.
- `apps/daemon/src/cells/stream-proxy.ts`: `desktopRoutes`, `desktopStreamRoute` (dials the cell
  first and completes the viewer's upgrade from its `open`; 502 when the cell refuses or can't be
  reached), `STREAM_PING_MS`, `STREAM_STALL_MS`.
- `apps/daemon/src/cells/secrets.ts`: `TicketRegistry`, `newCellToken()`.

**desktopd (in the cell)**
- `cells/desktop/desktopd/src/app.ts`: `createDesktopdApp(deps: DesktopdDeps): Hono` with
  `GET /healthz` behind `Authorization: Bearer <LOCALDOT_DESKTOPD_TOKEN>`; `DesktopdDeps { token; scale; display; readXsettings(); readScreen() }`;
  `DesktopdHealth`, `hidpiReport`. Part 3 adds `observe`, `hitTest`, `input`, `type`, `settle`,
  `shell`, `files.*`, `browser.*` routes to this app and extends `DesktopdDeps`.
- `cells/desktop/desktopd/src/auth.ts`: `bearerMatches(expected, authorization)`.
- The service: `cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-desktopd/run` runs
  `/opt/node/bin/node /opt/localdot/desktopd.mjs` as `abc` with `DISPLAY=:1` and
  `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus` (the XFCE session's bus; AT-SPI
  registers on it). The bundle is `cells/desktop/desktopd/build.mjs` → `dist/desktopd.mjs`,
  listening on `0.0.0.0:7700` inside the cell, reached through the gate relay at the published port.
- In the image for Part 3: `/usr/local/bin/cua-driver` (0.30.4, run as `abc` with
  `mcp --no-overlay`; `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`,
  `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0` baked in), `xinput`, `python3-xlib`, `xdotool`,
  `xfconf-query`, `xdpyinfo`, `xprop`, `certutil`, `chromium` (`chromium-browser`), LibreOffice,
  VSCodium, GIMP, ImageMagick, ffmpeg, pandoc, Node 24.21.0. Scale 2 means `Gdk/WindowScalingFactor` 2
  with `Xft/DPI` 96 (g = 2, c = 2: native frames are in model units, D13).
- Desktop geometry Part 3's mapping meets: the top panel is a 26 px (1×) / 54 px (2×) strut across
  the full width (`_NET_WM_STRUT_PARTIAL` from xfce4-panel, so maximized windows start below it);
  the Plank dock sits bottom-centre, always visible (`hide-mode none`), 48 px icons at 1× (96 device
  px at 2×) plus WhiteSur's dock padding, and also sets a strut; window buttons are on the left
  (`CHM|`) in WhiteSur's `-xhdpi` title bar at 2× and the base one at 1×. Read both struts with
  `xprop -id <window> _NET_WM_STRUT_PARTIAL` (xdotool search `--classname xfce4-panel` and `plank`)
  before trusting any window origin.

**Part 3 obligations carried from Part 1 and this plan (P2-R15, not implemented here)**
- Stage imports `PointerPlan` from `@localdot/protocol` and switches on `curve`, so the schema's
  version tag versions the renderer; the stage's own `PointerPlan` type goes away.
- Finite-input guards in the stage maths (`travelDurationMs`, `springValue` with response 0, NaN
  plans); the renderer is the last line before pixels.
- Decide the overshoot pixel cap (a 2000 px move overshoots 40–60 px) and the meaning of
  `resizedPixels` in `@localdot/providers` (or delete it) in the first stage/gateway task.
- Envelope `id` validated with `ULID_PATTERN` (schema change) before keyd reads the schema.
- `observe` screenshots stored as files keyed by `frameId`, never inline in the JSONL.
- The gateway truncates labels and names to the schema limits before emitting.
- Confirm Cua Driver's telemetry and update-check opt-outs on the wire (a cell on an isolated
  network reaches nothing today; Part 3 proves it when the driver first runs in a cell).
- Stream relay backpressure: `relay()` in `stream-proxy.ts` never checks `client.bufferedAmount`;
  a slow viewer must shed frames rather than grow the daemon's memory.
- Chromium launched maximized (`--start-maximized`) by the app launcher (P2-R8).
- A wedged Docker socket hangs daemon startup: `DockerClient.request` has no timeout, and `main.ts`
  awaits `orchestrator.reconcile()` before `serve()`. Give each request an `AbortSignal` timeout and
  reconcile in the background, so the UI is served while Docker is stuck (a stopped Docker already
  fails fast).

**Web**
- `apps/web/src/lib/api.ts`: `createApi(token, opts): ApiClient` (`get`, `post`, `del`, `socketUrl`, `socketProtocols`), `ApiError`.
- `apps/web/src/lib/socket.ts`: `openSocket({ url, protocols, handlers, … }): { close() }` — the
  session event stream (`/api/sessions/:id/stream`) is opened with `api.socketUrl(...)` and
  `api.socketProtocols()` the same way `useCell` opens the status socket.
- `apps/web/src/cells/useCell.ts`: `useCell(api): { cell, busy, error, start, stop }`;
  `apps/web/src/cells/hud-state.ts`: `hudFor(cell, busy): HudState`; `apps/web/src/cells/types.ts`.
- `apps/web/src/stage/frame-source.ts`: `FrameSource { readable: ReadableStream<VideoFrame>; trackId; stop() }`,
  `tapVideoTrack(video)`, `frameTapSupport()`.
- `apps/web/src/stage/pump.ts`: `Presenter { present(frame: VideoFrame) }`, `pumpFrames(readable, presenter, report, opts)`, `PumpStats`.
- `apps/web/src/stage/presenter.ts`: `canvasPresenter(canvas: OffscreenCanvas): Presenter` — Part 3
  replaces this with the PixiJS presenter (video texture + overlays under one camera matrix) inside
  `render-worker.ts`, keeping `WorkerIn`/`WorkerOut`.
- `apps/web/src/stage/render-worker.ts`: `WorkerIn = init | frames | stop`, `WorkerOut = stats | error`;
  `apps/web/src/stage/StageCanvas.tsx`: `StageCanvasHandle { attach(source); detach() }`,
  `<canvas class="stage-canvas" data-frames data-fps data-size>` (the stage canvas mount);
  `apps/web/src/stage/DesktopFrame.tsx`; `apps/web/src/stage/Stage.tsx` (`{ cell, api }`).
- `apps/web/src/shell/StageColumn.tsx` renders `children` inside `.stage` (overlays and the HUD
  layer go there); `apps/web/src/shell/Hud.tsx` (`data-testid="hud-status"`); `apps/web/src/theme.css`
  tokens named after Tailwind 4's theme namespaces, in `:root` until M4 moves them into `@theme`
  (`--color-xenon`, `--color-hud*`, `--color-text*`, `--color-cursor-*`, `--color-avatar-*`,
  `--font-ui`, `--font-mono`, `--spacing-rail`, `--radius-stage`, `--shadow-stage`, `--ease-press`;
  `--duration-press` is localDot's own).

## Decisions taken by this plan (ruled on by the controller, P2-R1 to P2-R15)

- Docker client: our own JSON-over-Unix-socket client pinned to API `v1.47`, not dockerode (P2-R3).
- Cell ports: Docker picks the host ports (`HostIp 127.0.0.1`, `HostPort ""`); the daemon re-reads
  them after every start, including its own restarts of an exited container (P2-R3, P2-R14).
- Static IPs inside each cell network: gate at offset 10, desktop at offset 11 of the subnet Docker
  assigned; the gate starts on its egress network and joins the internal one afterwards (S3's order).
- Desktop limits: 4 GiB memory (no swap), 4 CPUs, 4096 pids, 1 GiB `/dev/shm`; gate 64 MiB, 64 pids.
  No Docker restart policy: the orchestrator restarts with backoff 2/4/8/16/30 s and gives up after
  five restarts since the last user start or stop (P2-R14); a user's stop that lands during a
  restart wins, and the restart stops without touching the cell.
- Stream access from the iframe: one per-cell stream ticket (128-bit, memory only, constant-time
  compare, revoked when the cell leaves `ready`, on remove and on daemon restart; the same ticket
  is handed back while the cell stays ready) in the URL path, because the iframe cannot send a
  bearer (P2-R2).
- Selkies' client is vendored into `apps/web/vendor/selkies` from the pinned image with the MPL-2.0
  text and a NOTICE, and served by the daemon; nothing served by a cell runs in the UI's origin (P2-R1).
- Stall detection rests on the daemon's own 500 ms pings (Selkies' server heartbeat is 30 s):
  `stalled` after 1500 ms of silence; S8 may raise the second number (P2-R6).
- UI: plain CSS with the Theatre tokens named after Tailwind 4's theme namespaces in a `:root` block
  that M4 moves into `@theme` (`--duration-*` is localDot's own); Tailwind and shadcn/ui arrive with
  M4's component-heavy UI (P2-R4).
- The macOS look is in Part 2 (Task 3b): WhiteSur LIGHT GTK theme and `-xhdpi` xfwm4 build,
  WhiteSur icons, Plank with WhiteSur's light dock theme, a menu-bar panel; sources pinned by
  commit; licenses recorded in the image and in `cells/desktop/THIRD-PARTY.md` (P2-R5, P2-R12, P2-R13).
- The daemon is started with `node` directly by anything that must stop it; `pnpm start` is for a
  terminal only (P2-R11). It prints the `#token=` URL to stdout at startup until `npx localdot`
  opens the browser (P2-R7).
- Part 1's lock residuals and Ruling 36's two trivia (Task 6a) and A19's session metadata (Task 6b)
  are done here; the remaining carries are listed above as Part 3 obligations (P2-R11, P2-R15).
- Part 2 stops short of the keyd relay target: `LD_KEYD_PORT` is allocated and relayed to
  `host.docker.internal`, with nothing listening until M3 (P2-R9). Chromium-maximized and the
  locked `h264enc` encoder stand as ruled (P2-R8); S8 proves the stream path first (P2-R10).
