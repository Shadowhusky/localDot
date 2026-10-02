import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareApiVersions, DOCKER_API, DockerClient } from "./docker.ts";
import { imagesFromEnv } from "./images.ts";
import { tar } from "./tar.ts";
import { DOCKER_TESTS, docker } from "./testing/docker-cli.ts";

describe.skipIf(!DOCKER_TESTS)("DockerClient against Docker Desktop", () => {
  it("installs a binary archive while stopped and pauses, resumes and stops the same container", async () => {
    const client = new DockerClient();
    const name = `localdot-test-archive-${randomUUID()}`;
    const container = await client.request<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      query: { name },
      body: {
        Image: imagesFromEnv().gate,
        User: "0:0",
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: ["trap 'exit 0' TERM; while :; do sleep 1; done"],
        HostConfig: {
          NetworkMode: "none",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
        },
      },
    });
    const path = `/containers/${container.Id}`;
    const post = (action: string) => client.request({ method: "POST", path: `${path}/${action}` });
    try {
      const value = Buffer.from([0, 128, 255, 10, 192, 65]);
      await client.putArchive(
        container.Id,
        "/tmp",
        tar([{ name: "proxy-token", data: value, mode: 0o640 }]),
      );
      await expect(post("pause")).rejects.toMatchObject({ status: 409 });
      await post("start");
      expect(Buffer.from(docker("exec", name, "base64", "/tmp/proxy-token"), "base64")).toEqual(
        value,
      );
      expect(docker("exec", name, "stat", "-c", "%a:%u:%g", "/tmp/proxy-token")).toBe("640:0:0");
      await client.putArchive(
        container.Id,
        "/tmp",
        tar([{ name: "proxy-token", data: "rotated", mode: 0o600 }]),
      );
      expect(docker("exec", name, "cat", "/tmp/proxy-token")).toBe("rotated");
      await post("pause");
      expect(await client.request({ method: "GET", path: `${path}/json` })).toMatchObject({
        State: { Running: true, Paused: true },
      });
      await expect(post("pause")).rejects.toMatchObject({ status: 409 });
      await expect(post("start")).rejects.toMatchObject({ status: 409 });
      await post("unpause");
      // Engine 29.2 reports any non-paused container as 500, not 409.
      await expect(post("unpause")).rejects.toMatchObject({ status: 500 });
      await post("pause");
      await client.request({ method: "POST", path: `${path}/stop`, query: { t: "1" } });
      expect(await client.request({ method: "GET", path: `${path}/json` })).toMatchObject({
        State: { Running: false, Paused: false },
      });
      await expect(post("unpause")).rejects.toMatchObject({ status: 500 });
    } finally {
      await client.request({ method: "DELETE", path, query: { force: "true", v: "true" } });
    }
  });
  it("negotiates the pinned API version", async () => {
    const v = await new DockerClient().version();
    expect(compareApiVersions(v.MinAPIVersion, DOCKER_API)).toBeLessThanOrEqual(0);
    expect(compareApiVersions(v.ApiVersion, DOCKER_API)).toBeGreaterThanOrEqual(0);
    expect(v.Os).toBe("linux");
  });
});
