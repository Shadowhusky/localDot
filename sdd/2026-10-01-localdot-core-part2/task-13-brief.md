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
