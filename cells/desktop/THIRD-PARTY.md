# Third-party components in the desktop image

| Component | Version | License | Where |
|---|---|---|---|
| linuxserver webtop (Ubuntu 26.04, XFCE 4.20, Selkies 2.0.0) | 53afe260-ls3, `sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804` | GPL-3.0-only (image), Selkies MPL-2.0 | base image |
| WhiteSur GTK theme (light) | tag 2026-09-10, commit 99247ecd219bdc1c7409baff062b4aafcf1102a7 | MIT | `/usr/share/themes/WhiteSur-Light*`, `/usr/share/plank/themes/WhiteSur-Light`, license at `/usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING` |
| WhiteSur icon theme | tag 2026-09-10, commit 73d8040da51a9ed74e47c7366e7e9ff437601a5c | GPL-3.0 (separately licensed data) | `/usr/share/icons/WhiteSur*`, license at `/usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING` |
| WhiteSur wallpapers: `Wallpaper-nord/Mojave-nord-light.png` | tag 2023-06-11, commit 4fe5ae7a01f38f8ff9a25c343e0a49234c1012c9, `sha256:4a5867e8c67e04ef23e8a13ce38644053ddb3aebeb0d02706924ffdfb0d95833` | MIT | `/usr/share/backgrounds/localdot/mojave-nord-light.png`, license at `/usr/share/doc/localdot-themes/WhiteSur-wallpapers.LICENSE` |
| Plank | Ubuntu package (unpinned, like the rest of apt) | GPL-3.0-or-later | `/usr/bin/plank`, license at `/usr/share/doc/plank/copyright` |
| Cua Driver | 0.30.4 | MIT | `/opt/cua`, `/usr/local/bin/cua-driver` |
| VSCodium | 1.135.06055 | MIT | `/usr/share/codium` |
| Node.js | 24.21.0 | MIT | `/opt/node` |

