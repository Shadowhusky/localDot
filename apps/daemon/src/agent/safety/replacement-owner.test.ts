import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplacementOwner } from "./replacement.ts";
import { ReplacementStore } from "./replacement-store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-replacement-owner-"));
  homes.push(home);
  const oldCellId = ulid(),
    candidate = ulid(),
    requestId = ulid(),
    store = new ReplacementStore(home);
  const d = {
    current: () => ({ cellId: oldCellId, revision: 3, fenced: true, taskEnded: true }),
    save: async () => {},
    retireOld: vi.fn(async () => ({ absent: true, revoked: true, streamClosed: true })),
    allocateId: vi.fn(() => candidate),
    createFresh: vi.fn(async () => {}),
    retireFresh: vi.fn(async () => {}),
    inspectFresh: vi.fn(async () => "absent" as "absent" | "owned" | "ready" | "foreign"),
  };
  const owner = () => new ReplacementOwner({ store, forCell: () => d });
  return {
    home,
    oldCellId,
    candidate,
    requestId,
    store,
    d,
    owner,
    body: { requestId, oldRevision: 3, home: "fresh" as const },
  };
}
describe("durable replacement ownership and restart", () => {
  it("the same concurrent request joins creation exactly once, including before first save", async () => {
    const h = fixture(),
      o = h.owner(),
      hold = deferred();
    h.d.retireOld.mockImplementation(async () => {
      await hold.promise;
      return { absent: true, revoked: true, streamClosed: true };
    });
    const first = o.replace(h.oldCellId, h.body),
      second = o.replace(h.oldCellId, h.body);
    await Promise.resolve();
    hold.resolve();
    expect(await first).toEqual(await second);
    expect(h.d.retireOld).toHaveBeenCalledOnce();
    expect(h.d.createFresh).toHaveBeenCalledExactlyOnceWith(h.candidate);
  });
  it("a lost response reconciles from status without authorizing replay", async () => {
    const h = fixture(),
      o = h.owner(),
      result = await o.replace(h.oldCellId, h.body);
    expect(await o.status(h.oldCellId, h.requestId)).toEqual(result);
    expect(await o.replace(h.oldCellId, h.body)).toEqual(result);
    expect(h.d.createFresh).toHaveBeenCalledOnce();
  });
  it("request owner and revision cannot be changed when joining or reading a receipt", async () => {
    const h = fixture(),
      o = h.owner();
    await o.replace(h.oldCellId, h.body);
    await expect(o.replace(ulid(), h.body)).rejects.toThrow("owner mismatch");
    await expect(o.replace(h.oldCellId, { ...h.body, oldRevision: 4 })).rejects.toThrow(
      "owner mismatch",
    );
    await expect(o.status(ulid(), h.requestId)).rejects.toThrow("owner mismatch");
    expect(h.d.createFresh).toHaveBeenCalledOnce();
  });
  it.each(["allocating", "ready"] as const)(
    "restart of a missing %s candidate is blocked and never creates a second computer",
    async (phase) => {
      const h = fixture();
      h.store.write({
        requestId: h.requestId,
        oldCellId: h.oldCellId,
        revision: 3,
        phase,
        newCellId: h.candidate,
      });
      const o = h.owner();
      await o.start();
      expect(await o.status(h.oldCellId, h.requestId)).toMatchObject({
        phase: "blocked",
        newCellId: h.candidate,
      });
      expect((await o.replace(h.oldCellId, h.body)).phase).toBe("blocked");
      expect(h.d.createFresh).not.toHaveBeenCalled();
      expect(h.d.allocateId).not.toHaveBeenCalled();
    },
  );
  it("restart retires exactly an owned partial candidate before allowing an explicit new request", async () => {
    const h = fixture();
    h.store.write({
      requestId: h.requestId,
      oldCellId: h.oldCellId,
      revision: 3,
      phase: "allocating",
      newCellId: h.candidate,
    });
    h.d.inspectFresh.mockResolvedValue("owned");
    const o = h.owner();
    await o.start();
    expect(h.d.retireFresh).toHaveBeenCalledExactlyOnceWith(h.candidate);
    expect(h.d.createFresh).not.toHaveBeenCalled();
    const nextId = ulid();
    h.d.allocateId.mockReturnValue(nextId);
    expect(await o.replace(h.oldCellId, { ...h.body, requestId: ulid() })).toMatchObject({
      phase: "ready",
      newCellId: nextId,
    });
    expect(h.store.read(h.requestId)).toMatchObject({ phase: "blocked", newCellId: h.candidate });
  });
  it("a foreign collision is untouched and closes all replacement admission on restart", async () => {
    const h = fixture();
    h.store.write({
      requestId: h.requestId,
      oldCellId: h.oldCellId,
      revision: 3,
      phase: "allocating",
      newCellId: h.candidate,
    });
    h.d.inspectFresh.mockResolvedValue("foreign");
    const o = h.owner();
    await expect(o.start()).rejects.toThrow("recovery needs attention");
    await expect(o.replace(h.oldCellId, h.body)).rejects.toThrow();
    expect(h.d.retireFresh).not.toHaveBeenCalled();
    expect(h.d.createFresh).not.toHaveBeenCalled();
  });
  it("an uncertain candidate cleanup keeps restart admission closed", async () => {
    const h = fixture();
    h.store.write({
      requestId: h.requestId,
      oldCellId: h.oldCellId,
      revision: 3,
      phase: "allocating",
      newCellId: h.candidate,
    });
    h.d.inspectFresh.mockResolvedValue("owned");
    h.d.retireFresh.mockRejectedValue(new Error("lost cleanup"));
    const o = h.owner();
    await expect(o.start()).rejects.toThrow();
    expect(h.store.read(h.requestId)?.phase).toBe("allocating");
    await expect(o.replace(h.oldCellId, { ...h.body, requestId: ulid() })).rejects.toThrow();
    expect(h.d.allocateId).not.toHaveBeenCalled();
  });
  it("a confirmed Ready candidate is reconciled without create or retirement", async () => {
    const h = fixture();
    h.store.write({
      requestId: h.requestId,
      oldCellId: h.oldCellId,
      revision: 3,
      phase: "ready",
      newCellId: h.candidate,
    });
    h.d.inspectFresh.mockResolvedValue("ready");
    const o = h.owner();
    await o.start();
    expect((await o.replace(h.oldCellId, h.body)).phase).toBe("ready");
    expect(h.d.createFresh).not.toHaveBeenCalled();
    expect(h.d.retireFresh).not.toHaveBeenCalled();
    await expect(o.replace(h.oldCellId, { ...h.body, requestId: ulid() })).rejects.toThrow(
      "already has a replacement",
    );
  });
  it("older blocked history cannot hide a Ready candidate regardless of request sort order", async () => {
    const h = fixture();
    h.store.write({
      requestId: h.requestId,
      oldCellId: h.oldCellId,
      revision: 3,
      phase: "ready",
      newCellId: h.candidate,
    });
    h.store.write({
      requestId: ulid(),
      oldCellId: h.oldCellId,
      revision: 3,
      phase: "blocked",
      reason: "old_retirement",
    });
    h.d.inspectFresh.mockResolvedValue("ready");
    const o = h.owner();
    await o.start();
    await expect(o.replace(h.oldCellId, { ...h.body, requestId: ulid() })).rejects.toThrow(
      "already has a replacement",
    );
    expect(h.d.createFresh).not.toHaveBeenCalled();
  });
  it("a durable fence's missing request cannot be recreated after restart", async () => {
    const h = fixture(),
      o = new ReplacementOwner({
        store: h.store,
        forCell: () => h.d,
        expectedRequests: () => [{ oldCellId: h.oldCellId, requestId: h.requestId }],
      });
    await expect(o.start()).rejects.toThrow();
    await expect(o.replace(h.oldCellId, h.body)).rejects.toThrow();
    expect(h.d.createFresh).not.toHaveBeenCalled();
  });
  it.each([{ force: true }, { newCellId: ulid() }, { home: "reuse" }])(
    "caller-owned authority %j is rejected before any effect",
    async (fields) => {
      const h = fixture();
      await expect(h.owner().replace(h.oldCellId, { ...h.body, ...fields })).rejects.toThrow();
      expect(h.d.retireOld).not.toHaveBeenCalled();
      expect(h.d.allocateId).not.toHaveBeenCalled();
    },
  );
  it("initial record failure keeps the old fence closed and creates nothing", async () => {
    const h = fixture();
    vi.spyOn(h.store, "write").mockImplementation(() => {
      throw new Error("record fsync");
    });
    const o = h.owner();
    await expect(o.replace(h.oldCellId, h.body)).rejects.toThrow(
      "completion could not be confirmed",
    );
    await expect(o.replace(h.oldCellId, h.body)).rejects.toThrow("admission is closed");
    expect(h.d.retireOld).not.toHaveBeenCalled();
    expect(h.d.createFresh).not.toHaveBeenCalled();
  });
  it("a renamed Ready record with a lost fsync acknowledgement never appears confirmed through status", async () => {
    const h = fixture(),
      hold = deferred(),
      write = h.store.write.bind(h.store),
      ready = vi.fn();
    vi.spyOn(h.store, "write").mockImplementation((record) => {
      write(record);
      if (record.phase === "ready") throw new Error("lost directory fsync acknowledgement");
    });
    h.d.retireFresh.mockImplementation(async () => {
      await hold.promise;
      throw new Error("cleanup unknown");
    });
    const owner = new ReplacementOwner({ store: h.store, forCell: () => h.d, onReady: ready }),
      work = owner.replace(h.oldCellId, h.body),
      failure = expect(work).rejects.toThrow("completion could not be confirmed");
    for (let n = 0; n < 30 && h.store.read(h.requestId)?.phase !== "ready"; n++)
      await new Promise<void>((r) => setTimeout(r, 1));
    expect(h.store.read(h.requestId)?.phase).toBe("ready");
    expect(await owner.status(h.oldCellId, h.requestId)).toMatchObject({ phase: "allocating" });
    expect(ready).not.toHaveBeenCalled();
    hold.resolve();
    await failure;
    await expect(owner.status(h.oldCellId, h.requestId)).rejects.toThrow("records unavailable");
    expect(ready).not.toHaveBeenCalled();
  });
});
