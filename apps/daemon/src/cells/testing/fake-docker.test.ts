import { afterEach, describe, expect, it } from "vitest";
import { DockerClient, DockerError } from "../docker.ts";
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
