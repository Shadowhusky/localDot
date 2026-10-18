// @vitest-environment jsdom

import { emptyManifest, type LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import type { StageHandle } from "../stage/Stage.tsx";
import type { ReplaySource, WorkerOut } from "../stage/worker-protocol.ts";
import { useReplay } from "./useReplay.ts";

function liveFixture(extra: LocalDotEvent[] = []) {
  const sessionId = ulid();
  const events: LocalDotEvent[] = [
    {
      v: 1,
      id: ulid(),
      seq: 0,
      t: 0,
      agent: "main",
      type: "session.start",
      data: { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: "Live replay" },
    },
    {
      v: 1,
      id: ulid(),
      seq: 1,
      t: 5_000_000,
      agent: "main",
      type: "text.progress",
      data: { count: 1, chunk: "a", masked: false },
    },
  ];
  events.push(...extra);
  let listener: ((message: WorkerOut) => void) | undefined;
  const unsubscribe = vi.fn();
  const replay = {
    open: vi.fn<StageHandle["replay"]["open"]>(),
    close: vi.fn(),
    seek: vi.fn(),
    transport: vi.fn(),
    probe: vi.fn(),
    onReplay: vi.fn((callback: (message: WorkerOut) => void) => {
      listener = callback;
      return unsubscribe;
    }),
  };
  const stage = {
    current: { replay, resetSession: vi.fn(), pushEvents: vi.fn() } as unknown as StageHandle,
  };
  const requests: string[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: (async (input) => {
      const address = new URL(String(input));
      requests.push(address.pathname + address.search);
      if (address.pathname.endsWith("/card"))
        return Response.json({
          id: sessionId,
          title: "Live replay",
          startedAt: new Date(Date.now() - 300_000).toISOString(),
          durationMs: events.at(-1)?.t,
          verdict: events.some((event) => event.type === "session.end") ? "done" : "live",
          steps: 0,
          failedSteps: 0,
          coverFrameId: null,
          screen: { w: 1280, h: 800, scale: 1 },
          recording: { state: "none", bytes: 0 },
        });
      if (address.pathname.endsWith("/recording"))
        return Response.json({
          manifest: emptyManifest("none"),
          live: !events.some((event) => event.type === "session.end"),
          upto: 0,
          servedBytes: 0,
        });
      const from = Number(address.searchParams.get("fromSeq"));
      return new Response(
        events
          .filter((event) => event.seq >= from)
          .map((event) => JSON.stringify(event))
          .join("\n"),
      );
    }) as typeof fetch,
  });
  const grow = () =>
    events.push({
      v: 1,
      id: ulid(),
      seq: events.length,
      t: 10_000_000,
      agent: "main",
      type: "text.progress",
      data: { count: 2, chunk: "b", masked: false },
    });
  return {
    sessionId,
    api,
    stage,
    replay,
    grow,
    requests,
    unsubscribe,
    emit: (message: WorkerOut) =>
      listener?.({ ...message, owner: replay.open.mock.calls.at(-1)?.[0].owner } as WorkerOut),
    emitRaw: (message: WorkerOut) => listener?.(message),
  };
}

describe("a stretch marked for export", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("marks in and out at the playhead, starts over past the other end, and Escape clears it", async () => {
    const fixture = liveFixture();
    const onGoLive = vi.fn();
    const hook = renderHook(() =>
      useReplay(fixture.api, fixture.sessionId, fixture.stage, { onGoLive }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const run = (command: Parameters<typeof hook.result.current.run>[0]) =>
      act(() => hook.result.current.run(command));
    expect(hook.result.current.selection).toBeNull();
    act(() => hook.result.current.seek(1000, "exact"));
    run({ kind: "mark", edge: "in" });
    expect(hook.result.current.selection).toEqual({ fromMs: 1000, toMs: 5000 });
    act(() => hook.result.current.seek(3000, "exact"));
    run({ kind: "mark", edge: "out" });
    expect(hook.result.current.selection).toEqual({ fromMs: 1000, toMs: 3000 });
    act(() => hook.result.current.seek(4000, "exact"));
    run({ kind: "mark", edge: "in" });
    expect(hook.result.current.selection).toEqual({ fromMs: 4000, toMs: 5000 });
    act(() => hook.result.current.seek(2000, "exact"));
    run({ kind: "mark", edge: "out" });
    expect(hook.result.current.selection).toEqual({ fromMs: 0, toMs: 2000 });
    run({ kind: "exit" });
    expect(hook.result.current.selection).toBeNull();
    expect(onGoLive).not.toHaveBeenCalled();
    run({ kind: "exit" });
    expect(onGoLive).toHaveBeenCalledOnce();
    hook.unmount();
  });
});

describe("a scrub's seeks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("sends the worker one preview at a time, the newest next, and an exact seek on release", async () => {
    const f = liveFixture();
    const hook = renderHook(() => useReplay(f.api, f.sessionId, f.stage, { onGoLive: vi.fn() }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => {
      for (let index = 0; index < 200; index++)
        hook.result.current.seek(1000 + index * 10, "preview");
    });
    expect(f.replay.seek.mock.calls).toEqual([[1000, "preview"]]);
    expect(hook.result.current.tMs).toBe(1000);
    act(() => f.emit({ type: "replay-time", tMs: 1000, playing: false, idle: false }));
    expect(f.replay.seek.mock.calls).toEqual([
      [1000, "preview"],
      [2990, "preview"],
    ]);
    expect(hook.result.current.tMs).toBe(2990);
    act(() => {
      hook.result.current.seek(3200, "preview");
      hook.result.current.seek(3300, "exact");
    });
    expect(f.replay.seek.mock.calls.at(-1)).toEqual([3300, "exact"]);
    act(() => f.emit({ type: "replay-time", tMs: 2990, playing: false, idle: false }));
    act(() => f.emit({ type: "replay-time", tMs: 3300, playing: false, idle: false }));
    expect(f.replay.seek).toHaveBeenCalledTimes(3);
    expect(hook.result.current.tMs).toBe(3300);
    hook.unmount();
  });
});

