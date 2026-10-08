import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBrowserBootstrap, startBootstrappedBrowser } from "./bootstrap.ts";

vi.mock("node:fs/promises", () => ({ open: vi.fn() }));

const identity = Object.freeze({
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
});
const material = {
  v: 1,
  ...identity,
  proxyToken: "c".repeat(43),
  caCertPem: readFileSync(new URL("./testing/bootstrap-ca.pem", import.meta.url), "utf8"),
};
const streams: PassThrough[] = [];
function handle(directory = false) {
  return {
    fd: directory ? 777 : 778,
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
  for (const value of [directory, ca, token])
    vi.mocked(open).mockResolvedValueOnce(value as unknown as Awaited<ReturnType<typeof open>>);
  const input = new PassThrough(),
    lifetime = new AbortController(),
    start = vi.fn(async () => {});
  streams.push(input);
  const run = () => {
    const result = startBootstrappedBrowser(input, identity, lifetime.signal, start);
    input.end(JSON.stringify(material));
    return result;
  };
  return { directory, ca, token, input, lifetime, start, run };
}
beforeEach(() => {
  vi.mocked(open).mockReset();
  vi.spyOn(process, "getuid").mockReturnValue(1000);
});
afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  vi.restoreAllMocks();
});

describe("independent bootstrap failure admission", () => {
  it("closes the opened directory when its stat fails and opens no credential file", async () => {
    const test = fixture();
    test.directory.stat.mockRejectedValueOnce(new Error("private-stat-detail"));
    await expect(test.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
    expect(test.directory.close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(test.start).not.toHaveBeenCalled();
  });

  it("a first-file close failure still closes the directory and never admits the second file or runtime", async () => {
    const test = fixture();
    test.ca.close.mockRejectedValueOnce(new Error("private-close-detail"));
    await expect(test.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
    expect(test.ca.close).toHaveBeenCalledOnce();
    expect(test.directory.close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    expect(test.start).not.toHaveBeenCalled();
    expect(test.ca.writeFile.mock.calls[0]?.[0].every((byte) => byte === 0)).toBe(true);
  });

  it("abort during the final file close cannot cross the startup guard", async () => {
    const test = fixture();
    test.token.close.mockImplementation(async () => {
      test.lifetime.abort();
    });
    const outcome = await test.run().catch((error: unknown) => error);
    expect(test.start).not.toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Browser credential handoff failed");
    expect(test.directory.close).toHaveBeenCalledOnce();
  });

  it("two installation cleanup failures retain a generic refusal with all owners attempted", async () => {
    const test = fixture();
    test.token.sync.mockRejectedValueOnce(new Error("private-sync-detail"));
    test.token.close.mockRejectedValueOnce(new Error("private-close-detail"));
    test.directory.close.mockRejectedValueOnce(new Error("private-directory-detail"));
    await expect(test.run()).rejects.toThrow(/^Browser credential handoff failed$/u);
    for (const owner of [test.ca, test.token, test.directory])
      expect(owner.close).toHaveBeenCalledOnce();
    expect(test.start).not.toHaveBeenCalled();
    expect(test.token.writeFile.mock.calls[0]?.[0].every((byte) => byte === 0)).toBe(true);
  });

  it("rejects concatenated envelopes with zero filesystem or runtime effects", async () => {
    const test = fixture();
    const pending = startBootstrappedBrowser(
      test.input,
      identity,
      test.lifetime.signal,
      test.start,
    );
    test.input.end(JSON.stringify(material) + JSON.stringify(material));
    await expect(pending).rejects.toThrow(/^Browser credential handoff failed$/u);
    expect(open).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
  });

  it("rejects a different parent with zero filesystem or runtime effects", async () => {
    const test = fixture();
    const pending = startBootstrappedBrowser(
      test.input,
      { ...identity, parentCellId: "01J00000000000000000000003" },
      test.lifetime.signal,
      test.start,
    );
    test.input.end(JSON.stringify(material));
    const outcome = await pending.catch((error: unknown) => error);
    expect(open).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Browser credential handoff failed");
  });

  it("returns frozen matching material while preserving caller-owned buffers", async () => {
    const input = new PassThrough();
    streams.push(input);
    const bytes = Buffer.from(JSON.stringify(material));
    const original = Buffer.from(bytes);
    const pending = readBrowserBootstrap(input, identity, new AbortController().signal);
    input.end(bytes);
    const accepted = await pending;
    expect(accepted).toEqual(material);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(bytes).toEqual(original);
    expect(input.listenerCount("data")).toBe(0);
  });
});
