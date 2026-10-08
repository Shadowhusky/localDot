// @vitest-environment jsdom
import { emptyManifest, type LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import { useReplay } from "./useReplay.ts";

afterEach(() => cleanup());
function fixture() {
  const sessionId = ulid(),
    before = ulid(),
    afterOne = ulid(),
    afterTwo = ulid();
  const parts = [
    { t: 0, type: "session.start", data: { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" } },
    { t: 100000, type: "observe", data: { frameId: before, width: 1280, height: 800 } },
    { t: 1000000, step: "one", type: "step.start", data: { kind: "gui" } },
    {
      t: 2000000,
      step: "one",
      type: "observe",
      data: { frameId: afterOne, width: 1280, height: 800 },
    },
    { t: 2100000, step: "one", type: "step.end", data: { status: "ok" } },
    { t: 4000000, step: "two", type: "step.start", data: { kind: "gui" } },
    {
      t: 5000000,
      step: "two",
      type: "observe",
      data: { frameId: afterTwo, width: 1280, height: 800 },
    },
    { t: 5100000, step: "two", type: "step.end", data: { status: "ok" } },
    { t: 6000000, type: "session.end", data: { reason: "done" } },
  ];
  const events = parts.map((p, seq) => ({
    v: 1,
    id: ulid(),
    seq,
    agent: "main",
    ...p,
  })) as LocalDotEvent[];
  const api = createApi("fixture", {
    origin: "http://fixture.test",
    fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/card"))
        return Response.json({
          id: sessionId,
          title: "Compare fixture",
          startedAt: "2026-10-01T00:00:00.000Z",
          durationMs: 6000,
          verdict: "done",
          steps: 2,
          failedSteps: 0,
          coverFrameId: null,
          screen: null,
          recording: { state: "none", bytes: 0 },
        });
      if (path.endsWith("/recording"))
        return Response.json({
          manifest: emptyManifest("none"),
          live: false,
          upto: 0,
          servedBytes: 0,
        });
      return new Response(events.map((e) => JSON.stringify(e)).join("\n"));
    }) as typeof fetch,
  });
  const stage = {
    current: {
      resetSession: vi.fn(),
      pushEvents: vi.fn(),
      replay: {
        open: vi.fn(),
        close: vi.fn(),
        seek: vi.fn(),
        transport: vi.fn(),
        onReplay: () => () => {},
      },
    } as unknown as StageHandle,
  };
  const hook = renderHook(() => useReplay(api, sessionId, stage, { onGoLive: vi.fn() }));
  return { hook, before, afterOne, afterTwo };
}
it("does not show the old step comparison under the newly selected step", async () => {
  const f = fixture();
  await waitFor(() => expect(f.hook.result.current.map).not.toBeNull());
  act(() => {
    f.hook.result.current.selectStep("one");
    f.hook.result.current.run({ kind: "compare" });
  });
  expect(f.hook.result.current.compare).toEqual({ before: f.before, after: f.afterOne });
  act(() => f.hook.result.current.run({ kind: "step", dir: 1 }));
  expect(f.hook.result.current.tMs).toBe(4000);
  const current = f.hook.result.current.compare;
  expect(
    current === null || (current.before === f.afterOne && current.after === f.afterTwo),
    "comparison must close or follow its current step when the replay position changes",
  ).toBe(true);
});
it("opening comparison at the second step uses its correct owned frame pair", async () => {
  const f = fixture();
  await waitFor(() => expect(f.hook.result.current.map).not.toBeNull());
  act(() => {
    f.hook.result.current.selectStep("two");
    f.hook.result.current.run({ kind: "compare" });
  });
  expect(f.hook.result.current.compare).toEqual({ before: f.afterOne, after: f.afterTwo });
  act(() => f.hook.result.current.run({ kind: "exit" }));
  expect(f.hook.result.current.compare).toBeNull();
});
