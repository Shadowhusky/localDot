import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CONTROL_TIMEOUT_MS,
  type BrowserActionPermit,
  type BrowserControlRequest,
} from "../../../../packages/protocol/src/browser-control.ts";
import { BrowserControl, type BrowserControlDeps } from "./control.ts";

const browserCellId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const parentCellId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";
const sessionId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0K";
const instance = "87ae386e-79f1-4f3e-b604-869812515446";

function request(revision = 1, holder: "user" | "agent" = "agent"): BrowserControlRequest {
  const identity = { browserCellId, parentCellId, instance, revision, requestId: sessionId };
  return holder === "agent"
    ? { ...identity, holder, owner: { sessionId, generation: 1 } }
    : { ...identity, holder };
}

function permit(revision = 1): BrowserActionPermit {
  return {
    browserCellId,
    parentCellId,
    instance,
    revision,
    requestId: sessionId,
    owner: { sessionId, generation: 1 },
  };
}

function setup(overrides: Partial<BrowserControlDeps> = {}) {
  const clearSelections = vi.fn(async () => {});
  const secretPages = vi.fn(async (): Promise<readonly string[]> => []);
  const reload = vi.fn(async () => {});
  const control = new BrowserControl({
    browserCellId,
    parentCellId,
    instance,
    clearSelections,
    secretPages,
    reload,
    ...overrides,
  });
  return { control, clearSelections, secretPages, reload };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("browser control authority", () => {
  it("admits manual input only after a completed user grant and keeps agent permits separate", async () => {
    const { control } = setup();
    const { owner: _, ...manual } = permit();
    expect(() => control.admitManual(manual)).toThrow();
    await control.set(request());
    expect(() => control.admitManual(manual)).toThrow();
    await control.set(request(2, "user"));
    expect(() => control.admitManual({ ...permit(2) })).toThrow();
    expect(() =>
      control.admitManual({ ...manual, revision: 2, parentCellId: sessionId }),
    ).toThrow();
    expect(() => control.admitManual(manual)).toThrow();
    const action = control.admitManual({ ...manual, revision: 2 });
    action.check();
    expect(() => control.admit(permit(2))).toThrow();
    action.finish();
    expect(() => action.check()).toThrow();
  });

  it("drains agent input before manual admission, and manual input before secret cleanup", async () => {
    const f = setup();
    const { owner: _, ...manual } = permit(2);
    await f.control.set(request());
    const agent = f.control.admit(permit());
    const taking = f.control.set(request(2, "user"));
    await flush();
    expect(agent.signal.aborted).toBe(true);
    expect(() => f.control.admitManual(manual)).toThrow();
    agent.finish();
    await taking;
    const user = f.control.admitManual(manual);
    f.clearSelections.mockClear();
    const returning = f.control.set(request(3));
    await flush();
    expect(user.signal.aborted).toBe(true);
    expect(f.clearSelections).not.toHaveBeenCalled();
    expect(() => f.control.admitManual(manual)).toThrow();
    expect(() => f.control.admit(permit(3))).toThrow();
    user.finish();
    await returning;
    expect(f.clearSelections).toHaveBeenCalledTimes(1);
    const replacement = f.control.admit(permit(3));
    replacement.finish();
  });

  it("closes only after active manual input drains", async () => {
    const { control } = setup();
    await control.set(request(1, "user"));
    const { owner: _, ...manual } = permit();
    const action = control.admitManual(manual);
    let closed = false;
    const closing = control.close().then(() => {
      closed = true;
    });
    await flush();
    expect(action.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    action.finish();
    await closing;
    expect(() => control.admitManual(manual)).toThrow();
  });
  it("starts closed to every observation and input permit", () => {
    const { control } = setup();
    expect(control.holder).toBe("user");
    expect(() => control.admit(permit())).toThrow("locked");
  });

  it("clears selections and rechecks password fields before granting", async () => {
    const events: string[] = [];
    let secret = true;
    const { control } = setup({
      clearSelections: async () => {
        events.push("clear");
      },
      secretPages: async () => {
        events.push("scan");
        return secret ? ["page"] : [];
      },
      reload: async (page) => {
        events.push(`reload:${page}`);
        secret = false;
      },
    });
    expect(await control.set(request())).toMatchObject({
      holder: "agent",
      reloaded: 1,
      selectionsCleared: true,
    });
    expect(events).toEqual(["clear", "scan", "reload:page", "scan"]);
    const action = control.admit(permit());
    action.check();
    action.finish();
    expect(() => action.check()).toThrow("locked");
  });

  it.each(["browserCellId", "parentCellId", "instance"] as const)(
    "rejects commands and permits for another %s",
    async (field) => {
      const { control } = setup();
      const replacement = field === "instance" ? "d5f2a41b-f1fa-4d8f-98f9-ac8a4a6eaa69" : sessionId;
      expect(() => control.set({ ...request(), [field]: replacement })).toThrow("identity");
      await control.set(request());
      expect(() => control.admit({ ...permit(), [field]: replacement })).toThrow("identity");
    },
  );

  it("cannot grant a permit to another session or brain generation", async () => {
    const { control } = setup();
    await control.set(request());
    expect(() =>
      control.admit({ ...permit(), owner: { sessionId: parentCellId, generation: 1 } }),
    ).toThrow("locked");
    expect(() => control.admit({ ...permit(), owner: { sessionId, generation: 2 } })).toThrow(
      "locked",
    );
  });

  it("rejects stale revisions and conflicting duplicate identities", async () => {
    const { control, clearSelections } = setup();
    const first = control.set(request(2));
    expect(control.set(request(2))).toBe(first);
    await first;
    expect(control.set(request(2))).toBe(first);
    expect(() => control.set(request(1))).toThrow("stale");
    expect(() => control.set(request(2, "user"))).toThrow("stale");
    expect(() => control.set({ ...request(2), requestId: parentCellId })).toThrow("stale");
    expect(() => control.admit(permit(1))).toThrow("locked");
    expect(clearSelections).toHaveBeenCalledTimes(1);
  });

  it("copies caller data before waiting and returns an immutable receipt", async () => {
    const { control } = setup();
    const input = request();
    const pending = control.set(input);
    input.revision = 9;
    if (input.holder === "agent") input.owner.generation = 8;
    const receipt = await pending;
    expect(receipt.revision).toBe(1);
    expect(Object.isFrozen(receipt)).toBe(true);
    const action = control.admit(permit());
    action.finish();
  });

  it("fences synchronously on takeover and waits for admitted work to drain", async () => {
    const { control } = setup();
    await control.set(request());
    const action = control.admit(permit());
    let acknowledged = false;
    const taking = control.set(request(2, "user")).then(() => {
      acknowledged = true;
    });
    expect(action.signal.aborted).toBe(true);
    expect(() => action.check()).toThrow();
    expect(() => control.admit(permit())).toThrow("locked");
    await flush();
    expect(acknowledged).toBe(false);
    action.finish();
    await taking;
    expect(control.holder).toBe("user");
  });

  it("a newer takeover defeats an older handback even when cleanup ignores abort", async () => {
    const cleaning = Promise.withResolvers<void>();
    const { control, reload } = setup({ clearSelections: () => cleaning.promise });
    const older = control.set(request());
    const rejected = expect(older).rejects.toThrow("stale");
    await flush();
    const newer = control.set(request(2, "user"));
    expect(control.holder).toBe("user");
    await rejected;
    cleaning.resolve();
    await newer;
    expect(control.holder).toBe("user");
    expect(reload).not.toHaveBeenCalled();
    expect(() => control.admit(permit())).toThrow("locked");
  });

  it("reentrant cancellation cannot replace a newer control revision", async () => {
    const { control } = setup();
    await control.set(request());
    const action = control.admit(permit());
    let newest: Promise<unknown> | undefined;
    action.signal.addEventListener(
      "abort",
      () => {
        newest = control.set(request(3, "user"));
        action.finish();
      },
      { once: true },
    );
    const superseded = control.set(request(2));
    await expect(superseded).rejects.toThrow("stale");
    await newest;
    expect(control.holder).toBe("user");
    expect(() => control.set(request(2))).toThrow("stale");
    expect(() => control.admit(permit(2))).toThrow("locked");
  });

  it.each(["clear", "scan", "reload", "remaining"])(
    "cleanup failure at %s keeps observations and input closed",
    async (phase) => {
      const { control } = setup({
        clearSelections: async () => {
          if (phase === "clear") throw new Error("private details");
        },
        secretPages: async () => {
          if (phase === "scan") throw new Error("private details");
          return ["secret"];
        },
        reload: async () => {
          if (phase === "reload") throw new Error("private details");
        },
      });
      await expect(control.set(request())).rejects.toThrow("cleanup");
      expect(control.holder).toBe("user");
      expect(() => control.admit(permit())).toThrow("locked");
    },
  );

  it("times out without letting a later grant overlap undrained cleanup", async () => {
    vi.useFakeTimers();
    const stalled = Promise.withResolvers<void>();
    const clearSelections = vi
      .fn()
      .mockImplementationOnce(() => stalled.promise)
      .mockResolvedValue(undefined);
    const { control } = setup({ clearSelections });
    const first = control.set(request());
    const firstFailure = expect(first).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS);
    await firstFailure;
    const second = control.set(request(2));
    const secondFailure = expect(second).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS);
    await secondFailure;
    expect(clearSelections).toHaveBeenCalledTimes(1);
    stalled.resolve();
    await flush();
    expect(control.holder).toBe("user");
    await control.set(request(3));
    const action = control.admit(permit(3));
    action.finish();
  });

  it("a request disconnect during cleanup consumes its revision without granting", async () => {
    const cleaning = Promise.withResolvers<void>();
    const aborted = new AbortController();
    const { control } = setup({ clearSelections: () => cleaning.promise });
    const pending = control.set(request(), aborted.signal);
    const failure = expect(pending).rejects.toThrow("locked");
    await flush();
    aborted.abort();
    await failure;
    cleaning.resolve();
    await flush();
    expect(control.holder).toBe("user");
    expect(control.set(request())).toBe(pending);
    expect(() => control.admit(permit())).toThrow("locked");
  });

  it("terminal close fences immediately, drains calls, and cannot be reopened", async () => {
    const { control } = setup();
    await control.set(request());
    const action = control.admit(permit());
    const closing = control.close();
    expect(control.close()).toBe(closing);
    expect(action.signal.aborted).toBe(true);
    expect(() => control.set(request(2))).toThrow("locked");
    action.finish();
    await closing;
    expect(() => control.admit(permit())).toThrow("locked");
  });

  it("terminal close reports uncertainty when an admitted action never settles", async () => {
    vi.useFakeTimers();
    const { control } = setup();
    await control.set(request());
    const action = control.admit(permit());
    const closing = control.close();
    const failure = expect(closing).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS);
    await failure;
    expect(() => control.set(request(2))).toThrow("locked");
    action.finish();
    await flush();
    expect(control.close()).toBe(closing);
  });
});
