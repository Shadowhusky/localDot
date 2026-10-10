import { describe, expect, it, vi } from "vitest";
import { driveHarness, type HarnessHost, type HarnessStep } from "./harness.ts";

const result = { ok: true, content: [{ type: "text" as const, text: "Completed" }] };
const step = (...names: string[]): HarnessStep => ({
  text: "Working",
  calls: names.map((name, i) => ({ name, id: `${name}-${i}`, input: {} })),
});
function host(over: Partial<HarnessHost> = {}): HarnessHost {
  return {
    sessionId: "test-session",
    task: "Test the harness",
    signal: new AbortController().signal,
    request: async () => step("done"),
    execute: async () => ({ result, conclude: true }),
    stopping: async () => false,
    ...over,
  };
}

describe("DeepSeek Harness boundary", () => {
  it("runs serially and concludes without another model request", async () => {
    const order: string[] = [];
    let active = false;
    const request = vi.fn(async () => step("shell", "files", "done"));
    await driveHarness(
      host({
        request,
        execute: async (id) => {
          expect(active).toBe(false);
          active = true;
          await new Promise((resolve) => setTimeout(resolve, 1));
          order.push(id);
          active = false;
          return { result, conclude: id.startsWith("done") };
        },
      }),
    );
    expect(order).toEqual(["shell-0", "files-1", "done-2"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("honors continuation at the turn boundary", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ text: "Checking", calls: [] })
      .mockResolvedValueOnce(step("done"));
    const stopping = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await driveHarness(host({ request, stopping }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("propagates Stop while a model request is waiting", async () => {
    const abort = new AbortController();
    let active: AbortSignal | undefined;
    const run = driveHarness(
      host({
        signal: abort.signal,
        request: async (signal) => {
          active = signal;
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      }),
    );
    const assertion = expect(run).rejects.toThrow();
    await vi.waitUntil(() => !!active);
    abort.abort();
    expect(active?.aborted).toBe(true);
    await assertion;
  });

  it("does not swallow a tool transport or persistence error and run later actions", async () => {
    const execute = vi.fn(async () => {
      throw new Error("durable append failed");
    });
    const request = vi.fn(async () => step("shell", "files"));
    await expect(driveHarness(host({ request, execute }))).rejects.toThrow("durable append failed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("disposes the session so the same conversation can run again", async () => {
    await driveHarness(host());
    await driveHarness(host());
  });
});
