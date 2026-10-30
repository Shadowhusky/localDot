import { describe, expect, it } from "vitest";
import type { DockerRequest } from "../cells/docker.ts";
import { computerCapacity, dockerRoom, sizeBounds } from "./capacity.ts";

const GIB = 1024 ** 3;
// Docker Desktop's 8 GB VM reports a little under 8 GiB. Each running computer is a cell id and
// the memory its desktop may use, today's 4 GiB unless given.
function engine(
  running: (string | [string, number])[],
  memory: number | undefined,
  os = "Docker Desktop",
) {
  const asked: DockerRequest[] = [];
  const computers = running.map((each): [string, number] =>
    typeof each === "string" ? [each, 4 * GIB] : each,
  );
  return {
    asked,
    request: async <T>(request: DockerRequest): Promise<T> => {
      asked.push(request);
      if (request.path === "/containers/json")
        return computers.map(([cell]) => ({
          Id: `desktop-${cell}`,
          Labels: { "localdot.cell": cell },
        })) as T;
      const inspected = /^\/containers\/desktop-(.+)\/json$/.exec(request.path);
      if (inspected) {
        const memoryBytes = computers.find(([cell]) => cell === inspected[1])?.[1];
        return { HostConfig: { Memory: memoryBytes, NanoCpus: 4e9 } } as T;
      }
      return { MemTotal: memory, NCPU: 24, OperatingSystem: os } as T;
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

  it("counts each computer at the size its dot gave it", async () => {
    expect(
      await computerCapacity(engine([["A", 2 * GIB]], 7.66 * GIB), undefined, 3 * GIB),
    ).toBeUndefined();
    expect(await computerCapacity(engine([["A", 6 * GIB]], 12 * GIB), undefined, 6 * GIB)).toBe(
      "Two running computers need about 14 GB for Docker; it has 12 GB. Raise it in Docker Desktop → Settings → Resources.",
    );
  });
});

describe("how much one dot's computer may have", () => {
  it("leaves the headroom and what other dots hold, in whole steps", () => {
    const room = { memoryBytes: 7.65 * GIB, cpus: 24 };
    expect(sizeBounds(room, { memoryBytes: 0, cpus: 0 })).toEqual({
      memoryBytes: 5.5 * GIB,
      cpus: 24,
    });
    expect(sizeBounds(room, { memoryBytes: 4 * GIB, cpus: 4.5 })).toEqual({
      memoryBytes: 1.5 * GIB,
      cpus: 19,
    });
    expect(sizeBounds(room, { memoryBytes: 8 * GIB, cpus: 30 })).toEqual({
      memoryBytes: 0,
      cpus: 0,
    });
  });

  it("says where Docker's limits are raised", async () => {
    const info = (OperatingSystem: string, Name = "docker") => ({
      request: async <T>() => ({ MemTotal: 8 * GIB, NCPU: 8, OperatingSystem, Name }) as T,
    });
    expect((await dockerRoom(info("Docker Desktop"), "darwin"))?.app).toBe("docker-desktop");
    expect((await dockerRoom(info("OrbStack"), "darwin"))?.app).toBe("orbstack");
    expect((await dockerRoom(info("Ubuntu 24.04", "colima"), "darwin"))?.app).toBe("vm");
    expect((await dockerRoom(info("Ubuntu 24.04"), "linux"))?.app).toBe("host");
    expect(
      await dockerRoom({ request: async <T>() => ({ OperatingSystem: "Docker Desktop" }) as T }),
    ).toBeUndefined();
    expect(
      await dockerRoom({ request: async <T>() => ({ MemTotal: 8 * GIB }) as T }, "darwin"),
    ).toEqual({ memoryBytes: 8 * GIB, cpus: 0, app: "vm" });
  });
});
