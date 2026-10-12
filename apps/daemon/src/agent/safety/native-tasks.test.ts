import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeProcessProbe } from "./native-process.ts";
import { NativeTasks } from "./native-tasks.ts";

const boot = { host: "a".repeat(64), boot: "11111111-1111-4111-8111-111111111111" };
const homes: string[] = [];
afterEach(() => {
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync("/tmp/dot-native-record-");
  homes.push(home);
  const probe = {
    identity: vi.fn(() => ({ pid: 123, start: "100:20" })),
    status: vi.fn<NativeProcessProbe["status"]>(() => "alive"),
  };
  return { home, cell: ulid(), session: ulid(), probe, tasks: new NativeTasks(home, probe, boot) };
}
const child = () => ({ pid: 123 }) as unknown as SpawnedProcess & { pid: number };
it("persists an unknown launch before starting the process, then records its kernel identity", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, () => {
    expect(f.tasks.read(f.cell)?.runs).toHaveLength(1);
    expect(f.tasks.state(f.cell, f.session)).toBe("unknown");
    return child();
  });
  expect(f.tasks.state(f.cell, f.session)).toBe("alive");
  expect(f.tasks.read(f.cell)?.runs[0]?.identity).toEqual({ pid: 123, start: "100:20" });
});
it("can verify an exited group after losing the original runtime object", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, child);
  f.probe.status.mockReturnValue("exited");
  expect(new NativeTasks(f.home, f.probe, boot).state(f.cell, f.session)).toBe("exited");
});
it("never infers exit from a live descendant, unavailable probe, or missing launch identity", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, child);
  expect(f.tasks.state(f.cell, f.session)).toBe("alive");
  f.probe.status.mockReturnValue("unknown");
  expect(f.tasks.state(f.cell, f.session)).toBe("unknown");
  f.probe.identity.mockImplementation(() => {
    throw new Error("unavailable");
  });
  f.tasks.spawn(f.cell, f.session, child);
  f.probe.status.mockReturnValue("exited");
  expect(f.tasks.state(f.cell, f.session)).toBe("unknown");
});
it("records failed synchronous launches and compacts settled earlier runs", () => {
  const f = fixture();
  expect(() =>
    f.tasks.spawn(f.cell, f.session, () => {
      throw new Error("spawn failed");
    }),
  ).toThrow();
  expect(f.tasks.state(f.cell, f.session)).toBe("exited");
  for (let i = 0; i < 40; i++) {
    f.tasks.spawn(f.cell, f.session, child);
    f.probe.status.mockReturnValue("exited");
    f.tasks.confirmed(f.session);
    f.probe.status.mockReturnValue("alive");
  }
  expect(f.tasks.read(f.cell)?.runs).toHaveLength(1);
  f.tasks.spawn(f.cell, f.session, child);
  expect(f.tasks.state(f.cell, f.session)).toBe("alive");
});
it("never launches when ownership or durable recording cannot be verified", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, child);
  const launch = vi.fn(child);
  expect(() => f.tasks.spawn(f.cell, ulid(), launch)).toThrow();
  chmodSync(join(f.home, "safety/native-tasks", `${f.cell}.json`), 0o644);
  expect(() => f.tasks.spawn(f.cell, f.session, launch)).toThrow();
  expect(launch).not.toHaveBeenCalled();
});
it("a real boot change is proof but a different host or missing record is not", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, child);
  expect(
    new NativeTasks(f.home, f.probe, {
      ...boot,
      boot: "22222222-2222-4222-8222-222222222222",
    }).state(f.cell, f.session),
  ).toBe("exited");
  expect(
    new NativeTasks(f.home, f.probe, { ...boot, host: "b".repeat(64) }).state(f.cell, f.session),
  ).toBe("unknown");
  expect(f.tasks.state(ulid(), ulid())).toBe("legacy");
  expect(readFileSync(join(f.home, "safety/native-tasks", `${f.cell}.json`), "utf8")).not.toContain(
    "command",
  );
});

it("does not record a driver's normal retirement while known descendants remain", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, child);
  expect(() => f.tasks.confirmed(f.session)).toThrow("descendants");
  expect(f.tasks.read(f.cell)?.settled).toBeUndefined();
});
