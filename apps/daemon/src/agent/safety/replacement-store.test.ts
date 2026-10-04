import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { ComputerFences } from "./fences.ts";
import { ReplacementStore } from "./replacement-store.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-replacement-store-"));
  const requestId = ulid(),
    oldCellId = ulid();
  return {
    home,
    requestId,
    oldCellId,
    record: { requestId, oldCellId, revision: 1, phase: "retiring" as const },
  };
}
describe("private durable replacement records", () => {
  it("round-trips exact records with private file and directory modes", () => {
    const h = fixture(),
      store = new ReplacementStore(h.home);
    store.write(h.record);
    expect(store.read(h.requestId)).toEqual(h.record);
    expect(store.list()).toEqual([h.record]);
    expect(
      statSync(join(h.home, "safety", "replacements", h.requestId + ".json")).mode & 0o777,
    ).toBe(0o600);
    expect(statSync(join(h.home, "safety", "replacements")).mode & 0o777).toBe(0o700);
  });
  it.each(["symlink", "oversize", "permissive mode", "extra authority", "invalid owner"])(
    "refuses %s during recovery and overwrite",
    (kind) => {
      const h = fixture(),
        store = new ReplacementStore(h.home);
      store.write(h.record);
      const file = join(h.home, "safety", "replacements", h.requestId + ".json");
      if (kind === "symlink") {
        const outside = join(h.home, "outside.json");
        writeFileSync(outside, readFileSync(file), { mode: 0o600 });
        unlinkSync(file);
        symlinkSync(outside, file);
      }
      if (kind === "oversize") writeFileSync(file, " ".repeat(8193));
      if (kind === "permissive mode") chmodSync(file, 0o644);
      if (kind === "extra authority")
        writeFileSync(file, JSON.stringify({ ...h.record, approved: true }));
      if (kind === "invalid owner")
        writeFileSync(file, JSON.stringify({ ...h.record, requestId: ulid() }));
      expect(() => store.read(h.requestId)).toThrow();
      expect(() => store.list()).toThrow();
      expect(() => store.write(h.record)).toThrow();
    },
  );
  it("rejects path-shaped request IDs without writing outside the ledger", () => {
    const h = fixture(),
      store = new ReplacementStore(h.home);
    expect(() => store.read("../outside")).toThrow();
    expect(() => store.write({ ...h.record, requestId: "../outside" })).toThrow();
  });
  it("restores a permanent fence without granting replacement authority from missing native retirement", () => {
    const h = fixture(),
      fences = new ComputerFences(h.home);
    const id = ulid();
    fences.capture(h.oldCellId, id, "native");
    const recovered = new ComputerFences(h.home);
    expect(recovered.isFenced(h.oldCellId)).toBe(true);
    expect(recovered.record(h.oldCellId)).toMatchObject({ revision: 1, nativeRetired: false });
  });
  it("permanent fences cannot be cleared by reloading or a later task identity", () => {
    const h = fixture(),
      fences = new ComputerFences(h.home),
      sessionId = ulid();
    fences.capture(h.oldCellId, sessionId, "api");
    fences.capture(h.oldCellId, ulid(), "api");
    expect(new ComputerFences(h.home).record(h.oldCellId)).toMatchObject({
      sessionId,
      revision: 1,
    });
  });
});
