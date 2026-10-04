import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_AUTONOMY, ulid } from "@localdot/protocol";
import { afterEach, expect, it } from "vitest";
import { SafetyIntentStore } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync("/tmp/ld-safety-intent-");
  roots.push(home);
  const sessionId = ulid(),
    cellId = ulid();
  const store = new SafetyIntentStore(home);
  const pause = {
    requestId: ulid(),
    revision: 1,
    reason: "user" as const,
    phase: "paused" as const,
    atStepBoundary: true,
    resumeAvailable: true,
  };
  return {
    home,
    sessionId,
    cellId,
    store,
    pause,
    path: join(home, "sessions", sessionId, "safety.json"),
  };
}
it("persists only frozen policy and pause intent as a private atomic file, never grants", () => {
  const f = fixture();
  f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, f.pause);
  expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual({
    version: 1,
    sessionId: f.sessionId,
    cellId: f.cellId,
    policy: DEFAULT_AUTONOMY,
    pause: f.pause,
  });
  f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, undefined);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).not.toHaveProperty("pause");
  expect(readdirSync(join(f.home, "sessions", f.sessionId))).toEqual(["safety.json"]);
  expect(() =>
    f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, {
      ...f.pause,
      permit: "grant",
    } as never),
  ).toThrow();
});
it.each(["symlink", "dangling", "oversize", "public"])(
  "refuses unsafe %s intent without replacing it",
  (kind) => {
    const f = fixture();
    mkdirSync(join(f.home, "sessions", f.sessionId), { recursive: true, mode: 0o700 });
    const outside = join(f.home, "outside");
    if (kind === "symlink") {
      writeFileSync(outside, "unchanged");
      symlinkSync(outside, f.path);
    } else if (kind === "dangling") symlinkSync(outside, f.path);
    else {
      writeFileSync(f.path, kind === "oversize" ? "x".repeat(8193) : "public", { mode: 0o600 });
      if (kind === "public") chmodSync(f.path, 0o644);
    }
    const before = lstatSync(f.path);
    expect(() => f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, f.pause)).toThrow();
    const after = lstatSync(f.path);
    expect(after.ino).toBe(before.ino);
    if (kind === "symlink") expect(readFileSync(outside, "utf8")).toBe("unchanged");
  },
);
it("refuses a session-directory symlink and invalid owners before writing", () => {
  const f = fixture();
  const outside = join(f.home, "outside");
  mkdirSync(outside);
  mkdirSync(join(f.home, "sessions"), { mode: 0o700 });
  symlinkSync(outside, join(f.home, "sessions", f.sessionId));
  expect(() => f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, f.pause)).toThrow();
  expect(readdirSync(outside)).toEqual([]);
  expect(() => f.store.write("../escape", f.cellId, DEFAULT_AUTONOMY, f.pause)).toThrow();
});
