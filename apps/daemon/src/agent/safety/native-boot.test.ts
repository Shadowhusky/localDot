import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerFences } from "./fences.ts";
import { NativeBootRecords } from "./native-boot.ts";
import { replaceFencedComputer } from "./replacement.ts";

const boot = { host: "a".repeat(64), boot: "11111111-1111-4111-8111-111111111111" };
const reboot = { ...boot, boot: "22222222-2222-4222-8222-222222222222" };
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync("/tmp/ld-native-boot-");
  homes.push(home);
  const cell = ulid(),
    task = ulid();
  return {
    home,
    cell,
    task,
    start: (identity = boot) => new ComputerFences(home, undefined, identity),
  };
}
it("does not mistake daemon restarts for native exit, but accepts a verified OS reboot", () => {
  const h = fixture();
  h.start().capture(h.cell, h.task, "native");
  expect(h.start().record(h.cell)?.nativeRetired).toBe(false);
  const after = h.start(reboot);
  expect(after.record(h.cell)).toMatchObject({
    sessionId: h.task,
    revision: 1,
    nativeRetired: true,
  });
  expect(after.isFenced(h.cell)).toBe(true);
  expect(h.start(reboot).record(h.cell)?.nativeRetired).toBe(true);
});
it("migrates a legacy fence without guessing whether its old process exited", () => {
  const h = fixture();
  new ComputerFences(h.home).capture(h.cell, h.task, "native");
  expect(h.start().record(h.cell)?.nativeRetired).toBe(false);
  expect(new NativeBootRecords(h.home).read(h.cell)).toMatchObject({ ...boot, sessionId: h.task });
  expect(h.start().record(h.cell)?.nativeRetired).toBe(false);
  expect(h.start(reboot).record(h.cell)?.nativeRetired).toBe(true);
});
it("does not treat another machine or unavailable OS identity as proof", () => {
  const h = fixture();
  h.start().capture(h.cell, h.task, "native");
  expect(h.start({ ...reboot, host: "b".repeat(64) }).record(h.cell)?.nativeRetired).toBe(false);
  expect(new ComputerFences(h.home).record(h.cell)?.nativeRetired).toBe(false);
});
it.each(["task", "revision", "permissions", "malformed"])(
  "refuses an invalid %s boot receipt",
  (kind) => {
    const h = fixture();
    h.start().capture(h.cell, h.task, "native");
    const file = join(h.home, "safety", "native-boots", `${h.cell}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (kind === "task") record.sessionId = ulid();
    if (kind === "revision") record.revision++;
    if (kind === "malformed") record.boot = "unknown";
    writeFileSync(file, JSON.stringify(record) + "\n");
    if (kind === "permissions") chmodSync(file, 0o644);
    const after = h.start(reboot);
    expect(after.isFenced(h.cell)).toBe(true);
    expect(after.record(h.cell)).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(h.home, "safety", "fences", `${h.cell}.json`), "utf8"))
        .nativeRetired,
    ).toBe(false);
  },
);
it("does not rewrite API or already-confirmed native fences", () => {
  const h = fixture();
  h.start().capture(h.cell, h.task, "api");
  expect(new NativeBootRecords(h.home).read(h.cell)).toBeUndefined();
  expect(h.start(reboot).record(h.cell)?.nativeRetired).toBe(true);
});
it("a reboot permits replacement only after separate container retirement succeeds", async () => {
  const h = fixture();
  h.start().capture(h.cell, h.task, "native");
  let fences = h.start();
  const retireOld = vi.fn(async () => ({ absent: false, revoked: true, streamClosed: true }));
  const createFresh = vi.fn(async () => {});
  const deps = {
    current: () => ({
      cellId: h.cell,
      revision: 1,
      fenced: fences.isFenced(h.cell),
      taskEnded: !!fences.record(h.cell)?.nativeRetired,
    }),
    save: async () => {},
    retireOld,
    createFresh,
    allocateId: ulid,
    retireFresh: async () => {},
  };
  await expect(replaceFencedComputer(ulid(), 1, deps)).rejects.toThrow("not admitted");
  expect(retireOld).not.toHaveBeenCalled();
  fences = h.start(reboot);
  expect(await replaceFencedComputer(ulid(), 1, deps)).toMatchObject({
    phase: "blocked",
    reason: "old_retirement",
  });
  expect(createFresh).not.toHaveBeenCalled();
  retireOld.mockResolvedValue({ absent: true, revoked: true, streamClosed: true });
  expect(await replaceFencedComputer(ulid(), 1, deps)).toMatchObject({ phase: "ready" });
  expect(createFresh).toHaveBeenCalledOnce();
  expect(fences.isFenced(h.cell)).toBe(true);
});
