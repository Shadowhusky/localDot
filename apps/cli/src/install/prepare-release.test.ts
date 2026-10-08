import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  assemble: vi.fn(),
  native: vi.fn(),
  promote: vi.fn(),
  probe: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("./bootstrap-lock.ts", () => ({ withBootstrapInstallLock: mocks.lock }));
vi.mock("./assemble-release.ts", () => ({ assembleRelease: mocks.assemble }));
vi.mock("./prepare-native.ts", () => ({ prepareNativeDependencies: mocks.native }));
vi.mock("./promote-release.ts", () => ({ promotePreparedRelease: mocks.promote }));
vi.mock("./native-probe.ts", () => ({ probeNativeDependencies: mocks.probe }));
vi.mock("./assembly-scratch.ts", () => ({ recoverAssemblyScratch: mocks.recover }));

import { withPreparedRelease } from "./prepare-release.ts";

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});
function fixture(withLifetime = true) {
  let held = false;
  const lifetime = Object.freeze({
    directory: "/fixture/state",
    inheritDescriptor() {
      expect(held).toBe(true);
      return 77;
    },
  });
  const helper = Object.freeze({
    keydPath: "/fixture/bootstrap/keyd",
    ...(withLifetime ? { installLifetime: lifetime } : {}),
  });
  const calls: string[] = [],
    check = (name: string) => {
      expect(held).toBe(true);
      calls.push(name);
    };
  mocks.lock.mockImplementation(async (_state, _version, _signal, work) => {
    held = true;
    try {
      return await work(helper);
    } finally {
      held = false;
      calls.push("unlock");
    }
  });
  const dispose = vi.fn(async () => {
    check("dispose");
  });
  const candidate = { dispose },
    native = { receiptSha256: "a".repeat(64) };
  const promoted = {
    directory: "/fixture/release",
    identity: { version: "1.2.3", packageSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
    recovered: false,
  };
  mocks.recover.mockImplementation(async (state, _signal, scope) => {
    check("recover");
    expect(state).toBe("/fixture/state");
    expect(scope.inheritDescriptor()).toBe(77);
  });
  mocks.assemble.mockImplementation(async (_state, _version, _signal, scope) => {
    check("assemble");
    expect(scope).toBe(lifetime);
    return candidate;
  });
  mocks.probe.mockImplementation(async (_root, _version, _signal, scope) => {
    expect(scope).toBe(lifetime);
    expect(scope.inheritDescriptor()).toBe(77);
    return { sharp: "1.2.3", vips: "8.0.0" };
  });
  mocks.native.mockImplementation(async (input, signal, download, probe) => {
    check("native");
    expect(input).toBe(candidate);
    expect(download).toBeUndefined();
    await probe("/fixture/node_modules", "1.2.3", signal);
    return native;
  });
  mocks.promote.mockImplementation(async (_state, input, receipt) => {
    check("promote");
    expect(input).toBe(candidate);
    expect(receipt).toBe(native);
    return promoted;
  });
  const controller = new AbortController();
  const work = vi.fn(async (release, signal, lockedHelper) => {
    check("activate");
    expect(release).toEqual(promoted);
    expect(signal).toBe(controller.signal);
    expect(lockedHelper).toBe(helper);
    expect(dispose).toHaveBeenCalledOnce();
    return "done";
  });
  const run = () => withPreparedRelease("/fixture/state", "1.2.3", controller.signal, work);
  return { calls, candidate, dispose, work, run, controller };
}
it("keeps one lock through preparation, source cleanup and the activation callback", async () => {
  const f = fixture();
  expect(await f.run()).toBe("done");
  expect(f.calls).toEqual([
    "recover",
    "assemble",
    "native",
    "promote",
    "dispose",
    "activate",
    "unlock",
  ]);
});
it("does not spawn or activate when production preparation lacks its inherited lock scope", async () => {
  const f = fixture(false);
  await expect(f.run()).rejects.toThrow();
  expect(mocks.probe).not.toHaveBeenCalled();
  expect(mocks.promote).not.toHaveBeenCalled();
  expect(f.work).not.toHaveBeenCalled();
  expect(f.dispose).not.toHaveBeenCalled();
});
it.each(["recovery", "assembly", "native", "promotion", "cleanup", "cancellation"])(
  "never activates after %s failure",
  async (kind) => {
    const f = fixture();
    if (kind === "recovery") mocks.recover.mockRejectedValue(new Error("recovery failed"));
    if (kind === "assembly") mocks.assemble.mockRejectedValue(new Error("assembly failed"));
    if (kind === "native") mocks.native.mockRejectedValue(new Error("native failed"));
    if (kind === "promotion") mocks.promote.mockRejectedValue(new Error("promotion failed"));
    if (kind === "cleanup") f.dispose.mockRejectedValue(new Error("cleanup failed"));
    if (kind === "cancellation")
      mocks.native.mockImplementation(async () => {
        f.controller.abort(new Error("stop"));
        return {};
      });
    await expect(f.run()).rejects.toThrow();
    expect(f.work).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(["assembly", "recovery"].includes(kind) ? 0 : 1);
    expect(f.calls.at(-1)).toBe("unlock");
    if (kind === "cancellation") expect(mocks.promote).not.toHaveBeenCalled();
  },
);
it("retains both the preparation and cleanup failure without activating", async () => {
  const f = fixture(),
    first = new Error("native failed"),
    second = new Error("directory replaced");
  mocks.native.mockRejectedValue(first);
  f.dispose.mockRejectedValue(second);
  const error = await f.run().catch((e) => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([first, second]);
  expect(f.work).not.toHaveBeenCalled();
});
it("does not release the lock while an activation callback is still draining", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    drained = new Promise<void>((r) => {
      release = r;
    });
  f.work.mockImplementation(async () => {
    entered();
    await drained;
    return "done";
  });
  const run = f.run();
  await started;
  expect(f.calls).not.toContain("unlock");
  release();
  await run;
  expect(f.calls.at(-1)).toBe("unlock");
});
