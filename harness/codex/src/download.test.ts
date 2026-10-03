import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { ClientRequest } from "node:http";
import https from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadCodexArchive, VerifiedCodexInstaller } from "./install.ts";
import { prepareOwnedCodexRoots } from "./roots.ts";
import { codexRelease } from "./version.ts";

const URL = "https://registry.npmjs.org/@openai/codex/-/codex-0.154.0-darwin-arm64.tgz";
const owned: string[] = [];
function requestFixture() {
  const request = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  request.setTimeout = vi.fn(() => request);
  request.destroy = vi.fn((error: Error) => {
    queueMicrotask(() => request.emit("error", error));
    return request;
  });
  const get = vi.spyOn(https, "get").mockReturnValue(request as unknown as ClientRequest);
  return { request, get };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("native Codex download bounds", () => {
  it("refuses native HTTP redirects with one request and closes the response", async () => {
    const f = requestFixture();
    const response = Object.assign(Readable.from([]), {
      statusCode: 302,
      headers: { location: "https://example.com/next" },
    });
    const pending = downloadCodexArchive(URL, new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "download_failed" });
    f.request.emit("response", response);
    await rejected;
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(response.destroyed).toBe(true);
  });
  it("bounds DNS and TLS connect to 10 seconds and passes the owned abort signal", async () => {
    vi.useFakeTimers();
    const f = requestFixture(),
      owner = new AbortController();
    const pending = downloadCodexArchive(URL, owner.signal),
      rejected = expect(pending).rejects.toMatchObject({ code: "download_failed" });
    const socket = Object.assign(new EventEmitter(), { connecting: true });
    f.request.emit("socket", socket);
    expect(f.get.mock.calls[0]?.[1]).toMatchObject({ signal: owner.signal });
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.request.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(f.request.destroy).toHaveBeenCalledTimes(1);
  });
  it("retains the 30-second idle timer after TLS connects and clears the connect deadline", async () => {
    vi.useFakeTimers();
    const f = requestFixture();
    const pending = downloadCodexArchive(URL, new AbortController().signal),
      rejected = expect(pending).rejects.toMatchObject({ code: "download_failed" });
    const socket = Object.assign(new EventEmitter(), { connecting: true });
    f.request.emit("socket", socket);
    socket.emit("secureConnect");
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.request.destroy).not.toHaveBeenCalled();
    expect(f.request.setTimeout.mock.calls[0]?.[0]).toBe(30000);
    const expire = f.request.setTimeout.mock.calls[0]?.[1] as () => void;
    expire();
    await rejected;
  });
  it("the shared installer cancels a stalled transfer at its 300-second overall deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const top = mkdtempSync("/tmp/localdot-codex-deadline-");
    owned.push(top);
    mkdirSync(join(top, "user"), { mode: 0o700 });
    const roots = prepareOwnedCodexRoots(join(top, "app"), join(top, "user"));
    let entered!: () => void;
    const begun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const installer = new VerifiedCodexInstaller(
      roots,
      codexRelease("darwin", "arm64"),
      async (_url, signal) =>
        new Promise((_resolve, reject) => {
          entered();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const pending = installer.ensureInstalled(new AbortController().signal),
      rejected = expect(pending).rejects.toMatchObject({ code: "download_failed" });
    await begun;
    await vi.advanceTimersByTimeAsync(300000);
    await rejected;
    expect(installer.status()).toEqual({ state: "failed", code: "download_failed" });
    expect(readdirSync(roots.binRoot)).toEqual([]);
  });
});
