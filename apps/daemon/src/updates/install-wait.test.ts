import { describe, expect, it, vi } from "vitest";
import { installRefusal } from "./install-wait.ts";

const HAND_BACK = "Hand back the computer first, then update localDot.";
const BUSY = "Wait for dot to finish, or stop the task, then update localDot.";

function deps(
  options: {
    session?: { status: string; controlHeld: boolean };
    holds?: boolean;
    operation?: string;
    idleOperation?: boolean;
    release?: () => Promise<void>;
  } = {},
) {
  let live: string | undefined = options.session || options.holds ? "session-1" : undefined;
  const release = vi.fn(
    options.release ??
      (async () => {
        live = undefined;
      }),
  );
  return {
    release,
    d: {
      cells: { list: () => [{ id: "cell-1", operation: options.operation }] },
      live: {
        get: () => live,
        idleOperationPending: () => options.idleOperation ?? false,
      },
      runner: {
        holds: () => options.holds ?? false,
        get: () => options.session,
        release,
      },
    },
  };
}

describe("app install admission", () => {
  it("admits when no computer has a task or an operation", async () => {
    expect(await installRefusal(deps().d)).toBeNull();
  });

  it("asks for the computer back while the user holds it, with or without a task", async () => {
    const own = deps({ holds: true });
    expect(await installRefusal(own.d)).toBe(HAND_BACK);
    const handoff = deps({ session: { status: "running", controlHeld: true } });
    expect(await installRefusal(handoff.d)).toBe(HAND_BACK);
    expect(own.release).not.toHaveBeenCalled();
    expect(handoff.release).not.toHaveBeenCalled();
  });

  it("never interrupts a task at work", async () => {
    const f = deps({ session: { status: "running", controlHeld: false } });
    expect(await installRefusal(f.d)).toBe(BUSY);
    expect(f.release).not.toHaveBeenCalled();
  });

  it("ends a finished task's wait for a follow-up instead of refusing for half an hour", async () => {
    const f = deps({ session: { status: "idle", controlHeld: false } });
    expect(await installRefusal(f.d)).toBeNull();
    expect(f.release).toHaveBeenCalledWith(undefined, "session-1");
  });

  it("refuses when the finished task can't be released", async () => {
    const f = deps({
      session: { status: "idle", controlHeld: false },
      release: async () => {
        throw new Error("A task is starting.");
      },
    });
    expect(await installRefusal(f.d)).toBe(BUSY);
  });

  it("says the computer is busy while it starts, stops or updates", async () => {
    expect(await installRefusal(deps({ operation: "starting" }).d)).toBe(
      "Your computer is starting, stopping or updating. Try again in a minute.",
    );
    expect(await installRefusal(deps({ idleOperation: true }).d)).toBe(
      "Your computer is starting, stopping or updating. Try again in a minute.",
    );
  });
});
