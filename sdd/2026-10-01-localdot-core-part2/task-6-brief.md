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
