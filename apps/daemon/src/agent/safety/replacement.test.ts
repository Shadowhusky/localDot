import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type ReplacementDeps,
  type ReplacementRecord,
  replaceFencedComputer,
} from "./replacement.ts";

function fixture() {
  const oldCellId = ulid(),
    newCellId = ulid(),
    requestId = ulid();
  const records: ReplacementRecord[] = [];
  let owner = { cellId: oldCellId, revision: 4, fenced: true, taskEnded: true };
  const d: ReplacementDeps = {
    current: () => ({ ...owner }),
    save: vi.fn(async (r) => {
      records.push(structuredClone(r));
    }),
    retireOld: vi.fn(async () => ({ absent: true, revoked: true, streamClosed: true })),
    allocateId: vi.fn(() => newCellId),
    createFresh: vi.fn(async () => {}),
    retireFresh: vi.fn(async () => {}),
  };
  return {
    d,
    records,
    oldCellId,
    newCellId,
    requestId,
    setOwner: (v: Partial<typeof owner>) => {
      owner = { ...owner, ...v };
    },
  };
}
describe("explicit fresh computer replacement", () => {
  it.each(["absent", "revoked", "streamClosed"] as const)(
    "RF5 missing %s never authorizes a fresh computer",
    async (field) => {
      const h = fixture();
      vi.mocked(h.d.retireOld).mockResolvedValue({
        absent: true,
        revoked: true,
        streamClosed: true,
        [field]: false,
      });
      expect(await replaceFencedComputer(h.requestId, 4, h.d)).toMatchObject({
        phase: "blocked",
        reason: "old_retirement",
      });
      expect(h.d.allocateId).not.toHaveBeenCalled();
      expect(h.d.createFresh).not.toHaveBeenCalled();
      expect(h.d.current().fenced).toBe(true);
    },
  );
  it("an uncertain retirement acknowledgement blocks allocation", async () => {
    const h = fixture();
    vi.mocked(h.d.retireOld).mockRejectedValue(new Error("lost response"));
    expect((await replaceFencedComputer(h.requestId, 4, h.d)).phase).toBe("blocked");
    expect(h.d.allocateId).not.toHaveBeenCalled();
  });
  it.each([{ fenced: false }, { taskEnded: false }, { revision: 5 }])(
    "rejects stale or executable old owner %j",
    async (patch) => {
      const h = fixture();
      h.setOwner(patch);
      await expect(replaceFencedComputer(h.requestId, 4, h.d)).rejects.toThrow("not admitted");
      expect(h.d.save).not.toHaveBeenCalled();
      expect(h.d.retireOld).not.toHaveBeenCalled();
      expect(h.d.createFresh).not.toHaveBeenCalled();
    },
  );
  it("saves old retirement and candidate identity before creating fresh resources", async () => {
    const h = fixture();
    vi.mocked(h.d.createFresh).mockImplementation(async (id) => {
      expect(h.records.map((r) => r.phase)).toEqual(["retiring", "retired", "allocating"]);
      expect(h.records.at(-1)).toMatchObject({ newCellId: id });
    });
    expect(await replaceFencedComputer(h.requestId, 4, h.d)).toMatchObject({
      phase: "ready",
      newCellId: h.newCellId,
    });
    expect(h.d.current().fenced).toBe(true);
    expect(h.d.createFresh).toHaveBeenCalledOnce();
  });
  it.each(["retiring", "retired", "allocating"] as const)(
    "failed %s fsync cannot start a fresh computer",
    async (phase) => {
      const h = fixture();
      vi.mocked(h.d.save).mockImplementation(async (r) => {
        if (r.phase === phase) throw new Error("fsync unavailable");
      });
      await expect(replaceFencedComputer(h.requestId, 4, h.d)).rejects.toThrow();
      expect(h.d.createFresh).not.toHaveBeenCalled();
    },
  );
  it("owner changes while old resources retire cannot obtain fresh authorization", async () => {
    const h = fixture();
    vi.mocked(h.d.retireOld).mockImplementation(async () => {
      h.setOwner({ revision: 5 });
      return { absent: true, revoked: true, streamClosed: true };
    });
    await expect(replaceFencedComputer(h.requestId, 4, h.d)).rejects.toThrow("owner changed");
    expect(h.d.allocateId).not.toHaveBeenCalled();
  });
  it.each(["creation", "ready persistence", "owner change"])(
    "%s retires only the recorded candidate",
    async (failure) => {
      const h = fixture();
      if (failure === "creation")
        vi.mocked(h.d.createFresh).mockRejectedValue(new Error("creation failed"));
      if (failure === "ready persistence")
        vi.mocked(h.d.save).mockImplementation(async (r) => {
          if (r.phase === "ready") throw new Error("fsync");
        });
      if (failure === "owner change")
        vi.mocked(h.d.createFresh).mockImplementation(async () => {
          h.setOwner({ taskEnded: false });
        });
      expect(await replaceFencedComputer(h.requestId, 4, h.d)).toMatchObject({
        phase: "blocked",
        reason: "new_creation",
        newCellId: h.newCellId,
      });
      expect(h.d.retireFresh).toHaveBeenCalledExactlyOnceWith(h.newCellId);
      expect(h.d.current().fenced).toBe(true);
    },
  );
  it("uncertain candidate cleanup cannot publish a ready or terminal retry receipt", async () => {
    const h = fixture();
    vi.mocked(h.d.createFresh).mockRejectedValue(new Error("create uncertainty"));
    vi.mocked(h.d.retireFresh).mockRejectedValue(new Error("cleanup unknown"));
    await expect(replaceFencedComputer(h.requestId, 4, h.d)).rejects.toThrow("cleanup unknown");
    expect(h.records.at(-1)?.phase).toBe("allocating");
  });
  it("candidate reuse of the permanently fenced identity is refused", async () => {
    const h = fixture();
    vi.mocked(h.d.allocateId).mockReturnValue(h.oldCellId);
    await expect(replaceFencedComputer(h.requestId, 4, h.d)).rejects.toThrow("fresh identity");
    expect(h.d.createFresh).not.toHaveBeenCalled();
  });
  it("owner drift during Retiring fsync cannot retire or allocate", async () => {
    const h = fixture();
    vi.mocked(h.d.save).mockImplementation(async (record) => {
      if (record.phase === "retiring") h.setOwner({ revision: 5 });
    });
    await expect(replaceFencedComputer(h.requestId, 4, h.d)).rejects.toThrow("owner changed");
    expect(h.d.retireOld).not.toHaveBeenCalled();
    expect(h.d.allocateId).not.toHaveBeenCalled();
  });
  it("owner drift during Ready fsync retires the candidate instead of confirming Ready", async () => {
    const h = fixture();
    vi.mocked(h.d.save).mockImplementation(async (record) => {
      if (record.phase === "ready") h.setOwner({ revision: 5 });
    });
    expect(await replaceFencedComputer(h.requestId, 4, h.d)).toMatchObject({
      phase: "blocked",
      reason: "new_creation",
    });
    expect(h.d.retireFresh).toHaveBeenCalledExactlyOnceWith(h.newCellId);
  });
});
