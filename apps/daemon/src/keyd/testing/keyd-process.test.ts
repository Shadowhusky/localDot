import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type KeydProcess, startKeyd } from "./keyd-process.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), write: vi.fn() }));
vi.mock("node:child_process", async (load) => ({
  ...(await load<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  execFileSync: () => {
    throw new Error("unit test must not build or execute keyd");
  },
}));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => mocks.write(...args),
  };
});

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals) => {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  });
}

const ready = Buffer.from("keyd ready socket=/tmp/mock-keyd.sock boot=0123456789abcdef\n");
let children: FakeChild[];
let running: KeydProcess[];
let homes: string[];

beforeEach(async () => {
  vi.stubEnv("LOCALDOT_KEYD_BIN", "/tmp/mock-keyd-never-executed");
  children = [];
  running = [];
  homes = [];
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  mocks.write.mockReset().mockImplementation(fs.writeSync);
});
afterEach(async () => {
  for (const process of running) await process.stop().catch(() => {});
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function start(home?: string) {
  const pending = startKeyd(home ? { home } : {});
  const child = children.at(-1);
  if (!child) throw new Error("expected the mocked child");
  child.stderr.write(ready);
  const process = await pending;
  running.push(process);
  return { process, child };
}

const ownedDirectories = () =>
  readdirSync("/tmp")
    .filter(
      (name) =>
        name.startsWith(`ld-keyd-${process.pid}-`) ||
        name.startsWith(`ld-keyd-stderr-${process.pid}-`),
    )
    .sort();

describe("test keyd stderr capture", () => {
  it("keeps exact raw history beyond the diagnostic tail, including partial writes", async () => {
    const { process, child } = await start();
    const path = process.stderrPath();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    mocks.write.mockImplementation((fd: number, data: Buffer, offset: number, length: number) =>
      fs.writeSync(fd, data, offset, Math.min(length, 1024)),
    );
    const first = Buffer.from("early-canary-must-survive\n");
    const middle = Buffer.alloc(70 * 1024, "x");
    const binary = Buffer.from([0, 255, 0xe4, 0xb8, 0xad]);
    child.stderr.write(first);
    child.stderr.write(middle);
    child.stderr.write(binary.subarray(0, 3));
    child.stderr.write(binary.subarray(3));
    expect(process.stderrPath()).toBe(path);
    expect(readFileSync(path)).toEqual(Buffer.concat([ready, first, middle, binary]));
    expect(process.stderr()).not.toContain("early-canary");
    expect(process.stderr()).toHaveLength(64 * 1024);
    expect(process.stderr().endsWith("\0�中")).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await process.stop();
    expect(existsSync(path)).toBe(false);
    expect(() => process.stderrPath()).toThrow("closed");
  });

  it("isolates artifacts without overwriting existing files or removing a caller's home", async () => {
    const home = mkdtempSync("/tmp/ld-stderr-home-");
    homes.push(home);
    const existing = join(home, "stderr.log");
    writeFileSync(existing, "existing caller artifact");
    const first = await start(home);
    const second = await start(home);
    expect(first.process.stderrPath()).not.toBe(second.process.stderrPath());
    first.child.stderr.write(Buffer.from("first only"));
    expect(readFileSync(second.process.stderrPath(), "utf8")).not.toContain("first only");
    await first.process.stop();
    await second.process.stop();
    expect(readFileSync(existing, "utf8")).toBe("existing caller artifact");
  });

  it("cleans owned artifacts and home when startup fails", async () => {
    const before = ownedDirectories();
    const pending = startKeyd();
    const rejected = expect(pending).rejects.toThrow("keyd could not start");
    children[0]?.emit("error", new Error("missing mock executable"));
    await rejected;
    expect(ownedDirectories()).toEqual(before);
  });

  it("cleans owned artifacts when spawn throws synchronously", async () => {
    const before = ownedDirectories();
    mocks.spawn.mockImplementation(() => {
      throw new Error("mock spawn failure");
    });
    await expect(startKeyd()).rejects.toThrow("mock spawn failure");
    expect(ownedDirectories()).toEqual(before);
  });

  it("fails startup instead of accepting an incomplete ready-line capture", async () => {
    const before = ownedDirectories();
    mocks.write.mockImplementation(() => {
      throw new Error("mock disk full");
    });
    const pending = startKeyd();
    const rejected = expect(pending).rejects.toThrow("stderr capture failed");
    children[0]?.stderr.write(ready);
    await rejected;
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(ownedDirectories()).toEqual(before);
  });

  it("surfaces capture failure after startup through both the guard and cleanup", async () => {
    const { process, child } = await start();
    const path = process.stderrPath();
    mocks.write.mockReturnValue(0);
    child.stderr.write(Buffer.from("would otherwise be silently missing"));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(() => process.stderrPath()).toThrow("stderr capture failed");
    await expect(process.stop()).rejects.toThrow("stderr capture failed");
    expect(existsSync(path)).toBe(false);
  });

  it("rejects a truncated artifact rather than claiming complete history", async () => {
    const { process } = await start();
    writeFileSync(process.stderrPath(), "");
    expect(() => process.stderrPath()).toThrow("artifact changed");
  });

  it("waits for stderr close even when the child has already emitted exit", async () => {
    const { process, child } = await start();
    const path = process.stderrPath();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    let stopped = false;
    const stopping = process.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    child.stderr.write(Buffer.from("late pipe bytes after exit\n"));
    expect(readFileSync(path, "utf8")).toContain("late pipe bytes after exit");
    child.emit("close", 0, null);
    await stopping;
    expect(existsSync(path)).toBe(false);
  });

  it("preserves late canary bytes and the complete home only after close, then removes originals", async () => {
    const { process, child } = await start();
    const original = process.stderrPath();
    const parent = mkdtempSync("/tmp/ld-final-artifacts-");
    homes.push(parent);
    const artifactsTo = join(parent, "snapshot");
    const nested = join(process.home, "keyd", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "audit.jsonl"), "audit before exit\n");
    child.exitCode = 0;
    child.emit("exit", 0, null);
    const stopping = process.stop({ artifactsTo });
    await Promise.resolve();
    expect(existsSync(artifactsTo)).toBe(false);
    const late = Buffer.from("CANARY-only-delivered-after-exit\n");
    child.stderr.write(late);
    writeFileSync(join(nested, "audit.jsonl"), "audit final bytes\n");
    child.emit("close", 0, null);
    await stopping;
    expect(readFileSync(join(artifactsTo, "stderr.log"))).toEqual(Buffer.concat([ready, late]));
    expect(
      readFileSync(join(artifactsTo, "keyd-home", "keyd", "nested", "audit.jsonl"), "utf8"),
    ).toBe("audit final bytes\n");
    expect(statSync(artifactsTo).mode & 0o777).toBe(0o700);
    expect(existsSync(original)).toBe(false);
    expect(existsSync(process.home)).toBe(false);
  });

  it("refuses an existing artifact directory without changing it and still cleans original state", async () => {
    const { process } = await start();
    const original = process.stderrPath();
    const artifactsTo = mkdtempSync("/tmp/ld-existing-artifacts-");
    homes.push(artifactsTo);
    const existing = join(artifactsTo, "stderr.log");
    writeFileSync(existing, "caller-owned bytes");
    await expect(process.stop({ artifactsTo })).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(existing, "utf8")).toBe("caller-owned bytes");
    expect(readdirSync(artifactsTo)).toEqual(["stderr.log"]);
    expect(existsSync(original)).toBe(false);
    expect(existsSync(process.home)).toBe(false);
  });

  it("refuses to preserve a failed capture while still removing its originals", async () => {
    const { process, child } = await start();
    const original = process.stderrPath();
    const parent = mkdtempSync("/tmp/ld-failed-artifacts-");
    homes.push(parent);
    const artifactsTo = join(parent, "snapshot");
    mocks.write.mockReturnValue(0);
    child.stderr.write(Buffer.from("capture cannot finish"));
    await expect(process.stop({ artifactsTo })).rejects.toThrow("stderr capture failed");
    expect(existsSync(artifactsTo)).toBe(false);
    expect(existsSync(original)).toBe(false);
    expect(existsSync(process.home)).toBe(false);
  });
});