| @hono/node-server | 2.1.3 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| @modelcontextprotocol/sdk | 1.31.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ajv | 8.20.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ajv-formats | 3.0.1 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| cross-spawn | 7.0.6 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| fast-deep-equal | 3.1.3 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| fast-uri | 3.1.8 | BSD-3-Clause | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| Hono | 4.13.12 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| isexe | 2.0.0 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| json-schema-traverse | 1.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| path-key | 3.1.1 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| shebang-command | 2.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| shebang-regex | 3.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| which | 2.0.2 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ws | 8.22.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| zod | 4.6.5 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| zod-to-json-schema | 3.25.2 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src && pnpm --filter @localdot/desktopd build && cells/desktop/build.sh`
Expected: tests pass; the build prints `desktopd bundles 17 packages: …` with the packages above;
the bundle includes the MCP SDK (esbuild reports about 1.4 MB); the image rebuilds its last layer.

- [ ] **Step 6: Docker test — perception against real apps**

`apps/daemon/src/cells/desktopd-perception.docker.test.ts`:
```ts
import type { HitTestResult, ObserveResult } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyIntoDesktop, type DesktopContainer, execAsDesktopUser, startDesktopContainer, windowGeometry } from "./testing/desktop-container.ts";
import { DOCKER_TESTS, dockerExec, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

const C = "localdot-test-perception";
let cell: DesktopContainer;
const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${cell.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

describe.skipIf(!DOCKER_TESTS)("desktopd perception at 2x", () => {
  beforeAll(async () => {
    cell = startDesktopContainer(C, 2);
    await post("/launch", { app: "terminal" });
    waitFor("terminal", () => windowGeometry(C, "xfce4-terminal") !== undefined, 30_000);
    sleepSync(2000);
  });
  afterAll(() => removeAll({ containers: [C] }));

  it("hit-tests the terminal's File menu through the GTK mapping", async () => {
    const g = windowGeometry(C, "xfce4-terminal");
    if (!g) throw new Error("no terminal");
    const point = { x: g.x + 40, y: g.y + 26 };
    const hit = await post<HitTestResult>("/hitTest", { point });
    expect(hit.window).toBe(g.id);
    expect(hit.target).toMatchObject({ source: "ax", role: "menu", name: "File", app: "Xfce4-terminal" });
    const b = hit.target?.bbox;
    if (!b) throw new Error("no bbox");
    expect(point.x).toBeGreaterThanOrEqual(b.x);
    expect(point.x).toBeLessThan(b.x + b.w);
    expect(point.y).toBeGreaterThanOrEqual(b.y);
    expect(point.y).toBeLessThan(b.y + b.h);
    expect(b.h).toBe(54);
    expect(hit.ms).toBeLessThan(2500);
  });

  it("observes a 1280x800 WebP with the pointer and the windows", async () => {
    const o = await post<ObserveResult>("/observe", {});
    const bytes = Buffer.from(o.image, "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
    copyIntoDesktop(C, "/tmp/observe.webp", bytes);
    const identify = dockerExec(C, "identify", "-format", "%m %wx%h", "/tmp/observe.webp");
    expect(identify.status, identify.out).toBe(0);
    expect(identify.out).toBe("WEBP 1280x800");
    expect(o.windows.some((w) => w.cls === "Xfce4-terminal" && w.pid > 0)).toBe(true);
    expect(o.pointer.x).toBeGreaterThanOrEqual(0);
  });

  it("finds Calc's Name Box (GTK-drawn) and places a VCL-drawn sheet tab near the bottom", async () => {
    await post("/launch", { app: "calc" });
    waitFor("calc", () => windowGeometry(C, "libreoffice") !== undefined, 90_000);
    sleepSync(8000);
    const g = windowGeometry(C, "libreoffice");
    if (!g) throw new Error("no calc");
    const nameBox = await post<HitTestResult>("/find", { name: "Name Box" });
    expect(nameBox.target).toMatchObject({ source: "ax", app: expect.stringMatching(/libreoffice|Soffice/i) });
    expect(nameBox.target?.bbox?.w).toBeGreaterThan(50);
    const again = await post<HitTestResult>("/hitTest", { point: nameBox.target?.point });
    expect(again.target?.name).toBe(nameBox.target?.name);
    const tab = await post<HitTestResult>("/find", { name: "Sheet1", role: "page tab" });
    const b = tab.target?.bbox;
    if (!b) throw new Error("no sheet tab");
    expect(b.y).toBeGreaterThan(g.y + g.h * 0.8);
    expect(b.y + b.h).toBeLessThanOrEqual(g.y + g.h);
    // Use the found Name Box for real: click it, type B2, Enter — Calc's current cell must become B2.
    await post("/input", { input: { kind: "click", button: "left", count: 1, at: nameBox.target?.point }, window: nameBox.window });
    await post("/type", { text: "B2", masked: false, pace: { firstMs: 20, firstCount: 60, restMs: 6 } });
    await post("/input", { input: { kind: "key", combo: ["Return"] } });
    sleepSync(1000);
    const after = await post<HitTestResult>("/find", { name: "Name Box" });
    expect(after.target).toBeDefined();
    const value = execAsDesktopUser(C, "/usr/bin/python3", "-c", "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi\nd=Atspi.get_desktop(0)\n" +
      "def walk(n,depth=0):\n    for i in range(min(n.get_child_count(),400)):\n        c=n.get_child_at_index(i)\n        if c is None: continue\n        if c.get_name()=='Name Box' and c.get_role_name()=='text':\n            print(c.get_text_iface().get_text(0,-1)); return True\n        if depth<12 and walk(c,depth+1): return True\n    return False\n" +
      "[walk(d.get_child_at_index(i)) for i in range(d.get_child_count()) if 'soffice' in (d.get_child_at_index(i).get_name() or '').lower()]");
    expect(value.status, value.out).toBe(0);
    expect(value.out.trim()).toBe("B2");
  });
});
```

Run:
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktopd-perception.docker.test.ts
```
Expected: 3 tests pass in about 4 minutes.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/protocol cells/desktop apps/daemon/src/cells pnpm-lock.yaml
git commit -m "feat(desktopd): perception through Cua Driver with per-toolkit mapping, observe, hitTest and find"
```

---
### Task 7b: The driver's opt-outs on the wire

A Part 2 obligation, in its own unit (P3-C10): the image sets `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`
and `CUA_DRIVER_RS_UPDATE_CHECK=0`; this proves on the wire that the driver then sends nothing.
A CONNECT-logging proxy on the host receives every outbound TLS attempt of a container started with
`HTTPS_PROXY`; a control run with the opt-outs removed must show telemetry or update traffic, or
the method proves nothing (P3-C5). The proxy runs in a worker thread: the test's Docker helpers
block its own thread (`spawnSync`) for the whole driver run, so a proxy there could not answer
until the run was over (Part 2's Task 1 ruling).

**Files:**
- Create: `apps/daemon/src/cells/driver-optout.docker.test.ts`
- Test: `apps/daemon/src/cells/driver-optout.docker.test.ts`

**Interfaces:**
- Consumes: `docker`, `dockerExecAs`, `removeAll`, `sleepSync`, `waitFor` (`testing/docker-cli.ts`, Part 2), `DESKTOP_IMAGE` (`testing/desktop-container.ts`).
- Produces: nothing new; a documented limitation if the control run cannot see the driver's traffic.

- [ ] **Step 1: The proxy, the control run and the opt-out run**

`apps/daemon/src/cells/driver-optout.docker.test.ts`:
```ts
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESKTOP_IMAGE } from "./testing/desktop-container.ts";
import { DOCKER_TESTS, docker, dockerExecAs, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

// A CONNECT-logging proxy on 127.0.0.1:4798: every outbound TLS attempt from a container that honours
// HTTPS_PROXY shows up as a "CONNECT host:443" line. The driver is Rust/reqwest, which honours the
// variable; the control run proves the method before the opt-out run is trusted. The proxy answers
// from its own thread, because runDriver's Docker calls block this one (spawnSync) while the driver
// runs, and keeps its log until asked for it.
const PROXY_PORT = 4798;
const PROXY = `const { parentPort } = require("node:worker_threads");
const connects = [];
const server = require("node:net").createServer((socket) => {
  socket.once("data", (d) => {
    connects.push(String(d).split("\\r\\n")[0] ?? "");
    socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
  });
  socket.on("error", () => {});
});
parentPort.on("message", () => parentPort.postMessage(connects.splice(0)));
server.listen(${PROXY_PORT}, "127.0.0.1", () => parentPort.postMessage("listening"));
`;
let proxy: Worker;

// The CONNECT lines logged since the last call.
async function connectsSince(): Promise<string[]> {
  proxy.postMessage("read");
  const [lines] = await once(proxy, "message");
  return lines as string[];
}

function runDriver(name: string, env: Record<string, string>): string {
  removeAll({ containers: [name] });
  const flags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  docker("run", "-d", "--name", name, "--shm-size=1g", "--cap-drop", "NET_RAW", "-e", `HTTPS_PROXY=http://host.docker.internal:${PROXY_PORT}`, "-e", `HTTP_PROXY=http://host.docker.internal:${PROXY_PORT}`, "-e", "LOCALDOT_DESKTOPD_TOKEN=x".padEnd(60, "x"), ...flags, DESKTOP_IMAGE);
  waitFor("panel", () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0, 180_000);
  sleepSync(3000);
  const run = dockerExecAs(name, "abc", "env", "DISPLAY=:1", "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus", "sh", "-c", "timeout 20 cua-driver doctor; timeout 20 cua-driver telemetry status; printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"0\"}}}\\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"list_windows\",\"arguments\":{}}}\\n' | timeout 20 cua-driver mcp --no-overlay | head -c 20000");
  expect(run.status, run.out).toBe(0);
  sleepSync(5000);
  return run.out;
}

// The driver's JSON-RPC replies among the run's output lines.
const replies = (out: string) =>
  out.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }];
    } catch {
      return [];
    }
  });

