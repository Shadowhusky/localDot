import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
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
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const s = {
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        contentType: req.headers["content-type"],
      };
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
  return { socketPath, seen };
}

describe("DockerClient", () => {
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
    await expect(
      new DockerClient(socketPath).request({
        method: "DELETE",
        path: "/containers/c1",
        query: { force: "true", v: "false" },
      }),
    ).resolves.toBeUndefined();
    expect(seen[0]?.url).toBe(`/${DOCKER_API}/containers/c1?force=true&v=false`);
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
    expect((err as Error).message).toContain("No such container: c1");
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
    const err = await new DockerClient(join(tmpdir(), "ld-missing.sock")).version().catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(0);
    expect((err as Error).message).toContain("Docker Desktop");
  });

  it("reads the socket path from DOCKER_HOST", () => {
    expect(dockerSocketPath({})).toBe("/var/run/docker.sock");
    expect(dockerSocketPath({ DOCKER_HOST: "unix:///Users/me/.docker/run/docker.sock" })).toBe(
      "/Users/me/.docker/run/docker.sock",
    );
    expect(dockerSocketPath({ DOCKER_HOST: "tcp://1.2.3.4:2375" })).toBe("/var/run/docker.sock");
  });
});
