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
import { ComputerFences } from "./fences.ts";
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

it("reads typed bounded private intent but never restores a permit or live generation", () => {
  const f = fixture();
  f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, f.pause, "api");
  expect(f.store.read(f.sessionId)).toMatchObject({
    sessionId: f.sessionId,
    cellId: f.cellId,
    executor: "api",
    pause: f.pause,
  });
  expect(f.store.list()).toHaveLength(1);
  expect(new ComputerFences(f.home).isFenced(f.cellId)).toBe(false);
  writeFileSync(
    f.path,
    JSON.stringify({ ...JSON.parse(readFileSync(f.path, "utf8")), permit: "injected" }) + "\n",
  );
  expect(() => f.store.read(f.sessionId)).toThrow();
  expect(new ComputerFences(f.home).isFenced(ulid())).toBe(true);
});
it("a crashed uncertain API pause becomes a permanent deny before startup effects", () => {
  const f = fixture();
  f.store.write(
    f.sessionId,
    f.cellId,
    DEFAULT_AUTONOMY,
    { ...f.pause, phase: "uncertain", resumeAvailable: false },
    "api",
  );
  const recovered = new ComputerFences(f.home);
  expect(recovered.record(f.cellId)).toMatchObject({
    cellId: f.cellId,
    sessionId: f.sessionId,
    nativeRetired: true,
  });
  f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, undefined, "api");
  expect(new ComputerFences(f.home).isFenced(f.cellId)).toBe(true);
});
it.each(["symlink", "oversize", "public", "wrong-owner"])(
  "a %s intent read refuses recovery without rewriting it",
  (kind) => {
    const f = fixture();
    f.store.write(f.sessionId, f.cellId, DEFAULT_AUTONOMY, f.pause);
    if (kind === "symlink") {
      rmSync(f.path);
      const outside = join(f.home, "unchanged");
      writeFileSync(outside, "untouched");
      symlinkSync(outside, f.path);
    } else if (kind === "oversize") writeFileSync(f.path, "x".repeat(8193));
    else if (kind === "public") chmodSync(f.path, 0o644);
    else
      writeFileSync(
        f.path,
        JSON.stringify({ ...JSON.parse(readFileSync(f.path, "utf8")), sessionId: ulid() }) + "\n",
      );
    const before = lstatSync(f.path);
    expect(() => f.store.read(f.sessionId)).toThrow();
    expect(lstatSync(f.path).ino).toBe(before.ino);
    expect(new ComputerFences(f.home).isFenced(ulid())).toBe(true);
  },
);

const LEGACY_POLICY = {
  reading: "act",
  browsing: "act",
  purchase: "ask",
  send: "ask",
  post: "ask",
  delete: "ask",
  download_execute: "ask",
  system_settings: "ask",
};
function writeIntent(home: string, record: { sessionId: string } & Record<string, unknown>) {
  const dir = join(home, "sessions", record.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "safety.json"), `${JSON.stringify({ version: 1, ...record })}\n`, {
    mode: 0o600,
  });
}
function mixedIntents(f: ReturnType<typeof fixture>) {
  const legacy = { sessionId: ulid(), cellId: ulid() };
  const current = { sessionId: ulid(), cellId: ulid() };
  const crashed = { sessionId: ulid(), cellId: ulid() };
  writeIntent(f.home, { ...legacy, policy: LEGACY_POLICY, pause: f.pause });
  writeIntent(f.home, {
    ...current,
    policy: { ...LEGACY_POLICY, computer: "ask", memory: "ask" },
    executor: "api",
  });
  writeIntent(f.home, {
    ...crashed,
    policy: LEGACY_POLICY,
    pause: { ...f.pause, phase: "uncertain", resumeAvailable: false },
  });
  return { legacy, current, crashed };
}
it("reads legacy eight-class intents as upgraded policies beside new ones", () => {
  const f = fixture();
  const { legacy, current } = mixedIntents(f);
  expect(f.store.read(legacy.sessionId)?.policy).toEqual({
    ...LEGACY_POLICY,
    computer: "act",
    memory: "ask",
  });
  expect(f.store.read(current.sessionId)?.policy.computer).toBe("ask");
  expect(f.store.list()).toHaveLength(3);
});
it("old and new intents together never fence every computer at startup", () => {
  const f = fixture();
  const { legacy, current, crashed } = mixedIntents(f);
  const fences = new ComputerFences(f.home);
  expect(() => fences.records()).not.toThrow();
  expect(fences.isFenced(legacy.cellId)).toBe(false);
  expect(fences.isFenced(current.cellId)).toBe(false);
  expect(fences.isFenced(ulid())).toBe(false);
  expect(fences.isFenced(crashed.cellId)).toBe(true);
});
