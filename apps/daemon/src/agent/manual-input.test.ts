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
  it("cancels admitted typing but retains the fence when its completion cannot be verified", async () => {
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
    expect(signal?.aborted).toBe(true);
    done.resolve();
    expect(await active).toBeInstanceOf(ManualInputUncertain);
    expect(await handback).toBe(false);
    expect(f.session.controlHeld).toBe(true);
    expect(f.session.manualControl).toBe("unconfirmed");
    expect(() => f.session.beginBrain()).toThrow(ControlHeldError);
    await expect(f.send(click)).rejects.toBeInstanceOf(ControlHeldError);
    expect(f.session.endTakeover(f.requestId, "bypass")).toBe(false);
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
