import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBootstrappedBrowser } from "./bootstrap.ts";

vi.mock("node:fs/promises", () => ({ open: vi.fn() }));

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
};
const material = {
  v: 1,
  ...identity,
  proxyToken: "c".repeat(43),
  caCertPem: readFileSync(new URL("./testing/bootstrap-ca.pem", import.meta.url), "utf8"),
};
const streams: PassThrough[] = [];

function handle(directory = false) {
  return {
    fd: directory ? 314 : 315,
    stat: vi.fn(async () => ({
      isDirectory: () => directory,
      isFile: () => !directory,
      uid: 1000,
      mode: directory ? 0o700 : 0o600,
      nlink: 1,
    })),
    writeFile: vi.fn(async (_bytes: Buffer) => {}),
    sync: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function fixture() {
  const directory = handle(true),
    ca = handle(),
    token = handle();
  const opened = vi.mocked(open);
  for (const h of [directory, ca, token])
    opened.mockResolvedValueOnce(h as unknown as Awaited<ReturnType<typeof open>>);
  const lifetime = new AbortController(),
    start = vi.fn(async () => {}),
    stream = new PassThrough();
  streams.push(stream);
  const run = () => {
    const pending = startBootstrappedBrowser(stream, identity, lifetime.signal, start);
    stream.end(JSON.stringify(material));
    return pending;
  };
  return { directory, ca, token, opened, lifetime, start, run };
}

beforeEach(() => {
  vi.mocked(open).mockReset();
  vi.spyOn(process, "getuid").mockReturnValue(1000);
});
afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  vi.restoreAllMocks();
});

describe("credential installation and startup admission", () => {
  it("starts once only after both private files are synced and all handles close", async () => {
    const f = fixture();
    f.start.mockImplementation(async () => {
      expect(f.ca.sync).toHaveBeenCalledOnce();
      expect(f.token.sync).toHaveBeenCalledOnce();
      for (const h of [f.directory, f.ca, f.token]) expect(h.close).toHaveBeenCalledOnce();
    });
    await f.run();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.opened).toHaveBeenNthCalledWith(
      1,
      "/etc/localdot/cell",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    for (const [index, name] of ["ca.pem", "proxy-token"].entries())
      expect(f.opened).toHaveBeenNthCalledWith(
        index + 2,
        `/proc/self/fd/314/${name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    for (const h of [f.ca, f.token])
      expect(h.writeFile.mock.calls[0]?.[0].every((byte) => byte === 0)).toBe(true);
  });

  it("refuses another uid before opening the directory", async () => {
    const f = fixture();
    vi.spyOn(process, "getuid").mockReturnValue(0);
    await expect(f.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
    expect(f.opened).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(["directory", "owner", "mode"])("refuses unsafe directory %s", async (fault) => {
    const f = fixture();
    const state = await f.directory.stat();
    f.directory.stat.mockResolvedValue({
      ...state,
      isDirectory: () => fault !== "directory",
      uid: fault === "owner" ? 0 : 1000,
      mode: fault === "mode" ? 0o777 : 0o700,
    });
    await expect(f.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
    expect(f.opened).toHaveBeenCalledTimes(1);
    expect(f.directory.close).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(["directory", "ca", "token"])(
    "refuses a symlink/existing %s destination",
    async (fault) => {
      const f = fixture();
      f.opened.mockReset();
      for (const [name, h] of [
        ["directory", f.directory],
        ["ca", f.ca],
        ["token", f.token],
      ] as const) {
        if (name === fault) {
          f.opened.mockRejectedValueOnce(new Error("ELOOP/EEXIST private-credential-canary"));
          break;
        }
        f.opened.mockResolvedValueOnce(h as unknown as Awaited<ReturnType<typeof open>>);
      }
      await expect(f.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.directory.close).toHaveBeenCalledTimes(fault === "directory" ? 0 : 1);
      expect(f.ca.close).toHaveBeenCalledTimes(fault === "token" ? 1 : 0);
      expect(f.token.close).not.toHaveBeenCalled();
    },
  );

  it.each(["regular", "owner", "mode", "links"])("refuses unsafe file %s", async (fault) => {
    const f = fixture();
    const state = await f.ca.stat();
    f.ca.stat.mockResolvedValue({
      ...state,
      isFile: () => fault !== "regular",
      uid: fault === "owner" ? 0 : 1000,
      mode: fault === "mode" ? 0o644 : 0o600,
      nlink: fault === "links" ? 2 : 1,
    });
    await expect(f.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
    expect(f.ca.writeFile).not.toHaveBeenCalled();
    expect(f.ca.close).toHaveBeenCalledOnce();
    expect(f.directory.close).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(["stat", "writeFile", "sync", "close"] as const)(
    "contains a file %s failure",
    async (operation) => {
      const f = fixture();
      f.token[operation].mockRejectedValueOnce(new Error("private-credential-canary"));
      await expect(f.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
      expect(f.ca.close).toHaveBeenCalledOnce();
      expect(f.token.close).toHaveBeenCalledOnce();
      expect(f.directory.close).toHaveBeenCalledOnce();
      expect(f.start).not.toHaveBeenCalled();
      if (f.token.writeFile.mock.calls.length)
        expect(f.token.writeFile.mock.calls[0]?.[0].every((byte) => byte === 0)).toBe(true);
    },
  );

  it("does not start after Stop interrupts an in-flight write", async () => {
    const f = fixture(),
      entered = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>();
    f.ca.writeFile.mockImplementation(async () => {
      entered.resolve();
      await released.promise;
    });
    const pending = f.run(),
      refused = expect(pending).rejects.toThrow(/^Browser credential handoff failed$/u);
    await entered.promise;
    f.lifetime.abort();
    released.resolve();
    await refused;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.ca.close).toHaveBeenCalledOnce();
    expect(f.directory.close).toHaveBeenCalledOnce();
    expect(f.opened).toHaveBeenCalledTimes(2);
  });

  it("does not start when Stop arrives after installation but before startup admission", async () => {
    const f = fixture();
    f.directory.close.mockImplementation(async () => {
      f.lifetime.abort();
    });
    await expect(f.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
    for (const h of [f.directory, f.ca, f.token]) expect(h.close).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
  });
});
