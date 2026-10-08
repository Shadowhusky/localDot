import { emptyManifest, LocalDotEvent, ulid } from "@localdot/protocol";
import { buildPlaybackMap, emptyModel, foldEvents, observeAt, sceneAt } from "@localdot/stage";
import { expect, it } from "vitest";
import { exportContext } from "../export/export-context.ts";
import { createApi } from "../lib/api.ts";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { recordingUrl, replayGeometry, replayView } from "./recording-source.ts";
import { compareFrames } from "./replay-view.ts";
import type { ReplayState } from "./useReplay.ts";

function history() {
  let seq = 0;
  const event = (type: string, t: number, data: unknown, step?: string) =>
    LocalDotEvent.parse({
      v: 1,
      id: ulid(),
      seq: seq++,
      t: t * 1000,
      type,
      agent: "main",
      data,
      ...(step ? { step } : {}),
    });
  const desktop = ulid(),
    browser = ulid();
  const d1 = ulid(),
    b1 = ulid(),
    b2 = ulid(),
    d2 = ulid();
  const model = foldEvents(emptyModel(), [
    event("session.start", 0, { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" }),
    event("observe", 20, { frameId: d1, width: 1280, height: 800 }),
    event("screen.switch", 20, {
      screen: "browser",
      cellId: browser,
      revision: 1,
      by: "agent",
      geometry: { w: 1440, h: 900, scale: 2 },
    }),
    event("observe", 20, { frameId: b1, width: 2880, height: 1800 }),
    event("step.start", 25, { kind: "gui" }, "browser-step"),
    event(
      "action.intent",
      30,
      { verb: "click", label: "Browser click", risk: "none", point: { x: 300, y: 100 } },
      "browser-step",
    ),
    event("observe", 40, { frameId: b2, width: 2880, height: 1800 }, "browser-step"),
    event("screen.switch", 50, {
      screen: "desktop",
      cellId: desktop,
      revision: 2,
      by: "agent",
      geometry: { w: 1280, h: 800, scale: 1 },
    }),
    event("observe", 60, { frameId: d2, width: 1280, height: 800 }),
  ]);
  return { model, d1, b1, b2, d2 };
}
it("assigns equal-clock observations by event order and isolates thumbnails and comparison", () => {
  const { model, d1, b1, b2, d2 } = history();
  expect(observeAt(model, 19, "browser")).toBeUndefined();
  expect(observeAt(model, 20, "desktop")?.frameId).toBe(d1);
  expect(observeAt(model, 20, "browser")?.frameId).toBe(b1);
  expect(observeAt(model, 70, "desktop")?.frameId).toBe(d2);
  expect(observeAt(model, 70, "browser")?.frameId).toBe(b2);
  expect(compareFrames(model, "browser-step", "browser")).toEqual({ before: b1, after: b2 });
  expect(compareFrames(model, "browser-step", "desktop")).toEqual({ before: d1, after: null });
});
it("uses browser logical geometry and renders only the selected track's action overlays", () => {
  const { model } = history();
  const source: ReplaySource = {
    sessionId: ulid(),
    origin: "http://127.0.0.1:4750",
    authorization: "Bearer fixture",
    video: null,
    gaps: [],
    screen: "browser",
  };
  expect(replayGeometry(model, source)).toEqual({ w: 1440, h: 900, scale: 2 });
  const view = replayView(source, { reducedMotion: true, screen: "desktop", screenRevision: 2 });
  expect(view.screenRevision).toBeUndefined();
  expect(sceneAt(model, 40, view).target).not.toBeNull();
  expect(sceneAt(model, 40, replayView({ ...source, screen: "desktop" }, view)).target).toBeNull();
  expect(sceneAt(model, 65, view).target).toBeNull();
});
it("freezes the selected export track, its snapshot, geometry and privacy intervals", () => {
  const { model } = history();
  const id = ulid();
  const replay = {
    screen: "browser",
    model,
    tMs: 30,
    info: {
      manifest: {
        ...emptyManifest("recording"),
        width: 2880,
        height: 1800,
        gaps: [{ from: 30000, to: 40000, reason: "user-control" }],
      },
      live: true,
      upto: 4,
      servedBytes: 1000,
    },
    map: buildPlaybackMap(0, 100, [], false),
  } as ReplayState;
  const api = createApi("fixture", { origin: "http://127.0.0.1:4750" });
  const context = exportContext(api, id, replay);
  replay.screen = "desktop";
  replay.info!.upto = 99;
  replay.info!.manifest.gaps.length = 0;
  model.screenChanges.length = 0;
  expect(context.source.screen).toBe("browser");
  expect(new URL(recordingUrl(context.source)).searchParams.get("upto")).toBe("4");
  expect(new URL(recordingUrl(context.source)).searchParams.get("screen")).toBe("browser");
  expect(context.source.gaps).toEqual([{ from: 30000, to: 40000, reason: "user-control" }]);
  expect(replayGeometry(context.model, context.source)).toEqual({ w: 1440, h: 900, scale: 2 });
});
