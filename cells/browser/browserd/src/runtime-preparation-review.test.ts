import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PREPARATION_DRAIN_MS } from "./prepare.ts";
import { BrowserRuntime } from "./runtime.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), mkdir: vi.fn(), open: vi.fn() }));
vi.mock("./profile-preferences.ts", () => ({ prepareProfilePreferences: vi.fn() }));

const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});
const runtimes: BrowserRuntime[] = [];

function preparationFixture(ignoreKill: boolean) {
  vi.useFakeTimers();
  vi.spyOn(process, "getuid").mockReturnValue(1000);
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(lstat).mockImplementation(async (path) => {
    const certificate = String(path) === "/etc/localdot/cell/ca.pem";
    return {
      uid: certificate ? 0 : 1000,
      mode: certificate ? 0o444 : 0o700,
      size: 512,
      nlink: 1,
      isDirectory: () => !certificate,
      isFile: () => certificate,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof lstat>>;
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 73400,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  const launched = Promise.withResolvers<void>();
  let alive = false;
  vi.mocked(spawn).mockImplementation(() => {
    alive = true;
    launched.resolve();
    return child as unknown as ReturnType<typeof spawn>;
  });
  const kill = vi.spyOn(process, "kill").mockImplementation((processId, signal) => {
    expect(processId).toBe(-child.pid);
    if (!alive) throw Object.assign(new Error("absent"), { code: "ESRCH" });
    if (signal !== 0 && !ignoreKill) {
      alive = false;
      Promise.resolve().then(() => child.emit("close", null));
    }
    return true;
  });
  const driver = vi.fn(() => {
    throw new Error("no runtime process should start before preparation");
  });
  const runtime = new BrowserRuntime(config, { driver });
  runtimes.push(runtime);
  return { runtime, driver, child, kill, launched, alive: () => alive };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => {})));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("runtime ownership of actual preparation utilities", () => {
  it("does not acknowledge physical Stop when the preparation utility is still alive after its drain deadline", async () => {
    const fixture = preparationFixture(true);
    const startup = fixture.runtime.start().then(
      () => "ready",
      () => "refused",
    );
    await fixture.launched.promise;
    const stopped = fixture.runtime.stop().then(
      () => "confirmed",
      () => "uncertain",
    );
    const retired = fixture.runtime.retired.then(
      () => "confirmed",
      () => "uncertain",
    );
    await vi.advanceTimersByTimeAsync(BROWSER_PREPARATION_DRAIN_MS + 1);
    expect(await startup).toBe("refused");
    expect(fixture.alive()).toBe(true);
    expect(fixture.kill).toHaveBeenCalledWith(-73400, "SIGKILL");
    expect(fixture.driver).not.toHaveBeenCalled();
    expect(await stopped, "Stop must retain uncertain preparation ownership").toBe("uncertain");
    expect(await retired).toBe("uncertain");
  });

  it("retains uncertain preparation ownership when a utility error precedes runtime shutdown", async () => {
    const fixture = preparationFixture(true);
    const startup = fixture.runtime.start().then(
      () => "ready",
      () => "refused",
    );
    await fixture.launched.promise;
    fixture.child.emit("error", new Error("private fixture utility failure"));
    await vi.advanceTimersByTimeAsync(BROWSER_PREPARATION_DRAIN_MS + 1);
    expect(await startup).toBe("refused");
    expect(fixture.alive()).toBe(true);
    expect(fixture.driver).not.toHaveBeenCalled();
    expect(
      await fixture.runtime.retired.then(
        () => "confirmed",
        () => "uncertain",
      ),
      "Retirement must not forget an already-rejected preparation owner",
    ).toBe("uncertain");
  });

  it("can confirm Stop after the preparation utility actually closes and its process group disappears", async () => {
    const fixture = preparationFixture(false);
    const startup = fixture.runtime.start().then(
      () => "ready",
      () => "refused",
    );
    await fixture.launched.promise;
    const stop = fixture.runtime.stop();
    await vi.advanceTimersByTimeAsync(1);
    await stop;
    await fixture.runtime.retired;
    expect(await startup).toBe("refused");
    expect(fixture.alive()).toBe(false);
    expect(fixture.driver).not.toHaveBeenCalled();
  });

  it("Stop before admission performs no preparation utility or runtime allocation", async () => {
    const fixture = preparationFixture(true);
    await fixture.runtime.stop();
    await expect(fixture.runtime.start()).rejects.toThrow();
    await fixture.runtime.retired;
    expect(spawn).not.toHaveBeenCalled();
    expect(fixture.driver).not.toHaveBeenCalled();
    expect(fixture.alive()).toBe(false);
  });
});
