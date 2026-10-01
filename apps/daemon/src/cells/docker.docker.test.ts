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
