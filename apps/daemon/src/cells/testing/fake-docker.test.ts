import { afterEach, describe, expect, it } from "vitest";
import { DockerClient, DockerError } from "../docker.ts";
import { tar } from "../tar.ts";
import { type FakeDocker, startFakeDocker } from "./fake-docker.ts";

let fake: FakeDocker | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const statusOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (err: unknown) => (err instanceof DockerError ? err.status : err),
  );

describe("the fake Docker", () => {
  it("pauses as Docker does: a running container only, stopped even while paused", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    const post = (path: string) => statusOf(docker.request({ method: "POST", path }));
    await docker.request({
      method: "POST",
      path: "/containers/create",
      query: { name: "c" },
      body: { Image: "i", HostConfig: {} },
    });
    expect(await post("/containers/c/pause")).toBe(409);
    expect(await post("/containers/c/start")).toBe("ok");
    expect(await post("/containers/c/pause")).toBe("ok");
    expect(await docker.request({ method: "GET", path: "/containers/c/json" })).toMatchObject({
      State: { Running: true, Paused: true },
    });
    expect(await post("/containers/c/pause")).toBe(409);
    expect(await post("/containers/c/start")).toBe(409);
    expect(await post("/containers/c/unpause")).toBe("ok");
    expect(await post("/containers/c/unpause")).toBe(500);
    expect(await post("/containers/c/pause")).toBe("ok");
    expect(await post("/containers/c/stop")).toBe("ok");
    expect(fake.state.containers.get("c")).toMatchObject({ running: false, paused: false });
    expect(await post("/containers/c/unpause")).toBe(500);
  });

  it("extracts exact archive bytes into stopped and running containers", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    await docker.request({
      method: "POST",
      path: "/containers/create",
      query: { name: "c" },
      body: { Image: "i", HostConfig: {} },
    });
    const value = Buffer.from([0, 255, 128, 1]);
    await docker.putArchive("c", "/etc/localdot/cell", tar([{ name: "proxy-token", data: value }]));
    expect(fake.state.containers.get("c")?.files.get("/etc/localdot/cell/proxy-token")).toEqual(
      value,
    );
    await docker.request({ method: "POST", path: "/containers/c/start" });
    await docker.putArchive(
      "c",
      "/etc/localdot/cell",
      tar([
        { name: "proxy-token", data: "new" },
        { name: "empty", data: "" },
      ]),
    );
    expect(
      fake.state.containers.get("c")?.files.get("/etc/localdot/cell/proxy-token")?.toString(),
    ).toBe("new");
    expect(fake.state.containers.get("c")?.files.get("/etc/localdot/cell/empty")).toEqual(
      Buffer.alloc(0),
    );
    expect(await statusOf(docker.putArchive("missing", "/tmp", tar([])))).toBe(404);
  });
  it("refuses what Docker refuses, so an undo in the wrong order shows", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    const network = { Name: "n", Driver: "bridge" };
    const container = {
      Image: "i",
      HostConfig: { Mounts: [{ Type: "volume", Source: "v", Target: "/config" }] },
      NetworkingConfig: { EndpointsConfig: { n: {} } },
    };
    const create = (path: string, body: unknown, query?: Record<string, string>) =>
      statusOf(docker.request({ method: "POST", path, body, ...(query ? { query } : {}) }));
    const remove = (path: string, query?: Record<string, string>) =>
      statusOf(docker.request({ method: "DELETE", path, ...(query ? { query } : {}) }));

    expect(await create("/networks/create", network)).toBe("ok");
    expect(await create("/networks/create", network)).toBe(409);
    expect(await create("/volumes/create", { Name: "v" })).toBe("ok");
    expect(await create("/containers/create", container, { name: "c" })).toBe("ok");
    expect(await create("/containers/create", container, { name: "c" })).toBe(409);
    // Even force=true can't take a volume a container still uses, stopped or not.
    expect(await remove("/volumes/v", { force: "true" })).toBe(409);
    // A stopped container holds no endpoint; a running one does.
    expect(await statusOf(docker.request({ method: "POST", path: "/containers/c/start" }))).toBe(
      "ok",
    );
    expect(await remove("/networks/n")).toBe(403);
    expect(await remove("/containers/c")).toBe(409);
    expect(await remove("/containers/c", { force: "true" })).toBe("ok");
    expect(await remove("/networks/n")).toBe("ok");
    expect(await remove("/volumes/v", { force: "true" })).toBe("ok");
  });

  it("fails the requests a test names by prefix", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    fake.state.failRequests.add("POST /networks/create");
    expect(
      await statusOf(
        docker.request({ method: "POST", path: "/networks/create", body: { Name: "n" } }),
      ),
    ).toBe(500);
    expect(fake.state.networks.size).toBe(0);
  });
});
