import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareApiVersions,
  DOCKER_API,
  DockerClient,
  DockerError,
  dockerSocketPath,
} from "./docker.ts";
import { tar } from "./tar.ts";

interface Seen {
  method: string;
  url: string;
  body: string;
  raw: Buffer;
  contentType: string | undefined;
}

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function listen(handler: RequestListener): Promise<string> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "ld-docker-")), "d.sock");
  server = createServer(handler);
  const listening = server;
  await new Promise<void>((r) => listening.listen(socketPath, r));
  return socketPath;
}

async function fakeDocker(
  reply: (seen: Seen) => { status: number; body?: unknown },
): Promise<{ socketPath: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const socketPath = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const s = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw.toString("utf8"),
        raw,
        contentType: req.headers["content-type"],
      };
      seen.push(s);
      const r = reply(s);
      if (r.body === undefined) {
        res.writeHead(r.status);
        res.end();
        return;
      }
      // Docker sends a small JSON reply with its length; writeHead without one would chunk it.
      const text = JSON.stringify(r.body);
      res.writeHead(r.status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    });
  });
  return { socketPath, seen };
}

const missingSocket = () => join(tmpdir(), "ld-missing.sock");

describe("DockerClient", () => {
  it("checks the actual Linux engine rather than Desktop's version proxy", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({
      status: 200,
      body: { OSType: "linux", ServerVersion: "29.8.2" },
    }));
    await expect(new DockerClient(socketPath).checkReady()).resolves.toBeUndefined();
    expect(seen.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `/${DOCKER_API}/info` },
    ]);
  });
  it.each([undefined, null, {}, { OSType: "windows", ServerVersion: "29" }])(
    "does not accept an incomplete engine readiness response: %j",
    async (body) => {
      const { socketPath } = await fakeDocker(() => ({ status: 200, body }));
      await expect(new DockerClient(socketPath).checkReady()).rejects.toMatchObject({
        name: "DockerError",
        path: "/info",
        status: 503,
      });
    },
  );
  it("bounds an engine readiness probe even when Desktop accepts the socket but never responds", async () => {
    const socketPath = await listen(() => {});
    await expect(new DockerClient(socketPath).checkReady(50)).rejects.toMatchObject({
      name: "DockerError",
      status: 0,
      path: "/info",
      timedOut: true,
    });
  });
  it("tells a refused socket apart from a late reply", async () => {
    await expect(new DockerClient(missingSocket()).checkReady(50)).rejects.toMatchObject({
      name: "DockerError",
      status: 0,
      timedOut: false,
    });
  });
  it("uploads exact binary tar bytes with an encoded target directory and container", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({ status: 200 }));
    const archive = tar([{ name: "proxy-token", data: Buffer.from([0, 255, 192, 10, 128]) }]);
    await new DockerClient(socketPath).putArchive(
      "localdot-desktop-a/b",
      "/etc/local dot's/cell",
      archive,
    );
    expect(seen[0]).toMatchObject({
      method: "PUT",
      url: `/${DOCKER_API}/containers/localdot-desktop-a%2Fb/archive?path=%2Fetc%2Flocal+dot%27s%2Fcell`,
      contentType: "application/x-tar",
    });
    expect(seen[0]?.raw).toEqual(archive);
  });

  it("rejects a request with both JSON and raw data before sending it", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({ status: 200 }));
    await expect(
      new DockerClient(socketPath).request({
        method: "PUT",
        path: "/containers/c/archive",
        body: { ignored: true },
        raw: { contentType: "application/x-tar", data: Buffer.alloc(0) },
      }),
    ).rejects.toMatchObject({ name: "DockerError", status: 0 });
    expect(seen).toHaveLength(0);
  });
  it("gives up on a socket that never answers", async () => {
    const socketPath = await listen(() => {});
    const started = Date.now();
    const err = await new DockerClient(socketPath, 200)
      .request({ method: "GET", path: "/containers/c1/json" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 0, path: "/containers/c1/json" });
    expect((err as Error).message).toContain("no reply within 200 ms");
    expect(Date.now() - started).toBeLessThan(2000);
    const own = await new DockerClient(socketPath)
      .request({ method: "GET", path: "/version", timeoutMs: 50 })
      .catch((e) => e);
    expect((own as Error).message).toContain("no reply within 50 ms");
  });
  it("sends JSON with the API version prefix and parses JSON replies", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({
      status: 201,
      body: { Id: "abc", Warnings: [] },
    }));
    const out = await new DockerClient(socketPath).request<{ Id: string }>({
      method: "POST",
      path: "/networks/create",
      body: { Name: "n", Internal: true },
    });
    expect(out.Id).toBe("abc");
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: `/${DOCKER_API}/networks/create`,
      contentType: "application/json",
    });
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ Name: "n", Internal: true });
  });

  it("encodes query parameters and resolves undefined for empty replies", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({ status: 204 }));
    const query = { filters: JSON.stringify({ label: ["localdot.cell=a b"] }), name: "x&y=z w" };
    await expect(
      new DockerClient(socketPath).request({ method: "DELETE", path: "/containers/c1", query }),
    ).resolves.toBeUndefined();
    expect(seen[0]?.url).toBe(
      `/${DOCKER_API}/containers/c1?filters=%7B%22label%22%3A%5B%22localdot.cell%3Da+b%22%5D%7D&name=x%26y%3Dz+w`,
    );
    const decoded = new URL(seen[0]?.url ?? "", "http://docker").searchParams;
    expect(Object.fromEntries(decoded)).toEqual(query);
  });

  it("turns error replies into DockerError carrying Docker's message", async () => {
    const { socketPath } = await fakeDocker(() => ({
      status: 404,
      body: { message: "No such container: c1" },
    }));
    const err = await new DockerClient(socketPath)
      .request({ method: "GET", path: "/containers/c1/json" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 404, path: "/containers/c1/json" });
    expect((err as Error).message).toBe("docker 404 on /containers/c1/json: No such container: c1");
  });

  it("resolves a 304 (nothing to do) and rejects any other 3xx as DockerError", async () => {
    const { socketPath } = await fakeDocker((seen) => ({
      status: seen.url.endsWith("/start") ? 304 : 301,
    }));
    const client = new DockerClient(socketPath);
    await expect(
      client.request({ method: "POST", path: "/containers/c1/start" }),
    ).resolves.toBeUndefined();
    const err = await client
      .request({ method: "GET", path: "/containers/c1/json" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 301, path: "/containers/c1/json" });
  });

  it("reads a chunked reply whole", async () => {
    const socketPath = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"Id":');
      setTimeout(() => res.write('"abc","Warn'), 10);
      setTimeout(() => res.end('ings":[]}'), 20);
    });
    await expect(
      new DockerClient(socketPath).request({ method: "GET", path: "/containers/c1/json" }),
    ).resolves.toEqual({ Id: "abc", Warnings: [] });
  });

  it("reads a large reply whole", async () => {
    const containers = Array.from({ length: 20_000 }, (_, i) => ({
      Id: `c${i}`,
      Labels: { "localdot.cell": `cell-${i}` },
    }));
    const { socketPath } = await fakeDocker(() => ({ status: 200, body: containers }));
    const out = await new DockerClient(socketPath).request<typeof containers>({
      method: "GET",
      path: "/containers/json",
    });
    expect(JSON.stringify(containers).length).toBeGreaterThan(1_000_000);
    expect(out).toEqual(containers);
  });

  it("rejects, never throws, for a body it cannot serialise or a path Node refuses", async () => {
    const client = new DockerClient(missingSocket());
    const call = (path: string, body?: unknown) => {
      try {
        return client.request({ method: "POST", path, body });
      } catch (err) {
        return `threw ${String(err)}`;
      }
    };
    for (const [path, body] of [
      ["/containers/create", { Memory: 1n }],
      ["/containers/a b/start", undefined],
    ] as const) {
      const pending = call(path, body);
      expect(pending, path).toBeInstanceOf(Promise);
      await expect(pending, path).rejects.toMatchObject({ name: "DockerError", status: 0, path });
    }
  });

  it("rejects a reply cut off mid-body as DockerError 0", async () => {
    const socketPath = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write('{"Id":"ab', () => res.destroy());
    });
    const err = await new DockerClient(socketPath)
      .request({ method: "GET", path: "/containers/c1/json" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 0, path: "/containers/c1/json" });
  });

  it("rejects a malformed JSON reply as DockerError", async () => {
    const socketPath = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"Id":');
    });
    const err = await new DockerClient(socketPath)
      .request({ method: "GET", path: "/containers/c1/json" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 200, path: "/containers/c1/json" });
    expect((err as Error).message).toContain("malformed JSON");
  });

  it("reports an unreachable socket as DockerError 0", async () => {
    const err = await new DockerClient(missingSocket()).version().catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(0);
    expect((err as Error).message).toContain("Docker Desktop");
  });

  it("reads the socket path from DOCKER_HOST", () => {
    expect(dockerSocketPath({})).toBe("/var/run/docker.sock");
    expect(dockerSocketPath({ DOCKER_HOST: "unix:///Users/me/.docker/run/docker.sock" })).toBe(
      "/Users/me/.docker/run/docker.sock",
    );
    for (const host of [
      "tcp://1.2.3.4:2375",
      "unix://",
      "",
      "unix://relative",
      "unix:///",
      "unix:///tmp/../sock",
      "unix:///tmp/sock?x",
      "unix:///tmp/sock\n",
    ])
      expect(() => dockerSocketPath({ DOCKER_HOST: host })).toThrow();
  });

  it("refuses an empty socket path, which Node would trade for TCP to localhost:80", () => {
    expect(() => new DockerClient("")).toThrow("the Docker socket path is empty");
  });

  it("asks for the engine's own version without the API prefix", async () => {
    const engine = { Version: "26.1.4", ApiVersion: "1.45", MinAPIVersion: "1.24" };
    const { socketPath, seen } = await fakeDocker(() => ({ status: 200, body: engine }));
    await expect(new DockerClient(socketPath).engineVersion()).resolves.toEqual(engine);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /version"]);
  });

  it("compares API versions as integer pairs", () => {
    expect(compareApiVersions("1.100", DOCKER_API)).toBeGreaterThan(0);
    expect(compareApiVersions("1.45", "v1.47")).toBeLessThan(0);
    expect(compareApiVersions("v1.47", "1.47")).toBe(0);
    expect(compareApiVersions("2.0", "1.99")).toBeGreaterThan(0);
  });
});
