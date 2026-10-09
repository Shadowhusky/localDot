import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PREPARATION_DRAIN_MS, prepareBrowserRuntime } from "./prepare.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

vi.mock("./profile-preferences.ts", () => ({
  prepareProfilePreferences: vi.fn(),
  releaseProfileLocks: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), mkdir: vi.fn(), open: vi.fn() }));

const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});
const HASH = `$6$salt$${"A".repeat(86)}`;
const PROFILE = "/profile/chromium";
const PASSWORD = "/tmp/browser-runtime/stream.htpasswd";
const CERTIFICATE = "/etc/localdot/cell/ca.pem";

interface Entry {
  kind: "directory" | "file" | "symlink";
  mode: number;
  uid: number;
  size: number;
  nlink: number;
  text?: string;
}

function entry(kind: Entry["kind"] = "directory", changes: Partial<Entry> = {}): Entry {
  return {
    kind,
    mode: kind === "file" ? 0o600 : 0o700,
    uid: 1000,
    size: 512,
    nlink: 1,
    ...changes,
  };
}

function fixture(
  options: {
    hang?: boolean;
    ignoreKill?: boolean;
    output?: string;
    exitCode?: number;
    survivingGroup?: boolean;
  } = {},
) {
  const files = new Map<string, Entry>([
    ["/home/browser", entry()],
    ["/profile", entry()],
    ["/downloads", entry()],
    [PROFILE, entry()],
    [CERTIFICATE, entry("file", { uid: 0, mode: 0o444 })],
  ]);
  const launched = Promise.withResolvers<void>();
  const inputs: string[] = [];
  const handles: { child: ReturnType<typeof childFixture>; alive: boolean }[] = [];
  const fileClose = vi.fn(async () => {});
  vi.spyOn(process, "getuid").mockReturnValue(1000);
  vi.mocked(lstat).mockImplementation(async (path) => {
    const value = files.get(String(path));
    if (!value) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return {
      ...value,
      isDirectory: () => value.kind === "directory",
      isFile: () => value.kind === "file",
      isSymbolicLink: () => value.kind === "symlink",
    } as unknown as Awaited<ReturnType<typeof lstat>>;
  });
  vi.mocked(mkdir).mockImplementation(async (path) => {
    if (files.has(String(path))) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    files.set(String(path), entry());
    return undefined;
  });
  vi.mocked(open).mockImplementation(async (path) => {
    if (files.has(String(path))) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    const value = entry("file");
    files.set(String(path), value);
    return {
      stat: () => lstat(path),
      writeFile: async (text: string) => {
        value.text = text;
      },
      close: fileClose,
    } as unknown as Awaited<ReturnType<typeof open>>;
  });
  function childFixture() {
    return Object.assign(new EventEmitter(), {
      pid: 45000 + handles.length,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
  }
  vi.mocked(spawn).mockImplementation((executable) => {
    const child = childFixture();
    const handle = { child, alive: true };
    handles.push(handle);
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += String(chunk);
    });
    child.stdin.once("finish", () => {
      inputs.push(input);
      queueMicrotask(() => {
        if (options.hang) return;
        const output = options.output ?? (executable === "/usr/bin/openssl" ? `${HASH}\n` : "");
        child.stdout.write(output);
        handle.alive = options.survivingGroup === true;
        child.emit("close", options.exitCode ?? 0);
      });
    });
    queueMicrotask(() => child.emit("spawn"));
    launched.resolve();
    return child as unknown as ReturnType<typeof spawn>;
  });
  const kill = vi.spyOn(process, "kill").mockImplementation((processId, signal) => {
    const handle = handles.find(({ child }) => child.pid === -processId);
    expect(handle).toBeDefined();
    if (!handle?.alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (signal !== 0 && !options.ignoreKill) {
      handle.alive = false;
      queueMicrotask(() => handle.child.emit("close", null));
    }
    return true;
  });
  return { files, inputs, handles, kill, launched, fileClose };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("independent private preparation boundaries", () => {
  it("P1 accepts one private preparation with preserved profile and stdin-only secret", async () => {
    const f = fixture();
    f.files.set(`${PROFILE}/marker`, entry("file", { text: "keep" }));
    await prepareBrowserRuntime(config, new AbortController().signal);
    expect(f.files.get(`${PROFILE}/marker`)?.text).toBe("keep");
    expect(f.files.get(PASSWORD)?.text).toBe(`localdot:${HASH}\n`);
    expect(f.inputs).toEqual([`${config.streamToken}\n`, "", ""]);
    expect(f.fileClose).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(3);
    for (const [, args, options] of vi.mocked(spawn).mock.calls) {
      expect(JSON.stringify([args, options])).not.toContain(config.streamToken);
      expect(JSON.stringify([args, options])).not.toContain(config.serviceToken);
      expect(options).toMatchObject({ detached: true, shell: false, cwd: "/" });
    }
  });

  it("P2 rejects an already aborted request without file or child effects", async () => {
    fixture();
    const abort = new AbortController();
    abort.abort(new Error("private-cancel-canary"));
    await expect(prepareBrowserRuntime(config, abort.signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("captures the configured bearer before the first awaited path check", async () => {
    const f = fixture();
    const mutable = { ...config };
    const original = vi.mocked(lstat).getMockImplementation();
    if (!original) throw new Error("fixture missing lstat adapter");
    vi.mocked(lstat).mockImplementation(async (path, ...args) => {
      const value = await original(path, ...args);
      if (String(path) === "/home/browser") mutable.streamToken = "c".repeat(43);
      return value;
    });
    await prepareBrowserRuntime(mutable, new AbortController().signal);
    expect(f.inputs[0]).toBe(`${config.streamToken}\n`);
    expect(f.inputs[0]).not.toContain(mutable.streamToken);
  });

  it("cancellation during CA inspection admits no utility or secret write", async () => {
    fixture();
    const abort = new AbortController();
    const original = vi.mocked(lstat).getMockImplementation();
    if (!original) throw new Error("fixture missing lstat adapter");
    vi.mocked(lstat).mockImplementation(async (path, ...args) => {
      const value = await original(path, ...args);
      if (String(path) === CERTIFICATE) abort.abort();
      return value;
    });
    await expect(prepareBrowserRuntime(config, abort.signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("a password-handle close failure refuses NSS and returns only the fixed error", async () => {
    const f = fixture();
    f.fileClose.mockRejectedValue(new Error("private-close-canary"));
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(f.fileClose).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.files.get(PASSWORD)?.text).toBe(`localdot:${HASH}\n`);
  });

  it.each([{ nlink: 2 }, { uid: 0 }, { mode: 0o644 }])(
    "refuses an unsafe newly opened password descriptor %j before writing",
    async (change) => {
      const f = fixture();
      const original = vi.mocked(open).getMockImplementation();
      if (!original) throw new Error("fixture missing open adapter");
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await original(...args);
        const file = f.files.get(PASSWORD);
        if (!file) throw new Error("fixture missing password entry");
        Object.assign(file, change);
        return handle;
      });
      await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
        /^Browser preparation failed$/u,
      );
      expect(f.files.get(PASSWORD)?.text).toBeUndefined();
      expect(f.fileClose).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("abort after closing the password descriptor cannot start NSS", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.fileClose.mockImplementation(async () => abort.abort());
    await expect(prepareBrowserRuntime(config, abort.signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(f.fileClose).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("all group permission failures stay uncertain and cannot publish a password", async () => {
    vi.useFakeTimers();
    const f = fixture({ survivingGroup: true });
    f.kill.mockImplementation((pid) => {
      expect(pid).toBe(-45000);
      throw Object.assign(new Error("private-group-canary"), { code: "EPERM" });
    });
    const result = prepareBrowserRuntime(config, new AbortController().signal).then(
      () => "ready",
      (error: Error) => error.message,
    );
    await f.launched.promise;
    await vi.advanceTimersByTimeAsync(BROWSER_PREPARATION_DRAIN_MS + 40);
    await expect(result).resolves.toBe("Browser preparation failed");
    expect(f.files.has(PASSWORD)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("output is bounded cumulatively before a normal child close", async () => {
    const f = fixture({ hang: true });
    const result = prepareBrowserRuntime(config, new AbortController().signal);
    await f.launched.promise;
    const h = f.handles[0];
    if (!h) throw new Error("fixture missing child");
    try {
      h.child.stdout.emit("data", Buffer.alloc(600, 65));
      expect(f.kill).not.toHaveBeenCalledWith(-45000, "SIGKILL");
      h.child.stdout.emit("data", Buffer.alloc(425, 65));
      expect(f.kill).toHaveBeenCalledWith(-45000, "SIGKILL");
      await expect(result).rejects.toThrow(/^Browser preparation failed$/u);
      expect(open).not.toHaveBeenCalled();
    } finally {
      h.alive = false;
      h.child.emit("close", 1);
      await result.catch(() => {});
    }
  });

  it("a spawn error with no allocated PID uses no unrelated signal and cannot publish", async () => {
    const f = fixture({ hang: true });
    const original = vi.mocked(spawn).getMockImplementation();
    if (!original) throw new Error("fixture missing spawn adapter");
    vi.mocked(spawn).mockImplementation((...args) => {
      const child = original(...args);
      Object.defineProperty(child, "pid", { value: undefined });
      queueMicrotask(() => {
        child.emit("error", new Error("private-spawn-canary"));
        child.emit("close", -2);
      });
      return child;
    });
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(f.kill).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
