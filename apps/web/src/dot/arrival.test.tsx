// @vitest-environment jsdom
import type { Wearable } from "@localdot/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DotArrivalInput, rememberOwnDot, useDotArrival } from "./arrival.ts";

const KEY = "localdot.dot-look.v1";
const CREW: readonly Wearable[] = ["crown", "lei"];
const UNSURE: DotArrivalInput = {
  view: "chat",
  address: null,
  task: null,
  look: [],
  known: false,
  remember: true,
};

const arrive = (input: Partial<DotArrivalInput>) =>
  renderHook((props: DotArrivalInput) => useDotArrival(props), {
    initialProps: { ...UNSURE, ...input },
  });

const remember = (shown: object) => localStorage.setItem(KEY, JSON.stringify({ shown }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("how dot arrives", () => {
  it("stays off the page on a first visit until everything has answered, then remembers", () => {
    const view = arrive({ look: ["cap"] });
    expect(view.result.current).toEqual({ look: null, settled: false });
    view.rerender({ ...UNSURE, task: "T1", look: CREW, known: true });
    expect(view.result.current).toEqual({ look: CREW, settled: true });
    view.unmount();
    expect(arrive({ address: "T1" }).result.current).toEqual({ look: CREW, settled: false });
  });

  it("wears last visit's look at once, unless the address names another conversation", () => {
    remember({ view: "chat", task: "T1", look: CREW });
    expect(arrive({}).result.current.look).toEqual(CREW);
    expect(arrive({ address: "current" }).result.current.look).toEqual(CREW);
    expect(arrive({ address: "T1" }).result.current.look).toEqual(CREW);
    expect(arrive({ address: "T2" }).result.current.look).toBeNull();
    expect(arrive({ view: "studio" }).result.current.look).toBeNull();
    expect(arrive({ remember: false }).result.current.look).toBeNull();
  });

  it("dresses a new conversation as the user's own dot", () => {
    rememberOwnDot(["hoodie"], "cap");
    expect(arrive({ address: "new" }).result.current.look).toEqual(["hoodie"]);
  });

  it("doesn't leave the page without a dot if no answer comes", () => {
    vi.useFakeTimers();
    const view = arrive({ look: ["cap"] });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(view.result.current).toEqual({ look: [], settled: false });
    view.rerender({ ...UNSURE, look: CREW, known: true });
    expect(view.result.current).toEqual({ look: CREW, settled: true });
  });

  it("keeps following the look once it has arrived, whatever is known then", () => {
    const view = arrive({ look: CREW, known: true });
    view.rerender({ ...UNSURE, look: ["cap"], known: false });
    expect(view.result.current).toEqual({ look: ["cap"], settled: true });
  });

  it("forgets nothing else when it writes, and survives what it can't read", () => {
    rememberOwnDot(["hoodie"], "cap");
    arrive({ look: CREW, known: true, task: "T1" });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "")).toEqual({
      worn: ["hoodie"],
      accessory: "cap",
      shown: { view: "chat", task: "T1", look: CREW },
    });
    localStorage.setItem(KEY, "{not json");
    expect(arrive({}).result.current.look).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ shown: { view: "chat", task: null, look: ["?"] } }));
    expect(arrive({}).result.current.look).toBeNull();
  });
});
