import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ComputerResetRecord } from "../../../../packages/protocol/src/computer-reset.ts";
import { ComputerFences } from "../agent/safety/fences.ts";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { ComputerResetHolds } from "./reset-holds.ts";
import { ComputerResetOwner } from "./reset-owner.ts";
import { ComputerResetStore } from "./reset-store.ts";
import { CellStore } from "./store.ts";
import { startFakeDocker } from "./testing/fake-docker.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { DesktopdHealth } from "./types.ts";

const old = "01JXYZ00000000000000000001",
  fresh = "01JXYZ00000000000000000002",
  requestId = "01JXYZ00000000000000000003",
  other = "01JXYZ00000000000000000004";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-reset-holds-"));
  roots.push(home);
  const holds = new ComputerResetHolds(home),
    store = new ComputerResetStore(home);
  const record: ComputerResetRecord = {
    v: 1,
    requestId,
    oldCellId: old,
    newCellId: fresh,
    phase: "retiring",
    source: {
      scale: 2,
      browser: null,
      desktop: {
        workload: { name: "desktop", id: "a".repeat(64) },
        gate: { name: "gate", id: "b".repeat(64) },
        internalNetwork: { name: "internal", id: "c".repeat(64) },
        egressNetwork: { name: "egress", id: "d".repeat(64) },
        volume: "home",
      },
    },
  };
  const ready = () => {
    for (const phase of ["retiring", "retired", "creating", "ready"] as const)
      store.write({ ...record, phase });
    return { ...record, phase: "ready" as const };
  };
  return {
    home,
    holds,
    store,
    record,
    ready,
    file: join(home, "safety/computer-reset-holds", `${requestId}.json`),
  };
}
it("persists immutable request bindings independently and installs both holds synchronously", () => {
  const f = fixture();
  const listener = vi.fn(() => {
    expect(f.holds.oldHeld(old)).toBe(true);
    expect(f.holds.candidateHeld(fresh)).toBe(true);
  });
  f.holds.subscribe(listener);
  f.holds.hold(old, fresh, requestId);
  expect(listener).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual({
    requestId,
    oldCellId: old,
    newCellId: fresh,
  });
  expect(f.holds.records()).toEqual([{ requestId, oldCellId: old, newCellId: fresh }]);
  expect(f.holds.oldHeld(fresh)).toBe(false);
  expect(f.holds.candidateHeld(other)).toBe(false);
});
it("does not let a subscriber change the durable identity binding", () => {
  const f = fixture();
  f.holds.subscribe((binding) => {
    expect(() => {
      binding.newCellId = other;
    }).toThrow();
  });
  f.holds.hold(old, fresh, requestId);
  expect(f.holds.records()).toEqual([{ requestId, oldCellId: old, newCellId: fresh }]);
});
it("restores reset admission in real cell controls before replacement recovery can publish", async () => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  const ready = f.ready();
  const reopened = new ComputerResetHolds(f.home);
  const store = new CellStore(f.home);
  store.save(sampleRecord(old));
  store.save({ ...sampleRecord(fresh), keydPort: 4761 });
  const docker = new DockerClient(join(f.home, "unused-fixture.sock"));
  const request = vi
    .spyOn(docker, "request")
    .mockRejectedValue(new Error("unexpected Docker operation"));
  const cells = new CellOrchestrator({
    store,
    docker,
    images: { desktop: "fixture/desktop:dev", gate: "fixture/gate:dev" },
    permanentFence: (id) => reopened.oldHeld(id),
    candidateHold: (id) => reopened.candidateHeld(id),
    probeDesktopd: async () => undefined,
    probeStream: async () => false,
    watchEveryMs: 0,
  });
  try {
    expect(cells.get(old)?.fenced).toBeDefined();
    expect(cells.get(fresh)?.replacementPending).toBe(true);
    cells.publishReplacement(fresh);
    expect(cells.get(fresh)?.replacementPending).toBe(true);
    await expect(cells.start(fresh)).rejects.toThrow("awaiting replacement confirmation");
    await expect(cells.start(old)).rejects.toThrow("permanently fenced");
    expect(request).not.toHaveBeenCalled();
    reopened.publish(ready);
    expect(cells.get(fresh)?.replacementPending).toBeUndefined();
    expect(cells.get(old)?.fenced).toBeDefined();
  } finally {
    cells.dispose();
    request.mockRestore();
  }
});
it("a Reset candidate reaches Ready under its hold but stays withheld until the reset publishes it", async () => {
  const f = fixture(),
    fake = await startFakeDocker();
  f.holds.hold(old, fresh, requestId);
  const health: DesktopdHealth = {
    ok: true,
    scale: 2,
    display: ":1",
    screen: { w: 2560, h: 1600 },
    hidpi: {
      ok: true,
      expected: { windowScalingFactor: 2, xftDpi: 96 },
      windowScalingFactor: 2,
      xftDpi: 96,
    },
  };
  const cells = new CellOrchestrator({
    store: new CellStore(f.home),
    docker: new DockerClient(fake.socketPath),
    images: { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" },
    permanentFence: (id) => f.holds.oldHeld(id),
    candidateHold: (id) => f.holds.candidateHeld(id),
    probeDesktopd: async () => health,
    probeStream: async () => true,
    watchEveryMs: 60000,
    readyTimeoutMs: 1000,
  });
  try {
    await cells.create({ id: fresh, scale: 2 });
    await vi.waitFor(() => expect(cells.get(fresh)?.state).toBe("ready"));
    expect(cells.get(fresh)?.replacementPending).toBe(true);
    expect(cells.endpoints(fresh)).toBeUndefined();
    await expect(cells.start(fresh)).rejects.toThrow("awaiting replacement confirmation");
    f.holds.publish(f.ready());
    expect(cells.get(fresh)?.replacementPending).toBeUndefined();
    expect(cells.endpoints(fresh)).toBeDefined();
  } finally {
    cells.dispose();
    await fake.close();
  }
});
it("requires the exact durable Ready record and keeps a published candidate released on restart", () => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  expect(() => f.holds.publish({ ...f.record, phase: "ready" })).toThrow();
  const ready = f.ready();
  expect(new ComputerResetHolds(f.home).candidateHeld(fresh)).toBe(true);
  f.holds.publish(ready);
  expect(f.holds.oldHeld(old)).toBe(true);
  expect(f.holds.candidateHeld(fresh)).toBe(false);
  const reopened = new ComputerResetHolds(f.home);
  expect(reopened.oldHeld(old)).toBe(true);
  expect(reopened.candidateHeld(fresh)).toBe(false);
  expect(reopened.finalised(fresh)).toBe(true);
  reopened.hold(old, fresh, requestId);
  expect(reopened.candidateHeld(fresh)).toBe(false);
});
it.each(["changed-binding", "missing-ready-record"])(
  "closes all reset admission when a release receipt has %s",
  (fault) => {
    const f = fixture();
    f.holds.hold(old, fresh, requestId);
    f.holds.publish(f.ready());
    const receipt = join(f.home, "safety/computer-reset-releases", `${requestId}.json`);
    if (fault === "changed-binding")
      writeFileSync(receipt, JSON.stringify({ requestId, oldCellId: old, newCellId: other }), {
        mode: 0o600,
      });
    else unlinkSync(join(f.home, "safety/computer-resets", `${requestId}.json`));
    const reopened = new ComputerResetHolds(f.home);
    expect(reopened.candidateHeld(fresh)).toBe(true);
    expect(reopened.finalised(fresh)).toBe(false);
    expect(reopened.oldHeld(other)).toBe(true);
  },
);
it("a later reset of a finalised computer holds it as the old computer again", () => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  f.holds.publish(f.ready());
  const reopened = new ComputerResetHolds(f.home);
  reopened.hold(fresh, other, "01JXYZ00000000000000000005");
  expect(reopened.finalised(fresh)).toBe(false);
  expect(reopened.oldHeld(fresh)).toBe(true);
  expect(reopened.candidateHeld(fresh)).toBe(true);
  expect(new ComputerResetHolds(f.home).candidateHeld(fresh)).toBe(true);
});
it("never releases an identity that a later reset uses as its old computer", () => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  const ready = f.ready();
  f.holds.publish(ready);
  f.holds.hold(fresh, other, "01JXYZ00000000000000000005");
  expect(() => f.holds.publish(ready)).toThrow();
  expect(f.holds.oldHeld(fresh)).toBe(true);
  expect(f.holds.candidateHeld(fresh)).toBe(true);
});
it.each(["old", "candidate", "request", "cycle"])(
  "refuses a %s binding conflict and closes all admission",
  (kind) => {
    const f = fixture();
    f.holds.hold(old, fresh, requestId);
    const second = "01JXYZ00000000000000000005";
    const action =
      kind === "old"
        ? () => f.holds.hold(old, other, second)
        : kind === "candidate"
          ? () => f.holds.hold(other, fresh, second)
          : kind === "request"
            ? () => f.holds.hold(other, second, requestId)
            : () => f.holds.hold(fresh, old, second);
    expect(action).toThrow();
    expect(f.holds.oldHeld(other)).toBe(true);
    expect(() => f.holds.records()).toThrow();
  },
);
it.each(["malformed", "mode", "linked"])("refuses %s persisted holds on startup", (kind) => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  if (kind === "malformed") writeFileSync(f.file, '{"bad":true}\n');
  if (kind === "mode") chmodSync(f.file, 0o644);
  if (kind === "linked") {
    unlinkSync(f.file);
    writeFileSync(`${f.file}.other`, "{}", { mode: 0o600 });
    symlinkSync(`${f.file}.other`, f.file);
  }
  const reopened = new ComputerResetHolds(f.home);
  expect(reopened.oldHeld(other)).toBe(true);
  expect(() => reopened.records()).toThrow();
});
it("detects deletion of a known hold record", () => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  unlinkSync(f.file);
  expect(() => f.holds.records()).toThrow();
  expect(f.holds.candidateHeld(other)).toBe(true);
});
it("keeps runtime admission closed when persistence or synchronous ticket retirement fails", () => {
  const f = fixture();
  f.holds.subscribe(() => {
    throw new Error("ticket failure");
  });
  expect(() => f.holds.hold(old, fresh, requestId)).toThrow();
  expect(f.holds.oldHeld(other)).toBe(true);
});
it("feeds old reset holds into existing agent/computer fences without pretending candidates are permanent fences", () => {
  const f = fixture(),
    fences = new ComputerFences(f.home, (id) => f.holds.oldHeld(id));
  expect(fences.isFenced(old)).toBe(false);
  f.holds.hold(old, fresh, requestId);
  expect(fences.isFenced(old)).toBe(true);
  expect(fences.isFenced(fresh)).toBe(false);
  expect(fences.record(old)).toBeUndefined();
  const unavailable = new ComputerFences(f.home, () => {
    throw new Error("guard failed");
  });
  expect(unavailable.isFenced(other)).toBe(true);
});
it("fails closed after restart when a reset intent write was lost after its independent hold", async () => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  const reopened = new ComputerResetHolds(f.home),
    close = vi.fn(() => reopened.closeAdmission());
  const owner = new ComputerResetOwner({
    store: f.store,
    expectedRequests: () => reopened.records(),
    hold: (a, b, c) => reopened.hold(a, b, c),
    closeAdmission: close,
    allocateId: () => fresh,
    capture: () => f.record.source,
    retireOld: vi.fn(),
    oldAbsent: async () => true,
    inspectFresh: async () => "absent",
    createFresh: vi.fn(),
    retireFresh: vi.fn(),
    publish: (record) => reopened.publish(record),
    finalised: (record) => reopened.finalised(record.newCellId),
    thawFresh: vi.fn(),
  });
  expect(close).toHaveBeenCalledOnce();
  await expect(owner.reset(old, { requestId, eraseComputer: true })).rejects.toThrow();
  expect(reopened.oldHeld(other)).toBe(true);
});
it("restores a completed candidate through the coordinator only after fresh physical checks", async () => {
  const f = fixture();
  f.holds.hold(old, fresh, requestId);
  f.ready();
  const reopened = new ComputerResetHolds(f.home),
    inspect = vi.fn(async () => "ready" as const),
    create = vi.fn(),
    retire = vi.fn();
  const owner = new ComputerResetOwner({
    store: f.store,
    expectedRequests: () => reopened.records(),
    hold: (a, b, c) => reopened.hold(a, b, c),
    closeAdmission: () => reopened.closeAdmission(),
    allocateId: () => other,
    capture: () => f.record.source,
    retireOld: retire,
    oldAbsent: async () => true,
    inspectFresh: inspect,
    createFresh: create,
    retireFresh: retire,
    publish: (record) => reopened.publish(record),
    finalised: (record) => reopened.finalised(record.newCellId),
    thawFresh: vi.fn(),
  });
  expect(reopened.candidateHeld(fresh)).toBe(true);
  await owner.restoreReady();
  expect(inspect).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(retire).not.toHaveBeenCalled();
  expect(reopened.candidateHeld(fresh)).toBe(false);
});
