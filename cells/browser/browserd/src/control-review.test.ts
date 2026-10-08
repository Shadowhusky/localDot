import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CONTROL_TIMEOUT_MS,
  type BrowserActionPermit,
  BrowserControlReply,
  type BrowserControlRequest,
} from "../../../../packages/protocol/src/browser-control.ts";
import { BrowserControl, type BrowserControlDeps } from "./control.ts";

const browserCellId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const parentCellId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";
const sessionId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0K";
const instance = "87ae386e-79f1-4f3e-b604-869812515446";
const owner = { sessionId, generation: 7 };
function command(revision = 1, holder: "user" | "agent" = "agent"): BrowserControlRequest {
  const identity = { browserCellId, parentCellId, instance, revision, requestId: sessionId };
  return holder === "user" ? { ...identity, holder } : { ...identity, holder, owner: { ...owner } };
}
function permit(revision = 1): BrowserActionPermit {
  return {
    browserCellId,
    parentCellId,
    instance,
    revision,
    requestId: sessionId,
    owner: { ...owner },
  };
}
function setup(overrides: Partial<BrowserControlDeps> = {}) {
  const clear = vi.fn(async () => {});
  const scan = vi.fn(async (): Promise<readonly string[]> => []);
  const reload = vi.fn(async (_page: string) => {});
  const deps: BrowserControlDeps = {
    browserCellId,
    parentCellId,
    instance,
    clearSelections: clear,
    secretPages: scan,
    reload,
    ...overrides,
  };
  return { control: new BrowserControl(deps), deps, clear, scan, reload };
}
async function tick() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function effect(control: BrowserControl, p = permit()) {
  const lease = control.admit(p);
  try {
    lease.check();
    return 1;
  } finally {
    lease.finish();
  }
}
afterEach(() => vi.useRealTimers());

