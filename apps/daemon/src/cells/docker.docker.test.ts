import { describe, expect, it } from "vitest";
import { compareApiVersions, DOCKER_API, DockerClient } from "./docker.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

describe.skipIf(!DOCKER_TESTS)("DockerClient against Docker Desktop", () => {
  it("negotiates the pinned API version", async () => {
    const v = await new DockerClient().version();
    expect(compareApiVersions(v.MinAPIVersion, DOCKER_API)).toBeLessThanOrEqual(0);
    expect(compareApiVersions(v.ApiVersion, DOCKER_API)).toBeGreaterThanOrEqual(0);
    expect(v.Os).toBe("linux");
  });
});
