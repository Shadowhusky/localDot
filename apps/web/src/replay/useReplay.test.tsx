// @vitest-environment jsdom

import { emptyManifest, type LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import type { ReplaySource, WorkerOut } from "../stage/worker-protocol.ts";
import { useReplay } from "./useReplay.ts";

function liveFixture() {
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
          verdict: "live",
          steps: 0,
          failedSteps: 0,
          coverFrameId: null,
          screen: { w: 1280, h: 800, scale: 1 },
          recording: { state: "none", bytes: 0 },
        });
      if (address.pathname.endsWith("/recording"))
        return Response.json({
          manifest: emptyManifest("none"),
          live: true,
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