describe("live replay ownership", () => {
  it("keeps the timestamp across track changes and refuses late messages from retired sources", async () => {
    const f = liveFixture();
    const hook = renderHook(() => useReplay(f.api, f.sessionId, f.stage, { onGoLive: vi.fn() }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const desktop = f.replay.open.mock.calls.at(-1)?.[0] as ReplaySource;
    act(() => hook.result.current.seek(3500, "exact"));
    await act(async () => {
      hook.result.current.setScreen("browser");
      await vi.advanceTimersByTimeAsync(100);
    });
    const browser = f.replay.open.mock.calls.at(-1)?.[0] as ReplaySource;
    expect(browser.screen).toBe("browser");
    expect(browser.owner).not.toBe(desktop.owner);
    expect(hook.result.current.tMs).toBe(3500);
    expect(hook.result.current.playing).toBe(false);
    expect(f.requests).toContain(`/api/sessions/${f.sessionId}/recording?screen=browser`);
    act(() =>
      f.emitRaw({
        type: "replay-time",
        owner: desktop.owner,
        tMs: 5000,
        playing: true,
        idle: false,
      }),
    );
    act(() =>
      f.emitRaw({
        type: "replay-status",
        owner: desktop.owner,
        status: { state: "error", message: "retired" },
      }),
    );
    expect(hook.result.current.tMs).toBe(3500);
    expect(hook.result.current.status).toBe("no-video");
    await act(async () => {
      hook.result.current.setScreen("desktop");
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(f.replay.open.mock.calls.at(-1)?.[0].screen).toBe("desktop");
    expect(f.replay.open.mock.calls.at(-1)?.[0].owner).not.toBe(desktop.owner);
    act(() => f.emitRaw({ type: "replay-ended", owner: browser.owner }));
    expect(hook.result.current.playing).toBe(false);
    expect(hook.result.current.tMs).toBe(3500);
    hook.unmount();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("extends a screenshots-only playback map without reopening media or moving a paused seek", async () => {
    const fixture = liveFixture();
    const onGoLive = vi.fn();
    const hook = renderHook(() =>
      useReplay(fixture.api, fixture.sessionId, fixture.stage, { onGoLive }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(hook.result.current.map?.endMs).toBe(5000);
    act(() => hook.result.current.seek(4000, "exact"));
    fixture.grow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(hook.result.current.map?.endMs).toBe(10_000);
    expect(hook.result.current.tMs).toBe(4000);
    expect(fixture.replay.open).toHaveBeenCalledOnce();
    expect(fixture.replay.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: false, map: expect.objectContaining({ endMs: 10_000 }) }),
    );
    expect(onGoLive).not.toHaveBeenCalled();
    hook.unmount();
    const requests = fixture.requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fixture.requests).toHaveLength(requests);
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.replay.close).toHaveBeenCalledOnce();
  });

  it("resumes at an old live boundary when new history arrives without video bytes", async () => {
    const fixture = liveFixture();
    const onGoLive = vi.fn();
    const hook = renderHook(() =>
      useReplay(fixture.api, fixture.sessionId, fixture.stage, { onGoLive }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => {
      fixture.emit({ type: "replay-time", tMs: 5000, playing: false, idle: false });
      fixture.emit({ type: "replay-ended" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fixture.grow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(hook.result.current.playing).toBe(true);
    expect(hook.result.current.tMs).toBe(5000);
    expect(fixture.replay.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true, map: expect.objectContaining({ endMs: 10_000 }) }),
    );
    expect(onGoLive).not.toHaveBeenCalled();
  });
});

describe("a recording that fails to load", () => {
  afterEach(cleanup);
  it("loads again from the start when asked to try again", async () => {
    const fixture = liveFixture();
    let failing = true;
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: (async (input, init) => {
        if (failing && String(input).includes("/recording"))
          return new Response("boom", { status: 500 });
        return fixture.api.fetch(input, init);
      }) as typeof fetch,
    });
    const hook = renderHook(() =>
      useReplay(api, fixture.sessionId, fixture.stage, { onGoLive: vi.fn() }),
    );
    await vi.waitFor(() => expect(hook.result.current.status).toBe("error"));
    failing = false;
    act(() => hook.result.current.retry());
    await vi.waitFor(() => expect(fixture.replay.open).toHaveBeenCalledOnce());
    expect(hook.result.current.status).not.toBe("error");
  });
});

it("loads saved command details with replay and preserves them when switching screens", async () => {
  const step = "saved-command";
  const events = [
    { type: "step.start", data: { kind: "shell", intent: "Checking the build" } },
    { type: "tool.start", data: { tool: "run", title: "Run tests" } },
    { type: "tool.output", data: { stream: "stdout", chunk: "Tests passed\n" } },
    { type: "tool.end", data: { ok: true, exitCode: 0 } },
    { type: "step.end", data: { status: "ok", note: "Build verified" } },
  ].map((e, i) => ({
    ...e,
    v: 1,
    id: ulid(),
    seq: i + 2,
    t: 6_000_000 + i * 1000,
    agent: "main",
    step,
  })) as LocalDotEvent[];
  const f = liveFixture(events);
  const hook = renderHook(() => useReplay(f.api, f.sessionId, f.stage, { onGoLive: vi.fn() }));
  try {
    await vi.waitFor(() =>
      expect(hook.result.current.agent.steps.get(step)).toMatchObject({
        note: "Build verified",
        tool: { title: "Run tests", exitCode: 0 },
        output: [{ stream: "stdout", text: "Tests passed\n" }],
      }),
    );
    act(() => hook.result.current.setScreen("browser"));
    await vi.waitFor(() =>
      expect(hook.result.current.agent.steps.get(step)?.note).toBe("Build verified"),
    );
    const view = render(
      <ActivityRail
        rows={[]}
        agent={hook.result.current.agent}
        api={f.api}
        sessionId={f.sessionId}
        scale={1}
        asOfMs={7000}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Checking the build/ }));
    expect(screen.getByText("Tests passed")).toBeTruthy();
    expect(screen.getByText("Build verified")).toBeTruthy();
    view.unmount();
  } finally {
    hook.unmount();
  }
});

function switchingFixture() {
  const extra = [
    {
      type: "screen.switch",
      data: {
        screen: "browser",
        revision: 1,
        geometry: { w: 1440, h: 900, scale: 1 },
        cellId: ulid(),
        by: "agent",
      },
    },
    {
      type: "screen.switch",
      data: {
        screen: "desktop",
        revision: 2,
        geometry: { w: 1280, h: 800, scale: 1 },
        cellId: ulid(),
        by: "agent",
      },
    },
    { type: "session.end", data: { reason: "done" } },
  ].map((event, i) => ({
    ...event,
    v: 1,
    id: ulid(),
    seq: i + 2,
    t: (6000 + i * 2000) * 1000,
    agent: "main",
  })) as LocalDotEvent[];
  return liveFixture(extra);
}

describe("following the recorded active screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });
  const ready = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

  it("follows playback switches without pausing, losing settings or reloading history", async () => {
    const f = switchingFixture();
    const hook = renderHook(() => useReplay(f.api, f.sessionId, f.stage, { onGoLive: vi.fn() }));
    await ready();
    const model = hook.result.current.model;
    const agent = hook.result.current.agent;
    expect(hook.result.current.screenChoice).toBe("auto");
    expect(hook.result.current.screen).toBe("desktop");
    act(() => {
      hook.result.current.setSkipIdle(false);
      hook.result.current.setSpeed(2);
      hook.result.current.run({ kind: "mark", edge: "in" });
      hook.result.current.run({ kind: "toggle-play" });
    });
    const old = f.replay.open.mock.calls.at(-1)?.[0].owner;
    act(() => f.emit({ type: "replay-time", tMs: 5999, playing: true, idle: false }));
    expect(hook.result.current.screen).toBe("desktop");
    act(() => f.emit({ type: "replay-time", tMs: 6000, playing: true, idle: false }));
    expect(hook.result.current.screen).toBe("browser");
    expect(f.replay.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true, speed: 2, atPlayMs: 6000 }),
    );
    act(() => f.emitRaw({ type: "replay-ended", owner: old }));
    act(() => f.emitRaw({ type: "replay-time", owner: old, tMs: 0, playing: false, idle: false }));
    expect(hook.result.current.tMs).toBe(6000);
    expect(hook.result.current.playing).toBe(true);
    act(() => f.emit({ type: "replay-time", tMs: 8000, playing: true, idle: false }));
    expect(hook.result.current.screen).toBe("desktop");
    expect(hook.result.current.speed).toBe(2);
    expect(hook.result.current.skipIdle).toBe(false);
    expect(hook.result.current.selection).toEqual({ fromMs: 0, toMs: 10000 });
    expect(hook.result.current.model).toBe(model);
    expect(hook.result.current.agent).toBe(agent);
    expect(f.stage.current.resetSession).toHaveBeenCalledOnce();
    expect(f.requests.filter((path) => path.includes("/events?"))).toHaveLength(1);
    expect(f.replay.open.mock.calls.map(([source]) => source.screen)).toEqual([
      "desktop",
      "browser",
      "desktop",
    ]);
  });

  it("opens a deep link on the right screen, follows seeks both ways and honors a manual override", async () => {
    const f = switchingFixture();
    window.history.replaceState(null, "", `/?replay=${f.sessionId}&t=6500`);
    const hook = renderHook(() => useReplay(f.api, f.sessionId, f.stage, { onGoLive: vi.fn() }));
    await ready();
    expect(f.replay.open.mock.calls.map(([source]) => source.screen)).toEqual(["browser"]);
    expect(hook.result.current.tMs).toBe(6500);
    act(() => hook.result.current.seek(9000, "exact"));
    expect(hook.result.current.screen).toBe("desktop");
    act(() => hook.result.current.seek(7000, "exact"));
    expect(hook.result.current.screen).toBe("browser");
    act(() => hook.result.current.setScreen("desktop"));
    expect(hook.result.current.tMs).toBe(7000);
    expect(hook.result.current.screenChoice).toBe("desktop");
    expect(hook.result.current.screen).toBe("desktop");
    act(() => hook.result.current.seek(6500, "exact"));
    expect(hook.result.current.screen).toBe("desktop");
    act(() => hook.result.current.setScreen("auto"));
    expect(hook.result.current.screen).toBe("browser");
    expect(hook.result.current.tMs).toBe(6500);
    act(() => hook.result.current.seek(1000, "preview"));
    expect(hook.result.current.screen).toBe("desktop");
    act(() => hook.result.current.seek(7500, "exact"));
    expect(hook.result.current.screen).toBe("browser");
    expect(f.requests.filter((path) => path.includes("/events?"))).toHaveLength(1);
  });

  it("returns to the starting screen when replaying from the end", async () => {
    const f = switchingFixture();
    const hook = renderHook(() => useReplay(f.api, f.sessionId, f.stage, { onGoLive: vi.fn() }));
    await ready();
    act(() => {
      hook.result.current.setScreen("browser");
      hook.result.current.seek(10000, "exact");
      hook.result.current.setScreen("auto");
      hook.result.current.run({ kind: "toggle-play" });
    });
    expect(hook.result.current.tMs).toBe(0);
    expect(hook.result.current.screen).toBe("desktop");
    expect(hook.result.current.playing).toBe(true);
  });

  it("isolates a failed browser recording from the computer and allows switching back", async () => {
    const f = switchingFixture();
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: (async (input, init) => {
        if (String(input).endsWith("/recording?screen=browser"))
          return new Response("unavailable", { status: 503 });
        return f.api.fetch(input, init);
      }) as typeof fetch,
    });
    const hook = renderHook(() => useReplay(api, f.sessionId, f.stage, { onGoLive: vi.fn() }));
    await ready();
    expect(hook.result.current.status).toBe("no-video");
    act(() => hook.result.current.seek(6500, "exact"));
    expect(hook.result.current.screen).toBe("browser");
    expect(hook.result.current.status).toBe("error");
    expect(f.replay.close).toHaveBeenCalledOnce();
    act(() => hook.result.current.setScreen("desktop"));
    expect(hook.result.current.status).toBe("no-video");
    expect(hook.result.current.tMs).toBe(6500);
    expect(f.replay.open.mock.calls.at(-1)?.[0].screen).toBe("desktop");
  });
});
