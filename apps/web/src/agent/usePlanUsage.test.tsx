// @vitest-environment jsdom
import type { PlanUsageReply } from "@localdot/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { usePlanUsage } from "./usePlanUsage.ts";

afterEach(() => vi.useRealTimers());

const reply = (usedPercent: number): PlanUsageReply => ({
  plans: [
    {
      provider: "chatgpt",
      windows: [{ window: "primary", usedPercent, windowMinutes: 300, observedAt: 1 }],
      limitReached: false,
      observedAt: 1,
    },
  ],
  checking: [],
});
function client(answers: (path: string) => Promise<unknown>) {
  const get = vi.fn((path: string) => answers(path));
  return { api: { get } as unknown as ApiClient, get };
}

describe("plan usage feed", () => {
  it("reads while a plan is in use, asks for fresh figures while watched and keeps the last through an outage", async () => {
    vi.useFakeTimers();
    let answer = (): Promise<unknown> => Promise.resolve(reply(10));
    const { api, get } = client(() => answer());
    const { result, rerender } = renderHook(({ on }) => usePlanUsage(api, on), {
      initialProps: { on: false },
    });
    expect(get).not.toHaveBeenCalled();
    rerender({ on: true });
    await act(async () => {});
    expect(get).toHaveBeenLastCalledWith("/api/agent/plan-usage", expect.anything());
    expect(result.current.reply?.plans[0]?.windows[0]?.usedPercent).toBe(10);
    let stop!: () => void;
    act(() => {
      stop = result.current.watch();
    });
    expect(get).toHaveBeenCalledWith("/api/agent/plan-usage?fresh=1", expect.anything());
    answer = () => Promise.reject(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.reply?.plans[0]?.windows[0]?.usedPercent).toBe(10);
    answer = () => Promise.resolve(reply(55));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.reply?.plans[0]?.windows[0]?.usedPercent).toBe(55);
    act(() => stop());
    const calls = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(get.mock.calls.length).toBe(calls);
  });

  it("drops an answer overtaken by a later one, and a reply that isn't plan usage", async () => {
    let first!: (value: unknown) => void;
    const answers = [
      new Promise((resolve) => {
        first = resolve;
      }),
      Promise.resolve(reply(30)),
      Promise.resolve({ plans: "none" }),
    ];
    const { api } = client(() => answers.shift() ?? Promise.resolve(reply(30)));
    const { result } = renderHook(() => usePlanUsage(api, true));
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.reply?.plans[0]?.windows[0]?.usedPercent).toBe(30);
    await act(async () => first(reply(5)));
    expect(result.current.reply?.plans[0]?.windows[0]?.usedPercent).toBe(30);
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.reply?.plans[0]?.windows[0]?.usedPercent).toBe(30);
  });
});
