import { expect, it } from "vitest";
import { PausedStepError, StepBarrier } from "./step-barrier.ts";

it("RF4 Pause waits for atomic typing and refuses queued side effects", async () => {
  let finish!: () => void;
  let entered!: () => void;
  let effects = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const typed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const barrier = new StepBarrier(() => {});
  const signal = new AbortController().signal;
  const first = barrier.run(async () => {
    effects++;
    entered();
    await typed;
  }, signal);
  const queued = barrier
    .run(async () => {
      effects++;
    }, signal)
    .catch((error) => error);
  await started;
  const pause = barrier.requestPause("p1", "user");
  let settled = false;
  const boundary = barrier.waitAtBoundary(signal).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(effects).toBe(1);
  expect(() => barrier.confirmPaused(pause.requestId, pause.revision)).toThrow();
  finish();
  await first;
  await boundary;
  expect(await queued).toBeInstanceOf(PausedStepError);
  expect(effects).toBe(1);
  await expect(
    barrier.run(async () => {
      effects++;
    }, signal),
  ).rejects.toThrow("paused");
  barrier.confirmPaused(pause.requestId, pause.revision);
  expect(() => barrier.resume("wrong", pause.revision)).toThrow();
  expect(() => barrier.resume("p1", pause.revision + 1)).toThrow();
  barrier.resume(pause.requestId, pause.revision);
  await barrier.run(async () => {
    effects++;
  }, signal);
  expect(effects).toBe(2);
});
it("Stop and unconfirmed model closure cannot be undone by explicit Resume", () => {
  const barrier = new StepBarrier(() => {});
  const pause = barrier.requestPause("p1", "user");
  barrier.uncertain(pause.requestId, pause.revision);
  expect(() => barrier.resume("p1", pause.revision)).toThrow();
  barrier.stop();
  expect(() => barrier.confirmPaused("p1", pause.revision)).toThrow();
  expect(() => barrier.resume("p1", pause.revision)).toThrow();
});
it("current owner is revalidated before a queued step and Resume", async () => {
  let current = true;
  const barrier = new StepBarrier(() => {
    if (!current) throw new Error("stale");
  });
  const signal = new AbortController().signal;
  const result = barrier.run(async () => {
    throw new Error("must not execute");
  }, signal);
  current = false;
  await expect(result).rejects.toThrow("stale");
  expect(() => barrier.requestPause("p", "user")).toThrow("stale");
});

it("queued pre-Pause action stays cancelled after an immediate confirmed Resume", async () => {
  const barrier = new StepBarrier(() => {});
  const signal = new AbortController().signal;
  let effects = 0;
  const old = barrier
    .run(async () => {
      effects++;
    }, signal)
    .catch((error) => error);
  const pause = barrier.requestPause("p", "user");
  await barrier.waitAtBoundary(signal);
  barrier.confirmPaused(pause.requestId, pause.revision);
  barrier.resume(pause.requestId, pause.revision);
  expect(await old).toBeInstanceOf(PausedStepError);
  expect(effects).toBe(0);
  await barrier.run(async () => {
    effects++;
  }, signal);
  expect(effects).toBe(1);
});
