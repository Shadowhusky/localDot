import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShutdownFreezes } from "./shutdown-freezes.ts";

const A = "01JXYZ0000000000000000AAAA";
const B = "01JXYZ0000000000000000BBBB";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "localdot-shutdown-freezes-"));
  homes.push(dir);
  return dir;
}

describe("shutdown freezes", () => {
  it("hands the next start the computers the last stop froze, once", () => {
    const dir = home();
    new ShutdownFreezes(dir).record([A, B, A]);
    expect(statSync(join(dir, "shutdown-frozen.json")).mode & 0o777).toBe(0o600);
    const next = new ShutdownFreezes(dir);
    next.load();
    expect(next.take().sort()).toEqual([A, B]);
    expect(next.take()).toEqual([]);
    const after = new ShutdownFreezes(dir);
    after.load();
    expect(after.take()).toEqual([]);
  });

  it("never thaws a computer someone stopped after the start", () => {
    const dir = home();
    new ShutdownFreezes(dir).record([A, B]);
    const next = new ShutdownFreezes(dir);
    next.load();
    next.forget(A);
    expect(next.take()).toEqual([B]);
  });

  it("thaws nothing from a missing, damaged or foreign record", () => {
    const dir = home();
    const none = new ShutdownFreezes(dir);
    none.load();
    expect(none.take()).toEqual([]);
    writeFileSync(join(dir, "shutdown-frozen.json"), "{not json");
    const damaged = new ShutdownFreezes(dir);
    damaged.load();
    expect(damaged.take()).toEqual([]);
    writeFileSync(join(dir, "shutdown-frozen.json"), JSON.stringify({ cells: ["../etc", A] }));
    const foreign = new ShutdownFreezes(dir);
    foreign.load();
    expect(foreign.take()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "shutdown-frozen.json"), "utf8"))).toEqual({
      cells: [],
    });
  });
});
