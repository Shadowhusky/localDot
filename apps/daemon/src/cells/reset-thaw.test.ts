import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DockerClient, DockerError, type DockerRequest } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { ComputerResetHolds } from "./reset-holds.ts";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const old = "01JXYZ00000000000000000001",
  fresh = "01JXYZ00000000000000000002",
  requestId = "01JXYZ00000000000000000003";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ownership = {
  gate: "1".repeat(64),
  desktop: "2".repeat(64),
  internalNetwork: "3".repeat(64),
  egressNetwork: "4".repeat(64),
};

function fixture(candidate = true) {
  const home = mkdtempSync(join(tmpdir(), "localdot-reset-thaw-"));
  roots.push(home);
  const holds = new ComputerResetHolds(home);
  if (candidate) holds.hold(old, fresh, requestId);
  const record = { ...sampleRecord(fresh), ownership };
  new CellStore(home).save(record);
  const labels = (role: string) => ({ "localdot.cell": fresh, "localdot.role": role });
  const objects: Record<string, Record<string, unknown>> = {
    [`/containers/${record.docker.desktop}/json`]: {
      Id: ownership.desktop,
      Config: { Labels: labels("desktop") },
      State: { Running: true, Paused: true },
    },
    [`/containers/${record.docker.gate}/json`]: {
      Id: ownership.gate,
      Config: { Labels: labels("gate") },
      State: { Running: true, Paused: false },
    },
    [`/networks/${record.docker.internalNetwork}`]: {
      Id: ownership.internalNetwork,
      Labels: labels("internal"),
    },
    [`/networks/${record.docker.egressNetwork}`]: {
      Id: ownership.egressNetwork,
      Labels: labels("egress"),
    },
    [`/volumes/${record.docker.homeVolume}`]: {
      Name: record.docker.homeVolume,
      Labels: labels("home"),
    },
  };
  const events: string[] = [];
  const docker = new DockerClient(join(home, "unused-fixture.sock"));
  vi.spyOn(docker, "request").mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
    if (req.method === "POST") {
      events.push(`${req.path}`);
      return undefined as T;
    }
    const found = objects[req.path];
    if (!found) throw new DockerError(404, "fixture absent", req.path);
    return structuredClone(found) as T;
  });
  let wired = true;
  const keyd = {
    wire: vi.fn(),
    isWired: vi.fn(async () => {
      events.push("isWired");
      return wired;
    }),
    refresh: vi.fn(async () => {
      events.push("refresh");
      return [];
    }),
    revoke: vi.fn(async () => {
      events.push("revoke");
      return 0;
    }),
    close: vi.fn(),
  };
  const cells = new CellOrchestrator({
    store: new CellStore(home),
    docker,
    images: { desktop: "fixture/desktop:dev", gate: "fixture/gate:dev" },
    keyd,
    permanentFence: (id) => holds.oldHeld(id),
    candidateHold: (id) => holds.candidateHeld(id),
    probeDesktopd: async () => undefined,
    probeStream: async () => false,
    watchEveryMs: 0,
  });
  const unwire = () => {
    wired = false;
  };
  return { cells, events, objects, record, holds, unwire };
}

it("thaws an exactly owned frozen candidate with Resume's key order and keeps it held", async () => {
  const f = fixture();
  await f.cells.thawReplacement(fresh);
  expect(f.events).toEqual([
    "revoke",
    "isWired",
    "refresh",
    `/containers/${ownership.desktop}/unpause`,
  ]);
  expect(f.cells.get(fresh)?.replacementPending).toBe(true);
  f.cells.dispose();
});

it.each(["not-frozen", "gate-stopped", "foreign-desktop", "volume-missing", "unwired", "not-held"])(
  "refuses to thaw when %s",
  async (fault) => {
    const f = fixture(fault !== "not-held");
    const desktop = f.objects[`/containers/${f.record.docker.desktop}/json`] as {
      Id: string;
      State: { Paused: boolean };
    };
    const gate = f.objects[`/containers/${f.record.docker.gate}/json`] as {
      State: { Running: boolean };
    };
    if (fault === "not-frozen") desktop.State.Paused = false;
    if (fault === "gate-stopped") gate.State.Running = false;
    if (fault === "foreign-desktop") desktop.Id = "5".repeat(64);
    if (fault === "volume-missing") delete f.objects[`/volumes/${f.record.docker.homeVolume}`];
    if (fault === "unwired") f.unwire();
    await expect(f.cells.thawReplacement(fresh)).rejects.toThrow();
    expect(f.events.some((event) => event.endsWith("/unpause"))).toBe(false);
    expect(f.events).not.toContain("refresh");
    f.cells.dispose();
  },
);
