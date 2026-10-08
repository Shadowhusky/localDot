import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ComputerResetRecord,
  ComputerResetRequest,
} from "../../../../packages/protocol/src/computer-reset.ts";
import { ComputerResetStore } from "./reset-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-reset-store-"));
  roots.push(home);
  const record: ComputerResetRecord = {
    v: 1,
    requestId: "01JXYZ00000000000000000001",
    oldCellId: "01JXYZ00000000000000000002",
    newCellId: "01JXYZ00000000000000000003",
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
  return {
    home,
    record,
    store: new ComputerResetStore(home),
    file: join(home, "safety/computer-resets", `${record.requestId}.json`),
  };
}
it("persists a private canonical reset record and reopens the exact public snapshot", () => {
  const f = fixture();
  f.store.write(f.record);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.home, "safety/computer-resets")).mode & 0o777).toBe(0o700);
  expect(new ComputerResetStore(f.home).read(f.record.requestId)).toEqual(f.record);
  expect(readFileSync(f.file, "utf8")).toBe(
    JSON.stringify(ComputerResetRecord.parse(f.record)) + "\n",
  );
  for (const phase of ["retired", "creating", "ready"] as const)
    f.store.write({ ...f.record, phase });
  expect(f.store.list()[0]?.phase).toBe("ready");
});
it("refuses changed identity/source, skipped phase, rollback and missing initial intent", () => {
  const f = fixture();
  expect(() => f.store.write({ ...f.record, phase: "ready" })).toThrow();
  f.store.write(f.record);
  expect(() => f.store.write({ ...f.record, newCellId: "01JXYZ00000000000000000004" })).toThrow();
  expect(() => f.store.write({ ...f.record, source: { ...f.record.source, scale: 1 } })).toThrow();
  expect(() => f.store.write({ ...f.record, phase: "creating" })).toThrow();
  f.store.write({ ...f.record, phase: "retired" });
  expect(() => f.store.write(f.record)).toThrow();
});
it("rejects malformed snapshots and never accepts credential fields", () => {
  const f = fixture();
  for (const source of [
    { ...f.record.source, tokens: { stream: "private" } },
    { ...f.record.source, desktop: { ...f.record.source.desktop, volume: "../../other" } },
  ])
    expect(ComputerResetRecord.safeParse({ ...f.record, source }).success).toBe(false);
  expect(
    ComputerResetRecord.safeParse({ ...f.record, newCellId: f.record.oldCellId }).success,
  ).toBe(false);
  expect(
    ComputerResetRequest.safeParse({ requestId: f.record.requestId, eraseComputer: false }).success,
  ).toBe(false);
  expect(
    ComputerResetRequest.safeParse({ requestId: `${f.record.requestId}\n`, eraseComputer: true })
      .success,
  ).toBe(false);
  f.store.write(f.record);
  writeFileSync(f.file, '{"private":"malformed"}\n');
  expect(() => f.store.list()).toThrow();
});
