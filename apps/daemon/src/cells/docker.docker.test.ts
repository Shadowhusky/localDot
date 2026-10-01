import { describe, expect, it } from "vitest";
import { DOCKER_API, DockerClient } from "./docker.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// API versions compare as [major, minor] integers: read as decimals, 1.100 would sort below 1.47.
function compareApi(a: string, b: string): number {
  const [aMajor = Number.NaN, aMinor = Number.NaN] = a.replace(/^v/, "").split(".").map(Number);
  const [bMajor = Number.NaN, bMinor = Number.NaN] = b.replace(/^v/, "").split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

describe.skipIf(!DOCKER_TESTS)("DockerClient against Docker Desktop", () => {
  it("negotiates the pinned API version", async () => {
    expect(compareApi("1.100", DOCKER_API)).toBeGreaterThan(0);
    const v = await new DockerClient().version();
    expect(compareApi(v.MinAPIVersion, DOCKER_API)).toBeLessThanOrEqual(0);
    expect(compareApi(v.ApiVersion, DOCKER_API)).toBeGreaterThanOrEqual(0);
    expect(v.Os).toBe("linux");
  });
});
