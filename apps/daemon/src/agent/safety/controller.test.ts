import { type ModelAdmissionSnapshot, ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { toolHarness } from "../testing/harness.ts";
import { type ModelOwner, SafetyController } from "./controller.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (check()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("boundary not reached");
}
function fixture(autoApprove = true, mode: "api" | "native" = "api") {
  const h = toolHarness({ autoApprove });
  fixtures.push(h);
  let owner: ModelOwner | undefined = { cellId: ulid(), taskId: h.session.id };
  let snap: ModelAdmissionSnapshot = {
    taskId: h.session.id,
    generationId: "a".repeat(32),
    epoch: 2,
    paused: false,
    active: 0,
    retired: false,
  };
  const model = vi.fn(async () => ({ ...snap }));
  const write = vi.fn(
    async (
      _cell: string,
      input: {
        taskId: string;
        generationId: string;
        state: "paused" | "open";
        expectedEpoch?: number;
      },
    ) => {
      if (
        input.taskId !== snap.taskId ||
        input.generationId !== snap.generationId ||
        (input.state === "open" && input.expectedEpoch !== snap.epoch)
      )
        throw new Error("stale model owner");
      snap = { ...snap, paused: input.state === "paused", epoch: snap.epoch + 1 };
      return { ...snap };
    },
  );
  const persist = vi.fn();
  const ready = vi.fn();
  const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    await new Promise<void>((r) => setImmediate(r));
  });
  const deps = {
    owner: () => owner,
    ready,
    modelAdmission: model,
    setModelAdmission: write,
    persist,
    sleep,
    mode,
  };
  const controller = new SafetyController(h.session, deps);
  return {
    ...h,
    controller,
    deps,
    model,
    write,
    persist,
    ready,
    sleep,
    setOwner: (next: ModelOwner | undefined) => {
      owner = next;
    },
    snap: () => ({ ...snap }),
    setSnapshot: (update: Partial<ModelAdmissionSnapshot>) => {
      snap = { ...snap, ...update };
    },
  };
}
it("Pause drains the current actual shell call and refuses queued file effects before their lease", async () => {
  const f = fixture(),
    hold = deferred();
  let started = false;
  const original = f.tools.desktop;
  f.tools.desktop = (id) => {
    const d = original(id);
    return d
      ? {
          ...d,
          shell: async (...args) => {
            started = true;
            await hold.promise;
            return d.shell(...args);
          },
        }
      : undefined;
  };
  const first = f.call("shell", { command: "echo settled" });
  await until(() => started);
  const queued = f.call("files", { op: "write", path: "queued.txt", content: "must not run" });
  const pause = f.controller.request(ulid());
  expect(pause.phase).toBe("pausing");
  expect(f.session.safetyPause?.resumeAvailable).toBe(false);
  expect((await queued).body.pause).toBe(true);
  expect(f.desktop.files.has("queued.txt")).toBe(false);
  expect(f.session.abort.signal.aborted).toBe(false);
  hold.resolve();
  expect((await first).body.ok).toBe(true);
  await f.controller.settled();
  expect(f.desktop.shellCalls).toEqual(["echo settled"]);
  expect(f.session.safetyPause?.phase).toBe("paused");
  f.session.post("steer", "continue");
  f.session.post("followup", "more work");
  f.session.post("resume", "");
  expect((await f.call("shell", { command: "echo forbidden" })).body.pause).toBe(true);
  expect(f.desktop.shellCalls).toEqual(["echo settled"]);
  await f.controller.resume(pause.requestId, pause.revision);
  expect((await f.call("shell", { command: "echo next" })).body.ok).toBe(true);
  expect(f.desktop.shellCalls).toEqual(["echo settled", "echo next"]);
});
it.each(["approval", "ask"])(
  "Pause clears a waiting %s and returns only the daemon pause directive",
  async (kind) => {
    const f = fixture(false);
    const pending =
      kind === "approval"
        ? f.call("files", { op: "write", path: "denied.txt", content: "no" })
        : f.call("ask_user", { question: "Which?", options: ["One", "Two"] });
    await until(() => (kind === "approval" ? !!f.session.pendingApproval : !!f.session.pendingAsk));
    const card = f.session.pendingApproval;
    const ask = f.session.pendingAsk;
    const pause = f.controller.request(ulid());
    expect((await pending).body.pause).toBe(true);
    await f.controller.settled();
    expect(f.session.safetyPause?.phase).toBe("paused");
    expect(f.desktop.files.has("denied.txt")).toBe(false);
    if (card) expect(f.session.answerApproval({ ...card, decision: "approve" })).toBe(false);
    if (ask) expect(f.session.answerFields(ask, { answer: "One" }, (text) => text)).toBe(false);
    await f.controller.resume(pause.requestId, pause.revision);
    expect(f.session.pendingAsk).toBeUndefined();
    expect(f.session.pendingApproval).toBeUndefined();
  },
);
it("already started model work drains without cancellation, next admission stays closed", async () => {
  const f = fixture();
  f.setSnapshot({ active: 1 });
  const hold = deferred();
  f.sleep.mockImplementation(async () => hold.promise);
  const pause = f.controller.request(ulid());
  await until(() => f.sleep.mock.calls.length > 0);
  expect(f.snap().paused).toBe(true);
  expect(f.session.safetyPause?.phase).toBe("pausing");
  expect(f.session.abort.signal.aborted).toBe(false);
  f.setSnapshot({ active: 0 });
  hold.resolve();
  await f.controller.settled();
  expect(f.session.safetyPause?.phase).toBe("paused");
  await f.controller.resume(pause.requestId, pause.revision);
  expect(f.snap().paused).toBe(false);
  expect(f.write.mock.calls.filter((c) => c[1].state === "open")).toHaveLength(1);
});
it("failed or wrong-generation model confirmation keeps Uncertain and forbids Resume", async () => {
  for (const mode of ["missing", "wrong"] as const) {
    const f = fixture();
    if (mode === "missing") f.model.mockRejectedValue(new Error("missing ack"));
    else f.model.mockImplementation(async () => ({ ...f.snap(), generationId: "b".repeat(32) }));
    if (mode === "wrong")
      f.write.mockImplementation(async () => ({
        ...f.snap(),
        generationId: "c".repeat(32),
        paused: true,
      }));
    const pause = f.controller.request(ulid());
    await f.controller.settled();
    expect(f.session.safetyPause?.phase).toBe("uncertain");
    await expect(f.controller.resume(pause.requestId, pause.revision)).rejects.toThrow();
    expect(f.write.mock.calls.filter((c) => c[1].state === "open")).toHaveLength(0);
  }
});
it("Stop during asynchronous closure cannot be undone by late confirmation", async () => {
  const f = fixture(),
    hold = deferred();
  f.model.mockImplementation(async () => {
    await hold.promise;
    return f.snap();
  });
  const pause = f.controller.request(ulid());
  f.session.stop();
  hold.resolve();
  await f.controller.settled();
  await expect(f.controller.resume(pause.requestId, pause.revision)).rejects.toThrow();
  expect(f.write).not.toHaveBeenCalled();
});
it("stale requests and changed task/model owners cannot reopen admission", async () => {
  const f = fixture();
  const pause = f.controller.request(ulid());
  await f.controller.settled();
  await expect(f.controller.resume(ulid(), pause.revision)).rejects.toThrow();
  await expect(f.controller.resume(pause.requestId, pause.revision + 1)).rejects.toThrow();
  f.setOwner({ cellId: ulid(), taskId: ulid() });
  await expect(f.controller.resume(pause.requestId, pause.revision)).rejects.toThrow();
  expect(f.snap().paused).toBe(true);
});
it("lost open acknowledgement closes the exact old model owner and never releases the tool fence", async () => {
  const f = fixture();
  const pause = f.controller.request(ulid());
  await f.controller.settled();
  const original = f.write.getMockImplementation();
  if (!original) throw new Error("fixture");
  f.write.mockImplementation(async (cell, input) => {
    const result = await original(cell, input);
    if (input.state === "open") throw new Error("lost open ack");
    return result;
  });
  await expect(f.controller.resume(pause.requestId, pause.revision)).rejects.toThrow();
  expect(f.snap().paused).toBe(true);
  expect(f.session.safetyPause?.phase).toBe("uncertain");
  expect((await f.call("files", { op: "write", path: "lost.txt", content: "no" })).body.pause).toBe(
    true,
  );
  expect(f.desktop.files.has("lost.txt")).toBe(false);
});
it("native receipt uncertainty is not presented as a confirmed Pause", async () => {
  const f = fixture(true, "native");
  const control = f.controller;
  const pause = control.request(ulid());
  await control.settled();
  expect(f.session.safetyPause?.resumeAvailable).toBe(false);
  expect(f.session.safetyPause?.phase).toBe("uncertain");
  await expect(control.resume(pause.requestId, pause.revision)).rejects.toThrow();
});

