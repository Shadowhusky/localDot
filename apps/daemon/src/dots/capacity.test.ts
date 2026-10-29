import { describe, expect, it } from "vitest";
import type { DockerRequest } from "../cells/docker.ts";
import { computerCapacity } from "./capacity.ts";

const GIB = 1024 ** 3;
// Docker Desktop's 8 GB VM reports a little under 8 GiB.
function engine(running: string[], memory: number | undefined, os = "Docker Desktop") {
  const asked: DockerRequest[] = [];
  return {
    asked,
    request: async <T>(request: DockerRequest): Promise<T> => {
      asked.push(request);
      if (request.path === "/containers/json")
        return running.map((cell) => ({ Labels: { "localdot.cell": cell } })) as T;
      return { MemTotal: memory, OperatingSystem: os } as T;
    },
  };
}

describe("room for one more computer", () => {
  it("always lets the first computer start", async () => {
    const docker = engine([], 2 * GIB);
    expect(await computerCapacity(docker)).toBeUndefined();
    expect(docker.asked).toHaveLength(1);
    expect(docker.asked[0]?.query).toEqual({
      filters: JSON.stringify({ label: ["localdot.role=desktop"], status: ["running"] }),
    });
  });

  it("advises plainly when Docker needs more memory for a second one, on any dot", async () => {
    expect(await computerCapacity(engine(["A"], 7.66 * GIB))).toBe(
      "Two running computers need about 10 GB for Docker; it has 8 GB. Raise it in Docker Desktop → Settings → Resources.",
    );
    expect(await computerCapacity(engine(["A", "B"], 12 * GIB, "Ubuntu 24.04"))).toBe(
      "Three running computers need about 14 GB for Docker; it has 12 GB. Give Docker more memory, or stop a computer first.",
    );
  });

  it("lets it start with enough memory, when only it was running, or when memory is unknown", async () => {
    expect(await computerCapacity(engine(["A"], 10 * GIB))).toBeUndefined();
    expect(await computerCapacity(engine(["A"], 8 * GIB), "A")).toBeUndefined();
    expect(await computerCapacity(engine(["A"], undefined))).toBeUndefined();
  });
});
