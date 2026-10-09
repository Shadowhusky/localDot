import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PREPARATION_COMMAND_MS,
  BROWSER_PREPARATION_DRAIN_MS,
  prepareBrowserRuntime,
} from "./prepare.ts";
import { prepareProfilePreferences, releaseProfileLocks } from "./profile-preferences.ts";
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

describe("private browser runtime preparation", () => {
  it("keeps profile data and writes only a private password hash before creating fresh NSS trust", async () => {
    const test = fixture();
    test.files.set(`${PROFILE}/Cookies`, entry("file", { text: "persisted-fixture-cookie" }));
    await prepareBrowserRuntime(config, new AbortController().signal);
    expect(test.files.get(`${PROFILE}/Cookies`)?.text).toBe("persisted-fixture-cookie");
    expect(test.files.get(PASSWORD)?.text).toBe(`localdot:${HASH}\n`);
    expect(test.fileClose).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      PASSWORD,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    expect(test.inputs).toEqual([`${config.streamToken}\n`, "", ""]);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(prepareProfilePreferences).toHaveBeenCalledWith(PROFILE, expect.any(AbortSignal));
    expect(releaseProfileLocks).toHaveBeenCalledWith(PROFILE, expect.any(AbortSignal));
    expect(vi.mocked(releaseProfileLocks).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0] as number,
    );
    expect(vi.mocked(prepareProfilePreferences).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0] as number,
    );
    for (const [, args, options] of vi.mocked(spawn).mock.calls) {
      expect(options).toMatchObject({
        shell: false,
        detached: true,
        cwd: "/",
        stdio: ["pipe", "pipe", "ignore"],
      });
      expect(options?.env).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: "/home/browser",
        LANG: "C.UTF-8",
      });
      expect(JSON.stringify([args, options])).not.toContain(config.streamToken);
      expect(JSON.stringify([args, options])).not.toContain(config.serviceToken);
    }
    expect(vi.mocked(spawn).mock.calls.map(([path, args]) => [path, args])).toEqual([
      ["/usr/bin/openssl", ["passwd", "-6", "-stdin"]],
      ["/usr/bin/certutil", ["-N", "--empty-password", "-d", "sql:/home/browser/.pki/nssdb"]],
      [
        "/usr/bin/certutil",
        [
          "-A",
          "-t",
          "C,,",
          "-n",
          "localdot-cell",
          "-d",
          "sql:/home/browser/.pki/nssdb",
          "-i",
          CERTIFICATE,
        ],
      ],
    ]);
    expect(mkdir).not.toHaveBeenCalledWith(PROFILE, expect.objectContaining({ recursive: true }));
  });

  it("creates a missing private profile without a recursive path traversal", async () => {
    const test = fixture();
    test.files.delete(PROFILE);
    await prepareBrowserRuntime(config, new AbortController().signal);
    expect(test.files.get(PROFILE)?.mode).toBe(0o700);
    expect(mkdir).toHaveBeenCalledWith(PROFILE, { mode: 0o700 });
  });

  it("refuses startup when the private preferences cannot be prepared", async () => {
    fixture();
    vi.mocked(prepareProfilePreferences).mockRejectedValueOnce(new Error("unavailable"));
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      "Browser preparation failed",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["/home/browser", entry("symlink")],
    ["/home/browser", entry("directory", { uid: 0 })],
    ["/home/browser", entry("directory", { mode: 0o755 })],
    ["/profile", entry("symlink")],
    ["/profile", entry("directory", { uid: 2000 })],
    ["/downloads", entry("symlink")],
    ["/downloads", entry("directory", { uid: 0 })],
    ["/downloads", entry("directory", { mode: 0o755 })],
    [PROFILE, entry("symlink")],
    [PROFILE, entry("directory", { mode: 0o777 })],
    ["/tmp/browser-runtime", entry()],
    ["/home/browser/.pki", entry()],
    [CERTIFICATE, entry("symlink")],
    [CERTIFICATE, entry("directory")],
    [CERTIFICATE, entry("file", { size: 0 })],
    [CERTIFICATE, entry("file", { size: 65537 })],
  ] as const)("refuses unsafe or stale bootstrap path %s", async (path, state) => {
    const test = fixture();
    test.files.set(path, { ...state });
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses root execution before any file or subprocess operation", async () => {
    fixture();
    vi.spyOn(process, "getuid").mockReturnValue(0);
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      "Browser preparation failed",
    );
    expect(lstat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("an already cancelled start has no filesystem or process side effects", async () => {
    fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(prepareBrowserRuntime(config, abort.signal)).rejects.toThrow(
      "Browser preparation failed",
    );
    expect(lstat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["private-canary", `${HASH}\nlocaldot:injected`, "A".repeat(1025)])(
    "refuses malformed or oversized command output without storing it",
    async (output) => {
      const test = fixture({ output });
      await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
        /^Browser preparation failed$/u,
      );
      expect(test.files.has(PASSWORD)).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a failed utility even if it printed a syntactically valid hash", async () => {
    const test = fixture({ exitCode: 1 });
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(test.files.has(PASSWORD)).toBe(false);
  });

  it("cancellation kills and drains the owned utility before refusing readiness", async () => {
    const test = fixture({ hang: true });
    const abort = new AbortController();
    const result = prepareBrowserRuntime(config, abort.signal);
    await test.launched.promise;
    abort.abort();
    await expect(result).rejects.toThrow(/^Browser preparation failed$/u);
    expect(test.kill).toHaveBeenCalledWith(-45000, "SIGKILL");
    expect(test.handles[0]?.alive).toBe(false);
    expect(test.files.has(PASSWORD)).toBe(false);
  });

  it("a utility deadline kills its group and cannot publish readiness", async () => {
    vi.useFakeTimers();
    const test = fixture({ hang: true });
    const result = prepareBrowserRuntime(config, new AbortController().signal).catch(
      (error: Error) => error.message,
    );
    await test.launched.promise;
    await vi.advanceTimersByTimeAsync(BROWSER_PREPARATION_COMMAND_MS);
    await expect(result).resolves.toBe("Browser preparation failed");
    expect(test.kill).toHaveBeenCalledWith(-45000, "SIGKILL");
  });

  it("refuses a successful result when a utility group remains after its leader closes", async () => {
    const test = fixture({ survivingGroup: true });
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(test.kill).toHaveBeenCalledWith(-45000, "SIGKILL");
    expect(test.handles[0]?.alive).toBe(false);
    expect(test.files.has(PASSWORD)).toBe(false);
  });

  it("a failed forced drain still returns a fixed failure within the finite deadline", async () => {
    vi.useFakeTimers();
    const test = fixture({ hang: true, ignoreKill: true });
    const result = prepareBrowserRuntime(config, new AbortController().signal).catch(
      (error: Error) => error.message,
    );
    await test.launched.promise;
    await vi.advanceTimersByTimeAsync(
      BROWSER_PREPARATION_COMMAND_MS + BROWSER_PREPARATION_DRAIN_MS,
    );
    await expect(result).resolves.toBe("Browser preparation failed");
    expect(test.handles[0]?.alive).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(test.files.has(PASSWORD)).toBe(false);
  });

  it("never overwrites an existing password file or follows its symlink", async () => {
    const test = fixture();
    test.files.set(PASSWORD, entry("symlink", { text: "keep-original" }));
    await expect(prepareBrowserRuntime(config, new AbortController().signal)).rejects.toThrow(
      /^Browser preparation failed$/u,
    );
    expect(test.files.get(PASSWORD)?.text).toBe("keep-original");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
