import {
  type AcceptanceHost,
  accountStamped,
  type CodexInstallState,
  type InstalledCodex,
  type LocalAcceptance,
  NativeCheckError,
  nativeStamped,
  stampAccount,
  stampNative,
} from "@localdot/codex-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatgptStatus } from "./account.ts";
import { ChatgptSetup, SANDBOX_REASONS, SETUP_UNSAVED } from "./setup.ts";

const HOST: AcceptanceHost = { system: "25G83", runtime: "0.0.78" };
const INSTALLED = {
  version: "0.154.0",
  platform: "darwin-arm64",
  binDir: "/owned/bin/x",
  codexBin: "/owned/bin/x/codex",
  codeModeHostBin: "/owned/bin/x/codex-code-mode-host",
} as InstalledCodex;
const signedIn: ChatgptStatus = {
  available: true,
  codexVersion: "0.154.0",
  state: "signed_in",
  account: { email: "person@example.test", plan: "plus" },
  checkedAt: 1,
};
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(options: { record?: LocalAcceptance; host?: AcceptanceHost } = {}) {
  let install: CodexInstallState = { state: "not_installed" };
  let stored = options.record;
  const host = options.host ?? HOST;
  const check = vi.fn(async (_installed: InstalledCodex, _signal: AbortSignal) => ({
    host,
    reportSha256: "c".repeat(64),
  }));
  const write = vi.fn(async (record: LocalAcceptance) => {
    stored = structuredClone(record);
  });
  const verifiedInstallation = vi.fn(async () =>
    install.state === "ready" ? INSTALLED : undefined,
  );
  const setup = new ChatgptSetup({
    installer: { status: () => install, verifiedInstallation },
    host: () => host,
    check,
    read: () => (stored ? structuredClone(stored) : undefined),
    write,
    now: () => 42,
  });
  setups.push(setup);
  return {
    setup,
    check,
    write,
    verifiedInstallation,
    stored: () => stored,
    install() {
      install = { state: "ready", version: "0.154.0" };
    },
  };
}
const setups: ChatgptSetup[] = [];
afterEach(async () => {
  for (const setup of setups.splice(0)) await setup.close();
  vi.restoreAllMocks();
});

