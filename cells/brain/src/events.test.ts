import type { BrainEvent } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSink } from "./events.ts";

const sinks: EventSink[] = [];
afterEach(async () => {
  for (const s of sinks.splice(0)) await s.close();
  vi.useRealTimers();
});
function sink(options: ConstructorParameters<typeof EventSink>[0]) {
  const s = new EventSink(options);
  sinks.push(s);
  return s;
}
function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("event generation lifetime", () => {
  it("refuses events and heartbeats from an already cancelled generation", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    abort.abort();
    const send = vi.fn(async () => {}),
      s = sink({ send, signal: abort.signal });
    s.busy(true);
    s.text("late");
    s.state("thinking");
    await vi.advanceTimersByTimeAsync(10000);
    await s.flush();
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels in-flight sends and drops queued batches without waiting for ignored abort", async () => {
    vi.useFakeTimers();
    const abort = new AbortController(),
      gate = defer();
    const send = vi.fn(async (_events: BrainEvent[], signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return gate.promise;
    });
    const s = sink({ send, signal: abort.signal });
    s.text("first");
    const first = s.flush();
    await Promise.resolve();
    s.text("second");
    const second = s.flush();
    abort.abort();
    await Promise.all([first, second, s.close()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve();
  });
  it("normal close sends final text and heartbeat end once, then accepts no more events", async () => {
    const sent: BrainEvent[] = [];
    const s = sink({
      send: async (e) => {
        sent.push(...e);
      },
    });
    s.busy(true);
    s.text("Hello");
    await s.close();
    await s.close();
    s.text("late");
    s.busy(true);
    await s.flush();
    expect(sent.filter((e) => e.type === "message.assistant").map((e) => e.data)).toHaveLength(1);
    expect(sent.filter((e) => e.type === "heartbeat").map((e) => e.data.ongoing)).toEqual([
      true,
      false,
    ]);
    expect(JSON.stringify(sent)).not.toContain("late");
  });
  it("serializes bounded batches even if the first send waits", async () => {
    const gate = defer(),
      counts: number[] = [];
    const s = sink({
      send: async (e) => {
        counts.push(e.length);
        if (counts.length === 1) await gate.promise;
      },
    });
    for (let i = 0; i < 600; i++) s.push({ type: "thought.delta", data: { text: String(i) } });
    const sending = s.flush();
    await Promise.resolve();
    expect(counts).toEqual([256]);
    gate.resolve();
    await sending;
    expect(counts).toEqual([256, 256, 88]);
  });
  it("keeps heartbeats running through six minutes of work, then stops every timer on cancellation", async () => {
    vi.useFakeTimers();
    const abort = new AbortController(),
      sent: BrainEvent[] = [];
    const s = sink({
      send: async (e) => {
        sent.push(...e);
      },
      signal: abort.signal,
    });
    s.busy(true);
    await vi.advanceTimersByTimeAsync(360001);
    expect(sent.filter((e) => e.type === "heartbeat").length).toBeGreaterThanOrEqual(360);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(360001);
    expect(sent).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("splits long text deltas to protocol-sized pieces and caps the final text", async () => {
    const sent: BrainEvent[] = [];
    const s = sink({
      send: async (e) => {
        sent.push(...e);
      },
    });
    s.text("x".repeat(25000));
    s.endText();
    await s.flush();
    const deltas = sent.filter((e) => e.type === "message.delta");
    expect(deltas.every((e) => e.data.text.length <= 4000)).toBe(true);
    expect(deltas.map((e) => e.data.text).join("")).toHaveLength(25000);
    const final = sent.find((e) => e.type === "message.assistant");
    expect(final?.data.text).toHaveLength(20000);
  });
  it("keeps a failed event delivery from rejecting tool work or close", async () => {
    const s = sink({
      send: async () => {
        throw new Error("fixture failure");
      },
    });
    s.state("thinking");
    await expect(s.flush()).resolves.toBeUndefined();
    await expect(s.close()).resolves.toBeUndefined();
  });
});
