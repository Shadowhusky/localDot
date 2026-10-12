import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { expect, it, vi } from "vitest";
import { ComputerFences } from "./agent/safety/fences.ts";
import { readNativeBoot } from "./agent/safety/native-boot.ts";
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

vi.mock("./agent/safety/native-boot.ts", async (original) => ({
  ...(await original<typeof import("./agent/safety/native-boot.ts")>()),
  readNativeBoot: vi.fn(() => ({
    host: "a".repeat(64),
    boot: "11111111-1111-4111-8111-111111111111",
  })),
}));
it("gives actionable reboot instructions only with a matching baseline and stays read-only", () => {
  const home = mkdtempSync("/tmp/ld-recovery-advice-");
  try {
    const boot = readNativeBoot();
    if (!boot) throw new Error("missing test boot");
    const fences = new ComputerFences(home, undefined, boot),
      cell = ulid(),
      task = ulid();
    fences.capture(cell, task, "native");
    const path = join(home, "safety", "fences", `${cell}.json`),
      before = readFileSync(path);
    expect(recoveryChecks(home)[0]?.detail).toContain("Restart this machine, run localdot up");
    vi.mocked(readNativeBoot).mockReturnValueOnce({
      ...boot,
      boot: "22222222-2222-4222-8222-222222222222",
    });
    expect(recoveryChecks(home)[0]?.detail).toContain("The system has restarted");
    vi.mocked(readNativeBoot).mockReturnValueOnce(undefined);
    expect(recoveryChecks(home)[0]?.detail).toContain("No verified system-restart record");
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
