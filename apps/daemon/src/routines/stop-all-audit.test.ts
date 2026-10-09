import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fileStopAllAudit } from "./stop-all-audit.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const outcome = {
  sessions: [],
  cells: [],
  routinesPaused: 2,
  launchesCancelled: 0,
  confirmed: true,
};

it("appends one private JSON line per Stop everything", () => {
  const home = mkdtempSync(join(tmpdir(), "ld-audit-"));
  roots.push(home);
  const audit = fileStopAllAudit(home);
  audit.append({ at: Date.parse("2026-10-12T07:30:00Z"), by: "user", outcome });
  audit.append({ at: Date.parse("2026-10-12T07:31:00Z"), by: "cli", outcome });
  const lines = readFileSync(join(home, "audit", "stop-all.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { v: 1, at: "2026-10-12T07:30:00.000Z", by: "user", ...outcome },
    { v: 1, at: "2026-10-12T07:31:00.000Z", by: "cli", ...outcome },
  ]);
  expect(statSync(join(home, "audit")).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, "audit", "stop-all.jsonl")).mode & 0o777).toBe(0o600);
});

it("refuses an audit folder that is a symlink", () => {
  const home = mkdtempSync(join(tmpdir(), "ld-audit-"));
  roots.push(home);
  mkdirSync(join(home, "elsewhere"));
  symlinkSync(join(home, "elsewhere"), join(home, "audit"));
  expect(() => fileStopAllAudit(home).append({ at: 0, by: "user", outcome })).toThrow();
});