it("a failed durable intent cannot leave the model gate open or allow Resume", async () => {
  const f = fixture();
  f.persist.mockImplementation(() => {
    throw new Error("disk unavailable");
  });
  const pause = f.controller.request(ulid());
  await f.controller.settled();
  expect(f.snap().paused).toBe(true);
  expect(f.session.safetyPause?.phase).toBe("uncertain");
  await expect(f.controller.resume(pause.requestId, pause.revision)).rejects.toThrow();
  expect(f.write.mock.calls.every(([, input]) => input.state === "paused")).toBe(true);
});

it("the control read uses current bearer ownership and refuses fake brain safety events", async () => {
  const f = fixture();
  expect((await f.app.request("/v1/control")).status).toBe(401);
  expect(
    (await f.app.request("/v1/control", { headers: { ...f.auth, origin: "http://foreign" } }))
      .status,
  ).toBe(403);
  const pause = f.controller.request(ulid());
  await f.controller.settled();
  const response = await f.app.request("/v1/control?after=0&waitMs=0", { headers: f.auth });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    pause: { requestId: pause.requestId, phase: "paused" },
  });
  for (const query of ["after=-1", "waitMs=25001", "after=NaN"]) {
    expect((await f.app.request(`/v1/control?${query}`, { headers: f.auth })).status).toBe(400);
  }
  expect(
    (
      await f.app.request("/v1/events", {
        method: "POST",
        headers: f.auth,
        body: JSON.stringify({ events: [{ type: "safety.pause", data: { revision: 99 } }] }),
      })
    ).status,
  ).toBe(400);
  expect(f.session.safetyPause?.phase).toBe("paused");
  const generation = f.session.generation;
  if (generation) f.session.retireBrain(generation);
  expect((await f.app.request("/v1/control", { headers: f.auth })).status).toBe(401);
});
