// Inert owned ToolApi/model gate; actual session authority and file-effect counters.
import { type ModelAdmissionSnapshot, ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { toolHarness } from "../testing/harness.ts";
import { type ModelOwner, SafetyController } from "./controller.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(autoApprove = true) {
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
    mode: "api" as const,
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

it("Pause closes model admission despite failure to publish the safety event", async () => {
  const f = fixture();
  const append = f.session.append.bind(f.session);
  vi.spyOn(f.session, "append").mockImplementation((...args) => {
    if (args[0] === "safety.pause") throw new Error("owned journal fixture failure");
    return append(...args);
  });
  try {
    f.controller.request(ulid());
  } catch {
    /* A failed reply cannot permit provider admission. */
  }
  try {
    await f.controller.settled();
  } catch {
    /* Keep the diagnostic; assert the actual fence. */
  }
  const actual = {
    modelPaused: f.snap().paused,
    closeWrites: f.write.mock.calls.filter(([, v]) => v.state === "paused").length,
  };
  expect(actual, JSON.stringify(actual)).toEqual({ modelPaused: true, closeWrites: 1 });
});

it("a failed final Resume journal keeps native/file admission closed", async () => {
  const f = fixture();
  const pause = f.controller.request(ulid());
  await f.controller.settled();
  expect(f.snap().paused).toBe(true);
  expect(f.session.safetyPause?.phase).toBe("paused");
  const append = f.session.append.bind(f.session);
  vi.spyOn(f.session, "append").mockImplementation((...args) => {
    if (args[0] === "safety.pause" && !f.session.safetyPause)
      throw new Error("owned final journal fixture failure");
    return append(...args);
  });
  let accepted = false;
  try {
    await f.controller.resume(pause.requestId, pause.revision);
    accepted = true;
  } catch {
    // A rejected Resume must preserve uncertainty; a confirmed successful one may grant work.
  }
  const reply = await f.call("files", {
    op: "write",
    path: "after-uncertain.txt",
    content: "must not run",
  });
  const actual = {
    accepted,
    modelPaused: f.snap().paused,
    written: f.desktop.files.has("after-uncertain.txt"),
    ok: reply.body.ok,
  };
  expect(actual, JSON.stringify(actual)).toEqual({
    accepted,
    modelPaused: !accepted,
    written: accepted,
    ok: accepted,
  });
});

it("ordinary explicit Pause and Resume retains a real file-effect positive control", async () => {
  const f = fixture();
  const pause = f.controller.request(ulid());
  await f.controller.settled();
  const blocked = await f.call("files", { op: "write", path: "during.txt", content: "no" });
  expect({
    modelPaused: f.snap().paused,
    paused: blocked.body.pause,
    effects: f.desktop.files.size,
  }).toEqual({ modelPaused: true, paused: true, effects: 0 });
  await f.controller.resume(pause.requestId, pause.revision);
  const allowed = await f.call("files", { op: "write", path: "after.txt", content: "yes" });
  expect({
    modelPaused: f.snap().paused,
    ok: allowed.body.ok,
    effects: f.desktop.files.size,
  }).toEqual({ modelPaused: false, ok: true, effects: 1 });
});
