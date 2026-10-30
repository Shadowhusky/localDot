import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMPUTER_SIZE, ulid } from "@localdot/protocol";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyLimits,
  browserLimits,
  ComputerSizes,
  desktopLimits,
  type Limits,
} from "./computer-size.ts";
import { DockerClient } from "./docker.ts";
import { DOCKER_TESTS, docker, dockerExec } from "./testing/docker-cli.ts";

const PREFIX = process.env.LOCALDOT_SIZE_TEST_PREFIX || "ldtest-size-";
const [LABEL_KEY = "", LABEL_VALUE = ""] = (
  process.env.LOCALDOT_SIZE_TEST_LABEL || "dev.localdot.test=size"
).split("=");
const IMAGE = process.env.LOCALDOT_SIZE_TEST_IMAGE || "alpine:3";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

interface Inspect {
  Id: string;
  State: { Running: boolean; OOMKilled: boolean; StartedAt: string };
  HostConfig: Limits;
}

describe.skipIf(!DOCKER_TESTS)("a computer's size on Docker", () => {
  const client = new DockerClient();
  const made: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "localdot-size-docker-"));
  afterAll(() => {
    for (const id of made) docker("rm", "-f", id);
    rmSync(home, { recursive: true, force: true });
  });

  async function computer(labels: Record<string, string>, limits: Limits): Promise<string> {
    const { Id } = await client.request<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      query: { name: `${PREFIX}${randomUUID()}` },
      body: {
        Image: IMAGE,
        Cmd: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
        Labels: { [LABEL_KEY]: LABEL_VALUE, ...labels },
        HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], ShmSize: GIB, ...limits },
      },
    });
    made.push(Id);
    await client.request({ method: "POST", path: `/containers/${Id}/start` });
    return Id;
  }
  const inspect = (id: string) =>
    client.request<Inspect>({ method: "GET", path: `/containers/${id}/json` });
  // What the kernel enforces inside, not only what Docker recorded.
  const cgroup = (id: string) => ({
    memory: dockerExec(id, "cat", "/sys/fs/cgroup/memory.max").out.trim(),
    cpu: dockerExec(id, "cat", "/sys/fs/cgroup/cpu.max").out.trim(),
  });

  it("changes a running computer's desktop and web browser in place", async () => {
    const cell = ulid();
    const desktop = await computer(
      { "localdot.role": "desktop", "localdot.cell": cell },
      desktopLimits(DEFAULT_COMPUTER_SIZE),
    );
    const browser = await computer(
      { "localdot.role": "browser", "localdot.cell": ulid(), "localdot.parent": cell },
      browserLimits(DEFAULT_COMPUTER_SIZE),
    );
    const before = await inspect(desktop);
    const sizes = new ComputerSizes({ home, docker: client, computers: () => [cell] });

    const view = await sizes.change({ memoryBytes: 3 * GIB, cpus: 3 });
    expect(view).toMatchObject({ size: { memoryBytes: 3 * GIB, cpus: 3 }, pending: false });
    expect(view.usage?.memoryBytes).toBeGreaterThan(0);
    expect(view.docker.memoryBytes).toBeGreaterThan(0);

    expect((await inspect(desktop)).HostConfig).toMatchObject(
      desktopLimits({ memoryBytes: 3 * GIB, cpus: 3 }),
    );
    expect(cgroup(desktop)).toEqual({ memory: String(3 * GIB), cpu: "300000 100000" });
    expect(cgroup(browser)).toEqual({ memory: String(2.25 * GIB), cpu: "150000 100000" });
    const after = await inspect(desktop);
    expect(after.State.Running).toBe(true);
    expect(after.State.StartedAt).toBe(before.State.StartedAt);
  });

  it("raises live, but leaves memory a running computer uses for its next start", async () => {
    const id = await computer({}, { Memory: GIB, MemorySwap: GIB, NanoCpus: 1e9 });
    expect(
      await applyLimits(client, id, { Memory: 2 * GIB, MemorySwap: 2 * GIB, NanoCpus: 2e9 }),
    ).toBe("applied");
    expect(cgroup(id)).toEqual({ memory: String(2 * GIB), cpu: "200000 100000" });

    // 300 MB in shared memory is held by the programs; the kernel can't drop it.
    expect(
      dockerExec(id, "dd", "if=/dev/zero", "of=/dev/shm/held", "bs=1M", "count=300").status,
    ).toBe(0);
    const tight = { Memory: 512 * MIB, MemorySwap: 512 * MIB, NanoCpus: 1e9 };
    expect(await applyLimits(client, id, tight)).toBe("pending");
    expect(cgroup(id)).toEqual({ memory: String(2 * GIB), cpu: "100000 100000" });
    expect((await inspect(id)).State).toMatchObject({ Running: true, OOMKilled: false });

    expect(await applyLimits(client, id, { Memory: GIB, MemorySwap: GIB, NanoCpus: 1e9 })).toBe(
      "applied",
    );
    expect(cgroup(id).memory).toBe(String(GIB));

    await client.request({ method: "POST", path: `/containers/${id}/stop`, query: { t: "1" } });
    expect(await applyLimits(client, id, tight)).toBe("applied");
    expect((await inspect(id)).HostConfig).toMatchObject(tight);
  });
});
