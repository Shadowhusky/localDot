import { expect, it, vi } from "vitest";
import type {
  ComputerResetRecord,
  ComputerResetSource,
} from "../../../../packages/protocol/src/computer-reset.ts";
import { type ComputerResetHost, ComputerResetOwner } from "./reset-owner.ts";

const old = "01JXYZ00000000000000000001",
  fresh = "01JXYZ00000000000000000002",
  requestId = "01JXYZ00000000000000000003",
  other = "01JXYZ00000000000000000004";
const resources = {
  workload: { name: "localdot-desktop", id: "a".repeat(64) },
  gate: { name: "localdot-gate", id: "b".repeat(64) },
  internalNetwork: { name: "localdot-internal", id: "c".repeat(64) },
  egressNetwork: { name: "localdot-egress", id: "d".repeat(64) },
  volume: "localdot-home",
};
const source: ComputerResetSource = { scale: 2, desktop: resources, browser: null };
const request = { requestId, eraseComputer: true as const };
function fixture(initial: ComputerResetRecord[] = []) {
  const records = new Map(initial.map((row) => [row.requestId, structuredClone(row)]));
  const events: string[] = [];
  let state: "absent" | "owned" | "ready" | "foreign" = "absent";
  const host: ComputerResetHost = {
    store: {
      read: (id) => {
        const row = records.get(id);
        return row && structuredClone(row);
      },
      list: () => [...records.values()].map((row) => structuredClone(row)),
      write: vi.fn((row) => {
        events.push(`save:${row.phase}`);
        records.set(row.requestId, structuredClone(row));
      }),
    },
    allocateId: vi.fn(() => fresh),
    hold: vi.fn(() => {
      events.push("hold");
    }),
    closeAdmission: vi.fn(),
    capture: vi.fn(() => source),
    expectedRequests: vi.fn(() =>
      initial.map(({ oldCellId, newCellId, requestId }) => ({ oldCellId, newCellId, requestId })),
    ),
    retireOld: vi.fn(async () => {
      events.push("retire-old");
    }),
    oldAbsent: vi.fn(async () => true),
    inspectFresh: vi.fn(async () => state),
    createFresh: vi.fn(async () => {
      events.push("create");
      state = "ready";
    }),
    retireFresh: vi.fn(async () => {
      events.push("retire-fresh");
      state = "absent";
    }),
    publish: vi.fn(() => {
      events.push("publish");
    }),
  };
  const owner = new ComputerResetOwner(host);
  return {
    owner,
    host,
    records,
    events,
    setState: (value: typeof state) => {
      state = value;
    },
  };
}
function record(phase: ComputerResetRecord["phase"]): ComputerResetRecord {
  return { v: 1, requestId, oldCellId: old, newCellId: fresh, source, phase };
}
it("holds admission and persists intent before retirement, then saves ready before publication", async () => {
  const f = fixture();
  const result = await f.owner.reset(old, request);
  expect(result.phase).toBe("ready");
  expect(f.events).toEqual([
    "hold",
    "save:retiring",
    "hold",
    "retire-old",
    "save:retired",
    "save:creating",
    "create",
    "save:ready",
    "publish",
  ]);
  expect(f.records.get(requestId)).toEqual(result);
});
it("deduplicates concurrent same-request calls and rejects another reset of the same old computer", async () => {
  const f = fixture();
  let release!: () => void;
  vi.mocked(f.host.retireOld).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.owner.reset(old, request),
    second = f.owner.reset(old, request);
  expect(first).toBe(second);
  await expect(f.owner.reset(old, { requestId: other, eraseComputer: true })).rejects.toThrow();
  release();
  await first;
  expect(f.host.createFresh).toHaveBeenCalledOnce();
});
it("requires explicit erase confirmation and rejects request reuse for another computer", async () => {
  const f = fixture();
  await expect(f.owner.reset(old, { requestId, eraseComputer: false } as never)).rejects.toThrow();
  expect(f.host.hold).not.toHaveBeenCalled();
  await f.owner.reset(old, request);
  await expect(f.owner.reset(other, request)).rejects.toThrow();
  expect(f.host.createFresh).toHaveBeenCalledOnce();
});
it("replays a completed request without retirement or creation", async () => {
  const f = fixture([record("ready")]);
  f.setState("ready");
  await f.owner.reset(old, request);
  expect(f.host.retireOld).not.toHaveBeenCalled();
  expect(f.host.createFresh).not.toHaveBeenCalled();
  expect(f.host.publish).toHaveBeenCalledOnce();
});
it.each(["retiring", "retired", "creating"] as const)(
  "restores %s holds on restart without automatically continuing destructive work",
  async (phase) => {
    const f = fixture([record(phase)]);
    await f.owner.restoreReady();
    expect(f.host.hold).toHaveBeenCalledWith(old, fresh, requestId);
    expect(f.host.retireOld).not.toHaveBeenCalled();
    expect(f.host.createFresh).not.toHaveBeenCalled();
    expect(f.host.publish).not.toHaveBeenCalled();
    await f.owner.reset(old, request);
    expect(f.host.createFresh).toHaveBeenCalledOnce();
  },
);
it.each([
  "retirement-error",
  "still-present",
  "foreign-candidate",
  "failed-create",
  "not-ready",
  "ready-write",
])("keeps admission held after %s", async (kind) => {
  const f = fixture();
  if (kind === "retirement-error")
    vi.mocked(f.host.retireOld).mockRejectedValue(new Error("private details"));
  if (kind === "still-present") vi.mocked(f.host.oldAbsent).mockResolvedValue(false);
  if (kind === "foreign-candidate") f.setState("foreign");
  if (kind === "failed-create")
    vi.mocked(f.host.createFresh).mockRejectedValue(new Error("private details"));
  if (kind === "not-ready")
    vi.mocked(f.host.createFresh).mockImplementation(async () => {
      f.setState("owned");
    });
  if (kind === "ready-write")
    vi.mocked(f.host.store.write).mockImplementation((row) => {
      if (row.phase === "ready") throw new Error("private details");
      f.records.set(row.requestId, structuredClone(row));
    });
  await expect(f.owner.reset(old, request)).rejects.toThrow("reset is unconfirmed");
  expect(f.host.publish).not.toHaveBeenCalled();
  if (["retirement-error", "still-present", "foreign-candidate"].includes(kind))
    expect(f.host.createFresh).not.toHaveBeenCalled();
  if (kind === "foreign-candidate") {
    expect(f.host.retireFresh).not.toHaveBeenCalled();
    expect(f.host.retireOld).not.toHaveBeenCalled();
  }
});
it("does not recreate a candidate after its create reply is lost but readiness can be observed", async () => {
  const f = fixture();
  vi.mocked(f.host.createFresh).mockImplementation(async () => {
    f.setState("ready");
    throw new Error("lost reply");
  });
  await expect(f.owner.reset(old, request)).rejects.toThrow();
  expect(f.records.get(requestId)?.phase).toBe("creating");
  expect((await f.owner.reset(old, request)).phase).toBe("ready");
  expect(f.host.createFresh).toHaveBeenCalledOnce();
});
it("continues an observed ready write after a lost acknowledgement without deleting the candidate", async () => {
  const f = fixture();
  vi.mocked(f.host.store.write).mockImplementation((row) => {
    f.records.set(row.requestId, structuredClone(row));
    if (row.phase === "ready") throw new Error("lost acknowledgement");
  });
  await expect(f.owner.reset(old, request)).rejects.toThrow();
  expect(f.host.publish).not.toHaveBeenCalled();
  expect((await f.owner.reset(old, request)).phase).toBe("ready");
  expect(f.host.createFresh).toHaveBeenCalledOnce();
  expect(f.host.retireFresh).not.toHaveBeenCalled();
});
it("contains an incomplete owned candidate before explicitly retrying the same creation identity", async () => {
  const f = fixture([record("creating")]);
  f.setState("owned");
  await f.owner.reset(old, request);
  expect(f.events.indexOf("retire-fresh")).toBeLessThan(f.events.indexOf("create"));
  expect(f.host.allocateId).not.toHaveBeenCalled();
});
it("does not publish a prior reset candidate after that computer has itself been reset", async () => {
  const first = record("ready"),
    second = {
      ...record("retiring"),
      requestId: other,
      oldCellId: fresh,
      newCellId: "01JXYZ00000000000000000005",
    };
  const f = fixture([first, second]);
  f.setState("ready");
  await f.owner.restoreReady();
  await f.owner.reset(old, request);
  expect(f.host.publish).not.toHaveBeenCalled();
  expect(f.host.createFresh).not.toHaveBeenCalled();
});
it("fails closed on ambiguous or cyclic recovered ownership", async () => {
  const first = record("ready"),
    second = { ...record("retiring"), requestId: other, oldCellId: fresh, newCellId: old };
  const f = fixture([first, second]);
  expect(f.host.closeAdmission).toHaveBeenCalledOnce();
  await expect(f.owner.reset(old, request)).rejects.toThrow();
  expect(f.host.retireOld).not.toHaveBeenCalled();
});
it("does not advance after a durable record disappears during an effect", async () => {
  const f = fixture();
  vi.mocked(f.host.retireOld).mockImplementation(async () => {
    f.records.delete(requestId);
  });
  await expect(f.owner.reset(old, request)).rejects.toThrow();
  expect(f.host.createFresh).not.toHaveBeenCalled();
  expect(() => f.owner.status(old, requestId)).toThrow();
  expect(f.host.closeAdmission).toHaveBeenCalledOnce();
});
it("closes admission on startup when a durable fence names a missing reset record", async () => {
  const f = fixture();
  vi.mocked(f.host.expectedRequests).mockReturnValue([
    { oldCellId: old, newCellId: fresh, requestId },
  ]);
  const restarted = new ComputerResetOwner(f.host);
  expect(f.host.closeAdmission).toHaveBeenCalledOnce();
  await expect(restarted.reset(old, request)).rejects.toThrow();
  expect(f.host.retireOld).not.toHaveBeenCalled();
});
