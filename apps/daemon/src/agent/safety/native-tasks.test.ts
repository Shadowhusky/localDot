import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeProcessProbe } from "./native-process.ts";
import { interruptedNativeTasks, NativeCleanupPending, NativeTasks } from "./native-tasks.ts";

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
    expect(f.tasks.read(f.session)?.runs).toHaveLength(1);
    expect(f.tasks.state(f.cell, f.session)).toBe("unknown");
    return child();
  });
  expect(f.tasks.state(f.cell, f.session)).toBe("alive");
  expect(f.tasks.read(f.session)?.runs[0]?.identity).toEqual({ pid: 123, start: "100:20" });
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
  expect(f.tasks.read(f.session)?.runs).toHaveLength(1);
  f.tasks.spawn(f.cell, f.session, child);
  expect(f.tasks.state(f.cell, f.session)).toBe("alive");
});
it("never launches when ownership or durable recording cannot be verified", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, child);
  const launch = vi.fn(child);
  expect(() => f.tasks.spawn(f.cell, ulid(), launch)).toThrow();
  chmodSync(join(f.home, "safety/native-tasks", `${f.session}.json`), 0o644);
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
  expect(
    readFileSync(join(f.home, "safety/native-tasks", `${f.session}.json`), "utf8"),
  ).not.toContain("command");
});

it("does not record a driver's normal retirement while known descendants remain", () => {
  const f = fixture();
  f.tasks.spawn(f.cell, f.session, child);
  expect(() => f.tasks.confirmed(f.session)).toThrow("descendants");
  expect(f.tasks.read(f.session)?.settled).toBeUndefined();
});

describe("tasks that share a computer", () => {
  it("each launch while the others are at work, and each keeps its own record", () => {
    const f = fixture(),
      other = ulid();
    f.tasks.spawn(f.cell, f.session, child);
    const launch = vi.fn(child);
    f.tasks.spawn(f.cell, other, launch, (id) => id === f.session);
    expect(launch).toHaveBeenCalledOnce();
    expect(f.tasks.state(f.cell, f.session)).toBe("alive");
    expect(f.tasks.state(f.cell, other)).toBe("alive");
    f.probe.status.mockReturnValue("exited");
    f.tasks.confirmed(f.session);
    expect(f.tasks.read(f.session)?.settled).toBe(true);
    expect(f.tasks.read(other)?.settled).toBeUndefined();
    expect(interruptedNativeTasks(f.home)).toEqual([{ cellId: f.cell, sessionId: other }]);
  });

  it("confirms a task's exit only once nothing launched on its computer is still running", () => {
    const f = fixture(),
      other = ulid();
    f.tasks.spawn(f.cell, f.session, child);
    f.probe.identity.mockReturnValueOnce({ pid: 456, start: "200:10" });
    f.tasks.spawn(f.cell, other, child, (id) => id === f.session);
    f.probe.status.mockImplementation((identity) => (identity.pid === 456 ? "alive" : "exited"));
    expect(f.tasks.state(f.cell, f.session)).toBe("alive");
    f.probe.status.mockImplementation(() => "exited");
    expect(f.tasks.state(f.cell, f.session)).toBe("exited");
  });

  it("refuses a launch beside another task's unconfirmed one once that task is no longer at work", () => {
    const f = fixture();
    f.tasks.spawn(f.cell, f.session, child);
    const launch = vi.fn(child);
    expect(() => f.tasks.spawn(f.cell, ulid(), launch, () => false)).toThrow(NativeCleanupPending);
    expect(launch).not.toHaveBeenCalled();
    f.tasks.spawn(ulid(), ulid(), launch);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("drops another task's settled record on the computer at the next launch there", () => {
    const f = fixture(),
      next = ulid();
    f.tasks.spawn(f.cell, f.session, child);
    f.probe.status.mockReturnValue("exited");
    f.tasks.confirmed(f.session);
    f.tasks.spawn(f.cell, next, child);
    expect(f.tasks.read(f.session)).toBeUndefined();
    expect(f.tasks.state(f.cell, f.session)).toBe("unknown");
    expect(f.tasks.list().map((record) => record.sessionId)).toEqual([next]);
  });

  it("reads a record an earlier version saved under the computer, and moves it under its task", () => {
    const f = fixture(),
      run = { id: ulid(), identity: { pid: 123, start: "100:20" } };
    f.tasks.write(f.cell, {
      v: 1,
      route: "claude-code",
      cellId: f.cell,
      sessionId: f.session,
      boot,
      runs: [run],
    });
    expect(f.tasks.state(f.cell, f.session)).toBe("alive");
    expect(interruptedNativeTasks(f.home)).toEqual([{ cellId: f.cell, sessionId: f.session }]);
    expect(() => f.tasks.spawn(f.cell, ulid(), child)).toThrow(NativeCleanupPending);
    f.tasks.spawn(f.cell, f.session, child);
    expect(f.tasks.read(f.cell)).toBeUndefined();
    expect(f.tasks.read(f.session)?.runs[0]).toEqual(run);
    expect(f.tasks.read(f.session)?.runs).toHaveLength(2);
  });

  it("confirms a task's exit in a record an earlier version saved under the computer", () => {
    const f = fixture();
    f.tasks.write(f.cell, {
      v: 1,
      route: "claude-code",
      cellId: f.cell,
      sessionId: f.session,
      boot,
      runs: [{ id: ulid(), identity: { pid: 123, start: "100:20" } }],
    });
    f.probe.status.mockReturnValue("exited");
    f.tasks.confirmed(f.session);
    expect(f.tasks.read(f.cell)?.settled).toBe(true);
    expect(f.tasks.state(f.cell, f.session)).toBe("exited");
    f.tasks.spawn(f.cell, ulid(), child);
    expect(f.tasks.read(f.cell)).toBeUndefined();
  });
});
