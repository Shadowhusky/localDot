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
