import { TypeRequest, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ManualDesktop, ManualInputUncertain, sendManualInput } from "./manual-input.ts";
import { AgentError } from "./runner.ts";
import { AgentSession, ControlHeldError } from "./session.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.stop();
    await session.toolsSettled();
  }
});
async function setup() {
  const events: unknown[] = [];
  const session = new AgentSession(ulid(), ulid(), "synthetic task", {
    append: (_id, event) => {
      events.push(event);
      return undefined as never;
    },
  });
  sessions.push(session);
  const generation = session.beginBrain();
  const outcome = session
    .takeover("login", "Please enter your login")
    .catch(() => ({ by: "stop" as const }));
  await Promise.resolve();
  await Promise.resolve();
  const requestId = session.pendingTakeover;
  if (!requestId || session.manualControl !== "ready") throw new Error("fixture control missing");
  const input = vi.fn(async () => ({
    pressMono: 1,
    presses: [1],
    injector: "xtest" as const,
    armedMono: 0,
  }));
  const type = vi.fn<ManualDesktop["client"]["type"]>(async (_request, _progress, _signal) => ({
    done: true,
    count: 1,
    firstPressMono: 1,
    injector: "xtest",
    armedMono: 0,
  }));
  const access: ManualDesktop = {
    screen: { w: 2560, h: 1600 },
    client: { input, type },
    prepare: async () => {},
    check: () => {},
    release: vi.fn(),
  };
  const send = (
    input: Parameters<typeof sendManualInput>[1]["input"],
    owner = new AbortController(),
  ) => sendManualInput(session, { requestId, input }, owner.signal, () => access);
  return { session, generation, events, requestId, outcome, input, type, access, send };
}
const click = { kind: "click", at: { x: 20, y: 30 }, button: "left", count: 1 } as const;