describe.skipIf(!DOCKER_TESTS)("Cua Driver telemetry and update checks are off on the wire", () => {
  beforeAll(async () => {
    proxy = new Worker(PROXY, { eval: true });
    await once(proxy, "message");
  });
  afterAll(async () => {
    removeAll({ containers: ["localdot-test-optout-control", "localdot-test-optout"] });
    await proxy?.terminate();
  });

  it("control: with the opt-outs removed the driver tries to phone home through the proxy", async () => {
    runDriver("localdot-test-optout-control", { CUA_DRIVER_RS_TELEMETRY_ENABLED: "1", CUA_DRIVER_RS_UPDATE_CHECK: "1" });
    const connects = await connectsSince();
    const outbound = connects.filter((l) => /posthog|github/i.test(l));
    expect(outbound.length, `control run saw no telemetry or update traffic (${connects.join(" | ")}): the proxy method cannot confirm the opt-out; trace the driver with strace in a container with CAP_SYS_PTRACE instead`).toBeGreaterThan(0);
  });

  it("with the image's opt-outs the driver sends nothing", async () => {
    const out = runDriver("localdot-test-optout", {});
    // The driver ran for real: it answered the list_windows call (JSON-RPC id 2) with a result.
    expect(replies(out).find((r) => r.id === 2)?.result, out).toBeDefined();
    expect((await connectsSince()).filter((l) => /posthog|github/i.test(l))).toEqual([]);
  });
});
```


Run:
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/driver-optout.docker.test.ts
```
Expected: 2 tests pass in about 2 minutes. If the control run's assertion fails, the opt-out cannot
be confirmed by this method: record that in the commit message and in SUMMARY-style notes for the
user, and keep the test (it then documents the limitation by failing loudly rather than passing
vacuously).

- [ ] **Step 2: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells/driver-optout.docker.test.ts
git commit -m "test(cells): prove the driver's telemetry and update-check opt-outs on the wire"

localDot changed these components (2026-10-01):
- WhiteSur GTK theme: `WhiteSur-Light` is the repository's pre-built `release/WhiteSur-Light-solid`
  theme under that name, without its `gnome-shell` part (this desktop has no GNOME Shell, and its
  activities icon is the Apple logo). Its xfwm4 `-hdpi`/`-xhdpi` variants are assembled from the
  repository's `src/` the way its installer does.
- WhiteSur icon theme: the `start-here` and `folder-apple` icons (the Apple logo), and the links to
  them, are removed before its installer runs. No Apple fonts or artwork are in the image.
- Thunar (base image): `thunar.desktop` gains `StartupWMClass=Thunar-real`, so the dock matches the
  windows of the base's renamed Thunar binary.

The localDot code in this image (`desktopd`, the s6 services, the templates) is MIT like the rest
of the repository. This file is also in the image, at
`/usr/share/doc/localdot-themes/THIRD-PARTY.md`.