describe("independent browser authority boundaries", () => {
  it("takeover fences effects immediately and receipt waits for every admitted action", async () => {
    const { control } = setup();
    await control.set(command());
    let effects = effect(control);
    const first = control.admit(permit()),
      second = control.admit(permit());
    let settled = false;
    const taking = control.set(command(2, "user")).then(() => {
      settled = true;
    });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(() => {
      first.check();
      effects++;
    }).toThrow();
    expect(() => {
      effects += effect(control);
    }).toThrow();
    first.finish();
    await tick();
    expect(settled).toBe(false);
    expect(effects).toBe(1);
    second.finish();
    await taking;
    await control.set(command(3));
    effects += effect(control, permit(3));
    expect(effects).toBe(2);
    await control.close();
  });

  it("timed-out action drain retains refusal outcome and requires a fresh revision", async () => {
    vi.useFakeTimers();
    const { control, clear } = setup();
    await control.set(command());
    const action = control.admit(permit());
    const pending = control.set(command(2));
    const rejected = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS);
    await rejected;
    expect(clear).toHaveBeenCalledTimes(1);
    expect(() => effect(control, permit(2))).toThrow();
    action.finish();
    await tick();
    expect(control.set(command(2))).toBe(pending);
    await expect(pending).rejects.toThrow("timeout");
    expect(control.holder).toBe("user");
    await control.set(command(3));
    expect(effect(control, permit(3))).toBe(1);
    expect(clear).toHaveBeenCalledTimes(2);
    await control.close();
  });

  it("a timeout cannot acknowledge takeover or run cleanup past an undrained reload", async () => {
    vi.useFakeTimers();
    const blocked = Promise.withResolvers<void>();
    const clear = vi.fn(async () => {});
    let reloads = 0,
      scans = 0;
    const { control } = setup({
      clearSelections: clear,
      secretPages: async () => (++scans === 1 ? ["one"] : []),
      reload: async () => {
        reloads++;
        await blocked.promise;
      },
    });
    const granting = control.set(command());
    const failed = expect(granting).rejects.toThrow("timeout");
    await tick();
    expect(reloads).toBe(1);
    await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS);
    await failed;
    let acknowledged = false;
    const take = control.set(command(2, "user")).then(() => {
      acknowledged = true;
    });
    await tick();
    expect(acknowledged).toBe(false);
    expect(() => effect(control)).toThrow();
    blocked.resolve();
    await take;
    expect(clear).toHaveBeenCalledTimes(1);
    expect(control.holder).toBe("user");
    await control.set(command(3));
    expect(effect(control, permit(3))).toBe(1);
    await control.close();
  });

  it("a reentrant close wins over handback and shares one terminal drain", async () => {
    const { control, clear } = setup();
    await control.set(command());
    const action = control.admit(permit());
    let close: Promise<void> | undefined;
    action.signal.addEventListener(
      "abort",
      () => {
        close = control.close();
        action.finish();
      },
      { once: true },
    );
    const handback = control.set(command(2));
    await expect(handback).rejects.toThrow("locked");
    expect(close).toBeDefined();
    expect(control.close()).toBe(close);
    await close;
    expect(clear).toHaveBeenCalledTimes(1);
    expect(control.holder).toBe("user");
    expect(() => effect(control, permit(2))).toThrow();
    expect(() => control.set(command(3))).toThrow("locked");
  });

  it("reentrant takeover from the last scan cannot publish the older grant", async () => {
    let control!: BrowserControl;
    let scans = 0,
      taking: Promise<unknown> | undefined;
    ({ control } = setup({
      secretPages: async () => {
        if (++scans === 2) taking = control.set(command(2, "user"));
        return [];
      },
    }));
    await expect(control.set(command())).rejects.toThrow("stale");
    await taking;
    expect(control.holder).toBe("user");
    expect(() => effect(control)).toThrow();
    await control.set(command(3));
    expect(effect(control, permit(3))).toBe(1);
    await control.close();
  });

  it("disconnect before work consumes the command without invoking cleanup", async () => {
    const { control, clear } = setup();
    const signal = new AbortController();
    signal.abort(new Error("private-token"));
    const first = control.set(command(), signal.signal);
    await expect(first).rejects.toThrow("Browser control refused: locked");
    expect(control.set(command())).toBe(first);
    expect(clear).not.toHaveBeenCalled();
    await control.set(command(2));
    expect(effect(control, permit(2))).toBe(1);
    await control.close();
  });

  it("disconnect during the final secret scan fences and cannot be replayed to success", async () => {
    const last = Promise.withResolvers<readonly string[]>();
    let scans = 0;
    const signal = new AbortController();
    const { control } = setup({ secretPages: async () => (++scans === 2 ? last.promise : []) });
    const first = control.set(command(), signal.signal);
    const failed = expect(first).rejects.toThrow("locked");
    await tick();
    signal.abort();
    await failed;
    last.resolve([]);
    await tick();
    expect(() => effect(control)).toThrow();
    expect(control.set(command())).toBe(first);
    await control.set(command(2));
    expect(effect(control, permit(2))).toBe(1);
    await control.close();
  });

  it("post-receipt caller disconnect does not silently revoke an acknowledged grant", async () => {
    const { control } = setup();
    const caller = new AbortController();
    await control.set(command(), caller.signal);
    caller.abort();
    expect(effect(control)).toBe(1);
    await control.set(command(2, "user"));
    expect(() => effect(control)).toThrow();
    await control.close();
  });

  it("snapshots constructor identities and dependency functions", async () => {
    const { control, deps, clear } = setup();
    deps.instance = "d5f2a41b-f1fa-4d8f-98f9-ac8a4a6eaa69";
    deps.clearSelections = async () => {
      throw new Error("replacement-function");
    };
    const reply = await control.set(command());
    expect(BrowserControlReply.parse(reply)).toEqual(reply);
    expect(reply.instance).toBe(instance);
    expect(Object.isFrozen(reply)).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(effect(control)).toBe(1);
    await control.close();
  });

  it("an old-process command cannot initialize a replacement instance", async () => {
    const next = "d5f2a41b-f1fa-4d8f-98f9-ac8a4a6eaa69";
    const { control, clear } = setup({ instance: next });
    expect(() => control.set(command(300))).toThrow("identity");
    expect(clear).not.toHaveBeenCalled();
    await control.set({ ...command(), instance: next });
    expect(() => effect(control)).toThrow("identity");
    expect(effect(control, { ...permit(), instance: next })).toBe(1);
    await control.close();
  });

  it("binds every effect to exact session generation and request", async () => {
    const { control } = setup();
    await control.set(command());
    let effects = 0,
      refusals = 0;
    for (const changes of [
      { owner: { sessionId: parentCellId, generation: 7 } },
      { owner: { sessionId, generation: 8 } },
      { requestId: parentCellId },
    ]) {
      try {
        effects += effect(control, { ...permit(), ...changes });
      } catch {
        refusals++;
      }
    }
    expect(effects).toBe(0);
    expect(refusals).toBe(3);
    effects += effect(control);
    expect(effects).toBe(1);
    await control.close();
  });

  it.each([256, 257])(
    "enforces the secret-page bound at %i before reload effects",
    async (count) => {
      const pages = new Set(Array.from({ length: count }, (_, i) => `page-${i}`));
      let effects = 0;
      const { control } = setup({
        secretPages: async () => [...pages],
        reload: async (page) => {
          effects++;
          pages.delete(page);
        },
      });
      if (count === 257) {
        await expect(control.set(command())).rejects.toThrow("cleanup");
        expect(effects).toBe(0);
        expect(() => effect(control)).toThrow();
      } else {
        expect((await control.set(command())).reloaded).toBe(256);
        expect(effects).toBe(256);
        expect(effect(control)).toBe(1);
      }
      await control.close();
    },
  );

  it("sanitizes cleanup failure and retains the failed duplicate until explicit retry", async () => {
    let calls = 0;
    const { control } = setup({
      clearSelections: async () => {
        if (++calls === 1) throw new Error("password-canary-never-real");
      },
    });
    const first = control.set(command());
    const error = await first.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Browser control refused: cleanup");
    expect(JSON.stringify(error)).not.toContain("password-canary");
    expect(control.set({ ...command() })).toBe(first);
    expect(calls).toBe(1);
    expect(() => effect(control)).toThrow();
    await control.set(command(2));
    expect(effect(control, permit(2))).toBe(1);
    expect(calls).toBe(2);
    await control.close();
  });

  it("close timeout remains sticky after the last dependency eventually settles", async () => {
    vi.useFakeTimers();
    const stalled = Promise.withResolvers<void>();
    const { control } = setup({ clearSelections: async () => stalled.promise });
    const grant = control.set(command());
    const refused = expect(grant).rejects.toThrow("locked");
    await tick();
    const closing = control.close();
    const uncertain = expect(closing).rejects.toThrow("timeout");
    await refused;
    await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS);
    await uncertain;
    stalled.resolve();
    await tick();
    expect(control.close()).toBe(closing);
    await expect(control.close()).rejects.toThrow("timeout");
    expect(() => control.set(command(2))).toThrow("locked");
  });
});
