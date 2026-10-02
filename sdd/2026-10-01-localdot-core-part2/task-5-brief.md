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
