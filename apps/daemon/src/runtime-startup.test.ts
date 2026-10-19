import { expect, it, vi } from "vitest";
import { RuntimeStartup } from "./runtime-startup.ts";

it("waits without recovery mutations, launches once, and recovers once after delayed Docker readiness", async () => {
  const check = vi
    .fn()
    .mockRejectedValueOnce(new Error("missing socket"))
    .mockRejectedValueOnce(new Error("booting"))
    .mockResolvedValue(undefined);
  const runtime = new RuntimeStartup(check),
    recover = vi.fn(),
    launch = vi.fn();
  const pause = vi.fn(async () => {
    expect(recover).not.toHaveBeenCalled();
    expect(runtime.state).toBe("waiting");
  });
  await runtime.run(recover, { signal: new AbortController().signal, launch, pause });
  expect(launch).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledTimes(2);
  expect(recover).toHaveBeenCalledOnce();
  expect(await runtime.snapshot()).toEqual({ docker: "ready", startup: "ready" });
});
it("does not launch Docker when it is already ready", async () => {
  const runtime = new RuntimeStartup(async () => {}),
    launch = vi.fn();
  await runtime.run(async () => {}, { signal: new AbortController().signal, launch });
  expect(launch).not.toHaveBeenCalled();
});
it("aborts while waiting and never starts recovery after shutdown", async () => {
  const runtime = new RuntimeStartup(async () => {
    throw new Error("down");
  });
  const abort = new AbortController(),
    recover = vi.fn();
  await expect(
    runtime.run(recover, { signal: abort.signal, pause: async () => abort.abort() }),
  ).rejects.toThrow();
  expect(recover).not.toHaveBeenCalled();
});
it("reports recovery failure without a restart loop or repeated side effects", async () => {
  const check = vi.fn().mockResolvedValue(undefined),
    runtime = new RuntimeStartup(check);
  const recover = vi.fn(async () => {
    throw new Error("held computer");
  });
  await expect(runtime.run(recover, { signal: new AbortController().signal })).rejects.toThrow(
    "held computer",
  );
  expect(await runtime.snapshot()).toEqual({ docker: "ready", startup: "failed" });
  check.mockRejectedValue(new Error("Docker closed"));
  expect(await runtime.snapshot()).toEqual({ docker: "unavailable", startup: "failed" });
  expect(recover).toHaveBeenCalledOnce();
});