describe("daemon-owned manual input", () => {
  it("keeps caller retirement user-owned and routes Unicode/password text only as masked typing", async () => {
    const f = await setup();
    f.session.retireBrain(f.generation);
    const text = "synthetic-password-42 中文🙂";
    f.type.mockImplementation(async (request, progress) => {
      TypeRequest.parse(request);
      expect(request.masked).toBe(true);
      await progress({ count: 1, pressMono: 1, chunk: text });
      return {
        done: true,
        count: [...text].length,
        firstPressMono: 1,
        injector: "xtest",
        armedMono: 0,
      };
    });
    await f.send({ kind: "text", text });
    expect(f.type).toHaveBeenCalledOnce();
    expect(f.type.mock.calls[0]?.[0]).toMatchObject({ text, masked: true });
    expect(f.input).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events)).not.toContain(text);
    expect(f.session.inboxSequence).toBe(0);
    expect(f.session.controlHeld).toBe(true);
    expect(f.session.manualControl).toBe("ready");
    expect(() => f.session.beginBrain()).toThrow(ControlHeldError);
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
  });
  it("fences duplicate, old and unrelated IDs without desktop calls", async () => {
    const f = await setup(),
      before = deferred();
    f.access.prepare = () => before.promise;
    const active = f.send(click).then(
      () => true,
      () => false,
    );
    await expect(f.send(click)).rejects.toBeInstanceOf(ControlHeldError);
    await expect(
      sendManualInput(
        f.session,
        { requestId: ulid(), input: click },
        new AbortController().signal,
        () => f.access,
      ),
    ).rejects.toBeInstanceOf(ControlHeldError);
    expect(f.input).not.toHaveBeenCalled();
    before.resolve();
    expect(await active).toBe(true);
    expect(f.input).toHaveBeenCalledOnce();
  });
  it("rejects an unrelated takeover ID before any desktop call when no other input is active", async () => {
    const f = await setup();
    const error = await sendManualInput(
      f.session,
      { requestId: ulid(), input: click },
      new AbortController().signal,
      () => f.access,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(f.input).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ControlHeldError);
    expect(f.session.controlHeld).toBe(true);
  });
  it("closes admission before hand-back awaits preflight and delivers no late input", async () => {
    const f = await setup(),
      before = deferred();
    f.access.prepare = () => before.promise;
    const active = f.send(click).then(
      () => undefined,
      (error: unknown) => error,
    );
    const handback = f.session.handback(f.requestId, "Ready");
    expect(f.session.manualControl).toBe("returning");
    expect(() => f.session.admitManual(f.requestId, new AbortController().signal)).toThrow(
      ControlHeldError,
    );
    expect(f.session.endTakeover(f.requestId, "bypass")).toBe(false);
    before.resolve();
    const error = await active;
    expect(f.input).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ControlHeldError);
    expect(await handback).toBe(true);
    expect(await f.outcome).toEqual({ by: "user", note: "Ready" });
    expect(f.session.beginBrain()).toBeDefined();
  });
  it("retains a Stop drain owner through delayed preflight and delivers no late input", async () => {
    const f = await setup(),
      before = deferred();
    f.access.prepare = () => before.promise;
    const active = f.send(click).then(
      () => undefined,
      (error: unknown) => error,
    );
    f.session.stop();
    let settled = false;
    const drain = f.session.toolsSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    before.resolve();
    const error = await active;
    expect(f.input).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ControlHeldError);
    await drain;
    expect(f.session.stopped).toBe(true);
  });
  it("lets admitted typing land before hand-back, and keeps the fence when nothing can confirm it", async () => {
    const f = await setup(),
      done = deferred(),
      entered = deferred();
    let signal: AbortSignal | undefined;
    f.type.mockImplementation(async (_request, _progress, owner) => {
      signal = owner;
      entered.resolve();
      await done.promise;
      return { done: true, count: 1, firstPressMono: 1, injector: "xtest", armedMono: 0 };
    });
    const active = f.send({ kind: "text", text: "fixture private text" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const handback = f.session.handback(f.requestId, undefined);
    expect(signal?.aborted).toBe(false);
    done.resolve();
    expect(await active).toBeInstanceOf(ManualInputUncertain);
    expect(await handback).toBe(false);
    expect(f.session.controlHeld).toBe(true);
    expect(f.session.manualControl).toBe("unconfirmed");
    expect(() => f.session.beginBrain()).toThrow(ControlHeldError);
    await expect(f.send(click)).rejects.toBeInstanceOf(ControlHeldError);
    expect(f.session.endTakeover(f.requestId, "bypass")).toBe(false);
  });
  it("lifts the fence once the computer confirms what landed, then hands back", async () => {
    const f = await setup(),
      answer = deferred();
    f.access.confirm = vi.fn(async () => answer.promise);
    f.type.mockResolvedValueOnce({
      done: true,
      count: 1,
      firstPressMono: 1,
      injector: "xtest",
      armedMono: 0,
    });
    await expect(f.send({ kind: "text", text: "partly typed" })).rejects.toBeInstanceOf(
      ManualInputUncertain,
    );
    expect(f.session.manualControl).toBe("unconfirmed");
    expect(f.access.confirm).toHaveBeenCalledOnce();
    answer.resolve();
    await vi.waitFor(() => expect(f.session.manualControl).toBe("ready"));
    await f.send(click);
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
    expect(await f.outcome).toEqual({ by: "user" });
    expect(f.access.confirm).toHaveBeenCalledOnce();
  });
  it("never lifts a later input's fence with an earlier screen's confirmation", async () => {
    const f = await setup();
    const confirm = vi.fn(async () => {});
    f.access.confirm = confirm;
    f.input.mockRejectedValueOnce(new Error("synthetic press not seen"));
    await expect(f.send(click)).rejects.toBeInstanceOf(ManualInputUncertain);
    await vi.waitFor(() => expect(f.session.manualControl).toBe("ready"));
    // The next input goes to a screen that cannot confirm what landed.
    const unconfirmable: ManualDesktop = { ...f.access, confirm: undefined };
    f.input.mockRejectedValueOnce(new Error("synthetic press not seen"));
    await expect(
      sendManualInput(
        f.session,
        { requestId: f.requestId, input: click },
        new AbortController().signal,
        () => unconfirmable,
      ),
    ).rejects.toBeInstanceOf(ManualInputUncertain);
    expect(await f.session.handback(f.requestId, undefined)).toBe(false);
    expect(f.session.manualControl).toBe("unconfirmed");
    expect(confirm).toHaveBeenCalledOnce();
  });
  it("asks the computer again until it confirms, and hand-back asks too", async () => {
    vi.useFakeTimers();
    try {
      const f = await setup();
      let answers = 0;
      f.access.confirm = vi.fn(async () => {
        answers++;
        if (answers < 4) throw new Error("synthetic desktop not answering");
      });
      f.input.mockRejectedValueOnce(new Error("synthetic press not seen"));
      await expect(f.send(click)).rejects.toBeInstanceOf(ManualInputUncertain);
      await vi.advanceTimersByTimeAsync(250);
      expect(answers).toBe(2);
      expect(f.session.manualControl).toBe("unconfirmed");
      // Hand-back asks at once rather than waiting for the next try.
      expect(await f.session.handback(f.requestId, undefined)).toBe(false);
      expect(answers).toBe(3);
      expect(f.session.manualControl).toBe("unconfirmed");
      await vi.advanceTimersByTimeAsync(500);
      expect(answers).toBe(4);
      expect(f.session.manualControl).toBe("ready");
      expect(await f.session.handback(f.requestId, undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("leaves the user in control to try again when a hand-back cannot finish", async () => {
    const f = await setup(),
      before = deferred(),
      caller = new AbortController();
    f.access.prepare = () => before.promise;
    const active = f.send(click).catch(() => undefined);
    const handback = f.session.handback(f.requestId, undefined, caller.signal);
    expect(f.session.manualControl).toBe("returning");
    caller.abort();
    expect(await handback).toBe(false);
    before.resolve();
    await active;
    expect(f.session.manualControl).toBe("ready");
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
  });
  it("rejects changed endpoint/readiness after preflight before any injection", async () => {
    const f = await setup(),
      before = deferred();
    let ready = true;
    f.access.prepare = () => before.promise;
    f.access.check = () => {
      if (!ready) throw new AgentError(409, "fixture changed");
    };
    const active = f.send(click).then(
      () => undefined,
      (error: unknown) => error,
    );
    ready = false;
    before.resolve();
    const error = await active;
    expect(f.input).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(AgentError);
  });
  it("refuses points outside the actual desktop and unavailable transport before dispatch", async () => {
    const f = await setup();
    await expect(f.send({ ...click, at: { x: 2560, y: 0 } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      sendManualInput(
        f.session,
        { requestId: f.requestId, input: click },
        new AbortController().signal,
        undefined,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.input).not.toHaveBeenCalled();
  });
  it("requires confirmed input and successful owner cleanup before releasing the fence", async () => {
    const f = await setup();
    f.access.release = () => {
      throw new Error("synthetic private diagnostic");
    };
    await expect(f.send(click)).rejects.toBeInstanceOf(ManualInputUncertain);
    expect(f.session.manualControl).toBe("unconfirmed");
    expect(await f.session.handback(f.requestId, undefined)).toBe(false);
  });
});
