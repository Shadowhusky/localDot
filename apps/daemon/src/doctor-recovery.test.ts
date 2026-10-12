import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { expect, it } from "vitest";
import { ComputerFences } from "./agent/safety/fences.ts";
import { ReplacementStore } from "./agent/safety/replacement-store.ts";
import { recoveryChecks } from "./doctor-recovery.ts";

it("reports the recovery blocker read-only, including failed replacements", () => {
  const home = mkdtempSync("/tmp/ld-recovery-doctor-");
  try {
    const fences = new ComputerFences(home),
      cell = ulid(),
      task = ulid(),
      request = ulid();
    fences.capture(cell, task, "native");
    fences.claimReplacement(cell, request);
    const replacements = new ReplacementStore(home);
    replacements.write({
      oldCellId: cell,
      requestId: request,
      revision: 1,
      phase: "blocked",
      reason: "old_retirement",
    });
    const path = join(home, "safety", "fences", `${cell}.json`),
      before = readFileSync(path);
    expect(recoveryChecks(home)[0]).toMatchObject({ ok: false, pendingAction: "recover-computer" });
    expect(recoveryChecks(home)[0]?.detail).toContain("Native task exit has not been confirmed");
    expect(readFileSync(path)).toEqual(before);
    fences.confirmNativeRetirement(cell, task);
    expect(recoveryChecks(home)[0]?.detail).toContain("Task retirement is confirmed");
    replacements.write({
      oldCellId: cell,
      requestId: request,
      revision: 1,
      phase: "ready",
      newCellId: ulid(),
    });
    expect(recoveryChecks(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