describe("ChatGPT plan setup", () => {
  it("goes from not installed to checking, then sign-in, then ready", async () => {
    const f = fixture();
    expect(f.setup.sandbox()).toBe("unchecked");
    expect(await f.setup.check()).toBe("unchecked");
    expect(f.check).not.toHaveBeenCalled();
    f.install();
    const checking = f.setup.check();
    expect(f.setup.sandbox()).toBe("checking");
    expect(f.setup.reason()).toBe(SANDBOX_REASONS.checking);
    expect(await checking).toBe("passed");
    expect(f.check).toHaveBeenCalledWith(INSTALLED, expect.any(AbortSignal));
    expect(nativeStamped(f.stored(), HOST)).toBe(true);
    expect(f.setup.reason()).toBeUndefined();
    expect(f.setup.ready()).toBe(false);
    const signedOut = { ...signedIn, state: "signed_out" as const, account: undefined };
    expect(await f.setup.confirm(signedOut)).toBe(signedOut);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(await f.setup.confirm(signedIn)).toBe(signedIn);
    expect(accountStamped(f.stored())).toBe(true);
    expect(f.setup.ready()).toBe(true);
    expect(await f.setup.confirm(signedIn)).toBe(signedIn);
    expect(f.write).toHaveBeenCalledTimes(2);
  });
  it("runs one check for concurrent callers and none once passed", async () => {
    const f = fixture();
    f.install();
    const held = gate<{ host: AcceptanceHost; reportSha256: string }>();
    f.check.mockReturnValueOnce(held.promise);
    const first = f.setup.check(),
      second = f.setup.check();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.check).toHaveBeenCalledTimes(1));
    held.resolve({ host: HOST, reportSha256: "c".repeat(64) });
    expect(await first).toBe("passed");
    expect(await f.setup.check()).toBe("passed");
    expect(f.check).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the check fails, then passes when checked again", async () => {
    const f = fixture();
    f.install();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    f.check.mockRejectedValueOnce(new NativeCheckError("task write"));
    expect(await f.setup.check()).toBe("failed");
    expect(error).toHaveBeenCalledWith("ChatGPT safety check failed at: task write");
    expect(f.setup.reason()).toBe(SANDBOX_REASONS.failed);
    expect(f.write).not.toHaveBeenCalled();
    expect(await f.setup.confirm(signedIn)).toMatchObject({
      available: false,
      state: "unavailable",
      reason: SETUP_UNSAVED,
    });
    expect(f.stored()).toBeUndefined();
    expect(f.setup.ready()).toBe(false);
    expect(await f.setup.check()).toBe("passed");
    expect(f.check).toHaveBeenCalledTimes(2);
  });
  it("fails when the check speaks for another macOS build or sandbox runtime", async () => {
    const f = fixture();
    f.install();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.check.mockResolvedValueOnce({
      host: { ...HOST, runtime: "0.0.79" },
      reportSha256: "c".repeat(64),
    });
    expect(await f.setup.check()).toBe("failed");
    expect(f.write).not.toHaveBeenCalled();
  });
  it("fails closed when the stamp can't be saved or read back", async () => {
    const f = fixture();
    f.install();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.write.mockRejectedValueOnce(new Error("disk full"));
    expect(await f.setup.check()).toBe("failed");
    f.write.mockImplementationOnce(async () => {});
    expect(await f.setup.check()).toBe("failed");
    expect(await f.setup.check()).toBe("passed");
    f.write.mockRejectedValueOnce(new Error("disk full"));
    expect(await f.setup.confirm(signedIn)).toMatchObject({ reason: SETUP_UNSAVED });
    expect(f.setup.ready()).toBe(false);
  });
  it.each([
    ["macOS update", { system: "25H12", runtime: HOST.runtime }],
    ["sandbox runtime update", { system: HOST.system, runtime: "0.0.79" }],
  ])("checks again after a %s and keeps the account stamp", async (_name, next) => {
    const record = stampAccount(stampNative(undefined, HOST, "c".repeat(64), 1), HOST, 2);
    const f = fixture({ record, host: next });
    expect(f.setup.sandbox()).toBe("unchecked");
    expect(f.setup.ready()).toBe(false);
    f.install();
    expect(await f.setup.check()).toBe("passed");
    expect(nativeStamped(f.stored(), next)).toBe(true);
    expect(accountStamped(f.stored())).toBe(true);
    expect(f.setup.ready()).toBe(true);
  });
  it("starts both stamps again for another Codex version", async () => {
    const old = stampAccount(stampNative(undefined, HOST, "c".repeat(64), 1), HOST, 2);
    const f = fixture({ record: { ...old, codexVersion: "0.153.0" } });
    expect(f.setup.sandbox()).toBe("unchecked");
    f.install();
    expect(await f.setup.check()).toBe("passed");
    expect(accountStamped(f.stored())).toBe(false);
    expect(f.setup.ready()).toBe(false);
    expect(await f.setup.confirm(signedIn)).toBe(signedIn);
    expect(f.setup.ready()).toBe(true);
  });
  it("opens straight away with a current record", () => {
    const record = stampAccount(stampNative(undefined, HOST, "c".repeat(64), 1), HOST, 2);
    const f = fixture({ record });
    expect(f.setup.sandbox()).toBe("passed");
    expect(f.setup.ready()).toBe(true);
  });
  it("stays unchecked when this Mac can't be identified", async () => {
    const f = fixture();
    const setup = new ChatgptSetup({
      installer: {
        status: () => ({ state: "ready", version: "0.154.0" }),
        verifiedInstallation: async () => INSTALLED,
      },
      host: () => {
        throw new NativeCheckError("host");
      },
      check: f.check,
      read: () => undefined,
      write: f.write,
    });
    setups.push(setup);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(setup.sandbox()).toBe("unchecked");
    expect(await setup.check()).toBe("failed");
    expect(f.write).not.toHaveBeenCalled();
  });
  it("leaves the check unfinished when the daemon closes", async () => {
    const f = fixture();
    f.install();
    f.check.mockImplementationOnce(
      (_installed, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    const checking = f.setup.check();
    await vi.waitFor(() => expect(f.check).toHaveBeenCalled());
    await f.setup.close();
    expect(await checking).toBe("unchecked");
    expect(f.write).not.toHaveBeenCalled();
    expect(await f.setup.check()).toBe("unchecked");
    expect(f.check).toHaveBeenCalledTimes(1);
  });
});
