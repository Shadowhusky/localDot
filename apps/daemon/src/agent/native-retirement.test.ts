import { mkdtempSync, rmSync } from "node:fs";
import { ulid } from "@localdot/protocol";
import { expect, it, vi } from "vitest";
import { NativeRetirement } from "./native-retirement.ts";
import { ComputerFences } from "./safety/fences.ts";

it("persists late retirement across restart without removing the computer fence", async () => {
  const home = mkdtempSync("/tmp/ld-native-recovery-");
  try {
    const fences = new ComputerFences(home),
      cell = ulid(),
      task = ulid();
    const retired = vi.fn((id) => fences.confirmNativeRetirement(cell, id));
    const tracker = new NativeRetirement(retired),
      drain = Promise.withResolvers<void>();
    tracker.begin(task);
    const cleanup = tracker.track(task, drain.promise);
    fences.capture(cell, task, "native");
    tracker.end(task);
    expect(tracker.confirmed(task)).toBe(false);
    expect(new ComputerFences(home).record(cell)?.nativeRetired).toBe(false);
    drain.resolve();
    await cleanup;
    expect(retired).toHaveBeenCalledExactlyOnceWith(task);
    expect(tracker.confirmed(task)).toBe(true);
    expect(new ComputerFences(home).record(cell)).toMatchObject({
      nativeRetired: true,
      revision: 1,
    });
    expect(new ComputerFences(home).isFenced(cell)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it("requires every cleanup and the driver itself to finish", async () => {
  const retired = vi.fn(),
    tracker = new NativeRetirement(retired),
    id = ulid();
  const first = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>();
  tracker.begin(id);
  const a = tracker.track(id, first.promise),
    b = tracker.track(id, second.promise);
  first.resolve();
  await a;
  tracker.end(id);
  expect(retired).not.toHaveBeenCalled();
  second.resolve();
  await b;
  expect(retired).toHaveBeenCalledOnce();
  expect(tracker.confirmed(ulid())).toBe(false);
});
it("a real cleanup failure never becomes a retirement receipt", async () => {
  const retired = vi.fn(),
    tracker = new NativeRetirement(retired),
    id = ulid();
  tracker.begin(id);
  await expect(tracker.track(id, Promise.reject(new Error("exit unknown")))).rejects.toThrow();
  tracker.end(id);
  expect(tracker.confirmed(id)).toBe(false);
  expect(retired).not.toHaveBeenCalled();
});

it("never reports confirmed retirement when its durable callback fails", () => {
  const tracker = new NativeRetirement(() => {
    throw new Error("descendant still alive");
  });
  const id = ulid();
  tracker.begin(id);
  expect(() => tracker.end(id)).toThrow("descendant still alive");
  expect(tracker.confirmed(id)).toBe(false);
  expect(() => tracker.begin(id)).toThrow("cleanup is pending");
});
